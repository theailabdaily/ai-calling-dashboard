/**
 * Hostname-aware routing + auth gate.
 *
 * Two hostnames serve from the same Vercel project:
 *
 *   1. Main dashboard (any host that is NOT the lookup host)
 *      → Basic auth required (DASHBOARD_USERNAME + DASHBOARD_PASSWORD env vars).
 *      → Full app available.
 *
 *   2. Lookup tool: 'ai-lookup.vercel.app' (overridable via LOOKUP_HOSTNAME env)
 *      → No auth — BDAs paste the URL and use it.
 *      → Every non-lookup, non-_next, non-api path is rewritten to /lookup.
 *      → Sets x-is-lookup-host: 1 header so server components can render
 *        without sidebar/mobile-nav (the rewrite-target /lookup is opaque
 *        to client components which still see the original URL).
 */
import { NextRequest, NextResponse } from 'next/server';

const LOOKUP_HOSTNAME = process.env.LOOKUP_HOSTNAME || 'ai-lookup.vercel.app';

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') || '';
  const pathname = req.nextUrl.pathname;

  // ---- Lookup hostname: no auth, lookup-only sandbox ----
  if (host === LOOKUP_HOSTNAME) {
    // Allow Next.js internal asset routes through unconditionally
    if (pathname.startsWith('/_next')) {
      const r = NextResponse.next();
      r.headers.set('x-is-lookup-host', '1');
      return r;
    }

    // Lookup feature itself: page + its 2 backing endpoints — pass through
    // so the URL stays clean.
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

    // Everything else gets rewritten back to /lookup. Set the header on
    // both the request (so server components can read it) and the response.
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

  // ---- Main hostname: basic auth ----
  const user = process.env.DASHBOARD_USERNAME || 'admin';
  const pass = process.env.DASHBOARD_PASSWORD;

  if (!pass) {
    return new NextResponse('DASHBOARD_PASSWORD not configured', { status: 500 });
  }

  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const got = req.headers.get('authorization');

  if (got !== expected) {
    return new NextResponse('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Testbook AI Calling Analytics"' },
    });
  }

  // Picker route: tag it so the root layout knows to skip the sidebar.
  // Sidebar showing on /select is weird because no product line is selected yet.
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
}

// Run on every page + API route, skip Next internals + static assets
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logo-light.png|logo-dark.png).*)'],
};
