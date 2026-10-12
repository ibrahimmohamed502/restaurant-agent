import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/** Public routes that never require a session. */
const PUBLIC_PATHS = ['/login'];

export function middleware(req: NextRequest) {
  const { nextUrl } = req;
  const hasSession = req.cookies.has('lwc_session');
  const isPublic = PUBLIC_PATHS.some((p) => nextUrl.pathname === p || nextUrl.pathname.startsWith(`${p}/`));

  if (!hasSession && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  if (hasSession && nextUrl.pathname === '/login') {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|favicon.svg|manifest.webmanifest|images).*)']
};
