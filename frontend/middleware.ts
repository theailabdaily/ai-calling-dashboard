/**
 * Hostname-aware routing + NextAuth session gate.
 *
 * Two hostnames serve from the same Vercel project:
 *
 *   1. Lookup tool ('ai-lookup.vercel.app', overridable via LOOKUP_HOSTNAME env)
 *      → NO auth required. BDAs paste the URL and use it.
 *      → Every non-lookup, non-_next, non-api path is rewritten to /lookup.
 *      → Sets x-is-lookup-host: 1 so server components skip sidebar.
 *
 *   2. Main dashboard (any other host)
 *      → Google SSO required (NextAuth v5). Only @testbook.com signin allowed.
 *      → Public routes: /login, /api/auth/* (NextAuth's own endpoints).
 *      → Sets x-is-picker: 1 on /select so the layout skips the sidebar.
 *
 * Audit logging (who signed in / who was blocked) happens inside the NextAuth
 * signIn / signOut callbacks in auth.ts → POSTed to backend /internal/auth-events.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';

const LOOKUP_HOSTNAME = process.env.LOOKUP_HOSTNAME || 'ai-lookup.vercel.app';

// Routes that never require auth on the main hostname:
//  - /login: the signin page itself
//  - /api/auth/*: NextAuth's own endpoints (signin, callback, csrf, etc.)
const PUBLIC_PATHS = ['/login'];
function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith('/api/auth/')) return true;
  return PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'));
}

export default auth(function middleware(req) {
  const host = req.headers.get('host') || '';
  const pathname = req.nextUrl.pathname;

  // ---- Lookup hostname: no auth ----
  if (host === LOOKUP_HOSTNAME) {
    if (pathname.startsWith('/_next')) {
      const r = NextResponse.next();
      r.headers.set('x-is-lookup-host', '1');
      return r;
    }
    if (
      pathname === '/lookup' ||
      pathname.startsWith('/lookup/') ||
      pathname === '/api/lookup' ||
      pathname.startsWith('/api/lookup/')
    ) {
      const r = NextResponse.next();
      r.headers.set('x-is-lookup-host', '1');
      return r;
    }
    const url = req.nextUrl.clone();
    url.pathname = '/lookup';
    const r = NextResponse.rewrite(url, {
      request: {
        headers: new Headers({
          ...Object.fromEntries(req.headers),
          'x-is-lookup-host': '1',
        }),
      },
    });
    r.headers.set('x-is-lookup-host', '1');
    return r;
  }

  // ---- Main hostname: NextAuth session required ----
  const session = req.auth;
  if (!session && !isPublicPath(pathname)) {
    const loginUrl = new URL('/login', req.url);
    if (pathname !== '/') {
      loginUrl.searchParams.set('next', pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  if (session && pathname === '/login') {
    return NextResponse.redirect(new URL('/', req.url));
  }

  // Tag /login so the layout knows to hide the sidebar.
  if (pathname === '/login') {
    return NextResponse.next({
      request: {
        headers: new Headers({
          ...Object.fromEntries(req.headers),
          'x-is-login': '1',
        }),
      },
    });
  }

  // Tag /select so the root layout knows to hide the sidebar.
  if (pathname === '/select') {
    return NextResponse.next({
      request: {
        headers: new Headers({
          ...Object.fromEntries(req.headers),
          'x-is-picker': '1',
        }),
      },
    });
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|favicon.svg|favicon-32.png|favicon-16.png|apple-touch-icon.png|logo-light.png|logo-dark.png).*)'],
};
