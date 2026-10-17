'use client';

/**
 * P0.3 — the Platform Owner's control for `escalation.resolve`.
 *
 * WHAT THIS IS
 * ------------
 * The only interface through which the escalation-resolve ability can be given to
 * a person. It exists because the ability is held by NO built-in role, so nobody in
 * any company can discharge a customer complaint until the owner decides who should
 * be able to. Until then the feature is unusable — and this is the deliberate,
 * reversible answer to that, not a workaround.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is NOT a permission of the operator. It cannot change what the server
 * enforces, and hiding these controls grants nobody anything: `/api/v1/platform`
 * is behind a guard requiring both a row in `platform_super_admins` and the
 * platform role, and the service re-verifies the role row's stored permissions
 * before it hands it over. Every rule shown here is also enforced server-side;
 * this screen only avoids showing controls that would fail.
 *
 * IT DOES NOT GRANT BRAND ACCESS
 * ------------------------------
 * Nothing here touches `user_brand_grants`. A manager can only reach the brands
 * they were separately granted, so the picker deliberately does not pretend to be
 * about brand scope — someone can hold this role and still be unable to close the
 * escalations they are nominally responsible for, and that is correct.
 *
 * A mandatory reason is required for both grant and revoke. It is stored with the
 * assignment in `audit_logs`, inside the same transaction as the write, so it
 * cannot be lost or written without the change it describes.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ShieldCheck, Loader2, UserPlus, UserMinus, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { platformApi, ApiError } from '@/lib/api';
import type { EscalationManagersView } from '@/lib/api';
import { cn } from '@/lib/utils';

type Company = { id: string; name: string };

type Props = { companies: Company[] };

/** Mirrors the server's MIN_REASON_CHARS so the button is honest about it. */
const MIN_REASON_CHARS = 8;

export function EscalationManagersCard({ companies }: Props) {
  const t = useTranslations('platform.escalation');

  const [tenantId, setTenantId] = React.useState<string>('');
  const [view, setView] = React.useState<EscalationManagersView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [userId, setUserId] = React.useState<string>('');
  const [reason, setReason] = React.useState<string>('');
  const [actionBusy, setActionBusy] = React.useState<null | 'grant' | string>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // Default to the first company so the screen is never in an inert empty state.
  React.useEffect(() => {
    if (!tenantId && companies.length > 0) setTenantId(companies[0].id);
  }, [companies, tenantId]);

  const load = React.useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      setView(await platformApi.listEscalationManagers(id));
    } catch (e) {
      setView(null);
      const err = e as ApiError;
      setLoadError(err.code ?? 'failed');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (tenantId) void load(tenantId);
    // Re-selecting a company clears the previous company's answer rather than
    // showing one company's holders above another company's name.
    else setView(null);
  }, [tenantId, load]);

  const reasonValid = reason.trim().length >= MIN_REASON_CHARS;

  const run = async (kind: 'grant' | 'revoke', targetUserId: string) => {
    if (!tenantId) return;
    setActionBusy(kind === 'grant' ? 'grant' : targetUserId);
    setActionError(null);
    setNotice(null);
    try {
      if (kind === 'grant') {
        const r = await platformApi.grantEscalationManager({ tenantId, userId: targetUserId, reason });
        // `alreadyGranted` is a success, not a failure: a retried request converges
        // rather than alarming the operator about something they already did.
        setNotice(r.alreadyGranted ? t('alreadyGranted') : t('granted'));
      } else {
        const r = await platformApi.revokeEscalationManager({ tenantId, userId: targetUserId, reason });
        setNotice(r.alreadyRevoked ? t('alreadyRevoked') : t('revoked'));
      }
      setReason('');
      await load(tenantId);
    } catch (e) {
      const err = e as ApiError;
      setActionError(err.message || err.code || t('genericError'));
    } finally {
      setActionBusy(null);
    }
  };

  const holders = view?.holders ?? [];
  const candidates = (view?.candidates ?? []).filter((c) => !c.already_granted);
  const selected = candidates.find((c) => c.id === userId);

  return (
    <Card data-testid="escalation-managers">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('description')}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="esc-company">{t('companyLabel')}</Label>
          <select
            id="esc-company"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {t('loading')}
          </p>
        ) : null}

        {loadError ? (
          <p role="alert" className="text-xs text-destructive">{t('loadError')}</p>
        ) : null}

        {/* ---- who holds it now ---- */}
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('holdersLabel')}</p>
          {view && holders.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="no-holders">{t('noHolders')}</p>
          ) : null}
          <ul className="space-y-2">
            {holders.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2"
              >
                <span className="min-w-0 text-sm">
                  <span className="font-medium">{h.name || h.email}</span>
                  <span className="block truncate text-xs text-muted-foreground">{h.email}</span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => run('revoke', h.id)}
                  disabled={actionBusy !== null || !reasonValid}
                  data-testid={`revoke-${h.id}`}
                >
                  {actionBusy === h.id
                    ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    : <UserMinus className="h-3 w-3" aria-hidden />}
                  {t('revoke')}
                </Button>
              </li>
            ))}
          </ul>
        </div>

        <Separator />

        {/* ---- grant to someone new ---- */}
        <div className="space-y-3">
          <p className="text-sm font-medium">{t('grantLabel')}</p>

          {view && candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('noCandidates')}</p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="esc-user">{t('userLabel')}</Label>
              <select
                id="esc-user"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                disabled={candidates.length === 0}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              >
                <option value="">{t('pickUser')}</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>{c.name ? `${c.name} — ${c.email}` : c.email}</option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="esc-reason">{t('reasonLabel')}</Label>
              <Input
                id="esc-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('reasonPlaceholder')}
                maxLength={500}
              />
            </div>
          </div>

          {/* The reason is mandatory and the server enforces the same minimum. Saying
              so here is the difference between a form that explains itself and one
              the operator has to discover by failing. */}
          <p className="text-xs text-muted-foreground">{t('reasonHint')}</p>

          <Button
            onClick={() => run('grant', userId)}
            disabled={!userId || !selected || !reasonValid || actionBusy !== null}
            data-testid="grant-escalation"
          >
            {actionBusy === 'grant'
              ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              : <UserPlus className="h-3 w-3" aria-hidden />}
            {t('grant')}
          </Button>

          {actionError ? (
            <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {actionError}
            </p>
          ) : null}

          {notice ? (
            <p role="status" data-testid="esc-notice" className="text-xs text-muted-foreground">{notice}</p>
          ) : null}

          {/* State plainly what this does and does not do, rather than leaving the
              operator to assume brand access came along with it. */}
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            {t('scopeWarning')}
          </p>
        </div>

        {view ? (
          <p className="text-xs text-muted-foreground" data-testid="esc-permissions">
            {t('permissionsLabel')}: {view.permissions.join(', ')}
            <Badge variant="neutral" className={cn('ms-2', 'align-middle')}>{view.role}</Badge>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}