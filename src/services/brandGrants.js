/**
 * R1 — per-user brand grants: service layer.
 *
 * Every mutation is a single transactional statement guarded by the SAME
 * condition the read path uses, so authorization is enforced by the database in
 * the same statement that writes. A grant can never be created across
 * companies: the composite foreign keys in migration 015 reject it even if this
 * module is bypassed.
 *
 * Fail-closed everywhere: a missing grant means zero brands, never tenant-wide.
 */
import { pool, enabled } from '../db/pg.js';
import { audit } from '../auth/audit.js';
import { isUuid } from '../api/v1/brandAccess.js';

class GrantError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Resolve the caller's own brand scope; used to gate who may delegate. */
export async function callerBrandScope({ db = pool, tenantId, userId }) {
  const { rows } = await db.query(
    `SELECT
        EXISTS (SELECT 1 FROM user_brand_scope_all
                 WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL) AS all_brands,
        COALESCE(ARRAY(
          SELECT brand_id FROM user_brand_grants
           WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL
        ), '{}'::uuid[]) AS brand_ids`,
    [userId, tenantId]
  );
  // Coerced explicitly: the flag is an authorization decision, so it must not
  // depend on how a driver surfaces EXISTS (boolean vs 0/1).
  const r = rows[0] || { all_brands: false, brand_ids: [] };
  return {
    allBrands: r.all_brands === true || r.all_brands === 1 || r.all_brands === 't',
    brandIds: Array.isArray(r.brand_ids) ? r.brand_ids : []
  };
}

function assertCanDelegate({ tenantId, userId, scope, targetTenantId, brandId }) {
  if (targetTenantId !== tenantId) {
    throw new GrantError('CROSS_TENANT_TARGET', 'target is not in your company', 403);
  }
  if (scope.allBrands) return;
  if (brandId && !scope.brandIds.includes(brandId)) {
    throw new GrantError('BRAND_OUTSIDE_SCOPE', 'you can only delegate brands you can access', 403);
  }
}

/**
 * Grant one brand to one user.
 *
 * Idempotent while the grant is live. After a revoke, re-granting inserts a NEW
 * row and leaves the revoked one in place, so grant history is a complete
 * chronological trail (see the partial unique index in migration 015).
 */
