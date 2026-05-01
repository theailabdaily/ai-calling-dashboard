/**
 * HTTP Basic Auth gate.
 * Set DASHBOARD_USERNAME + DASHBOARD_PASSWORD in Vercel env.
 * Browser remembers the credentials for the session.
 *
 * To "log out": close the browser or clear site data.
 * Webhooks bypass this because they hit the backend (Render) directly,
 * not the frontend.
 */
import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const user = process.env.DASHBOARD_USERNAME || 'admin';
  const pass = process.env.DASHBOARD_PASSWORD;

  // If no password is set in env, fail closed.
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
