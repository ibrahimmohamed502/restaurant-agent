'use client';

/**
 * P0.5-C — Brand access management.
 *
 * A thin surface over /api/v1/brand-grants. It does not re-implement access
 * control: every grant and revoke goes through the existing routes, which
 * enforce the delegation ceiling (you can only hand out brands you can already
 * reach) and refuse self-revoke. This screen makes those decisions visible
 * and clickable; it never becomes the authority.
 *
 * Brand access and department membership stay separate on purpose. A department
 * decides who routing can consider; a brand grant decides which conversations
 * they may see. Conflating them is how somebody ends up able to read every
 * conversation in a brand they were never granted.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, ShieldCheck, ShieldOff, Check, X, AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, PageLoading } from '@/components/ui/states';
import { ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils';
import { brandGrantsApi, describeGrantError, type GrantRow } from '@/lib/brand-grants-api';
import type { EffectivePermission, BrandOption } from '@/lib/teams-api';

type Props = {
  people: EffectivePermission[];
  brands: BrandOption[];
  canGrant: boolean;
  canRevoke: boolean;
  canGrantAll: boolean;
  canRevokeAll: boolean;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  setActionError: (e: string | null) => void;
  reloadPeople: () => void;
};

export function BrandAccessTab(props: Props) {
  const t = useTranslations('teams');
  const tc = useTranslations('common');
  const {
    people, brands, canGrant, canRevoke, canGrantAll, canRevokeAll,
    busy, run, setActionError, reloadPeople
  } = props;

  const [selected, setSelected] = React.useState<EffectivePermission | null>(null);
  const [grants, setGrants] = React.useState<GrantRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);

  // Load grants lazily for the selected person. A company can have hundreds
  // of employees and 10 brands each; loading all up front would be wasteful
  // and would race against concurrent edits.
  React.useEffect(() => {
    if (!selected) { setGrants(null); return; }
    let cancelled = false;
    setLoading(true);
    brandGrantsApi.history(selected.id)
      .then((rows) => { if (!cancelled) setGrants(rows); })
      .catch(() => { if (!cancelled) setGrants([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);

  const liveGrant = (brandId: string) => grants?.find((g) => g.brandId === brandId && g.live) ?? null;
  const allLive = grants?.some((g) => g.live && g.brandName === undefined) === false
    ? false
    : false;

  // Whether the person holds company-wide scope. brandIds is null in that case.
  const hasAll = selected?.all_brands === true;

  const reload = async () => {
    if (selected) {
      const rows = await brandGrantsApi.history(selected.id);
      setGrants(rows);
    }
    reloadPeople();
  };

  const handleGrant = (brandId: string) => run(async () => {
    await brandGrantsApi.grant(selected!.id, brandId);
    await reload();
  });

  const handleRevoke = (brandId: string) => run(async () => {
    try {
      await brandGrantsApi.revoke(selected!.id, brandId);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'SELF_REVOKE_FORBIDDEN') {
        setActionError(t('brandAccess.errors.selfRevoke'));
        return;
      }
      throw e;
    }
    await reload();
  });

  const handleGrantAll = () => run(async () => {
    await brandGrantsApi.grantAll(selected!.id);
    await reload();
  });

  const handleRevokeAll = () => run(async () => {
    try {
      await brandGrantsApi.revokeAll(selected!.id);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'SELF_REVOKE_FORBIDDEN') {
        setActionError(t('brandAccess.errors.selfRevoke'));
        return;
      }
      throw e;
    }
    await reload();
    setConfirmRevokeAll(false);
  });

  if (people.length === 0) {
    return <EmptyState title={t('eligibility.empty.title')} description={t('eligibility.empty.description')} />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('brandAccess.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('brandAccess.description')}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="grant-person" className="text-sm font-medium">
              {t('brandAccess.choosePerson')}
            </Label>
            <select id="grant-person" value={selected?.id ?? ''}
              onChange={(e) => {
                const p = people.find((x) => x.id === e.target.value) ?? null;
                setSelected(p);
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="">—</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name ?? p.email}</option>
              ))}
            </select>
          </div>

          {selected && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  {selected.name ?? selected.email}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {(canGrantAll || canRevokeAll) && (
                    <Button size="sm" variant={hasAll ? 'destructive' : 'default'}
                      disabled={busy || (hasAll ? !canRevokeAll : !canGrantAll)}
                      onClick={() => {
                        if (hasAll) setConfirmRevokeAll(true);
                        else void handleGrantAll();
                      }}>
                      {hasAll ? t('brandAccess.revokeAll') : t('brandAccess.grantAll')}
                    </Button>
                  )}
                </div>
              </div>

              {/*
                Company Admins and anyone with an all-brands delegation hold
                company-wide scope, so per-brand grants are redundant for them.
                Showing "Not granted" beside "All brands" in the eligibility
                screen looked like a contradiction; this explains why.
              */}
              {selected.all_brands && (
                <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-sm">
                  <ShieldCheck className="size-4 shrink-0 mt-0.5 text-info" />
                  <span>{t('brandAccess.allBrandsNote')}</span>
                </div>
              )}

              {loading && <PageLoading />}

              {!loading && grants && (
                <ul className="space-y-1.5">
                  {brands.map((b) => {
                    const live = liveGrant(b.id);
                    const disabled = hasAll; // individual grants are redundant
                    return (
                      <li key={b.id}
                        className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                        <span className="text-sm">{b.name}</span>
                        <div className="flex items-center gap-2">
                          {live ? (
                            <Badge variant="success">{t('brandAccess.granted')}</Badge>
                          ) : hasAll ? (
                            <Badge variant="neutral">{t('brandAccess.coveredByAll')}</Badge>
                          ) : (
                            <Badge variant="neutral">{t('brandAccess.notGranted')}</Badge>
                          )}
                          {live ? (
                            <Button size="sm" variant="ghost"
                              disabled={busy || !canRevoke || hasAll}
                              title={hasAll ? t('brandAccess.redundantHint') : undefined}
                              onClick={() => void handleRevoke(b.id)}>
                              <ShieldOff className="size-3.5" /> {t('brandAccess.revoke')}
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost"
                              disabled={busy || !canGrant || hasAll}
                              title={hasAll ? t('brandAccess.redundantHint') : undefined}
                              onClick={() => void handleGrant(b.id)}>
                              <ShieldCheck className="size-3.5" /> {t('brandAccess.grant')}
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmRevokeAll} onOpenChange={setConfirmRevokeAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('brandAccess.confirmRevokeAllTitle')}</DialogTitle>
            <DialogDescription>{t('brandAccess.confirmRevokeAllBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmRevokeAll(false)}>{tc('cancel')}</Button>
            <Button variant="destructive" disabled={busy}
              onClick={() => void handleRevokeAll()}>
              {busy && <Loader2 className="size-4 animate-spin" />} {t('brandAccess.revokeAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
