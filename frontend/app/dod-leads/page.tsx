'use client';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ChevronDown, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight,
  CalendarDays, Download,
} from 'lucide-react';
import { api, fmt } from '@/lib/api';
import type { DodLeadCampaign, Filters } from '@/types';

// Sales-action bucket → matching funnel_stage URL param + display name.
// Single source of truth: changing this updates BOTH the column header AND
// the deep-link query string, so they can never drift apart.
// Explicitly typed so TS treats `accent` as a uniform optional field across
// all entries. Using `as const` made each item a narrow tuple member where
// `accent` only existed on the first entry — broke the build.
type BucketKey = 'top_priority' | 'interested_only' | 'callback_only' | 'no_intent';
type Bucket = {
  key: BucketKey;
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

// Date range presets. `days: null` means "no lower bound" (all time).
type RangeKey = 'last_7' | 'last_30' | 'last_90' | 'all_time';
const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: 'last_7',   label: 'Last 7 days',   days: 7   },
  { key: 'last_30',  label: 'Last 30 days',  days: 30  },
  { key: 'last_90',  label: 'Last 90 days',  days: 90  },
  { key: 'all_time', label: 'All time',      days: null },
];

type ViewMode = 'date' | 'campaign';

const PAGE_SIZES = [10, 25, 50, 100];

// Default ticked buckets when the page first loads. "No intent" is off by
// default because the BD handoff workflow centres on actionable leads;
// users can tick it explicitly when they want it in the CSV.
const DEFAULT_BUCKETS: BucketKey[] = ['top_priority', 'interested_only', 'callback_only'];

// Format an IST ISO date ("2026-05-05") for display. Uses en-IN locale so
// dd MMM yyyy reads naturally for this team. We construct as UTC midnight
// then format with timeZone='UTC' to avoid the browser shifting the day.
function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

// Compute today's ISO date in IST (YYYY-MM-DD). We can't use new Date()'s
// local TZ because Render/Vercel servers run UTC; doing the IST shift
// arithmetically is more predictable than relying on Intl.
function todayIST(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60_000);
  return ist.toISOString().slice(0, 10);
}

