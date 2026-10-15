/**
 * Stage 8 Batch 2 — Integrations API (read-only listing & status).
 *
 * Exposes the channels + provider_credentials + integration_health rows that
 * already exist, through a provider-neutral shape driven by
 * src/providers/registry.js.
 *
 * SECURITY RULES (enforced here, not in the UI):
 *  - Tenant identity ALWAYS comes from the authenticated session (req.v1.tenantId).
 *    A browser can only narrow the view with `brandId`, which must be owned by
 *    the tenant AND inside the caller's brand scope (see ./brandAccess.js).
 *  - Credential VALUES are never selected, decrypted, logged or serialized:
 *    the query returns presence + expiry only.
 *  - Health diagnostics are reduced to approved CODES by services/healthCodes.js;
 *    raw provider error text is never returned.
 *  - Read-only in this batch: no connect / disconnect / rotation mutations.
 *
 * RBAC: every endpoint requires the existing `brand.integration.status`
 * ability (Company Admin, Supervisor, Agent — see api/v1/stage7-rbac.js).
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requireAbility } from './stage7-rbac.js';
import { providerCatalog, providerLabel } from '../../providers/registry.js';
import { safeHealthStatus, safeHealthErrorCode } from '../../services/healthCodes.js';
import { subscribePageWebhook } from '../../services/metaOAuth.js';
import { decrypt } from '../../db/crypto.js';
import { audit } from '../../auth/audit.js';
import { brandScopeFromSession, brandVisibleToScope, brandIsAccessible, BRAND_SCOPE_RESTRICTED } from './brandAccess.js';

/** Channel ids are uuids; anything else is rejected before touching the database. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared projection — no credential columns are ever selected. */
const PROJECTION = `
  SELECT c.id, c.provider, c.external_id, c.display_name, c.status, c.brand_id, c.created_at,
         b.name AS brand_name,
         EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.channel_id = c.id) AS credential_present,
         (SELECT MAX(pc.expires_at) FROM provider_credentials pc WHERE pc.channel_id = c.id) AS credential_expires_at,
         h.status AS health_status, h.last_event_at, h.last_error,
         c.subscription_state, c.subscription_error, c.verified_at
    FROM channels c
    LEFT JOIN brands b ON b.id = c.brand_id
    LEFT JOIN integration_health h ON h.channel_id = c.id
   WHERE c.tenant_id = $1
     AND ($2::uuid IS NULL OR c.brand_id = $2)`;

const listSql = (restricted) => (restricted ? `${PROJECTION}\n     AND c.brand_id = ANY($3::uuid[])` : PROJECTION);

const STATUS_SQL = `
  SELECT c.id, c.provider, c.external_id, c.display_name, c.status, c.brand_id, c.created_at,
         b.name AS brand_name,
         EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.channel_id = c.id) AS credential_present,
         (SELECT MAX(pc.expires_at) FROM provider_credentials pc WHERE pc.channel_id = c.id) AS credential_expires_at,
         h.status AS health_status, h.last_event_at, h.last_error,
         c.subscription_state, c.subscription_error, c.verified_at
    FROM channels c
    LEFT JOIN brands b ON b.id = c.brand_id
    LEFT JOIN integration_health h ON h.channel_id = c.id
   WHERE c.id = $1 AND c.tenant_id = $2`;

/** Map a DB row to the provider-neutral API shape. No secret, no raw error text. */
function toIntegration(row) {
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: providerLabel(row.provider),
    externalId: row.external_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    brand: row.brand_id ? { id: row.brand_id, name: row.brand_name } : null,
    credentials: {
      // presence + expiry only — the encrypted value is never selected
      present: Boolean(row.credential_present),
      expiresAt: row.credential_expires_at ?? null
    },
    health: {
      status: safeHealthStatus(row.health_status),
      lastEventAt: row.last_event_at ?? null,
      // allow-listed diagnostic CODE only — never the raw provider error text
      lastError: safeHealthErrorCode(row.last_error)
    }
  };
}

