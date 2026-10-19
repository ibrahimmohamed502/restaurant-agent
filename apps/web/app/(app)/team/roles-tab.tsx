'use client';

/**
 * P0.5-C / A1 — Custom Roles & Permissions management.
 *
 * A role is a named set of abilities. Built-in roles (Company Admin, Supervisor,
 * Agent) come from the hardcoded map and cannot be edited. Custom roles store
 * their abilities in roles.permissions and are resolved at session time.
 *
 * This tab does not grant abilities to anyone directly. It manages the
 * DEFINITION of a role; assigning it to a person happens on the user list
 * through /users/:id/roles, behind user.update. Two separate acts, two
 * separate abilities, so a role manager cannot promote anyone.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  Plus, Pencil, Trash2, ShieldCheck, ShieldOff, Loader2, AlertTriangle, Check
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, PageLoading } from '@/components/ui/states';
import { ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils';
import { rolesApi, describeRoleError, type Role } from '@/lib/roles-api';
import { teamsApi } from '@/lib/teams-api';

/**
 * The permission matrix, grouped by module. These are the abilities a custom
 * role may carry; the server's allowlist (KNOWN_ABILITIES) is the authority,
 * but keeping the UI grouped makes the editor usable.
 *
 * Order matters: most important modules first.
 */
const PERMISSION_GROUPS: Array<{ module: string; abilities: string[] }> = [
  { module: 'conversation', abilities: [
    'conversation.read', 'conversation.handoff', 'conversation.assign',
    'conversation.reassign', 'conversation.unassign', 'conversation.resolve',
    'conversation.resume_ai', 'conversation.reply',
    'conversation.assign_self', 'conversation.reply_own', 'conversation.resolve_own'
  ]},
  { module: 'team', abilities: [
    'team.read', 'team.create', 'team.update', 'team.disable', 'team.assign'
  ]},
  { module: 'role', abilities: [
    'role.read', 'role.create', 'role.update', 'role.disable', 'role.delete'
  ]},
  { module: 'brand', abilities: [
    'brand.read', 'brand.create', 'brand.update', 'brand.disable',
    'brand.grant', 'brand.revoke',
    'brand.integration.connect', 'brand.integration.disconnect',
    'brand.integration.reconnect', 'brand.integration.status'
  ]},
  { module: 'user', abilities: [
    'user.read', 'user.create', 'user.update', 'user.disable'
  ]},
  { module: 'company', abilities: ['company.read', 'company.update'] },
  { module: 'note', abilities: ['note.read', 'note.create', 'note.delete_own', 'note.delete_any'] },
  { module: 'notification', abilities: ['notification.read'] },
  { module: 'knowledge', abilities: ['knowledge.read', 'knowledge.edit'] },
  { module: 'ai', abilities: ['ai.config.read', 'ai.config.write'] },
  { module: 'audit', abilities: ['audit.read'] },
  { module: 'escalation', abilities: ['escalation.resolve'] }
];

type Props = {
  busy: boolean;
  setBusy: (b: boolean) => void;
  setActionError: (e: string | null) => void;
};

