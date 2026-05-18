'use client';

import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Shield, Check, X, LogOut as LogOutIcon, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import type { AuthEventRow } from '@/types';

function eventBadge(event: AuthEventRow['event']) {
  if (event === 'signin_success') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-50 text-green-800">
        <Check size={11} />
        Signed in
      </span>
    );
  }
  if (event === 'signin_blocked_non_testbook') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-800">
        <X size={11} />
        Blocked
      </span>
    );
  }
  if (event === 'signout') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-100 text-surface-600">
        <LogOutIcon size={11} />
        Signed out
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-800">
      <AlertCircle size={11} />
      {event}
    </span>
  );
}

export default function LoginActivityPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-auth-events'],
    queryFn: () => api.adminAuthEvents(100),
  });

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-[1100px] mx-auto">
      <header>
        <h1 className="text-2xl font-semibold text-brand-navy flex items-center gap-2">
          <Shield size={22} />
          Login activity
        </h1>
        <p className="text-sm text-surface-500 mt-1">
          Last 100 authentication events. Blocked attempts are non-Testbook emails
          that tried to sign in via Google but failed the domain check.
        </p>
      </header>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-50">
              <tr className="text-left text-xs uppercase tracking-wider text-surface-500">
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-3 py-3 font-medium">Event</th>
                <th className="px-3 py-3 font-medium">When</th>
                <th className="px-3 py-3 font-medium">IP</th>
                <th className="px-5 py-3 font-medium">User agent</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-surface-500 text-sm">
                    Loading…
                  </td>
                </tr>
              )}
              {isError && (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-red-600 text-sm">
                    Could not load login activity. Try refreshing.
                  </td>
                </tr>
              )}
              {data && data.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-surface-500 text-sm">
                    No login activity recorded yet.
                  </td>
                </tr>
              )}
              {data?.map(ev => (
                <tr key={ev.id} className="border-t border-surface-100 hover:bg-surface-50">
                  <td
                    className="px-5 py-3 font-medium text-brand-navy max-w-[260px] truncate"
                    title={ev.email}
                  >
                    {ev.email}
                  </td>
                  <td className="px-3 py-3">{eventBadge(ev.event)}</td>
                  <td
                    className="px-3 py-3 text-surface-600 whitespace-nowrap"
                    title={new Date(ev.occurred_at).toLocaleString()}
                  >
                    {formatDistanceToNow(new Date(ev.occurred_at), { addSuffix: true })}
                  </td>
                  <td className="px-3 py-3 text-surface-600 tabular-nums">
                    {ev.ip || '—'}
                  </td>
                  <td
                    className="px-5 py-3 text-surface-500 max-w-[280px] truncate text-xs"
                    title={ev.user_agent || ''}
                  >
                    {ev.user_agent || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
