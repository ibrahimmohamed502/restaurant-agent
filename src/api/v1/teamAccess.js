/**
 * P0.5-A — Team & Brand Access routes.
 *
 * Every handler is gated by an ability, then re-checked against the caller's
 * COMPANY. Two independent gates, because the ability map decides "may this
 * KIND of person do this" and the tenant check decides "over WHOSE data" -
 * conflating them is how a Company Admin of one company ends up editing
 * another's teams.
 *
 * Nothing here grants a role, a brand or a privilege. Brand access keeps its
 * existing, separately-ability-gated routes; this file only adds departments
 * and the read model that explains effective access.
 *
 * Responses are wrapped in `{ data: ... }` like every other /api/v1 router.
 * Returning bare `{ teams }` would make `api.get('/teams')` resolve to
 * `undefined` in the web client, because that helper reads `payload.data`.
 */

import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requireAbility } from './stage7-rbac.js';
import { can } from '../../auth/abilities.js';
import {
  listTeams, listTeamMembers, listEffectivePermissions,
  createTeam, updateTeam, addTeamMember, removeTeamMember,
  TeamError, TEAM_ERRORS
} from '../../services/teamAccess.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The complete set of team abilities, and nothing else.
 *
 * An allowlist rather than a filter over everything the caller holds: a new
 * ability added elsewhere must be named here before it can ever be reported,
 * so this endpoint cannot start answering questions it was never asked.
 */
const TEAM_ABILITIES = Object.freeze([
  'team.read', 'team.create', 'team.update', 'team.disable', 'team.assign'
]);

/**
 * Brand abilities the /teams screen needs in order to show and edit brand
 * access. A separate list rather than merging into TEAM_ABILITIES, so the
 * contract stays readable: team abilities administer departments, brand
 * abilities administer access, and the endpoint reports which of each the
 * caller holds.
 *
 * Both lists are allowlists. A new ability added anywhere else must be named
 * here before it can be reported, so this endpoint cannot start answering
 * questions it was never asked.
 */
const BRAND_ABILITIES = Object.freeze([
  'brand.read', 'brand.grant', 'brand.revoke', 'brand.grant_all', 'brand.revoke_all'
]);

const ROLE_ABILITIES_LIST = Object.freeze([
  'role.read', 'role.create', 'role.update', 'role.disable', 'role.delete'
]);

/** The same shim users.js uses, so `req.auth` means the same thing everywhere. */
function adaptAuth(req, _res, next) {
  if (req.v1) {
    req.auth = {
      tenantId: req.v1.tenantId,
      user: { id: req.v1.user?.id, email: req.v1.user?.email, name: req.v1.user?.name },
      roles: req.v1.roles || [],
      sessionId: null
    };
  }
  next();
}

