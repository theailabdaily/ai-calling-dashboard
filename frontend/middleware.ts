/**
 * Hostname-aware routing. Auth removed — no login required.
 *
 * Two hostnames serve from the same Vercel project:
 *
 *   1. Lookup tool ('ai-lookup.vercel.app', overridable via LOOKUP_HOSTNAME env)
 *      → Rewrites all paths to /lookup. Sets x-is-lookup-host: 1.
 *
 *   2. Main dashboard (any other host)
 *      → No auth gate. All routes open.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const LOOKUP_HOSTNAME = process.env.LOOKUP_HOSTNAME || 'ai-lookup.vercel.app';

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') || '';
  const pathname = req.nextUrl.pathname;

  // ---- Lookup hostname: rewrite everything to /lookup ----
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

  // ---- Main dashboard: no auth, open to all ----
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|favicon.svg|favicon-32.png|favicon-16.png|apple-touch-icon.png|logo-light.png|logo-dark.png).*)'],
};
