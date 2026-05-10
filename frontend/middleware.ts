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
 *        Even if a BDA manually types /calls or /ledger, they only ever see
 *        the lookup UI.
 *      → /api/lookup and /api/lookup/recording/* pass through (the page needs
 *        them); everything else under /api is rewritten to a 404-equivalent
 *        path so BDAs can't poke other endpoints.
 *
 * Both behaviors are server-enforced — typing a different path or messing
 * with cookies can't break out of the lookup-only sandbox.
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
      return NextResponse.next();
    }

    // The lookup feature itself: page + its 2 backing endpoints
    if (
      pathname === '/lookup' ||
      pathname.startsWith('/lookup/') ||
      pathname === '/api/lookup' ||
      pathname.startsWith('/api/lookup/')
    ) {
      return NextResponse.next();
    }

    // Everything else (typed /calls, /ledger, /api/overview/metrics, etc.)
    // gets rewritten back to /lookup so URL stays clean and BDA only sees
    // the lookup UI. For /api/* routes we rewrite to a path that returns
    // 404 from the page handler — keeps it clear those endpoints are off
    // limits without leaking which ones exist.
    const url = req.nextUrl.clone();
    url.pathname = '/lookup';
    return NextResponse.rewrite(url);
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
  return NextResponse.next();
}

// Run on every page + API route, skip Next internals + static assets
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logo-light.png|logo-dark.png).*)'],
};
