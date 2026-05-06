'use client';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, CalendarDays } from 'lucide-react';
import { api, fmt } from '@/lib/api';
import type { DodLeadDay, DodLeadCampaign } from '@/types';

// Sales-action bucket → matching funnel_stage URL param + display name.
// Single source of truth: changing this updates BOTH the column header AND
// the deep-link query string, so they can never drift apart.
// Explicitly typed so TS treats `accent` as a uniform optional field across
// all entries. Using `as const` made each item a narrow tuple member where
// `accent` only existed on the first entry — broke the build.
type Bucket = {
  key: 'top_priority' | 'interested_only' | 'callback_only' | 'no_intent';
  label: string;
  hint: string;
  accent?: boolean;
};

const BUCKETS: Bucket[] = [
  { key: 'top_priority',    label: 'Top Priority',     hint: 'Interested + Callback', accent: true },
  { key: 'interested_only', label: 'Interested only',  hint: 'HIGH/MEDIUM, no callback ask' },
  { key: 'callback_only',   label: 'Callback only',    hint: 'Asked callback, low/unclear interest' },
  { key: 'no_intent',       label: 'No intent',        hint: 'Connected but no positive signal' },
];

// Format an IST ISO date ("2026-05-05") for display. Uses en-IN locale so
// dd MMM yyyy reads naturally for this team. We construct as UTC midnight
// then format with timeZone='UTC' to avoid the browser shifting the day.
function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

// Build a /calls deep-link with date range + funnel_stage. Used for the
// day-level (parent) row clicks. The window is the full IST calendar day
// converted back to ISO. Calls page filters on vendor_created_at which
// matches the upload time, so this isolates exactly that day's leads.
function dayLink(isoDate: string, funnel_stage: string): string {
  // Construct local IST midnight bounds. Asia/Kolkata = UTC+5:30 with no
  // DST changes, so we can do the offset arithmetically rather than rely
  // on Date constructor TZ behaviour.
  const dayStart = new Date(`${isoDate}T00:00:00+05:30`);
  const dayEnd   = new Date(`${isoDate}T23:59:59+05:30`);
  const q = new URLSearchParams({
    start: dayStart.toISOString(),
    end:   dayEnd.toISOString(),
    funnel_stage,
  });
  return `/calls?${q.toString()}`;
}

// Campaign-level link — uses campaign_ids instead of date so the calls
// page filters to that campaign exactly. Date is implicit in the
// campaign's own data and doesn't need to be doubly-restricted.
function campaignLink(campaignId: string, funnel_stage: string): string {
  const q = new URLSearchParams({ funnel_stage });
  q.append('campaign_ids', campaignId);
  return `/calls?${q.toString()}`;
}