export async function grantBrand({ tenantId, actorUserId, targetUserId, brandId, reason = null, db = pool }) {
  if (!enabled) throw new GrantError('DB_DISABLED', 'database is not configured', 503);
  if (!isUuid(targetUserId) || !isUuid(brandId)) {
    throw new GrantError('INVALID_ID', 'targetUserId and brandId must be uuids', 400);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // The target must exist in THIS company. The composite FK below also
    // enforces it, but checking here yields a clean 404 instead of a 23503.
    const { rows: tgt } = await client.query(
      'SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [targetUserId, tenantId]
    );
    if (!tgt.length) throw new GrantError('TARGET_NOT_FOUND', 'target user not found in your company', 404);

    const { rows: br } = await client.query(
      'SELECT id FROM brands WHERE id = $1 AND tenant_id = $2', [brandId, tenantId]
    );
    if (!br.length) throw new GrantError('BRAND_NOT_FOUND', 'brand not found in your company', 404);

    const scope = await callerBrandScope({ db: client, tenantId, userId: actorUserId });
    assertCanDelegate({ tenantId, userId: actorUserId, scope, targetTenantId: tenantId, brandId });

    const { rows } = await client.query(
      `INSERT INTO user_brand_grants (tenant_id, user_id, brand_id, granted_by, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, brand_id) WHERE revoked_at IS NULL
       DO UPDATE SET revoked_at = NULL, revoked_by = NULL,
                     granted_by = EXCLUDED.granted_by, granted_at = now(),
                     reason = EXCLUDED.reason
       RETURNING id, granted_at`,
      [tenantId, targetUserId, brandId, actorUserId, reason]
    );

    await client.query('COMMIT');
    audit({
      tenantId,
      actorUserId,
      action: 'brand.grant',
      objectType: 'user_brand_grant',
      objectId: rows[0].id,
      metadata: { targetUserId, brandId, reason, outcome: 'granted' }
    });
    return { granted: true, id: rows[0].id, grantedAt: rows[0].granted_at };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Revoke preserves the row: it is stamped, never deleted, so history survives. */
export async function revokeBrand({ tenantId, actorUserId, targetUserId, brandId, db = pool }) {
  if (!enabled) throw new GrantError('DB_DISABLED', 'database is not configured', 503);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: br } = await client.query(
      'SELECT id FROM brands WHERE id = $1 AND tenant_id = $2', [brandId, tenantId]
    );
    if (!br.length) throw new GrantError('BRAND_NOT_FOUND', 'brand not found in your company', 404);

    const scope = await callerBrandScope({ db: client, tenantId, userId: actorUserId });
    assertCanDelegate({ tenantId, userId: actorUserId, scope, targetTenantId: tenantId, brandId });

    const { rows } = await client.query(
      `UPDATE user_brand_grants
          SET revoked_at = now(), revoked_by = $3
        WHERE tenant_id = $1 AND user_id = $2 AND brand_id = $4 AND revoked_at IS NULL
        RETURNING id`,
      [tenantId, targetUserId, actorUserId, brandId]
    );
    if (!rows.length) {
      throw new GrantError('GRANT_NOT_FOUND', 'no live grant for that user and brand', 404);
    }

    await client.query('COMMIT');
    audit({
      tenantId,
      actorUserId,
      action: 'brand.revoke',
      objectType: 'user_brand_grant',
      objectId: rows[0].id,
      metadata: { targetUserId, brandId, outcome: 'revoked' }
    });
    return { revoked: true, id: rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Explicit, audited delegation of every brand inside ONE company. Never platform-wide. */
export async function grantAllBrandsInCompany({ tenantId, actorUserId, targetUserId, reason = null, db = pool }) {
  if (!enabled) throw new GrantError('DB_DISABLED', 'database is not configured', 503);
  if (!isUuid(targetUserId)) throw new GrantError('INVALID_ID', 'targetUserId must be a uuid', 400);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: tgt } = await client.query(
      'SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [targetUserId, tenantId]
    );
    if (!tgt.length) throw new GrantError('TARGET_NOT_FOUND', 'target user not found in your company', 404);

    // Delegating company-wide scope requires already holding it yourself.
    const scope = await callerBrandScope({ db: client, tenantId, userId: actorUserId });
    if (!scope.allBrands) {
      throw new GrantError('DELEGATION_NOT_AUTHORIZED', 'you cannot delegate company-wide brand access', 403);
    }

    const { rows } = await client.query(
      `INSERT INTO user_brand_scope_all (tenant_id, user_id, granted_by, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, tenant_id) WHERE revoked_at IS NULL
       DO UPDATE SET revoked_at = NULL, revoked_by = NULL,
                     granted_by = EXCLUDED.granted_by, granted_at = now(),
                     reason = EXCLUDED.reason
       RETURNING id`,
      [tenantId, targetUserId, actorUserId, reason]
    );

    await client.query('COMMIT');
    audit({
      tenantId,
      actorUserId,
      action: 'brand.grant_all',
      objectType: 'user_brand_scope_all',
      objectId: rows[0].id,
      metadata: { targetUserId, outcome: 'granted', scope: 'company_wide' }
    });
    return { granted: true, id: rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeAllBrandsInCompany({ tenantId, actorUserId, targetUserId, db = pool }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const scope = await callerBrandScope({ db: client, tenantId, userId: actorUserId });
    if (!scope.allBrands) {
      throw new GrantError('DELEGATION_NOT_AUTHORIZED', 'you cannot revoke company-wide brand access', 403);
    }
    const { rows } = await client.query(
      `UPDATE user_brand_scope_all SET revoked_at = now(), revoked_by = $3
        WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [tenantId, targetUserId, actorUserId]
    );
    if (!rows.length) throw new GrantError('GRANT_NOT_FOUND', 'no live company-wide delegation', 404);
    await client.query('COMMIT');
    audit({
      tenantId, actorUserId, action: 'brand.revoke_all',
      objectType: 'user_brand_scope_all', objectId: rows[0].id,
      metadata: { targetUserId, outcome: 'revoked', scope: 'company_wide' }
    });
    return { revoked: true, id: rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Full history for a user, including revoked rows. */
export async function grantHistory({ tenantId, targetUserId, db = pool }) {
  const { rows } = await db.query(
    `SELECT g.id, g.brand_id, g.granted_at, g.revoked_at, g.reason,
            b.name AS brand_name
       FROM user_brand_grants g
       JOIN brands b ON b.id = g.brand_id
      WHERE g.tenant_id = $1 AND g.user_id = $2
      ORDER BY g.granted_at DESC`,
    [tenantId, targetUserId]
  );
  return rows.map((r) => ({
    id: r.id,
    brandId: r.brand_id,
    brandName: r.brand_name,
    grantedAt: r.granted_at,
    revokedAt: r.revoked_at,
    live: r.revoked_at === null,
    reason: r.reason
  }));
}

export { GrantError };