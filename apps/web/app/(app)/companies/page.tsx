'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, Trash2, Loader2, ShieldCheck, Building2, Users, AlertTriangle } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { BackButton } from '@/components/shell/back-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHead } from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';
import { platformApi } from '@/lib/api';
import { EscalationManagersCard } from './escalation-managers-card';
import { ErrorState, PageLoading } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export default function PlatformCompaniesPage() {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const router = useRouter();

  const [companies, setCompanies] = React.useState<Array<{
    id: string; name: string; slug: string; status: 'active' | 'disabled';
    createdAt: string; brandsCount: number; usersCount: number;
  }> | null>(null);
  const [metrics, setMetrics] = React.useState<{ total: number; active: number } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [forbidden, setForbidden] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [metricsLoading, setMetricsLoading] = React.useState(true);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [disableOpen, setDisableOpen] = React.useState<string | null>(null);
const [isDisableDialogOpen, setIsDisableDialogOpen] = React.useState(false);
  const [form, setForm] = React.useState({ name: '', slug: '', adminEmail: '', adminName: '', adminPassword: '' });
  const [formError, setFormError] = React.useState<string | null>(null);
  const [formBusy, setFormBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    setForbidden(false);
    try {
      const [companiesData, metricsData] = await Promise.all([
        platformApi.listCompanies(),
        platformApi.getMetrics()
      ]);
      setCompanies(companiesData);
      setMetrics(metricsData.companies);
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 403) setForbidden(true);
      else setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!form.name || !form.slug || !form.adminEmail || !form.adminName || !form.adminPassword) {
      setFormError('All fields are required');
      return;
    }
    if (form.adminPassword.length < 8) {
      setFormError('Password must be at least 8 characters');
      return;
    }
    setFormBusy(true);
    try {
      await platformApi.createCompany({
        name: form.name,
        slug: form.slug.toLowerCase(),
        adminEmail: form.adminEmail,
        adminName: form.adminName,
        adminPassword: form.adminPassword
      });
      setCreateOpen(false);
      setForm({ name: '', slug: '', adminEmail: '', adminName: '', adminPassword: '' });
      await load();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
      if (err.code === 'CONFLICT') setFormError('Slug already exists');
      else if (err.code === 'VALIDATION_ERROR' && err.details) {
        const firstKey = Object.keys(err.details)[0];
        setFormError(`${firstKey}: ${err.details[firstKey]}`);
      } else setFormError(err.message || 'Failed to create company');
    } finally {
      setFormBusy(false);
    }
  };

  const handleDisable = async (id: string) => {
    if (!id) return;
    setDisableOpen(id);
    setIsDisableDialogOpen(true);
    setBusy(true);
    try {
      await platformApi.disableCompany(id);
      await load();
    } catch {
      // error handled by toast in production
    } finally {
      setIsDisableDialogOpen(false);
      setDisableOpen(null);
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('companies')} breadcrumb={<BackButton />} />
        <PageLoading />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('companies')} breadcrumb={<BackButton />} />
        <ErrorState
          title={t('forbiddenTitle')}
          description={t('forbiddenDescription')}
          actionLabel={tc('retry')}
          onAction={load}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('companies')} breadcrumb={<BackButton />} />
        <ErrorState title="Failed to load" description="Could not load companies" actionLabel={tc('retry')} onAction={load} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('companies')}
        description={t('description')}
        breadcrumb={<BackButton />}
        actions={
          <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" aria-hidden /> {t('addCompany')}
          </Button>
        }
      />

      {/* Metrics Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('totalCompanies')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{metrics?.total ?? 0}</div>
            <p className="text-xs text-muted-foreground">{t('active')}: {metrics?.active ?? 0}</p>
          </CardContent>
        </Card>
      </div>

      {/* Companies Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t('companiesList')}</CardTitle>
            {busy && (
              <Badge variant="neutral" className="ml-2">
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                {t('loading')}
              </Badge>
            )}
          </div>
          </CardHeader>
        <CardContent>
          {companies === null || companies.length === 0 ? (
            <div className="py-12 text-center">
              <Building2 className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium text-foreground">{t('emptyTitle')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('emptyDescription')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('name')}</TableHead>
                    <TableHead className="hidden md:table-cell">{t('slug')}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t('brands')}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t('users')}</TableHead>
                    <TableHead>{t('status')}</TableHead>
                    <TableHead className="hidden md:table-cell">{t('created')}</TableHead>
                    <TableHead className="text-end w-[100px]">{t('actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companies?.map((c) => (
                    <TableRow key={c.id} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">{c.slug}</TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">{c.brandsCount}</TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">{c.usersCount}</TableCell>
                      <TableCell>
                        <Badge variant={c.status === 'active' ? 'success' : 'destructive'}>
                          {t(`statusLabels.${c.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">{timeAgo(c.createdAt)}</TableCell>
                      <TableCell className="text-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:bg-destructive/10"
                          onClick={() => setDisableOpen(c.id)}
                          disabled={busy || c.status === 'disabled'}
                          aria-label={t('disableCompany')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* P0.3 — the only interface that can hand `escalation.resolve` to a person.
          It lives on the platform page because it is a platform action, not a
          tenant one: a company administrator cannot grant this to themselves. */}
      {companies && companies.length > 0 ? (
        <EscalationManagersCard companies={companies} />
      ) : null}

      {/* Create Company Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader title={t('createCompany')} description={t('createCompanyDescription')} />
          <form onSubmit={handleCreate} className="space-y-4 p-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('name')}</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('namePlaceholder')}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">{t('slug')}</Label>
              <Input
                id="slug"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
                placeholder={t('slugPlaceholder')}
                required
              />
              <p className="text-xs text-muted-foreground">{t('slugHint')}</p>
            </div>
            <Separator />
            <p className="text-sm font-medium text-foreground">{t('adminAccount')}</p>
            <div className="space-y-2">
              <Label htmlFor="adminName">{t('adminName')}</Label>
              <Input
                id="adminName"
                value={form.adminName}
                onChange={(e) => setForm({ ...form, adminName: e.target.value })}
                placeholder={t('adminNamePlaceholder')}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adminEmail">{t('adminEmail')}</Label>
              <Input
                id="adminEmail"
                type="email"
                value={form.adminEmail}
                onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
                placeholder={t('adminEmailPlaceholder')}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adminPassword">{t('adminPassword')}</Label>
              <Input
                id="adminPassword"
                type="password"
                value={form.adminPassword}
                onChange={(e) => setForm({ ...form, adminPassword: e.target.value })}
                placeholder={t('adminPasswordPlaceholder')}
                required
                minLength={8}
              />
            </div>
            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}
            <DialogFooter className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)} disabled={formBusy}>
                {tc('cancel')}
              </Button>
              <Button type="submit" disabled={formBusy}>
                {formBusy ? t('creating') : t('createCompany')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Disable Confirmation Dialog */}
      <Dialog open={isDisableDialogOpen} onOpenChange={setIsDisableDialogOpen}>
        <DialogContent>
          <DialogHeader title={t('disableCompany')} description={t('disableCompanyDescription')} />
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDisableOpen(null)} disabled={busy}>
              {tc('cancel')}
            </Button>
            <Button variant="destructive" onClick={() => handleDisable(disableOpen!)} disabled={busy}>
              {busy ? t('disabling') : t('disableCompany')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}