export function createIntegrationsRouter({ pool }) {
  const router = express.Router();
  router.use(requireV1Auth);

  /* ------------------------- GET /integrations ------------------------- */
  router.get('/', requireAbility('brand.integration.status'), async (req, res) => {
    const brandId = req.query.brandId ? String(req.query.brandId) : null;
    const scope = brandScopeFromSession(req.v1);
    try {
      if (brandId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(brandId)) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'brandId must be a uuid');
      }
      if (brandId) {
        // Must be owned by the tenant AND inside the caller's brand scope —
        // otherwise a brandId could be used as an existence oracle.
        const allowed = await brandIsAccessible({ db: req.db, tenantId: req.v1.tenantId, brandId, scope });
        if (!allowed) return apiError(res, 404, 'BRAND_NOT_FOUND', 'brand not found');
      }

      const restricted = scope.mode === BRAND_SCOPE_RESTRICTED;
      const params = restricted ? [req.v1.tenantId, brandId, scope.brandIds] : [req.v1.tenantId, brandId];
      const { rows } = await req.db.query(listSql(restricted), params);
      return res.json({
        data: {
          integrations: rows.map(toIntegration),
          providers: providerCatalog(),
          scope: restricted ? { mode: scope.mode, brandCount: scope.brandIds.length } : { mode: scope.mode }
        }
      });
    } catch (err) {
      console.error('integrations list failed:', err?.code ?? err?.name ?? 'error');
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* --------------------- GET /integrations/:id/status --------------------- */
  router.get('/:id/status', requireAbility('brand.integration.status'), async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'channel id must be a uuid');
    }
    const scope = brandScopeFromSession(req.v1);
    try {
      const { rows } = await req.db.query(STATUS_SQL, [id, req.v1.tenantId]);
      // Out-of-scope brand is reported exactly like a missing channel (404),
      // so the endpoint never reveals that it exists.
      if (!rows[0] || !brandVisibleToScope(rows[0].brand_id, scope)) {
        return apiError(res, 404, 'CHANNEL_NOT_FOUND', 'integration not found');
      }
      return res.json({ data: { integration: toIntegration(rows[0]) } });
    } catch (err) {
      console.error('integration status failed:', err?.code ?? err?.name ?? 'error');
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });


  /* ------------- POST /integrations/:id/resubscribe (manual retry) ------------- */
  router.post('/:id/resubscribe', requireAbility('brand.integration.reconnect'), async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return apiError(res, 400, 'VALIDATION_ERROR', 'channel id must be a uuid');
    const scope = brandScopeFromSession(req.v1);
    try {
      const { rows } = await req.db.query(STATUS_SQL, [id, req.v1.tenantId]);
      if (!rows[0] || !brandVisibleToScope(rows[0].brand_id, scope)) {
        return apiError(res, 404, 'CHANNEL_NOT_FOUND', 'integration not found');
      }
      // Brand restriction: the channel brand must still be owned by this tenant
      // and inside the caller's current brand scope.
      if (rows[0].brand_id) {
        const ok = await brandIsAccessible({ db: req.db, tenantId: req.v1.tenantId, brandId: rows[0].brand_id, scope });
        if (!ok) return apiError(res, 404, 'CHANNEL_NOT_FOUND', 'integration not found');
      }
      const channel = rows[0];
      const { rows: creds } = await req.db.query(
        // Same ORDER BY as channelResolver + the connect step, so a retry uses
        // the credential that inbound routing would use.
        `SELECT value_encrypted, iv FROM provider_credentials
          WHERE channel_id = $1 AND tenant_id = $2 AND kind = 'page_access_token'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [id, req.v1.tenantId]
      );
      if (!creds[0]) return apiError(res, 404, 'NO_CREDENTIAL', 'no page credential stored for this integration');

      // Decrypted only for this outbound call; never returned or logged.
      const pageToken = decrypt(creds[0].value_encrypted, creds[0].iv);
      const sub = await subscribePageWebhook({ pageId: channel.external_id, pageToken });
      await req.db.query(
        `UPDATE channels SET subscription_state = $2, subscription_error = $3, verified_at = now() WHERE id = $1`,
        [id, sub.ok ? 'subscribed' : 'subscription_failed', sub.ok ? null : sub.errorCode]
      );
      audit({
        tenantId: req.v1.tenantId, actorUserId: req.v1.user.id,
        action: sub.ok ? 'integration.resubscribe' : 'integration.subscription_failed',
        objectType: 'channel', objectId: id, ip: req.ip,
        metadata: sub.ok ? { ok: true } : { code: sub.errorCode }
      });
      return res.json({ data: { subscriptionState: sub.ok ? 'subscribed' : 'subscription_failed', errorCode: sub.errorCode } });
    } catch (err) {
      console.error('integration resubscribe failed:', err?.code ?? err?.name ?? 'error');
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* --------------- POST /integrations/:id/reverify (legacy channels) --------------- */
  router.post('/:id/reverify', requireAbility('brand.integration.reconnect'), async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return apiError(res, 400, 'VALIDATION_ERROR', 'channel id must be a uuid');
    const scope = brandScopeFromSession(req.v1);
    try {
      const { rows } = await req.db.query(STATUS_SQL, [id, req.v1.tenantId]);
      if (!rows[0] || !brandVisibleToScope(rows[0].brand_id, scope)) {
        return apiError(res, 404, 'CHANNEL_NOT_FOUND', 'integration not found');
      }
      // Brand restriction: the channel brand must still be owned by this tenant
      // and inside the caller's current brand scope.
      if (rows[0].brand_id) {
        const ok = await brandIsAccessible({ db: req.db, tenantId: req.v1.tenantId, brandId: rows[0].brand_id, scope });
        if (!ok) return apiError(res, 404, 'CHANNEL_NOT_FOUND', 'integration not found');
      }
      const channel = rows[0];
      const { rows: creds } = await req.db.query(
        // Same ORDER BY as channelResolver + the connect step, so a retry uses
        // the credential that inbound routing would use.
        `SELECT value_encrypted, iv FROM provider_credentials
          WHERE channel_id = $1 AND tenant_id = $2 AND kind = 'page_access_token'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [id, req.v1.tenantId]
      );
      if (!creds[0]) return apiError(res, 404, 'NO_CREDENTIAL', 'no page credential stored for this integration');

      const pageToken = decrypt(creds[0].value_encrypted, creds[0].iv);
      const sub = await subscribePageWebhook({ pageId: channel.external_id, pageToken });
      await req.db.query(
        `UPDATE channels SET subscription_state = $2, subscription_error = $3, verified_at = now() WHERE id = $1`,
        [id, sub.ok ? 'subscribed' : 'subscription_failed', sub.ok ? null : sub.errorCode]
      );
      audit({
        tenantId: req.v1.tenantId, actorUserId: req.v1.user.id,
        action: 'integration.reverify', objectType: 'channel', objectId: id, ip: req.ip,
        metadata: { subscription: sub.ok ? 'subscribed' : 'subscription_failed' }
      });
      return res.json({ data: { subscriptionState: sub.ok ? 'subscribed' : 'subscription_failed', errorCode: sub.errorCode } });
    } catch (err) {
      console.error('integration reverify failed:', err?.code ?? err?.name ?? 'error');
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  return router;
}

export { toIntegration };