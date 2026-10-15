/**
 * Stage 8 Batch 2 — Integrations API (read-only listing & status).
 *
 * Exposes the channels + provider_credentials + integration_health rows that
 * already exist, through a provider-neutral shape driven by
 * src/providers/registry.js.
 *
 * SECURITY RULES (enforced here, not in the UI):
 *  - Tenant identity ALWAYS comes from the authenticated session (req.v1.tenantId).
 *    A browser can only narrow the view with `brandId`, which is validated as
 *    owned by that same tenant. There is no tenant parameter anywhere.
 *  - Credential VALUES are never selected, decrypted, logged or serialized:
 *    the query returns presence + expiry only.
 *  - Read-only in this batch: no connect / disconnect / rotation mutations.
 *
 * RBAC: every endpoint requires the existing `brand.integration.status`
 * ability (Company Admin, Supervisor, Agent — see api/v1/stage7-rbac.js).
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requireAbility } from './stage7-rbac.js';
import { providerCatalog, providerLabel } from '../../providers/registry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Channel listing with credential PRESENCE (never values) and health.
 * Tenant-scoped by construction; optional brand narrowing.
 */
const LIST_SQL = `
  SELECT c.id, c.provider, c.external_id, c.display_name, c.status, c.brand_id, c.created_at,
         b.name AS brand_name,
         EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.channel_id = c.id) AS credential_present,
         (SELECT MAX(pc.expires_at) FROM provider_credentials pc WHERE pc.channel_id = c.id) AS credential_expires_at,
         h.status AS health_status, h.last_event_at, h.last_error
    FROM channels c
    LEFT JOIN brands b ON b.id = c.brand_id
    LEFT JOIN integration_health h ON h.channel_id = c.id
   WHERE c.tenant_id = $1
     AND ($2::uuid IS NULL OR c.brand_id = $2)
   ORDER BY c.provider ASC, c.display_name ASC NULLS LAST, c.created_at ASC`;

const STATUS_SQL = `
  SELECT c.id, c.provider, c.external_id, c.display_name, c.status, c.brand_id, c.created_at,
         b.name AS brand_name,
         EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.channel_id = c.id) AS credential_present,
         (SELECT MAX(pc.expires_at) FROM provider_credentials pc WHERE pc.channel_id = c.id) AS credential_expires_at,
         h.status AS health_status, h.last_event_at, h.last_error
    FROM channels c
    LEFT JOIN brands b ON b.id = c.brand_id
    LEFT JOIN integration_health h ON h.channel_id = c.id
   WHERE c.id = $1 AND c.tenant_id = $2`;

/** Map a DB row to the provider-neutral API shape. No secret ever leaves here. */
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
      status: row.health_status ?? 'unknown',
      lastEventAt: row.last_event_at ?? null,
      // operator-written diagnostic text; truncated so it can never carry a payload
      lastError: row.last_error ? String(row.last_error).slice(0, 200) : null
    }
  };
}

export function createIntegrationsRouter({ pool }) {
  const router = express.Router();
  router.use(requireV1Auth);

  /* ------------------------- GET /integrations ------------------------- */
  router.get('/', requireAbility('brand.integration.status'), async (req, res) => {
    const brandId = req.query.brandId ? String(req.query.brandId) : null;
    try {
      if (brandId && !UUID_RE.test(brandId)) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'brandId must be a uuid');
      }
      // Brand must belong to the caller's tenant — otherwise a cross-tenant
      // brandId could be used as an existence oracle.
      if (brandId) {
        const { rows: brandRows } = await req.db.query(
          `SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`,
          [brandId, req.v1.tenantId]
        );
        if (!brandRows[0]) return apiError(res, 404, 'BRAND_NOT_FOUND', 'brand not found');
      }

      const { rows } = await req.db.query(LIST_SQL, [req.v1.tenantId, brandId]);
      return res.json({ data: { integrations: rows.map(toIntegration), providers: providerCatalog() } });
    } catch (err) {
      console.error('integrations list failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* --------------------- GET /integrations/:id/status --------------------- */
  router.get('/:id/status', requireAbility('brand.integration.status'), async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return apiError(res, 400, 'VALIDATION_ERROR', 'channel id must be a uuid');
    try {
      const { rows } = await req.db.query(STATUS_SQL, [id, req.v1.tenantId]);
      if (!rows[0]) return apiError(res, 404, 'CHANNEL_NOT_FOUND', 'integration not found');
      return res.json({ data: { integration: toIntegration(rows[0]) } });
    } catch (err) {
      console.error('integration status failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  return router;
}

export { toIntegration };