export default function DodLeadsPage() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const dod = useQuery({ queryKey: ['dod-leads'], queryFn: () => api.dodLeads() });

  const toggle = (date: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(date) ? next.delete(date) : next.add(date);
      return next;
    });
  };

  const days = dod.data?.days ?? [];

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1400px] mx-auto">
      <header>
        <h1 className="text-xl md:text-2xl font-semibold text-brand-navy flex items-center gap-2">
          <CalendarDays size={22} className="text-brand-pink" />
          DoD Leads
        </h1>
        <p className="text-xs md:text-sm text-surface-500 mt-1">
          Leads grouped by upload date, sliced into the four sales-action buckets.
          Click a row to see the campaign breakdown. Click any number to open the
          matching call list — ready to export.
        </p>
      </header>

      <div className="card overflow-hidden">
        {dod.isLoading && (
          <div className="p-8 text-center text-sm text-surface-500">Loading…</div>
        )}
        {dod.isError && (
          <div className="p-8 text-center text-sm text-red-600">
            Failed to load DoD data. Try refreshing.
          </div>
        )}
        {!dod.isLoading && !dod.isError && days.length === 0 && (
          <div className="p-8 text-center text-sm text-surface-500">
            No leads in the database yet.
          </div>
        )}

        {days.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-50 border-b border-surface-200 text-[11px] uppercase tracking-wider text-surface-600">
                <tr>
                  <th className="text-left py-2.5 px-3 w-8"></th>
                  <th className="text-left py-2.5 px-3">Date</th>
                  <th className="text-right py-2.5 px-3">Total leads</th>
                  {BUCKETS.map(b => (
                    <th key={b.key} className="text-right py-2.5 px-3 whitespace-nowrap">
                      <div className="font-medium">{b.label}</div>
                      <div className="text-[10px] text-surface-400 normal-case font-normal mt-0.5">
                        {b.hint}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map(day => {
                  const isOpen = expanded.has(day.date);
                  const camps = day.campaigns ?? [];
                  const expandable = camps.length > 0;

                  return (
                    <Fragment key={day.date}>
                      {/* Day-level row — clickable to expand. The whole row
                          carries the toggle (UX: bigger hit area). Inside,
                          numeric cells stop propagation so they navigate
                          to /calls instead of toggling expansion.        */}
                      <tr
                        key={day.date}
                        className={`border-b border-surface-100 transition-colors ${
                          expandable ? 'cursor-pointer hover:bg-surface-50' : ''
                        } ${isOpen ? 'bg-surface-50/70' : ''}`}
                        onClick={() => expandable && toggle(day.date)}
                      >
                        <td className="py-3 px-3 text-surface-400">
                          {expandable && (isOpen
                            ? <ChevronDown size={16} />
                            : <ChevronRight size={16} />)}
                        </td>
                        <td className="py-3 px-3 font-medium text-brand-navy whitespace-nowrap">
                          {formatDate(day.date)}
                          {camps.length > 1 && (
                            <span className="ml-2 text-[10px] text-surface-500">
                              {camps.length} campaigns
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right tabular-nums font-medium text-brand-navy">
                          {fmt.int(day.total_leads)}
                        </td>
                        {BUCKETS.map(b => (
                          <td
                            key={b.key}
                            className="py-3 px-3 text-right tabular-nums"
                            onClick={e => e.stopPropagation()}
                          >
                            <DayCell
                              date={day.date}
                              count={(day as any)[b.key] as number}
                              total={day.total_leads}
                              funnelStage={b.key}
                              accent={!!b.accent}
                            />
                          </td>
                        ))}
                      </tr>

                      {/* Campaign-level expansion. Indented, slightly muted
                          background, same column structure so the eye can
                          sum-check easily.                                  */}
                      {isOpen && camps.map(c => (
                        <tr
                          key={`${day.date}-${c.campaign_id}`}
                          className="border-b border-surface-100 bg-surface-50/40 text-[13px]"
                        >
                          <td></td>
                          <td className="py-2.5 px-3 pl-8 text-surface-600 truncate max-w-xs">
                            <span className="text-surface-400 mr-2">↳</span>
                            <span title={c.campaign_name}>{c.campaign_name}</span>
                          </td>
                          <td className="py-2.5 px-3 text-right tabular-nums text-surface-700">
                            {fmt.int(c.total_leads)}
                          </td>
                          {BUCKETS.map(b => (
                            <td
                              key={b.key}
                              className="py-2.5 px-3 text-right tabular-nums"
                            >
                              <CampaignCell
                                campaignId={c.campaign_id}
                                count={(c as any)[b.key] as number}
                                total={c.total_leads}
                                funnelStage={b.key}
                                accent={!!b.accent}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Helper note — explains the column meanings in one place so every
          tooltip on each row doesn't have to repeat them.                */}
      <div className="card p-4 text-[11px] text-surface-500 leading-relaxed">
        <strong className="text-surface-700">How this is computed:</strong> Each lead is one
        unique phone number, classified into exactly one bucket among Top Priority /
        Interested only / Callback only / No intent (mutually exclusive among connected
        leads). Unreached leads (still being retried, voicemail, hard fail) are NOT in
        these four columns — see Total to gauge what's still pending. Numbers
        click-through to Call Logs with matching filters pre-applied, ready to export.
      </div>
    </div>
  );
}

// ---- Cell components ----------------------------------------------------
// Two cell variants: day-level deep-links via date range, campaign-level
// via campaign_id. Visual treatment is shared but the link differs.

function DayCell({
  date, count, total, funnelStage, accent,
}: { date: string; count: number; total: number; funnelStage: string; accent: boolean }) {
  return (
    <CellLink
      href={dayLink(date, funnelStage)}
      count={count}
      total={total}
      accent={accent}
      bold
    />
  );
}

function CampaignCell({
  campaignId, count, total, funnelStage, accent,
}: { campaignId: string; count: number; total: number; funnelStage: string; accent: boolean }) {
  return (
    <CellLink
      href={campaignLink(campaignId, funnelStage)}
      count={count}
      total={total}
      accent={accent}
      bold={false}
    />
  );
}

function CellLink({
  href, count, total, accent, bold,
}: { href: string; count: number; total: number; accent: boolean; bold: boolean }) {
  // Zero counts shouldn't be clickable — there's nothing to drill into.
  // Greyed out and non-link to make this obvious.
  if (count === 0) {
    return <span className="text-surface-300">0</span>;
  }
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <Link
      href={href}
      className={`inline-flex items-baseline gap-1.5 px-2 py-0.5 rounded transition-colors ${
        accent
          ? 'text-emerald-700 hover:bg-emerald-50'
          : 'text-brand-navy hover:bg-surface-100'
      } ${bold ? 'font-semibold' : ''}`}
      title={`Open Call Logs filtered to these ${fmt.int(count)} leads`}
    >
      <span>{fmt.int(count)}</span>
      <span className="text-[10px] text-surface-400 font-normal">
        {pct.toFixed(0)}%
      </span>
    </Link>
  );
}
