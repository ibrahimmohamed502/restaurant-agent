'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Plus, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, PageLoading } from '@/components/ui/states';
import { BackButton } from '@/components/shell/back-button';
import { usersApi, type TeamUser } from '@/lib/api';

const ROLES = ['Company Admin', 'Supervisor', 'Agent'];

export default function TeamPage() {
  const t = useTranslations('team');
  const tc = useTranslations('common');

  const [users, setUsers] = React.useState<TeamUser[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<'forbidden' | 'failed' | null>(null);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TeamUser | null>(null);
  const [busy, setBusy] = React.useState(false);

  // create-user form
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [roles, setRoles] = React.useState<string[]>(['Agent']);
  const [formError, setFormError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await usersApi.list());
    } catch (err: unknown) {
      const code = (err as { status?: number })?.status;
      setError(code === 403 ? 'forbidden' : 'failed');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    setName(''); setEmail(''); setPassword(''); setRoles(['Agent']); setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (u: TeamUser) => {
    setEditing(u);
    setName(u.name); setEmail(u.email); setPassword(''); setRoles(u.roles ?? []); setFormError(null);
    setDialogOpen(true);
  };

  const toggleRole = (r: string) => setRoles((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]));

  const submit = async () => {
    setFormError(null);
    if (!name.trim() || !email.trim()) { setFormError(t('errors.required')); return; }
    setBusy(true);
    try {
      if (editing) {
        await usersApi.setRoles(editing.id, roles);
        if (!editing.status) await usersApi.setStatus(editing.id, 'active');
        setUsers((list) => (list ?? []).map((u) => (u.id === editing.id ? { ...u, roles } : u)));
      } else {
        if (String(password).length < 8) { setFormError(t('errors.passwordLength')); setBusy(false); return; }
        const created = await usersApi.create({ email: email.trim(), name: name.trim(), password, roles });
        setUsers((list) => [...(list ?? []), created]);
      }
      setDialogOpen(false);
      await load();
    } catch (err: unknown) {
      setFormError((err as { message?: string })?.message ?? t('errors.failed'));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (u: TeamUser) => {
    const next = u.status === 'active' ? 'disabled' : 'active';
    const ok = window.confirm(next === 'disabled' ? t('confirmDisable', { name: u.name }) : t('confirmEnable', { name: u.name }));
    if (!ok) return;
    try {
      const updated = await usersApi.setStatus(u.id, next);
      setUsers((list) => (list ?? []).map((x) => (x.id === u.id ? { ...x, status: updated.status } : x)));
    } catch (err: unknown) {
      window.alert((err as { message?: string })?.message ?? t('errors.failed'));
    }
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('nav')} breadcrumb={<BackButton />} />
        <PageLoading />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('nav')} breadcrumb={<BackButton />} />
        <ErrorState
          title={error === 'forbidden' ? t('forbidden.title') : t('errors.title')}
          description={error === 'forbidden' ? t('forbidden.description') : t('errors.description')}
          actionLabel={tc('retry')}
          onAction={load}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('nav')}
        description={t('description')}
        breadcrumb={<BackButton />}
        actions={
          <Button size="sm" className="gap-1.5" onClick={openCreate}>
            <UserPlus className="h-3.5 w-3.5" aria-hidden /> {t('addUser')}
          </Button>
        }
      />

      {(users ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-14 text-center">
          <Users className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium text-foreground">{t('empty.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('empty.description')}</p>
          <Button size="sm" className="mt-4 gap-1.5" onClick={openCreate}><Plus className="h-3.5 w-3.5" aria-hidden /> {t('addUser')}</Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-start font-medium">{t('table.name')}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t('table.email')}</th>
                <th className="hidden px-4 py-2.5 text-start font-medium sm:table-cell">{t('table.roles')}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t('table.status')}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t('table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(users ?? []).map((u) => (
                <tr key={u.id} className="transition-colors hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {u.name.trim().charAt(0).toUpperCase()}
                      </span>
                      <span className="font-medium text-foreground">{u.name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground" dir="ltr">{u.email}</td>
                  <td className="hidden px-4 py-2.5 sm:table-cell">
                    <span className="flex flex-wrap gap-1">
                      {(u.roles ?? []).map((r) => (
                        <span key={r} className="inline-flex items-center rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-2xs font-medium text-secondary-foreground">{roleLabel(r)}</span>
                      ))}
                      {(u.roles ?? []).length === 0 ? <span className="text-xs text-muted-foreground">—</span> : null}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={u.status === 'active'
                      ? 'inline-flex items-center rounded-md border border-success/30 bg-success/10 px-1.5 py-0.5 text-2xs font-medium text-success'
                      : 'inline-flex items-center rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-2xs font-medium text-destructive'}>
                      {u.status === 'active' ? t('statusActive') : t('statusDisabled')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => openEdit(u)}>
                        <Pencil className="h-3 w-3" aria-hidden /> {tc('edit') ?? t('edit')}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-destructive" onClick={() => toggleStatus(u)}>
                        <Trash2 className="h-3 w-3" aria-hidden /> {u.status === 'active' ? t('disable') : t('enable')}
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={editing ? t('editTitle') : t('addUser')}>
          <div className="absolute inset-0 bg-black/40" onClick={() => setDialogOpen(false)} aria-hidden />
          <div className="relative w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-lg">
            <h2 className="text-base font-semibold text-foreground">{editing ? t('editTitle') : t('addUser')}</h2>
            <div className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="u-name" className="text-[13px]">{t('table.name')}</Label>
                <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-email" className="text-[13px]">{t('table.email')}</Label>
                <Input id="u-email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} disabled={Boolean(editing)} className="h-9" />
              </div>
              {!editing ? (
                <div className="space-y-1.5">
                  <Label htmlFor="u-pass" className="text-[13px]">{t('password')}</Label>
                  <Input id="u-pass" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} className="h-9" />
                  <p className="text-xs text-muted-foreground">{t('passwordHint')}</p>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <p className="text-[13px] font-medium text-foreground">{t('table.roles')}</p>
                <div className="space-y-1.5">
                  {ROLES.map((r) => (
                    <label key={r} className="flex items-center gap-2 text-[13px] text-secondary-foreground">
                      <input type="checkbox" checked={roles.includes(r)} onChange={() => toggleRole(r)} className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" />
                      {roleLabel(r)}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t('rolesHint')}</p>
              </div>
              {formError ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{formError}</p> : null}
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDialogOpen(false)} disabled={busy}>{tc('cancel')}</Button>
              <Button size="sm" onClick={submit} disabled={busy} className="gap-1.5">
                {busy ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : null}
                {editing ? t('save') : t('addUser')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> {t('rbacNote')}
      </p>
    </div>
  );

  function roleLabel(r: string): string {
    if (r === 'Company Admin') return t('roles.admin');
    if (r === 'Supervisor') return t('roles.supervisor');
    if (r === 'Agent') return t('roles.agent');
    return r;
  }
}
