import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const API_UPSTREAM = process.env.API_UPSTREAM || 'http://restaurant-page-agent:3000';

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // Same-origin API proxy: the browser only ever talks to this app; the Next.js
  // server forwards /api/* to the Express backend on the shared docker network.
  // Keeps cookies first-party and avoids CORS entirely.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_UPSTREAM}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy', value: csp }
        ]
      }
    ];
  }
};

export default withNextIntl(nextConfig);
