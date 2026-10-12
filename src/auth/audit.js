import { pool, enabled } from '../db/pg.js';

/** Fire-and-forget audit record. Never throws — logging must not break flows. */
export function audit({ tenantId = null, actorUserId = null, action, objectType = null, objectId = null, ip = null, metadata = {} }) {
  if (!enabled) return;
  pool
    .query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, ip, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, actorUserId, action, objectType, objectId, ip, JSON.stringify(metadata)]
    )
    .catch((e) => console.error('audit write failed:', e.message));
}
