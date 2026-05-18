/**
 * NextAuth v5 configuration.
 *
 * Single sign-on for the AI Calling Analytics dashboard.
 *
 *   - Provider: Google OAuth (Testbook Workspace)
 *   - Domain restriction: only @testbook.com emails can sign in
 *   - Audit logging: every signin / blocked attempt / signout is POSTed to
 *     the backend /internal/auth-events endpoint for the admin activity page
 *
 * Exported helpers used elsewhere:
 *   - handlers (mounted at /api/auth/[...nextauth])
 *   - auth (called in middleware + server components)
 *   - signIn / signOut (called from client/server components)
 */
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

const ALLOWED_EMAIL_DOMAIN = '@testbook.com';
const BACKEND_URL = process.env.NEXT_PUBLIC_API_BASE || '';

async function logAuthEvent(payload: {
  email: string;
  event: 'signin_success' | 'signin_blocked_non_testbook' | 'signout' | 'signin_error';
  ip?: string | null;
  user_agent?: string | null;
}) {
  const secret = process.env.AUTH_LOG_SECRET;
  if (!secret || !BACKEND_URL) {
    // Non-fatal: don't block signin if logging fails. Surface in server logs only.
    console.warn('[auth] audit log skipped — missing AUTH_LOG_SECRET or NEXT_PUBLIC_API_BASE');
    return;
  }
  try {
    await fetch(`${BACKEND_URL}/internal/auth-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Log-Secret': secret,
      },
      body: JSON.stringify(payload),
      // Short timeout — audit logging must NEVER hang a signin flow
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.warn('[auth] failed to log audit event:', err);
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: '/login',
    error: '/login',
  },
  callbacks: {
    async signIn({ user, account }) {
      const email = (user?.email || '').toLowerCase();
      if (!email.endsWith(ALLOWED_EMAIL_DOMAIN)) {
        await logAuthEvent({
          email: email || '(no email returned by Google)',
          event: 'signin_blocked_non_testbook',
        });
        // Returning false sends user to the error page (which we route back
        // to /login). Returning a redirect URL string is also valid.
        return '/login?error=AccessDenied';
      }
      await logAuthEvent({
        email,
        event: 'signin_success',
      });
      return true;
    },
    // JWT and session callbacks — pass email through so middleware can read it
    async jwt({ token, user }) {
      if (user?.email) token.email = user.email;
      return token;
    },
    async session({ session, token }) {
      if (token?.email && session.user) {
        session.user.email = token.email as string;
      }
      return session;
    },
  },
  events: {
    async signOut(message) {
      const email = 'token' in message && message.token?.email
        ? (message.token.email as string)
        : 'unknown';
      await logAuthEvent({ email, event: 'signout' });
    },
  },
  // Session strategy: JWT (stateless, no DB needed for sessions themselves).
  // Audit log is separate — those go to Postgres via backend.
  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,
  // Trust the host header (Vercel sets this correctly)
  trustHost: true,
});
