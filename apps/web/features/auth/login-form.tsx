'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authApi, type MeResponse } from '@/lib/api';

type Errors = { email?: string; password?: string; form?: string };
type Props = {
  /** Injectable for tests; defaults to the real API client. */
  loginFn?: (email: string, password: string) => Promise<{ user: MeResponse['user'] }>;
  onSuccess?: () => void;
  texts?: {
    title: string;
    subtitle: string;
    email: string;
    password: string;
    submit: string;
    signingIn: string;
    showPassword: string;
    hidePassword: string;
    invalidCredentials: string;
    rateLimited: string;
    unexpected: string;
    emailRequired: string;
    emailInvalid: string;
    passwordRequired: string;
  };
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function LoginForm({ loginFn = (e, p) => authApi.login(e, p), onSuccess, texts }: Props) {
  const fallback = useTranslations('auth');
  const T = texts ?? {
    title: fallback('title'),
    subtitle: fallback('subtitle'),
    email: fallback('email'),
    password: fallback('password'),
    submit: fallback('submit'),
    signingIn: fallback('signingIn'),
    showPassword: fallback('showPassword'),
    hidePassword: fallback('hidePassword'),
    invalidCredentials: fallback('invalidCredentials'),
    rateLimited: fallback('rateLimited'),
    unexpected: fallback('unexpected'),
    emailRequired: fallback('emailRequired'),
    emailInvalid: fallback('emailInvalid'),
    passwordRequired: fallback('passwordRequired')
  };

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [reveal, setReveal] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [errors, setErrors] = React.useState<Errors>({});
  const submitting = React.useRef(false);

  const validate = (): boolean => {
    const next: Errors = {};
    if (!email.trim()) next.email = T.emailRequired;
    else if (!EMAIL_RE.test(email.trim())) next.email = T.emailInvalid;
    if (!password) next.password = T.passwordRequired;
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    if (!validate()) return;
    submitting.current = true;
    setLoading(true);
    setErrors({});
    try {
      await loginFn(email.trim(), password);
      onSuccess?.();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'RATE_LIMITED') setErrors({ form: T.rateLimited });
      else if (code === 'INVALID_CREDENTIALS' || code === 'UNAUTHENTICATED') setErrors({ form: T.invalidCredentials });
      else setErrors({ form: T.unexpected });
    } finally {
      setLoading(false);
      submitting.current = false;
    }
  };

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{T.title}</h1>
        <p className="text-sm text-muted-foreground">{T.subtitle}</p>
      </div>
      <form onSubmit={submit} noValidate className="space-y-4" aria-busy={loading}>
        <div className="space-y-1.5">
          <Label htmlFor="email">{T.email}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? 'email-error' : undefined}
            disabled={loading}
            required
          />
          {errors.email ? (
            <p id="email-error" className="text-xs text-destructive">
              {errors.email}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">{T.password}</Label>
          <div className="flex items-center gap-2">
            <Input
              id="password"
              name="password"
              type={reveal ? 'text' : 'password'}
              autoComplete="current-password"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? 'password-error' : undefined}
              disabled={loading}
              required
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => setReveal((r) => !r)} aria-label={reveal ? T.hidePassword : T.showPassword}>
              {reveal ? '🙈' : '👁'}
            </Button>
          </div>
          {errors.password ? (
            <p id="password-error" className="text-xs text-destructive">
              {errors.password}
            </p>
          ) : null}
        </div>

        {errors.form ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {errors.form}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? T.signingIn : T.submit}
        </Button>
      </form>
    </div>
  );
}
