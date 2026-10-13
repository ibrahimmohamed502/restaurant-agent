'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, Trash2, Loader2, Edit2, Globe, AlertTriangle } from 'lucide-react';
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
import { companiesApi } from '@/lib/api';
import { ErrorState, PageLoading } from '@/components/ui/states';
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

export default function BrandsPage() {
  const t = useTranslations('brands');
  const tc = useTranslations('common');
  const router = useRouter();

  const [brands, setBrands] = React.useState<Array<{
    id: string; name: string; slug: string; status: 'active' | 'disabled';
    createdAt: string; defaultLanguage?: string;
  }> | null>(null);
  const [company, setCompany] = React.useState<{
    id: string; name: string; slug: string; status: string;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState<string | null>(null);
const [isEditDialogOpen, setIsEditDialogOpen] = React.useState(false);
  const [disableOpen, setDisableOpen] = React.useState<string | null>(null);
const [isDisableDialogOpen, setIsDisableDialogOpen] = React.useState(false);
  const [form, setForm] = React.useState({ name: '', slug: '', defaultLanguage: 'ar', status: 'active' as 'active' | 'disabled' });
  const [formError, setFormError] = React.useState<string | null>(null);
  const [formBusy, setFormBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [brandsData, companyData] = await Promise.all([
        companiesApi.listBrands(),
        companiesApi.getCompany()
      ]);
      setBrands(brandsData);
      setCompany({ id: companyData.id, name: companyData.name, slug: companyData.slug, status: companyData.status });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!form.name || !form.slug) {
      setFormError('Name and slug are required');
      return;
    }
    setFormBusy(true);
    try {
      await companiesApi.createBrand({ name: form.name, slug: form.slug.toLowerCase(), defaultLanguage: form.defaultLanguage });
      setCreateOpen(false);
      setForm({ name: '', slug: '', defaultLanguage: 'ar', status: 'active' });
      await load();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
      if (err.code === 'CONFLICT') setFormError('Slug already exists in this company');
      else if (err.code === 'VALIDATION_ERROR' && err.details) {
        const firstKey = Object.keys(err.details)[0];
        setFormError(`${firstKey}: ${err.details[firstKey]}`);
      } else setFormError(err.message || 'Failed to create brand');
    } finally {
      setFormBusy(false);
    }
  };

  const handleUpdate = async (id: string) => {
    if (!id) return;
    setFormError(null);
    setFormBusy(true);
    try {
      const { name, slug, status, defaultLanguage } = form;
      await companiesApi.updateBrand(id, { name, slug: slug.toLowerCase(), status, defaultLanguage });
      setIsEditDialogOpen(false);
      setEditOpen(null);
      setForm({ name: '', slug: '', defaultLanguage: 'ar', status: 'active' });
      await load();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
      if (err.code === 'CONFLICT') setFormError('Slug already exists in this company');
      else if (err.code === 'VALIDATION_ERROR' && err.details) {
        const firstKey = Object.keys(err.details)[0];
        setFormError(`${firstKey}: ${err.details[firstKey]}`);
      } else setFormError(err.message || 'Failed to update brand');
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
      await companiesApi.disableBrand(id);
      await load();
    } catch {
      // error handled by toast in production
    } finally {
      setIsDisableDialogOpen(false);
      setDisableOpen(null);
      setBusy(false);
    }
  };

  const openEdit = (brand: NonNullable<typeof brands>[0]) => {
    setForm({ name: brand.name, slug: brand.slug, defaultLanguage: brand.defaultLanguage || 'ar', status: 'active' });
    setEditOpen(brand.id);
    setIsEditDialogOpen(true);
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('brands')} breadcrumb={<BackButton />} />
        <PageLoading />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('brands')} breadcrumb={<BackButton />} />
        <ErrorState title="Failed to load" description="Could not load brands" actionLabel={tc('retry')} onAction={load} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('brands')}
        description={t('description')}
        breadcrumb={<BackButton />}
        actions={
          <Button onClick={() => { setForm({ name: '', slug: '', defaultLanguage: 'ar', status: 'active' }); setCreateOpen(true); }} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" aria-hidden /> {t('addBrand')}
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t('brandsList')}</CardTitle>
            <Badge variant="neutral">
              {brands?.length ?? 0} {t('brands')}
            </Badge>
          </div>
          </CardHeader>
        <CardContent>
          {brands === null || brands.length === 0 ? (
            <div className="py-12 text-center">
              <Globe className="mx-auto h-12 w-12 text-muted-foreground" />
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
                    <TableHead className="hidden lg:table-cell">{t('defaultLanguage')}</TableHead>
                    <TableHead>{t('status')}</TableHead>
                    <TableHead className="hidden md:table-cell">{t('created')}</TableHead>
                    <TableHead className="text-end w-[100px]">{t('actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {brands?.map((b) => (
                    <TableRow key={b.id} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{b.name}</TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">{b.slug}</TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">
                        <Badge variant="neutral" className="text-xs">
                          {b.defaultLanguage === 'ar' ? '\u0627\u0644\u0639\u0631\u0628\u064a\u0629' : b.defaultLanguage === 'en' ? 'English' : b.defaultLanguage}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={b.status === 'active' ? 'success' : 'destructive'}>
                          {t(`status.${b.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">{timeAgo(b.createdAt)}</TableCell>
                      <TableCell className="text-end">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => openEdit(b)}
                            aria-label={t('editBrand')}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:bg-destructive/10"
                            onClick={() => setDisableOpen(b.id)}
                            disabled={b.status === 'disabled'}
                            aria-label={t('disableBrand')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Brand Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader title={t('createBrand')} description={t('createBrandDescription')} />
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
            <div className="space-y-2">
              <Label htmlFor="defaultLanguage">{t('defaultLanguage')}</Label>
              <select
                id="defaultLanguage"
                value={form.defaultLanguage}
                onChange={(e) => setForm({ ...form, defaultLanguage: e.target.value })}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="ar">{t('languages.ar')}</option>
                <option value="en">{t('languages.en')}</option>
              </select>
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            <DialogFooter className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)} disabled={formBusy}>
                {tc('cancel')}
              </Button>
              <Button type="submit" disabled={formBusy}>
                {formBusy ? t('creating') : t('createBrand')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Brand Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader title={t('editBrand')} description={t('editBrandDescription')} />
          <form onSubmit={(e) => { e.preventDefault(); handleUpdate(editOpen!); }} className="space-y-4 p-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('name')}</Label>
              <Input
                id="edit-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-slug">{t('slug')}</Label>
              <Input
                id="edit-slug"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
                required
              />
              <p className="text-xs text-muted-foreground">{t('slugHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-status">{t('status')}</Label>
              <select
                id="edit-status"
                value={form.status || 'active'}
                onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'disabled' })}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="active">{t('status.active')}</option>
                <option value="disabled">{t('status.disabled')}</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-defaultLanguage">{t('defaultLanguage')}</Label>
              <select
                id="edit-defaultLanguage"
                value={form.defaultLanguage}
                onChange={(e) => setForm({ ...form, defaultLanguage: e.target.value })}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="ar">{t('languages.ar')}</option>
                <option value="en">{t('languages.en')}</option>
              </select>
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            <DialogFooter className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setEditOpen(null)} disabled={formBusy}>
                {tc('cancel')}
              </Button>
              <Button type="submit" disabled={formBusy}>
                {formBusy ? t('saving') : t('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Disable Confirmation Dialog */}
      <Dialog open={isDisableDialogOpen} onOpenChange={setIsDisableDialogOpen}>
        <DialogContent>
          <DialogHeader title={t('disableBrand')} description={t('disableBrandDescription')} />
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDisableOpen(null)} disabled={busy}>
              {tc('cancel')}
            </Button>
            <Button variant="destructive" onClick={() => handleDisable(disableOpen!)} disabled={busy}>
              {busy ? t('disabling') : t('disableBrand')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}