'use client';

import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Suspense } from 'react';

function LoginInner() {
  const search = useSearchParams();
  const error = search.get('error');
  const next = search.get('next') || '/';

  const isAccessDenied = error === 'AccessDenied';

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-50 p-4">
      <div className="w-full max-w-md">
        <div className="card p-8">
          <header className="text-center mb-6">
            <p className="text-xs uppercase tracking-wider text-surface-500 mb-2">
              Testbook Supercoaching
            </p>
            <h1 className="text-2xl font-semibold text-brand-navy">AI Calling Analytics</h1>
            <p className="text-sm text-surface-500 mt-2">
              Sign in with your Testbook Google account
            </p>
          </header>

          {isAccessDenied && (
            <div className="mb-6 p-3 rounded-md bg-red-50 border border-red-100 text-sm text-red-800">
              <p className="font-medium mb-0.5">Access denied</p>
              <p className="text-red-700">
                Only <code className="px-1 bg-red-100 rounded text-xs">@testbook.com</code> accounts
                can sign in. The attempt has been logged.
              </p>
            </div>
          )}

          {error && !isAccessDenied && (
            <div className="mb-6 p-3 rounded-md bg-amber-50 border border-amber-100 text-sm text-amber-800">
              Sign-in failed. Try again, or reach out if this keeps happening.
            </div>
          )}

          <button
            type="button"
            onClick={() => signIn('google', { callbackUrl: next })}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white border border-surface-200 hover:bg-surface-50 hover:border-surface-300 rounded-lg transition-colors font-medium text-surface-900"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          </button>

          <p className="text-xs text-surface-500 text-center mt-6">
            Sign-in restricted to <code className="px-1 py-0.5 bg-surface-100 rounded text-[11px]">@testbook.com</code>{' '}
            accounts. All sign-in attempts are logged.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