export function RolesTab({ busy, setBusy, setActionError }: Props) {
  const t = useTranslations('roles');
  const tc = useTranslations('common');

  const [roles, setRoles] = React.useState<Role[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [editing, setEditing] = React.useState<Role | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [perms, setPerms] = React.useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = React.useState<Role | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setRoles(await rolesApi.list());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setPerms([]);
    setCreating(true);
  };

  const openEdit = (r: Role) => {
    setEditing(r);
    setName(r.name);
    setPerms([...r.permissions]);
    setCreating(true);
  };

  const submit = async () => {
    setActionError(null);
    if (!name.trim()) { setActionError(t('errors.nameRequired')); return; }
    setBusy(true);
    setActionError(null);
    try {
      if (editing) {
        await rolesApi.update(editing.id, name.trim(), perms);
      } else {
        await rolesApi.create(name.trim(), perms);
      }
      setCreating(false);
      setEditing(null);
      await load();
    } catch (e) {
      const d = describeRoleError(e as { code?: string });
      setActionError(d === 'name-taken' ? t('errors.nameTaken')
        : d === 'system-role' ? t('errors.systemRole')
          : d === 'not-delegable' ? t('errors.notDelegable')
            : d === 'invalid' ? t('errors.invalid')
              : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = (r: Role) => {
    const next = r.status === 'active' ? 'disabled' : 'active';
    setBusy(true);
    setActionError(null);
    rolesApi.setStatus(r.id, next).then(() => load()).catch((e) => {
      const d = describeRoleError(e as { code?: string });
      setActionError(d === 'system-role' ? t('errors.systemRole') : t('errors.generic'));
    }).finally(() => setBusy(false));
  };

  const remove = (r: Role) => {
    setBusy(true);
    setActionError(null);
    rolesApi.remove(r.id).then(() => load()).catch((e) => {
      const d = describeRoleError(e as { code?: string });
      setActionError(d === 'system-role' ? t('errors.systemRole') : t('errors.generic'));
    }).finally(() => setBusy(false));
    setConfirmDelete(null);
  };

  const togglePerm = (p: string) =>
    setPerms((ps) => (ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p]));

  if (loading) return <PageLoading />;
  if (error) return <ErrorState title={t('errors.title')} description={t('errors.description')} actionLabel={tc('retry')} onAction={load} />;

  const customRoles = roles.filter((r) => !['Company Admin', 'Supervisor', 'Agent', 'Platform Super Admin'].includes(r.name));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <Button size="sm" onClick={openCreate} disabled={busy}>
            <Plus className="size-4" /> {t('create')}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <p className="px-4 py-2 text-xs text-muted-foreground">{t('rbacNote')}</p>
          {roles.length === 0 ? (
            <EmptyState title={t('empty.title')} description={t('empty.description')} />
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-start font-medium">{t('table.name')}</th>
                  <th className="hidden px-4 py-2.5 text-start font-medium sm:table-cell">{t('table.permissions')}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t('table.status')}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t('table.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {roles.map((r) => {
                  const isSystem = ['Company Admin', 'Supervisor', 'Agent', 'Platform Super Admin'].includes(r.name);
                  return (
                    <tr key={r.id} className="transition-colors hover:bg-muted/40">
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-foreground">{r.name}</span>
                        {isSystem && (
                          <Badge variant="neutral" className="ml-2">{t('system')}</Badge>
                        )}
                      </td>
                      <td className="hidden px-4 py-2.5 text-muted-foreground sm:table-cell">
                        {r.permissions.length}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={r.status === 'active'
                          ? 'inline-flex items-center rounded-md border border-success/30 bg-success/10 px-1.5 py-0.5 text-2xs font-medium text-success'
                          : r.status === 'deleted'
                          ? 'inline-flex items-center rounded-md border border-red-300/30 bg-red-500/10 px-1.5 py-0.5 text-2xs font-medium text-red-600'
                          : 'inline-flex items-center rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-2xs font-medium text-destructive'}>
                          {r.status === 'active' ? tc('active') : r.status === 'deleted' ? t('deleted') : t('disabled')}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs"
                            disabled={busy || isSystem} onClick={() => openEdit(r)}>
                            <Pencil className="h-3 w-3" aria-hidden /> {tc('edit')}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs"
                            disabled={busy || isSystem || r.status === 'deleted'} onClick={() => toggleStatus(r)}>
                            {r.status === 'active' ? <ShieldOff className="h-3 w-3" aria-hidden /> : <ShieldCheck className="h-3 w-3" aria-hidden />}
                            {r.status === 'active' ? t('disable') : r.status === 'deleted' ? t('deleted') : t('enable')}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-destructive"
                            disabled={busy || isSystem} onClick={() => setConfirmDelete(r)}>
                            <Trash2 className="h-3 w-3" aria-hidden /> {tc('delete')}
                          </Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Create / Edit dialog */}
      {creating ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setCreating(false)} aria-hidden />
          <div className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-lg">
            <h2 className="text-base font-semibold text-foreground">{editing ? t('editTitle') : t('createTitle')}</h2>
            <div className="mt-4 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="role-name" className="text-[13px]">{t('name')}</Label>
                <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
                <p className="text-xs text-muted-foreground">{t('nameHint')}</p>
              </div>
              <div className="space-y-2">
                <p className="text-[13px] font-medium text-foreground">{t('permissions')}</p>
                {PERMISSION_GROUPS.map((g) => (
                  <div key={g.module} className="rounded-md border border-border p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`modules.${g.module}`)}</p>
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      {g.abilities.map((a) => (
                        <label key={a} className="flex items-center gap-2 text-[13px] text-secondary-foreground">
                          <input type="checkbox" checked={perms.includes(a)} onChange={() => togglePerm(a)} className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" />
                          {a}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">{t('permHint')}</p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setCreating(false); setEditing(null); }} disabled={busy}>{tc('cancel')}</Button>
              <Button size="sm" onClick={submit} disabled={busy || !name.trim()} className="gap-1.5">
                {busy ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : null}
                {editing ? tc('save') : t('create')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Delete confirmation */}
      {confirmDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setConfirmDelete(null)} aria-hidden />
          <div className="relative w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-lg">
            <h2 className="text-base font-semibold text-foreground">{t('confirmDeleteTitle')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('confirmDeleteBody', { name: confirmDelete.name })}</p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(null)} disabled={busy}>{tc('cancel')}</Button>
              <Button size="sm" variant="destructive" onClick={() => void remove(confirmDelete)} disabled={busy} className="gap-1.5">
                {busy ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : null}
                {tc('delete')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