export function createTeamAccessRouter() {
  const router = express.Router();

  const fail = (res, err) => {
    if (err instanceof TeamError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return res.status(500).json({ error: { code: 'TEAM_INTERNAL', message: 'team operation failed' } });
  };

  const uuidOr404 = (value, code = TEAM_ERRORS.NOT_FOUND) => {
    if (!UUID.test(String(value ?? ''))) throw new TeamError(code, 404, 'not found');
    return value;
  };

  const scope = (req, res) => {
    const tenantId = req.auth?.tenantId;
    const actorUserId = req.auth?.user?.id;
    if (!tenantId || !actorUserId) {
      res.status(403).json({ error: { code: 'TEAM_FORBIDDEN', message: 'company scope is required' } });
      return null;
    }
    return { tenantId, actorUserId };
  };

  /**
   * One PATCH, two different permissions.
   *
   * Taking a team out of service is a separate decision from renaming it, so
   * each needs its own ability and neither implies the other. An administrator
   * who may rename a team does not thereby gain the power to disable it, and a
   * person trusted only to disable one cannot rename it.
   *
   * Two bugs lived here, both invisible to a service-level test:
   *   1. the handler CALLED `requireAbility('team.disable')` and discarded the
   *      middleware it returns - `requireAbility` builds the check, it does not
   *      run it - so the gate never happened;
   *   2. `requireAbility('team.update', 'team.disable')` means EITHER, which
   *      let a disable-only holder rename and an update-only holder disable.
   * Gating per-act rather than per-route is what closes both.
   *
   * `can` is the same primitive `requireAbility` uses internally, applied to the
   * act the body actually requests. Express.json() runs ahead of this router,
   * so req.body is populated here; matching the two explicit status values
   * (rather than "any status field") means a missing or unparseable body cannot
   * be used to slip into a status change.
   */
  const patchGate = (req, res, next) => {
    const touchesStatus = req.body?.status === 'disabled' || req.body?.status === 'active';
    const needed = touchesStatus ? 'team.disable' : 'team.update';
    if (can(req.v1?.roles, needed, req.v1?.customAbilities)) return next();
    return apiError(res, 403, 'FORBIDDEN', 'insufficient permissions');
  };

  router.use(requireV1Auth, adaptAuth);

  /**
   * What THIS caller may do with teams.
   *
   * Answers the question the screen cannot work out for itself: renaming and
   * disabling are separate abilities, and without this the UI has to either show
   * a button that 403s or hide one the person is entitled to use.
   *
   * Deliberately narrow:
   *  - it returns the ABILITIES, not role names, so nothing about the account's
   *    composition travels;
   *  - it is derived entirely from the caller's own session - no query runs, so
   *    there is no path by which another company's or brand's grants could be
   *    read through it;
   *  - it enumerates a fixed list of `team.*` abilities and ignores anything
   *    else, so a platform-level ability held by the same account is never
   *    echoed back here;
   *  - it requires a COMPANY scope but NOT any team ability, because someone who
   *    holds none still deserves an accurate answer and a clear screen rather
   *    than a bare 403.
   *
   * This is presentation only. Every route below still enforces the same `can()`
   * decision on the server; hiding a button is a courtesy, not a control.
   */
  router.get('/capabilities', async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    const roles = req.v1?.roles ?? [];
    const custom = req.v1?.customAbilities ?? [];
    // The screen needs BOTH sets to decide which buttons to render. Reporting
    // them together is safe: the caller only learns about its own abilities, and
    // only from the fixed allowlists - never a free-form enumeration.
    const abilities = [...TEAM_ABILITIES, ...BRAND_ABILITIES, ...ROLE_ABILITIES_LIST]
      .filter((a) => can(roles, a, custom));
    return res.json({ data: { abilities } });
  });

  // ---- read ---------------------------------------------------------------

  router.get('/', requireAbility('team.read'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    const { tenantId } = ctx;
    try {
      const teams = await listTeams({ tenantId, db: req.db });
      return res.json({ data: { teams } });
    } catch (e) { return fail(res, e); }
  });

  /**
   * The read the admin screen is built around. `brandId` is OPTIONAL and only
   * narrows the eligibility calculation - it never filters WHICH PEOPLE are
   * returned, so this endpoint cannot be used to enumerate who exists.
   */
  router.get('/permissions', requireAbility('team.read'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    const { tenantId } = ctx;
    const brandId = req.query.brandId && UUID.test(String(req.query.brandId)) ? String(req.query.brandId) : null;
    try {
      const people = await listEffectivePermissions({ tenantId, brandId, db: req.db });
      const warnings = people.filter((p) => p.warnings.length > 0);
      return res.json({ data: { people, warning_count: warnings.length } });
    } catch (e) { return fail(res, e); }
  });

  router.get('/:teamId/members', requireAbility('team.read'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    const { tenantId } = ctx;
    try {
      uuidOr404(req.params.teamId);
      const members = await listTeamMembers({ tenantId, teamId: req.params.teamId, db: req.db });
      return res.json({ data: { members } });
    } catch (e) { return fail(res, e); }
  });

  // ---- write --------------------------------------------------------------

  router.post('/', requireAbility('team.create'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    const { tenantId, actorUserId } = ctx;
    try {
      const team = await createTeam({
        tenantId, actorUserId,
        name: req.body?.name,
        brandId: req.body?.brandId ?? null,
        db: req.db
      });
      return res.status(201).json({ data: { team } });
    } catch (e) { return fail(res, e); }
  });

  // Gated per-act by patchGate, not per-route: one PATCH covers renaming AND
  // enabling/disabling, and those are two different permissions.
  router.patch('/:teamId', patchGate, async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    const { tenantId, actorUserId } = ctx;
    try {
      uuidOr404(req.params.teamId);
      const team = await updateTeam({
        tenantId, actorUserId, teamId: req.params.teamId,
        name: req.body?.name, status: req.body?.status, brandId: req.body?.brandId,
        db: req.db
      });
      return res.json({ data: { team } });
    } catch (e) { return fail(res, e); }
  });

  router.post('/:teamId/members', requireAbility('team.assign'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    const { tenantId, actorUserId } = ctx;
    try {
      uuidOr404(req.params.teamId);
      uuidOr404(req.body?.userId, TEAM_ERRORS.USER_NOT_FOUND);
      const member = await addTeamMember({
        tenantId, actorUserId,
        teamId: req.params.teamId,
        userId: req.body.userId,
        roleInTeam: typeof req.body?.roleInTeam === 'string' ? req.body.roleInTeam : 'agent',
        db: req.db
      });
      return res.status(201).json({ data: { member } });
    } catch (e) { return fail(res, e); }
  });

  router.delete('/:teamId/members/:userId', requireAbility('team.assign'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    const { tenantId, actorUserId } = ctx;
    try {
      uuidOr404(req.params.teamId);
      uuidOr404(req.params.userId, TEAM_ERRORS.USER_NOT_FOUND);
      const member = await removeTeamMember({
        tenantId, actorUserId, teamId: req.params.teamId, userId: req.params.userId, db: req.db
      });
      return res.json({ data: { member } });
    } catch (e) { return fail(res, e); }
  });

  return router;
}