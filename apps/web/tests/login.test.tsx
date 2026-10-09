import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { LoginForm } from '@/features/auth/login-form';
import messages from '@/messages/en.json';

const texts = {
  title: 'Sign in',
  subtitle: 'Enter your credentials',
  email: 'Email',
  password: 'Password',
  submit: 'Sign in',
  signingIn: 'Signing in…',
  showPassword: 'Show password',
  hidePassword: 'Hide password',
  invalidCredentials: 'Invalid email or password',
  rateLimited: 'Too many attempts.',
  unexpected: 'Something went wrong.',
  emailRequired: 'Email is required',
  emailInvalid: 'Invalid email format',
  passwordRequired: 'Password is required'
};

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
}

describe('LoginForm (rendering + accessibility)', () => {
  it('renders email + password inputs with hidden type and accessible labels', () => {
    const html = render(<LoginForm texts={texts} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('for="email"');
    expect(html).toContain('for="password"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('autoComplete="current-password"');
    // credential inputs are LTR even inside RTL pages
    expect(html).toContain('dir="ltr"');
    // submit button exists and is keyboard-accessible
    expect(html).toContain('type="submit"');
    expect(html).toContain('aria-busy="false"');
  });

  it('uses injected texts (i18n) instead of hardcoded strings', () => {
    const html = render(<LoginForm texts={{ ...texts, submit: 'ENTRAR' }} />);
    expect(html).toContain('ENTRAR');
  });

  it('accepts an injected login function without calling it on render', () => {
    const loginFn = vi.fn().mockResolvedValue({ user: { id: 'u', email: 'a@b.co', name: 'A', roles: [] } });
    const html = render(<LoginForm texts={texts} loginFn={loginFn} />);
    expect(html).toContain('Sign in');
    expect(loginFn).not.toHaveBeenCalled();
  });

  it('show/hide password control is present', () => {
    const html = render(<LoginForm texts={texts} />);
    expect(html).toContain(texts.showPassword);
  });
});
