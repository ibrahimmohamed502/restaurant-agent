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
  teamsApi, describeError,
  type Team, type TeamMember, type EffectivePermission, type BrandOption, type EligibilityWarning
} from '@/lib/teams-api';

type Tab = 'departments' | 'eligibility';
type LoadState = 'loading' | 'ready' | 'unauthorized' | 'forbidden' | 'noScope' | 'error';

export default function TeamsPage() {
  const t = useTranslations('teams');
  const tc = useTranslations('common');
  const ts = useTranslations('states');

  const [tab, setTab] = React.useState<Tab>('departments');

  const [teams, setTeams] = React.useState<Team[] | null>(null);
  const [people, setPeople] = React.useState<EffectivePermission[] | null>(null);
  const [brands, setBrands] = React.useState<BrandOption[]>([]);
  const [brandFilter, setBrandFilter] = React.useState<string>('');

  const [state, setState] = React.useState<LoadState>('loading');
  const [roster, setRoster] = React.useState<Record<string, TeamMember[]>>({});
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

  const loadRoster = React.useCallback(async (teamId: string) => {
    // The await must be OUTSIDE the state updater: updaters run during render
    // and must be pure, so an await inside one is both a type error and a bug.
    try {
      const members = await teamsApi.members(teamId);
      setRoster((r) => ({ ...r, [teamId]: members }));
    } catch {
      setRoster((r) => ({ ...r, [teamId]: [] }));
    }
  }, []);

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
  const totalPeople = people?.length ?? 0;

  return (
    <div className="space-y-6">
      <BackButton />
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          tab === 'departments' ? (
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
                  const members = roster[team.id];
                  const loaded = members !== undefined;
                  const isEmpty = loaded && members.length === 0;
                  return (
                    <Card key={team.id}>
                      <CardHeader className="flex-row items-start justify-between space-y-0">
                        <div className="min-w-0">
                          <CardTitle className="truncate">{team.name}</CardTitle>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {loaded ? `${members.length} ${t('team.membership')}` : tc('loading')}
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
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary"
                            onClick={() => { setRenaming(team); setRenameValue(team.name); }}
                            disabled={busy}>
                            <Edit2 className="size-3.5" /> {tc('edit')}
                          </Button>
                          <Button size="sm" variant="secondary"
                            onClick={() => { setMemberFor(team); setCandidate(''); void loadRoster(team.id); }}
                            disabled={busy || team.status !== 'active'}>
                            <Users className="size-3.5" /> {t('team.addMember')}
                          </Button>
                          <Button size="sm" variant="ghost"
                            onClick={() => void run(async () => {
                              await teamsApi.setStatus(team.id, team.status === 'active' ? 'disabled' : 'active');
                              await loadTeams();
                            })}
                            disabled={busy}>
                            {team.status === 'active' ? t('status.disable') : t('status.enable')}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* The state production is actually in: teams that exist but hold nobody. */}
              {teams && teams.length > 0 && Object.keys(roster).length === 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Building2 className="size-4" /> {t('empty.unassigned')}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">{t('empty.unassignedBody')}</p>
                  </CardContent>
                </Card>
              )}
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
              <Badge variant={eligible > 0 ? 'success' : 'destructive'}>
                {totalPeople === 0 ? t('eligibility.summaryNone')
                  : eligible === totalPeople ? t('eligibility.summary', { eligible, total: totalPeople })
                    : t('eligibility.summary', { eligible, total: totalPeople })}
              </Badge>
            </CardContent>
          </Card>

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
              {memberFor && roster[memberFor.id]?.length === 0 && (
                <p className="text-xs text-muted-foreground">{t('team.emptyRoster')}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="role-in-team">{t('team.roleInTeam')}</Label>
              <Input id="role-in-team" value={roleInTeam} onChange={(e) => setRoleInTeam(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setMemberFor(null)}>{tc('cancel')}</Button>
            <Button disabled={busy || !candidate} onClick={() => void run(async () => {
              if (memberFor) {
                await teamsApi.addMember(memberFor.id, candidate, roleInTeam);
                await loadRoster(memberFor.id);
                await loadPeople(brandFilter);
              }
              setMemberFor(null);
            })}>{tc('confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One employee. `warnings` is rendered in full rather than as a single headline:
 * the whole point of the read model is that an administrator sees every
 * outstanding problem at once instead of fixing one and coming back.
 */
function PersonRow({ person }: { person: EffectivePermission }) {
  const t = useTranslations('teams');
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
        <div className="flex items-center gap-2">
          {person.assignment_eligible ? (
            <Badge><CheckCircle2 className="size-3.5" /> {t('eligibility.eligible')}</Badge>
          ) : (
            <Badge variant="destructive"><Ban className="size-3.5" /> {t('eligibility.notEligible')}</Badge>
          )}
        </div>
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
