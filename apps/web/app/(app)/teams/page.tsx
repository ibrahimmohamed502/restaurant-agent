'use client';

/**
 * P0.5-B — Departments and eligibility.
 *
 * This screen shows what an administrator needs in order to make automatic
 * routing possible, and nothing else:
 *
 *   - departments inside this company, and who is in each one;
 *   - for every employee, whether they could actually be handed a conversation,
 *     and precisely what is missing when they could not.
 *
 * It deliberately does NOT manage accounts, roles or brand access. Those live
 * behind their own abilities on /team and /brand-grants. Two screens that both
 * "manage access" would eventually disagree about who can see what, and the
 * disagreement would be invisible until someone was denied something they were
 * entitled to.
 *
 * The server decides eligibility. This screen never recomputes it - it renders
 * `assignment_eligible` and lists `warnings`, and treats
 * `assignment_eligible === (warnings.length === 0)` as given.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  Plus, Trash2, Loader2, Edit2, Users, AlertTriangle, CheckCircle2, Ban, Building2
} from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { BackButton } from '@/components/shell/back-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHead } from '@/components/ui/table';
import { ErrorState, EmptyState, PageLoading } from '@/components/ui/states';
import {
  teamsApi, describeError, eligibilityState, inAnyDepartment,
  type Team, type EffectivePermission, type BrandOption, type EligibilityWarning
} from '@/lib/teams-api';

type Tab = 'departments' | 'eligibility';
type LoadState = 'loading' | 'ready' | 'unauthorized' | 'forbidden' | 'noScope' | 'error';
type TeamAbility = 'team.read' | 'team.create' | 'team.update' | 'team.disable' | 'team.assign';

export default function TeamsPage() {
  const t = useTranslations('teams');
  const tc = useTranslations('common');
  const ts = useTranslations('states');

  const [tab, setTab] = React.useState<Tab>('departments');

  const [teams, setTeams] = React.useState<Team[] | null>(null);
  const [people, setPeople] = React.useState<EffectivePermission[] | null>(null);
  const [brands, setBrands] = React.useState<BrandOption[]>([]);
  const [brandFilter, setBrandFilter] = React.useState<string>('');
  /**
   * What this person may actually do. Empty until the answer arrives, and the
   * write controls stay disabled until then - flashing an enabled button that
   * the server will refuse is worse than a brief disabled state.
   */
  const [can, setCan] = React.useState<TeamAbility[]>([]);

  const [state, setState] = React.useState<LoadState>('loading');
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // dialogs
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [newBrand, setNewBrand] = React.useState('');
  const [memberFor, setMemberFor] = React.useState<Team | null>(null);
  const [candidate, setCandidate] = React.useState('');
  const [roleInTeam, setRoleInTeam] = React.useState('agent');
  const [renaming, setRenaming] = React.useState<Team | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [removing, setRemoving] = React.useState<{ team: Team; person: EffectivePermission } | null>(null);

  const loadTeams = React.useCallback(async () => {
    try {
      setTeams(await teamsApi.list());
      setState('ready');
    } catch (e) {
      const d = describeError(e);
      setState(d.kind === 'unauthorized' ? 'unauthorized' : d.noScope ? 'noScope'
        : d.kind === 'forbidden' ? 'forbidden' : 'error');
    }
  }, []);

  const loadPeople = React.useCallback(async (bid: string) => {
    try {
      setPeople((await teamsApi.permissions(bid || null)).people);
      setState('ready');
    } catch (e) {
      const d = describeError(e);
      setState(d.kind === 'unauthorized' ? 'unauthorized' : d.noScope ? 'noScope'
        : d.kind === 'forbidden' ? 'forbidden' : 'error');
    }
  }, []);

  React.useEffect(() => { void loadTeams(); }, [loadTeams]);
  React.useEffect(() => { void loadPeople(brandFilter); }, [loadPeople, brandFilter]);
  React.useEffect(() => {
    teamsApi.brands().then(setBrands).catch(() => setBrands([]));
  }, []);
  React.useEffect(() => {
    // A failure here must NOT flip the page into its error state: the list may
    // still be perfectly readable, we would simply have to show every control
    // and let the server refuse. Losing the whole screen over a missing hint
    // would be the wrong trade.
    teamsApi.capabilities().then(setCan).catch(() => setCan([]));
  }, []);

  const allowed = React.useCallback(
    (a: TeamAbility) => can.includes(a),
    [can]
  );

  /**
   * Who is in a team, derived from the permissions read model.
   *
   * That endpoint already lists every employee together with the departments
   * they belong to, so a separate roster request per team would be N extra
   * round trips to learn something already in hand - and two sources that could
   * disagree. One request, one truth.
   */
  const membersOf = React.useCallback(
    (teamId: string) => (people ?? []).filter((p) => p.teams.some((x) => x.id === teamId)),
    [people]
  );

  /** Runs a mutation, surfacing the server's refusal instead of hiding it. */
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      const d = describeError(e);
      setActionError(
        d.code === 'TEAM_NAME_TAKEN' ? t('errors.nameTaken')
          : d.code === 'TEAM_NAME_INVALID' ? t('errors.nameInvalid')
            : d.code === 'TEAM_ALREADY_MEMBER' ? t('errors.alreadyMember')
              : d.code === 'TEAM_SELF_ESCALATION' ? t('errors.selfRemoval')
                : d.kind === 'forbidden' ? t('errors.forbiddenDescription')
                  : t('errors.generic')
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') return <PageLoading />;
  if (state === 'unauthorized') {
    return <ErrorState title={t('errors.unauthorizedTitle')} description={t('errors.unauthorizedDescription')} />;
  }
  if (state === 'forbidden') {
    return <ErrorState title={t('errors.forbiddenTitle')} description={t('errors.forbiddenDescription')} />;
  }
  if (state === 'noScope') {
    return <ErrorState title={t('errors.noScopeTitle')} description={t('errors.noScopeDescription')} />;
  }
  if (state === 'error') {
    return <ErrorState title={t('errors.title')} description={t('errors.description')}
      actionLabel={tc('retry')} onAction={() => void loadTeams()} />;
  }

  const emptyTeams = teams?.length === 0;
  const eligible = people?.filter((p) => p.assignment_eligible).length ?? 0;
  const inDept = inAnyDepartment(people ?? []);
  const totalPeople = people?.length ?? 0;
  const noPeopleYet = people === null;

  return (
    <div className="space-y-6">
      <BackButton />
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          tab === 'departments' && allowed('team.create') ? (
            <Button onClick={() => { setName(''); setNewBrand(''); setCreateOpen(true); }} disabled={busy}>
              <Plus className="size-4" /> {t('create.submit')}
            </Button>
          ) : undefined
        }
      />

      <div className="flex gap-1 border-b" role="tablist">
        {(['departments', 'eligibility'] as Tab[]).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 ${
              tab === k ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'
            }`}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>

      {actionError && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>{actionError}</span>
        </div>
      )}

      {tab === 'departments' && (
        <>
          {emptyTeams ? (
            <EmptyState title={t('empty.title')} description={t('empty.description')} />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {teams?.map((team) => {
                  const members = membersOf(team.id);
                  const isEmpty = members.length === 0;
                  return (
                    <Card key={team.id}>
                      <CardHeader className="flex-row items-start justify-between space-y-0">
                        <div className="min-w-0">
                          <CardTitle className="truncate">{team.name}</CardTitle>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {people ? `${members.length} ${t('team.membership')}` : tc('loading')}
                          </p>
                        </div>
                        <Badge variant={team.status === 'active' ? 'success' : 'neutral'}>
                          {team.status === 'active' ? t('status.active') : t('status.disabled')}
                        </Badge>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {isEmpty && (
                          <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
                            {t('team.emptyRoster')}
                          </p>
                        )}
                        {/* The roster. Members are removed from here so the
                            person is always visible before the confirmation -
                            never a hidden id. */}
                        {members.length > 0 && (
                          <ul className="space-y-1.5">
                            {members.map((m) => (
                              <li key={m.id}
                                className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5">
                                <span className="min-w-0 truncate text-sm">{m.name ?? m.email}</span>
                                <Button size="sm" variant="ghost"
                                  aria-label={t('team.removeMember')}
                                  onClick={() => setRemoving({ team, person: m })}
                                  disabled={busy || !allowed('team.assign')}>
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary"
                            onClick={() => { setRenaming(team); setRenameValue(team.name); }}
                            disabled={busy || !allowed('team.update')}>
                            <Edit2 className="size-3.5" /> {tc('edit')}
                          </Button>
                          <Button size="sm" variant="secondary"
                            onClick={() => { setMemberFor(team); setCandidate(''); }}
                            disabled={busy || team.status !== 'active' || !allowed('team.assign')}>
                            <Users className="size-3.5" /> {t('team.addMember')}
                          </Button>
                          {/* Separate abilities: someone who may rename a team
                              does not thereby gain the power to disable it. */}
                          <Button size="sm" variant="ghost"
                            onClick={() => void run(async () => {
                              await teamsApi.setStatus(team.id, team.status === 'active' ? 'disabled' : 'active');
                              await loadTeams();
                            })}
                            disabled={busy || !allowed('team.disable')}>
                            {team.status === 'active' ? t('status.disable') : t('status.enable')}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {tab === 'eligibility' && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <Label htmlFor="brand-filter">{t('eligibility.filterBrand')}</Label>
                <select id="brand-filter" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="">{t('eligibility.filterAny')}</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              {/* Two numbers, deliberately not one. "Eligible" is about hand
                  assignment; "in a department" is about who routing can ever
                  select. Collapsing them would imply that being in a
                  department guarantees an automatic conversation - it does not.
                  Eligibility is necessary, not sufficient. */}
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={eligible > 0 ? 'success' : 'destructive'}
                  title={t('eligibility.hint.manualSummary')}>
                  {t('eligibility.summaryManual', { eligible, total: totalPeople })}
                </Badge>
                <Badge variant={inDept > 0 ? 'info' : 'warning'}
                  title={t('eligibility.hint.routingSummary')}>
                  {t('eligibility.summaryRouting', { inDept, total: totalPeople })}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">{t('eligibility.summaryNote')}</p>

          {totalPeople === 0 ? (
            <EmptyState title={t('eligibility.empty.title')} description={t('eligibility.empty.description')} />
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('eligibility.colPerson')}</TableHead>
                      <TableHead>{t('eligibility.colRoles')}</TableHead>
                      <TableHead>{t('eligibility.colDepartments')}</TableHead>
                      <TableHead>{t('eligibility.colBrandAccess')}</TableHead>
                      <TableHead>{t('eligibility.colStatus')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {people?.map((p) => <PersonRow key={p.id} person={p} />)}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ---------------------------------------------------------- dialogs */}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('create.title')}</DialogTitle>
            <DialogDescription>{t('create.nameHint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="team-name">{t('create.name')}</Label>
              <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="team-brand">{t('create.brand')}</Label>
              <select id="team-brand" value={newBrand} onChange={(e) => setNewBrand(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                <option value="">{t('create.brandAny')}</option>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">{t('create.brandHint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>{tc('cancel')}</Button>
            <Button disabled={busy || !name.trim()} onClick={() => void run(async () => {
              await teamsApi.create(name, newBrand || null);
              setCreateOpen(false);
              await loadTeams();
            })}>
              {busy && <Loader2 className="size-4 animate-spin" />} {t('create.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('rename.title')}</DialogTitle>
            <DialogDescription>{t('create.nameHint')}</DialogDescription>
          </DialogHeader>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRenaming(null)}>{tc('cancel')}</Button>
            <Button disabled={busy || !renameValue.trim()} onClick={() => void run(async () => {
              if (renaming) await teamsApi.rename(renaming.id, renameValue);
              setRenaming(null);
              await loadTeams();
            })}>{tc('save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!memberFor} onOpenChange={(o) => !o && setMemberFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('team.addMember')}</DialogTitle>
            <DialogDescription>{t('team.roleInTeamHint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="member-candidate">{t('team.choosePerson')}</Label>
              <select id="member-candidate" value={candidate} onChange={(e) => setCandidate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                <option value="">—</option>
                {(people ?? [])
                  .filter((p) => !p.teams.some((x) => x.id === memberFor?.id))
                  .map((p) => <option key={p.id} value={p.id}>{p.name ?? p.email}</option>)}
              </select>
              {memberFor && membersOf(memberFor.id).length === 0 && (
                <p className="text-xs text-muted-foreground">{t('team.emptyRoster')}</p>
              )}
              {memberFor && (people ?? []).every((p) => p.teams.some((x) => x.id === memberFor.id)) && (
                <p className="text-xs text-muted-foreground">{t('team.noCandidates')}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="role-in-team">{t('team.roleInTeam')}</Label>
              <Input id="role-in-team" value={roleInTeam} onChange={(e) => setRoleInTeam(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t('team.roleInTeamHint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setMemberFor(null)}>{tc('cancel')}</Button>
            <Button disabled={busy || !candidate} onClick={() => void run(async () => {
              if (memberFor) {
                await teamsApi.addMember(memberFor.id, candidate, roleInTeam);
                await loadPeople(brandFilter);
              }
              setMemberFor(null);
            })}>{tc('confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Removal is confirmed, names and all. A destructive action reached by a
          hidden id is how the wrong person gets removed. */}
      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('team.confirmRemove', {
                name: removing?.person.name ?? removing?.person.email ?? '',
                team: removing?.team.name ?? ''
              })}
            </DialogTitle>
            <DialogDescription>{t('team.confirmRemoveBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRemoving(null)}>{tc('cancel')}</Button>
            <Button variant="destructive" disabled={busy}
              onClick={() => void run(async () => {
                if (removing) {
                  await teamsApi.removeMember(removing.team.id, removing.person.id);
                  // Membership and eligibility are the same decision, so both
                  // are refreshed: removing somebody who was the last eligible
                  // member must visibly change their readiness.
                  await loadPeople(brandFilter);
                }
                setRemoving(null);
              })}>
              {busy && <Loader2 className="size-4 animate-spin" />} {t('team.removeMember')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One employee, in one of three states.
 *
 * `assignment_eligible` and the warning list answer different questions - can
 * they be assigned BY HAND, and can ROUTING ever reach them - so the screen
 * says both rather than collapsing them into one verdict.
 *
 * "Ready" means the displayed conditions are met. It does not promise an
 * automatic conversation: eligibility is necessary, not sufficient.
 */
function PersonRow({ person }: { person: EffectivePermission }) {
  const t = useTranslations('teams');
  const state = eligibilityState(person);

  const badge =
    state === 'ready'
      ? { variant: 'success' as const, icon: <CheckCircle2 className="size-3.5" />, label: t('eligibility.ready') }
      : state === 'manual_only'
        ? { variant: 'warning' as const, icon: <AlertTriangle className="size-3.5" />, label: t('eligibility.manualOnly') }
        : { variant: 'destructive' as const, icon: <Ban className="size-3.5" />, label: t('eligibility.notReady') };

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{person.name ?? person.email}</div>
        <div className="text-xs text-muted-foreground">{person.email}</div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {person.roles.length ? person.roles.join(', ') : '—'}
      </TableCell>
      <TableCell className="text-sm">
        {person.teams.length ? person.teams.map((x) => x.name).join(', ') : '—'}
      </TableCell>
      <TableCell className="text-sm">
        {person.all_brands ? t('eligibility.allBrands')
          : person.brand_ids.length ? t('eligibility.brandCount', { count: person.brand_ids.length })
            : t('eligibility.noBrands')}
      </TableCell>
      <TableCell>
        <Badge variant={badge.variant} title={t(`eligibility.hint.${state}`)}>
          {badge.icon} {badge.label}
        </Badge>
        {person.warnings.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {person.warnings.map((w: EligibilityWarning) => (
              <li key={w} className="text-xs text-muted-foreground">• {t(`eligibility.warnings.${w}`)}</li>
            ))}
          </ul>
        )}
      </TableCell>
    </TableRow>
  );
}
