# P0.5-B — API contract the team UI will build against

Source of truth: `src/api/v1/teamAccess.js`, mounted at `/api/v1/teams`.
Base URL from the browser: `/api/v1` (same origin, proxied) or `NEXT_PUBLIC_API_URL`.

Auth: session cookie `lwc_session`. **Every mutating call needs the double-submit
CSRF pair** — cookie `csrf_token` echoed in header `x-csrf-token`. Mutations are
`POST`, `PATCH`, `DELETE`. `GET` needs no token.

Errors are always `{ "error": { "code": "...", "message": "..." } }`.
Success is always `{ "data": ... }` — the same envelope every other `/api/v1`
router uses. `apps/web/lib/api.ts` reads `payload.data`, so an unwrapped body
resolves to `undefined` on the client. Use `api.get()` / `api.post()` normally.
The `code` is stable and is what the UI should branch on. **The `message` is
English-only and deliberately non-specific** — it must not be used to build
"why did this fail" copy for an administrator, because several distinct
conditions share one message on purpose so the endpoint cannot be used to
enumerate what exists.

## The seven endpoints

| Method | Path | Ability | Purpose |
|---|---|---|---|
| GET | `/teams` | `team.read` | List this company's teams |
| GET | `/teams/permissions?brandId=` | `team.read` | Who can take work, and why not |
| GET | `/teams/:teamId/members` | `team.read` | Roster of one team |
| POST | `/teams` | `team.create` | Create a team |
| PATCH | `/teams/:teamId` | `team.update` | Rename / re-brand a team |
| PATCH | `/teams/:teamId` `{status}` | `team.disable` | Enable / disable — **separate ability** |
| POST | `/teams/:teamId/members` | `team.assign` | Add someone |
| DELETE | `/teams/:teamId/members/:userId` | `team.assign` | Remove someone |

**Two gates on one PATCH.** `{status}` needs `team.disable` on top of
`team.update`. Holding only one does not grant the other — in either direction.

### GET /teams
```json
{ "data": { "teams": [ { "id": "uuid", "name": "Marketing", "status": "active", "brand_id": null } ] } }
```
`status` is `active` | `disabled`. `brand_id` is null when the team is not
pinned to one brand.

### GET /teams/permissions — the screen the whole feature exists for
Query `brandId` is **optional**. It narrows only the eligibility calculation; it
never changes *who* is returned, so this endpoint cannot be used to probe for
the existence of people.

```json
{
  "data": {
    "people": [{
      "id": "uuid",
      "name": "...", "email": "...", "status": "active",
      "roles": ["Agent"],
      "teams": [{ "id": "uuid", "name": "Marketing", "role_in_team": "agent" }],
      "all_brands": false,
      "brand_ids": ["uuid"],
      "has_handling_role": true,
      "assignment_eligible": false,
      "warnings": ["NO_BRAND_ACCESS"]
    }],
    "warning_count": 3
  }
}
```

**Invariant the UI can rely on and must not re-derive:**
`assignment_eligible === (warnings.length === 0)`.
Warnings list **every** outstanding reason, not the first one. An administrator
should see the whole to-do list at once.

`warnings` values: `NO_HANDLING_ROLE` · `NO_BRAND_ACCESS` · `NO_TEAM` · `INACTIVE`

Suggested copy (ar / en) — this is the UI's job, the server will not do it:
- `NO_HANDLING_ROLE` — no role that can handle conversations
- `NO_BRAND_ACCESS` — cannot reach the selected brand
- `NO_TEAM` — not in any department
- `INACTIVE` — account is not active

### POST /teams
Body `{ "name": "Marketing", "brandId": null }` → 201 `{ "data": { "team": {...} } }`.
Names are trimmed, internal whitespace collapsed, original casing preserved.
**Case-insensitively unique within the company** — `marketing` is refused with
409 when `Marketing` exists, and the stored name keeps its original casing. The
same name in a *different* company is fine.

### POST /teams/:teamId/members
Body `{ "userId": "uuid", "roleInTeam": "agent" }` → 201 `{ "data": { "member": {...} } }`.
`roleInTeam` is free text, defaults to `"agent"`. It is **display metadata for
load-balancing tie-breaks only** — it grants nothing. A team may not be
disabled.

### DELETE /teams/:teamId/members/:userId
Returns `{ "data": { "member": {...} } }`. This is a **soft revoke**: the row is preserved
with `revoked_at` set, so re-adding the same person revives the original row
and its `role_in_team`. Nothing is deleted, so team history stays intact.

### Error codes the UI must branch on

| Code | HTTP | Meaning |
|---|---|---|
| `TEAM_NAME_TAKEN` | 409 | A team with that name exists in this company (case-insensitive) |
| `TEAM_NAME_INVALID` | 422 | Blank, too long, or contains control/markup characters |
| `TEAM_NOT_FOUND` | 404 | No such team **in this company** |
| `TEAM_MEMBER_NOT_FOUND` | 404 | No such user **in this company** |
| `TEAM_BRAND_NOT_FOUND` | 404 | Brand belongs to another company |
| `TEAM_ALREADY_MEMBER` | 409 | Already on the roster |
| `TEAM_NOT_A_MEMBER` | 409 / 422 | Not on the roster |
| `TEAM_SELF_ESCALATION` | 422 | An admin cannot remove themselves |
| `TEAM_FORBIDDEN` | 403 | No company scope on the session |
| `FORBIDDEN` | 403 | Lacks the ability for this specific act |
| `CSRF_INVALID` | 403 | Missing or mismatched CSRF pair |
| `TEAM_INTERNAL` | 500 | Unexpected |

403 from `FORBIDDEN` and 403 from `TEAM_FORBIDDEN` mean different things —
ability vs. missing tenant context. The UI should not collapse them.

## What this contract deliberately does NOT do

- **It never grants a role, a brand or a privilege.** Brand access stays on
  `/brand-grants` behind `brand.grant`/`brand.revoke`; roles stay on `/users`
  behind `user.update`. The teams UI may *link* to those screens; it must not
  re-implement them, or we get two places that disagree about who can see what.
- **It exposes no "assign this conversation" action.** The read model explains
  eligibility. Actually assigning stays on the conversation endpoints, under
  their own abilities.
- **It cannot enumerate across companies.** Every route re-checks the caller's
  tenant after the ability gate.

## Known gap to design around

Production has **8 teams and 0 memberships**. On first load the permissions
screen will show every employee as ineligible with `NO_TEAM`. That is correct
and is the honest starting state — the UI should present it as "who needs
setting up", not as an error state.