// Subtract N days from an ISO date, in IST.
function isoMinusDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Build a /calls deep-link with date range + funnel_stage. Used for the
// day-level (parent) row clicks. The window is the full IST calendar day
// converted back to ISO. Calls page filters on vendor_created_at which
// matches the upload time, so this isolates exactly that day's leads.
function dayLink(isoDate: string, funnel_stage: string): string {
  // Asia/Kolkata = UTC+5:30, no DST — we can offset arithmetically.
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

// Range-level link — filters /calls to the date span currently shown on
// the totals row. Used by the totals-row cell click-throughs.
function rangeLink(startIso: string, endIso: string, funnel_stage: string): string {
  const start = new Date(`${startIso}T00:00:00+05:30`).toISOString();
  const end   = new Date(`${endIso}T23:59:59+05:30`).toISOString();
  const q = new URLSearchParams({ start, end, funnel_stage });
  return `/calls?${q.toString()}`;
}

export default function DodLeadsPage() {
  // Accordion state — only one row can be expanded at a time. Re-used for
  // both date and campaign views (key is row id, not date specifically).
  const [expanded, setExpanded] = useState<string | null>(null);
  const [range, setRange]       = useState<RangeKey>('last_30');
  const [view, setView]         = useState<ViewMode>('date');
  const [page, setPage]         = useState(0);
  const [pageSize, setPageSize] = useState<number>(10);
  const [selected, setSelected] = useState<Set<BucketKey>>(new Set(DEFAULT_BUCKETS));

  const dod = useQuery({ queryKey: ['dod-leads'], queryFn: () => api.dodLeads() });
  const allDays = dod.data?.days ?? [];

  // Filter days by selected date range. Done client-side because the
  // backend already returns the full set per day; filtering here keeps
  // the range picker instant with no extra round-trip.
  const filteredDays = useMemo(() => {
    const cfg = RANGES.find(r => r.key === range);
    if (!cfg || cfg.days === null) return allDays;
    const cutoff = isoMinusDays(todayIST(), cfg.days);
    return allDays.filter(d => d.date >= cutoff);
  }, [allDays, range]);

  // The actual start/end ISO dates in the filtered set — used for export
  // and for the totals-row click-throughs. Falls back to today if empty.
  const dateBounds = useMemo(() => {
    if (filteredDays.length === 0) {
      const t = todayIST();
      return { start: t, end: t };
    }
    const sorted = filteredDays.map(d => d.date).sort();
    return { start: sorted[0], end: sorted[sorted.length - 1] };
  }, [filteredDays]);

  // By-campaign aggregation. We flatten every (day, campaign) pair into a
  // map keyed by campaign_id, summing counts. `dates` tracks which days a
  // campaign was active so we can show a sub-label and sort by recency.
  type CampaignRow = DodLeadCampaign & { dates: string[] };
  const campaignRows: CampaignRow[] = useMemo(() => {
    if (view !== 'campaign') return [];
    const map = new Map<string, CampaignRow>();
    for (const day of filteredDays) {
      for (const c of day.campaigns ?? []) {
        const cur = map.get(c.campaign_id);
        if (cur) {
          cur.total_leads     += c.total_leads;
          cur.top_priority    += c.top_priority;
          cur.interested_only += c.interested_only;
          cur.callback_only   += c.callback_only;
          cur.no_intent       += c.no_intent;
          cur.unreached       += c.unreached;
          cur.dates.push(day.date);
        } else {
          map.set(c.campaign_id, { ...c, dates: [day.date] });
        }
      }
    }
    // Sort by latest activity date descending — matches the rhythm of
    // the date view (most recent first).
    return Array.from(map.values()).sort((a, b) => {
      const aLatest = a.dates.slice().sort().pop() ?? '';
      const bLatest = b.dates.slice().sort().pop() ?? '';
      return bLatest.localeCompare(aLatest);
    });
  }, [view, filteredDays]);

  // Unified row count for pagination. Switching view resets page to 0 to
  // avoid landing on an out-of-range page.
  const totalRows = view === 'date' ? filteredDays.length : campaignRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const startIdx = page * pageSize;
  const endIdx   = Math.min(startIdx + pageSize, totalRows);
  const pageDays      = view === 'date'     ? filteredDays.slice(startIdx, endIdx)  : [];
  const pageCampaigns = view === 'campaign' ? campaignRows.slice(startIdx, endIdx)  : [];

  // Totals across the ENTIRE filtered range (not just visible page). This
  // matches what gets exported when Export CSV is clicked.
  const totals = useMemo(() => {
    const src = view === 'date' ? filteredDays : campaignRows;
    return src.reduce(
      (acc, r) => ({
        total_leads:     acc.total_leads     + r.total_leads,
        top_priority:    acc.top_priority    + r.top_priority,
        interested_only: acc.interested_only + r.interested_only,
        callback_only:   acc.callback_only   + r.callback_only,
        no_intent:       acc.no_intent       + r.no_intent,
      }),
      { total_leads: 0, top_priority: 0, interested_only: 0, callback_only: 0, no_intent: 0 },
    );
  }, [view, filteredDays, campaignRows]);

  // Sum of leads across ticked buckets — the number that will appear in
  // the CSV(s) once Export is clicked.
  const selectedCount = useMemo(() => {
    let n = 0;
    for (const k of selected) n += (totals as any)[k] as number;
    return n;
  }, [selected, totals]);

  const toggle = (rowId: string) => {
    setExpanded(prev => (prev === rowId ? null : rowId));
  };

  const toggleBucket = (k: BucketKey) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  // Export: one CSV per ticked bucket. Each download reuses the existing
  // /api/export/calls.csv endpoint with the bucket's funnel_stage. We
  // stagger them by 350ms so browsers don't suppress subsequent
  // programmatic downloads in the same click event.
  const handleExport = () => {
    if (selected.size === 0) return;
    const filters: Filters = {
      start: new Date(`${dateBounds.start}T00:00:00+05:30`),
      end:   new Date(`${dateBounds.end}T23:59:59+05:30`),
      vendor_ids: [],
      campaign_ids: [],
    };
    const buckets = Array.from(selected);
    buckets.forEach((bucket, i) => {
      setTimeout(() => {
        const url = api.exportCallsUrl(filters, { funnel_stage: bucket });
        const a = document.createElement('a');
        a.href = url;
        a.download = `dod_leads_${bucket}_${dateBounds.start}_to_${dateBounds.end}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, i * 350);
    });
  };

  // Reset to first page whenever the underlying row set changes shape
  // (range or view change). Without this you can land on page 3 of 5
  // and then change the view to one with only 1 page, leaving the table
  // empty.
  const onRangeChange = (k: RangeKey) => {
    setRange(k);
    setPage(0);
    setExpanded(null);
  };
  const onViewChange = (v: ViewMode) => {
    setView(v);
    setPage(0);
    setExpanded(null);
  };
  const onPageSizeChange = (n: number) => {
    setPageSize(n);
    setPage(0);
  };

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

      {/* ---- Toolbar -------------------------------------------------- */}
      {/* Single row: view toggle, date range, Export CSV.                */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex bg-surface-100 border border-surface-200 rounded-md p-0.5">
          <button
            type="button"
            onClick={() => onViewChange('date')}
            className={`text-xs px-3 py-1.5 rounded transition-colors ${
              view === 'date'
                ? 'bg-white text-brand-navy font-medium shadow-sm'
                : 'text-surface-500 hover:text-brand-navy'
            }`}
          >
            By date
          </button>
          <button
            type="button"
            onClick={() => onViewChange('campaign')}
            className={`text-xs px-3 py-1.5 rounded transition-colors ${
              view === 'campaign'
                ? 'bg-white text-brand-navy font-medium shadow-sm'
                : 'text-surface-500 hover:text-brand-navy'
            }`}
          >
            By campaign
          </button>
        </div>

        <select
          value={range}
          onChange={e => onRangeChange(e.target.value as RangeKey)}
          className="text-xs border border-surface-200 rounded-md px-2.5 py-1.5 bg-white text-brand-navy hover:border-surface-300 focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
        >
          {RANGES.map(r => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>

        {filteredDays.length > 0 && (
          <span className="text-[11px] text-surface-500 whitespace-nowrap">
            {formatDate(dateBounds.start)} → {formatDate(dateBounds.end)}
          </span>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={handleExport}
          disabled={selected.size === 0 || filteredDays.length === 0}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-surface-300 bg-white text-brand-navy font-medium hover:border-brand-pink hover:text-brand-pink transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-surface-300 disabled:hover:text-brand-navy"
          title={selected.size === 0 ? 'Tick at least one bucket below' : `Download ${selected.size} CSV file(s)`}
        >
          <Download size={13} />
          Export CSV
        </button>
      </div>

      {/* ---- Table ---------------------------------------------------- */}
      <div className="card overflow-hidden">
        {dod.isLoading && (
          <div className="p-8 text-center text-sm text-surface-500">Loading…</div>
        )}
        {dod.isError && (
          <div className="p-8 text-center text-sm text-red-600">
            Failed to load DoD data. Try refreshing.
          </div>
        )}
        {!dod.isLoading && !dod.isError && totalRows === 0 && (
          <div className="p-8 text-center text-sm text-surface-500">
            {allDays.length === 0
              ? 'No leads in the database yet.'
              : 'No leads in the selected date range. Try widening it.'}
          </div>
        )}

        {totalRows > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-50 border-b border-surface-200 text-[11px] uppercase tracking-wider text-surface-600">
                <tr>
                  <th className="text-left py-2.5 px-3 w-8"></th>
                  <th className="text-left py-2.5 px-3">
                    {view === 'date' ? 'Date' : 'Campaign'}
                  </th>
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
                {/* --- By-date view rows --- */}
                {view === 'date' && pageDays.map(day => {
                  const isOpen = expanded === day.date;
                  const camps = day.campaigns ?? [];
                  const expandable = camps.length > 0;

                  return (
                    <Fragment key={day.date}>
                      <tr
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

                {/* --- By-campaign view rows --- */}
                {view === 'campaign' && pageCampaigns.map(c => {
                  const sortedDates = c.dates.slice().sort();
                  const earliest = sortedDates[0];
                  const latest   = sortedDates[sortedDates.length - 1];
                  return (
                    <tr
                      key={c.campaign_id}
                      className="border-b border-surface-100 hover:bg-surface-50 transition-colors"
                    >
                      <td className="py-3 px-3 text-surface-400"></td>
                      <td className="py-3 px-3 font-medium text-brand-navy">
                        <div className="truncate max-w-xs" title={c.campaign_name}>
                          {c.campaign_name}
                        </div>
                        <div className="text-[10px] text-surface-500 font-normal mt-0.5">
                          {sortedDates.length === 1
                            ? formatDate(earliest)
                            : `${formatDate(earliest)} → ${formatDate(latest)} · ${sortedDates.length} days`}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right tabular-nums font-medium text-brand-navy">
                        {fmt.int(c.total_leads)}
                      </td>
                      {BUCKETS.map(b => (
                        <td key={b.key} className="py-3 px-3 text-right tabular-nums">
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
                  );
                })}

                {/* --- All-dates total row with inline bucket checkboxes ---
                    Sums across the ENTIRE filtered range, not just the
                    visible page. Each bucket cell has a checkbox inline
                    with its number: ticking it includes that bucket in
                    the Export CSV. Click on the number itself still
                    deep-links to Call Logs for that bucket.            */}
                <tr className="border-t-2 border-surface-300 bg-surface-50/80 font-semibold">
                  <td></td>
                  <td className="py-3 px-3 text-brand-navy uppercase text-[11px] tracking-wider">
                    All dates total
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums text-brand-navy">
                    {fmt.int(totals.total_leads)}
                  </td>
                  {BUCKETS.map(b => {
                    const isSelected = selected.has(b.key);
                    const count = (totals as any)[b.key] as number;
                    return (
                      <td key={b.key} className="py-3 px-3 text-right tabular-nums">
                        <label
                          className="inline-flex items-center gap-2 cursor-pointer select-none"
                          title={isSelected
                            ? `${b.label} will be included in Export CSV`
                            : `Tick to include ${b.label} in Export CSV`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleBucket(b.key)}
                            className={`h-3.5 w-3.5 rounded border-surface-300 cursor-pointer ${
                              b.accent ? 'accent-emerald-600' : 'accent-brand-pink'
                            }`}
                          />
                          {count === 0 ? (
                            <span className="text-surface-300">0</span>
                          ) : (
                            <Link
                              href={rangeLink(dateBounds.start, dateBounds.end, b.key)}
                              onClick={e => e.stopPropagation()}
                              className={`hover:underline ${
                                isSelected
                                  ? (b.accent ? 'text-emerald-700' : 'text-brand-navy')
                                  : 'text-surface-400'
                              }`}
                              title="Open this bucket in Call Logs"
                            >
                              {fmt.int(count)}
                            </Link>
                          )}
                        </label>
                      </td>
                    );
                  })}
                </tr>
                <tr className="bg-surface-50/80">
                  <td></td>
                  <td colSpan={6} className="px-3 pb-2.5 pt-0 text-[11px] text-surface-500 italic">
                    Tick the buckets to include in Export CSV
                    {selected.size > 0 && (
                      <> — <span className="font-medium not-italic text-surface-700">{fmt.int(selectedCount)} leads selected</span></>
                    )}
                    {selected.size > 1 && (
                      <span className="text-surface-400"> ({selected.size} CSV files)</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- Pagination ---------------------------------------------- */}
      {totalRows > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-4">
            <span className="text-surface-500">
              Showing {fmt.int(startIdx + 1)}–{fmt.int(endIdx)} of {fmt.int(totalRows)}
              {' '}{view === 'date' ? 'days' : 'campaigns'}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-surface-500">Rows</span>
              <select
                value={pageSize}
                onChange={e => onPageSizeChange(Number(e.target.value))}
                className="border border-surface-200 rounded-md px-1.5 py-0.5 bg-white text-brand-navy"
              >
                {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(0)}
              disabled={page === 0}
              className="p-1 rounded hover:bg-surface-100 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="First page"
            >
              <ChevronsLeft size={14} />
            </button>
            <button
              type="button"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1 rounded hover:bg-surface-100 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-2 text-surface-700 tabular-nums">
              {page + 1} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-1 rounded hover:bg-surface-100 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </button>
            <button
              type="button"
              onClick={() => setPage(totalPages - 1)}
              disabled={page >= totalPages - 1}
              className="p-1 rounded hover:bg-surface-100 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Last page"
            >
              <ChevronsRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Helper note — explains the column meanings in one place so every
          tooltip on each row doesn't have to repeat them.                */}
      <div className="card p-4 text-[11px] text-surface-500 leading-relaxed">
        <strong className="text-surface-700">How this is computed:</strong> Each lead is one
        unique phone number, classified into exactly one bucket among Top Priority /
        Interested only / Callback only / No intent (mutually exclusive among connected
        leads). Unreached leads (still being retried, voicemail, hard fail) are NOT in
        these four columns — see Total leads to gauge what's still pending. Numbers
        click-through to Call Logs with matching filters pre-applied, ready to export.
        Export CSV downloads one file per ticked bucket (existing /calls export format)
        — merge them into your master sheet via VLOOKUP on mobile_number.
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
