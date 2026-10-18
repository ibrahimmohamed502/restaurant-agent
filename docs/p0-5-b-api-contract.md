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
| GET | `/teams/capabilities` | none (needs a company) | What THIS caller may do |
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

### GET /teams/capabilities
```json
{ "data": { "abilities": ["team.read", "team.create", "team.update", "team.disable", "team.assign"] } }
```

The abilities the **calling session** holds, and nothing else. The screen uses
it to avoid offering a button that would only be refused.

Deliberately narrow, and worth preserving in any future change:
- it returns **abilities, not role names** — nothing about the account's
  composition travels;
- it is computed from the session alone; **no query runs**, so there is no path
  by which another company's or brand's grants could be read through it;
- it iterates a **fixed allowlist** of `team.*`, so a platform-level ability
  held by the same account is never echoed back;
- it requires a **company scope but no team ability** — someone who holds none
  still gets an accurate empty list, which is more useful to a screen than a
  bare 403.

**This is presentation only.** Every other route re-derives the same decision
with the same `can()`; hiding a button is a courtesy, never a control.

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

**Two different questions, answered by two different fields. Do not collapse
them.**

| Field | Question |
|---|---|
| `assignment_eligible` | May this person be assigned a conversation **by hand**? |
| `warnings` | What is outstanding — for hand assignment **and** for automatic routing? |

`assignment_eligible` is `active && has_handling_role && brand_reachable`. It
deliberately **does not require a department**, because assigning by hand never
has. `NO_TEAM` is still raised, because automatic routing targets a team and
without one it can never select that person.

So an employee can be `assignment_eligible: true` **and** carry
`warnings: ["NO_TEAM"]` at the same time. Both are correct; they answer
different questions. A UI that renders a green "ready" badge beside "not in any
department" is telling the administrator the opposite of the truth, and that is
exactly what the first version of `/teams` did.

Three states the screen must show:

| State | Condition | Meaning |
|---|---|---|
| Ready | `assignment_eligible` and no warnings | Assignable by hand **and** reachable by routing |
| Manual only | `assignment_eligible` and `NO_TEAM` | Assignable by hand; routing can never select them |
| Not ready | not `assignment_eligible` | Cannot be assigned at all yet |

The only relationship that does hold is: **nobody is ever `not assignment_eligible`
with an empty warning list**, and an `assignment_eligible` person may carry
`NO_TEAM` and nothing else. Both are asserted against real server output in
`scripts/test-team-access-pg.mjs`.

**"Ready" is not a promise of an automatic conversation.** Eligibility is
necessary, not sufficient — load balancing, the conversation's own brand scope,
and queue order still apply.

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
| `TEAM_NOT_A_MEMBER` | **404** | Not on the roster — **identical to a user who does not exist**, so membership cannot be probed |
| `TEAM_SELF_ESCALATION` | **409** | An admin cannot remove themselves |
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
