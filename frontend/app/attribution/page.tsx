'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Upload, X, Plus, Download, Play, ChevronRight, ChevronDown,
  RotateCcw, Shuffle, FileSpreadsheet, AlertCircle, Database, Loader2,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { Agent, Campaign, Filters, Vendor } from '@/types';

// =============================================================================
// Lead Attribution — match dashboard leads against an external outcome CSV
// =============================================================================
// File A = leads
//   Default mode: fetched from this dashboard's own /api/export/calls.csv
//   (DISTINCT ON mobile_number — one row per phone, latest call kept).
//   Bucket column is computed client-side from interest_level + next_step_interest
//   + lifecycle_status + answered_by — same logic the Leads page uses.
//
//   Alternative mode: user uploads a CSV. Falls back to column auto-detection
//   and whatever bucket-like column exists in the file.
//
// File B = outcomes / payments
//   Always uploaded by the user (no internal source for this).
//
// Matching: normalize phones, then for each A row find the earliest B row
// satisfying the time rule. Pre-existing = B exists but only before A.
// Attributed = B exists with a date after A (or same day if toggle is on).
// =============================================================================

// ---- Types -----------------------------------------------------------------

type CSVData = {
  filename: string;
  columns: string[];
  rows: Record<string, string>[];
};

type FilterOperator =
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'gt' | 'lt' | 'between'
  | 'empty' | 'not_empty';

type FilterRule = {
  id: string;
  column: string;
  operator: FilterOperator;
  value: string;
  value2?: string;
};

type ColumnMappingA = {
  phone: string;
  date: string;
  // Display-only columns shown in the preview table between Bucket and A
  // date. Useful for surfacing Vendor / Campaign / Agent in dashboard mode
  // or any custom column from an uploaded CSV. Don't affect matching.
  extras: ExtraMapping[];
};
type ColumnMappingB = {
  phone: string;
  date: string;
  amount?: string;
  amountPaid?: string;
  // Display-only mappings. Shown as columns in the preview tables and
  // appended to download CSVs. Don't affect the matching algorithm.
  // Each entry has a user-editable label + the source column from File B.
  extras: ExtraMapping[];
};

type ExtraMapping = { label: string; column: string };

type AttributionRule = 'b_after_a' | 'any_time';
type FileASource = 'dashboard' | 'upload';
type DashboardRange = 'last_7' | 'last_30' | 'last_90' | 'last_180' | 'all_time';

type MatchedPair = {
  a: Record<string, string>;
  b: Record<string, string>;
  bDateIso: string | null;
  aDateIso: string | null;
  lagDays: number | null;
};

type Results = {
  totalA: number;
  keyMatched: number;
  preExisting: number;
  attributed: number;
  unmatched: number;
  revenueTotal: number;
  revenuePaid: number;
  attributedPairs: MatchedPair[];
  preExistingPairs: MatchedPair[];
  unmatchedRows: Record<string, string>[];
  ranAt: number;
};

// ---- Constants -------------------------------------------------------------

// Dashboard bucket vocabulary. The synthetic `_bucket` column we compute on
// dashboard-fetched rows uses these exact values. For uploaded files we also
// recognise these (so a CSV that already has top_priority/etc. picks up the
// same labels and default selection).
const DASHBOARD_BUCKETS = ['top_priority', 'interested_only', 'callback_only', 'no_intent', 'unreached'];
const DEFAULT_ON_BUCKETS = ['top_priority', 'interested_only', 'callback_only'];

const BUCKET_LABELS: Record<string, string> = {
  top_priority:    'Top Priority',
  interested_only: 'Interested only',
  callback_only:   'Callback only',
  no_intent:       'No intent',
  unreached:       'Unreached',
};

// Display order — pills appear in this order regardless of how unique() sees them
const BUCKET_ORDER: Record<string, number> = {
  top_priority: 0, interested_only: 1, callback_only: 2, no_intent: 3, unreached: 4,
};

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals: 'equals', not_equals: 'not equals',
  contains: 'contains', not_contains: 'does not contain',
  gt: 'greater than', lt: 'less than', between: 'between',
  empty: 'is empty', not_empty: 'is not empty',
};

const RANGE_OPTIONS: { key: DashboardRange; label: string; days: number | null }[] = [
  { key: 'last_7',   label: 'Last 7 days',   days: 7    },
  { key: 'last_30',  label: 'Last 30 days',  days: 30   },
  { key: 'last_90',  label: 'Last 90 days',  days: 90   },
  { key: 'last_180', label: 'Last 180 days', days: 180  },
  { key: 'all_time', label: 'All time',      days: null },
];

// ---- CSV parser (state machine, RFC 4180-ish) ------------------------------

function parseCSV(text: string): { columns: string[]; rows: Record<string, string>[] } {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++;
    } else {
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\n') {
        row.push(field); rows.push(row);
        row = []; field = ''; i++; continue;
      }
      field += ch; i++;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return { columns: [], rows: [] };
  const columns = rows[0].map(c => c.trim());
  const dataRows: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const raw = rows[r];
    if (raw.length === 1 && raw[0] === '') continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < columns.length; c++) {
      obj[columns[c]] = (raw[c] ?? '').trim();
    }
    dataRows.push(obj);
  }
  return { columns, rows: dataRows };
}

// ---- Bucket computation (matches the backend's classification) -------------

// Same logic the Leads page uses:
// - Unreached: NOT connected (lifecycle != COMPLETED or answered_by != HUMAN)
// - Top Priority: connected + interest in (HIGH, MEDIUM) + next_step = CALLBACK
// - Interested only: connected + interest in (HIGH, MEDIUM) + next_step != CALLBACK
// - Callback only: connected + interest NOT in (HIGH, MEDIUM) + next_step = CALLBACK
// - No intent: connected + neither interested nor callback
function computeBucket(row: Record<string, string>): string {
  const lifecycle  = (row.lifecycle_status || '').toUpperCase();
  const answeredBy = (row.answered_by || '').toUpperCase();
  const interest   = (row.interest_level || '').toUpperCase();
  const callback   = (row.next_step_interest || '').toUpperCase();

  const connected = lifecycle === 'COMPLETED' && answeredBy === 'HUMAN';
  if (!connected) return 'unreached';

  const interested = interest === 'HIGH' || interest === 'MEDIUM';
  const wantsCallback = callback === 'CALLBACK';

  if (interested && wantsCallback) return 'top_priority';
  if (interested) return 'interested_only';
  if (wantsCallback) return 'callback_only';
  return 'no_intent';
}

// ---- Phone normalization (Indian focus) ------------------------------------

function normalizePhone(raw: string): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    const tail = digits.slice(2);
    if (/^[6-9]/.test(tail)) return tail;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    const tail = digits.slice(1);
    if (/^[6-9]/.test(tail)) return tail;
  }
  if (digits.length === 10 && /^[6-9]/.test(digits)) return digits;
  if (digits.length > 10) {
    const tail = digits.slice(-10);
    if (/^[6-9]/.test(tail)) return tail;
  }
  return digits;
}

// ---- Date parsing ----------------------------------------------------------

function parseDate(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmy) {
    let [, a, b, y] = dmy;
    if (y.length === 2) y = '20' + y;
    const an = parseInt(a, 10);
    const bn = parseInt(b, 10);
    if (an > 12 && bn <= 12) return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    if (bn > 12 && an <= 12) return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
    return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function daysBetween(aIso: string | null, bIso: string | null): number | null {
  if (!aIso || !bIso) return null;
  const a = new Date(`${aIso}T00:00:00Z`).getTime();
  const b = new Date(`${bIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function todayIST(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60_000);
  return ist.toISOString().slice(0, 10);
}

function isoMinusDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---- Filters ---------------------------------------------------------------

function passesFilter(row: Record<string, string>, rule: FilterRule): boolean {
  const raw = (row[rule.column] ?? '').trim();
  const v = raw.toLowerCase();
  const t = (rule.value ?? '').trim().toLowerCase();
  const t2 = (rule.value2 ?? '').trim().toLowerCase();
  const numRaw = parseFloat(raw);
  const numT = parseFloat(rule.value);
  const numT2 = parseFloat(rule.value2 ?? '');

  switch (rule.operator) {
    case 'equals':       return v === t;
    case 'not_equals':   return v !== t;
    case 'contains':     return v.includes(t);
    case 'not_contains': return !v.includes(t);
    case 'gt':           return !Number.isNaN(numRaw) && !Number.isNaN(numT) && numRaw > numT;
    case 'lt':           return !Number.isNaN(numRaw) && !Number.isNaN(numT) && numRaw < numT;
    case 'between':
      return !Number.isNaN(numRaw) && !Number.isNaN(numT) && !Number.isNaN(numT2)
        && numRaw >= numT && numRaw <= numT2;
    case 'empty':        return v === '';
    case 'not_empty':    return v !== '';
    default: return true;
  }
}

function passesAllFilters(row: Record<string, string>, rules: FilterRule[]): boolean {
  for (const r of rules) {
    if (!r.column) continue;
    if (!passesFilter(row, r)) return false;
  }
  return true;
}

// ---- Auto-detection --------------------------------------------------------

function findColumn(columns: string[], patterns: string[]): string | undefined {
  const lower = columns.map(c => c.toLowerCase());
  for (const p of patterns) {
    const i = lower.indexOf(p);
    if (i >= 0) return columns[i];
  }
  for (const p of patterns) {
    const i = lower.findIndex(c => c.includes(p));
    if (i >= 0) return columns[i];
  }
  return undefined;
}

function autoDetectA(columns: string[]): ColumnMappingA {
  const extras: ExtraMapping[] = [];
  for (const [label, patterns] of Object.entries(EXTRA_PRESET_PATTERNS_A)) {
    const found = findColumn(columns, patterns);
    if (found) extras.push({ label, column: found });
  }
  return {
    phone: findColumn(columns, ['mobile_number', 'phone_number', 'mobile', 'phone', 'contact_number', 'contact']) || columns[0] || '',
    date:  findColumn(columns, ['final_lead_status_date', 'final_date', 'ended_at', 'completed_at', 'started_at', 'created_at', '_date', 'date', 'timestamp']) || columns[0] || '',
    extras,
  };
}

function autoDetectB(columns: string[]): ColumnMappingB {
  // Only phone + date are auto-mapped by default. Amount / Paid / Product /
  // Source / Custom mappings are user-opt-in via the "+ Add" pills below.
  // Date patterns put transaction-style names (TxnOn, txn_date) first so they
  // win over generic "*Date" columns like "successDate" on CSVs that have both.
  return {
    phone: findColumn(columns, ['mobile_number', 'phone_number', 'mobile', 'phone', 'user_phone', 'contact']) || columns[0] || '',
    date:  findColumn(columns, ['txnon', 'txn_on', 'txn_date', 'transaction_date', 'transaction_at', 'transaction_on', 'payment_date', 'paid_at', 'order_date', 'purchase_date', 'created_at', '_date', 'date', 'timestamp']) || columns[0] || '',
    extras: [],
  };
}

// Patterns used when the user clicks "+ Amount" / "+ Paid". The detected
// column is pre-selected; user can still change via the dropdown. Defined
// as a constant so the same patterns drive both the initial auto-detect
// (above) and the opt-in adds. Status is no longer a "named" mapping —
// users add a custom filter on `status` in Step 3 if they want it.
const OPTIONAL_B_PATTERNS = {
  amount:     ['totalamount', 'total_amount', 'total', 'amount', 'order_value', 'price'],
  amountPaid: ['paidamount', 'paid_amount', 'paid', 'amount_paid'],
} as const;

type OptionalMappingB = keyof typeof OPTIONAL_B_PATTERNS;
const OPTIONAL_B_LABELS: Record<OptionalMappingB, string> = {
  amount: 'Amount',
  amountPaid: 'Paid',
};

// Pre-set extra mapping patterns — purely for display. Each key is the
// label the user sees; the values are column-name patterns we sniff on
// file load (or when the user clicks the matching "+" pill). Add more
// here if there's another column you want as a one-click preset.
const EXTRA_PRESET_PATTERNS: Record<string, string[]> = {
  Product: ['product', 'product_name', 'item_name', 'plan', 'plan_name', 'course', 'course_name', 'sku'],
  Source:  ['source', 'utm_source', 'referrer', 'channel', 'lead_source', 'acquisition_channel'],
};

// Same idea for File A. The dashboard's export already has vendor / campaign /
// agent columns, so these are the obvious presets. For uploaded CSVs the same
// patterns will catch the equivalent columns if they exist.
const EXTRA_PRESET_PATTERNS_A: Record<string, string[]> = {
  Vendor:   ['vendor', 'vendor_name'],
  Campaign: ['campaign', 'campaign_name'],
  Agent:    ['agent', 'agent_name'],
};

function detectCategoricalColumn(columns: string[], patterns: string[]): string | null {
  for (const p of patterns) {
    const exact = columns.find(c => c.toLowerCase() === p);
    if (exact) return exact;
  }
  for (const p of patterns) {
    const sub = columns.find(c => c.toLowerCase().includes(p));
    if (sub) return sub;
  }
  return null;
}

const BUCKET_COL_PATTERNS  = ['_bucket', 'funnel_stage', 'bucket', 'lead_category', 'final_lead_status', 'category', 'tag'];
const STATUS_COL_PATTERNS  = ['status', 'payment_status', 'order_status', 'state'];

function uniqueValues(rows: Record<string, string>[], column: string, limit = 50): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = (r[column] ?? '').trim();
    if (v) set.add(v);
    if (set.size >= limit) break;
  }
  const values = Array.from(set);
  // Sort dashboard buckets in display order; everything else alphabetically
  values.sort((a, b) => {
    const oa = BUCKET_ORDER[a];
    const ob = BUCKET_ORDER[b];
    if (oa !== undefined && ob !== undefined) return oa - ob;
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return a.localeCompare(b);
  });
  return values;
}

function defaultBucketSelection(values: string[]): Set<string> {
  const isDashboard = values.every(v => DASHBOARD_BUCKETS.includes(v));
  if (isDashboard) return new Set(values.filter(v => DEFAULT_ON_BUCKETS.includes(v)));
  return new Set(values);
}

// ---- Currency / number format ----------------------------------------------

function fmtINR(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '₹0';
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000)   return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000)     return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
function fmtInt(n: number): string { return n.toLocaleString('en-IN'); }
function fmtPct(num: number, denom: number): string {
  if (denom === 0) return '—';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

// Build a readable filename for the fetched dashboard leads dataset.
// Reflects the date range + how narrow the dimension filters are.
function dashboardFilenameFor(rangeLabel: string, vCount: number, cCount: number, aCount: number): string {
  const parts = [`Dashboard leads · ${rangeLabel}`];
  if (vCount > 0) parts.push(`${vCount} vendor${vCount === 1 ? '' : 's'}`);
  if (cCount > 0) parts.push(`${cCount} campaign${cCount === 1 ? '' : 's'}`);
  if (aCount > 0) parts.push(`${aCount} agent${aCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// ---- Attribution algorithm -------------------------------------------------

type RunInput = {
  fileA: CSVData;
  fileB: CSVData;
  mappingA: ColumnMappingA;
  mappingB: ColumnMappingB;
  filtersA: FilterRule[];
  filtersB: FilterRule[];
  bucketColA: string | null;
  bucketSelA: Set<string>;
  statusColB: string | null;
  statusSelB: Set<string>;
  rule: AttributionRule;
  countSameDay: boolean;
};

function runAttribution(input: RunInput): Results {
  const {
    fileA, fileB, mappingA, mappingB,
    filtersA, filtersB,
    bucketColA, bucketSelA, statusColB, statusSelB,
    rule, countSameDay,
  } = input;

  const passesA = (row: Record<string, string>): boolean => {
    if (bucketColA && bucketSelA.size > 0) {
      const v = (row[bucketColA] ?? '').trim();
      if (!bucketSelA.has(v)) return false;
    }
    return passesAllFilters(row, filtersA);
  };
  const passesB = (row: Record<string, string>): boolean => {
    if (statusColB && statusSelB.size > 0) {
      const v = (row[statusColB] ?? '').trim();
      if (!statusSelB.has(v)) return false;
    }
    return passesAllFilters(row, filtersB);
  };

  const filteredA = fileA.rows.filter(passesA);
  const filteredB = fileB.rows.filter(passesB);

  type IndexedB = {
    row: Record<string, string>;
    bDateIso: string | null;
    amount: number;
    amountPaid: number;
  };

  const bIndex = new Map<string, IndexedB[]>();
  for (const row of filteredB) {
    const phone = normalizePhone(row[mappingB.phone] ?? '');
    if (!phone) continue;
    const entry: IndexedB = {
      row,
      bDateIso: parseDate(row[mappingB.date] ?? ''),
      amount: mappingB.amount ? (parseFloat(row[mappingB.amount]) || 0) : 0,
      amountPaid: mappingB.amountPaid ? (parseFloat(row[mappingB.amountPaid]) || 0) : 0,
    };
    if (!bIndex.has(phone)) bIndex.set(phone, []);
    bIndex.get(phone)!.push(entry);
  }
  bIndex.forEach(list => {
    list.sort((x, y) => (x.bDateIso ?? '\uffff').localeCompare(y.bDateIso ?? '\uffff'));
  });

  const attributedPairs: MatchedPair[] = [];
  const preExistingPairs: MatchedPair[] = [];
  const unmatchedRows: Record<string, string>[] = [];
  let revenueTotal = 0;
  let revenuePaid = 0;

  for (const aRow of filteredA) {
    const aPhone = normalizePhone(aRow[mappingA.phone] ?? '');
    const aDateIso = parseDate(aRow[mappingA.date] ?? '');

    if (!aPhone) { unmatchedRows.push(aRow); continue; }

    const candidates = bIndex.get(aPhone);
    if (!candidates || candidates.length === 0) {
      unmatchedRows.push(aRow);
      continue;
    }

    let matched: IndexedB | null = null;
    let earliestBefore: IndexedB | null = null;
    for (const b of candidates) {
      if (rule === 'any_time') { matched = b; break; }
      if (!aDateIso || !b.bDateIso) continue;
      if (b.bDateIso > aDateIso) { matched = b; break; }
      if (b.bDateIso === aDateIso && countSameDay) { matched = b; break; }
      if (!earliestBefore) earliestBefore = b;
    }

    if (matched) {
      attributedPairs.push({
        a: aRow, b: matched.row,
        bDateIso: matched.bDateIso, aDateIso,
        lagDays: daysBetween(aDateIso, matched.bDateIso),
      });
      revenueTotal += matched.amount;
      revenuePaid  += matched.amountPaid;
    } else if (earliestBefore || candidates.length > 0) {
      const b = earliestBefore ?? candidates[0];
      preExistingPairs.push({
        a: aRow, b: b.row,
        bDateIso: b.bDateIso, aDateIso,
        lagDays: daysBetween(aDateIso, b.bDateIso),
      });
    } else {
      unmatchedRows.push(aRow);
    }
  }

  return {
    totalA: filteredA.length,
    keyMatched: attributedPairs.length + preExistingPairs.length,
    preExisting: preExistingPairs.length,
    attributed: attributedPairs.length,
    unmatched: unmatchedRows.length,
    revenueTotal, revenuePaid,
    attributedPairs, preExistingPairs, unmatchedRows,
    ranAt: Date.now(),
  };
}

// ---- CSV download ----------------------------------------------------------

function escapeCsvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function downloadCSV(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) { alert('No rows to export.'); return; }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
  }
  const lines: string[] = [keys.map(escapeCsvCell).join(',')];
  for (const r of rows) {
    lines.push(keys.map(k => escapeCsvCell((r as any)[k])).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flattenPairs(pairs: MatchedPair[], mappingB: ColumnMappingB): Record<string, unknown>[] {
  return pairs.map(p => {
    const out: Record<string, unknown> = { ...p.a };
    out['_match_b_phone']  = normalizePhone(p.b[mappingB.phone] ?? '');
    out['_match_b_date']   = p.bDateIso ?? '';
    out['_match_lag_days'] = p.lagDays ?? '';
    if (mappingB.amount)     out['_match_amount']      = p.b[mappingB.amount] ?? '';
    if (mappingB.amountPaid) out['_match_amount_paid'] = p.b[mappingB.amountPaid] ?? '';
    // Display extras flow into the CSV too, prefixed with `_match_` and
    // slug-cased so they don't collide with A's existing column names.
    // Empty labels are skipped (user added the row but never typed a name).
    for (const extra of mappingB.extras) {
      const lbl = extra.label.trim();
      if (!lbl || !extra.column) continue;
      const slug = lbl.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      out[`_match_${slug || 'extra'}`] = p.b[extra.column] ?? '';
    }
    return out;
  });
}

// =============================================================================
// Page component
// =============================================================================

export default function LeadAttributionPage() {
  // File A mode
  const [fileASource, setFileASource] = useState<FileASource>('dashboard');
  const [dashboardRange, setDashboardRange] = useState<DashboardRange>('last_30');
  const [loadingDashboard, setLoadingDashboard] = useState(false);

  // Dashboard-mode dimension filters. Empty Set = "all" (no filter applied).
  // We use Set<string> internally for cheap toggle/has; convert to string[] at
  // fetch time to match the existing Filters / exportCallsUrl shape.
  const [vendorIds,   setVendorIds]   = useState<Set<string>>(new Set());
  const [campaignIds, setCampaignIds] = useState<Set<string>>(new Set());
  const [agentIds,    setAgentIds]    = useState<Set<string>>(new Set());

  // Dimension lookups for the multi-select dropdowns
  const vendorsQ   = useQuery({ queryKey: ['vendors'],   queryFn: () => api.vendors(),   staleTime: 5 * 60_000 });
  const campaignsQ = useQuery({ queryKey: ['campaigns'], queryFn: () => api.campaigns(), staleTime: 5 * 60_000 });
  const agentsQ    = useQuery({ queryKey: ['agents'],    queryFn: () => api.agents(),    staleTime: 5 * 60_000 });

  // Files (after load — same shape regardless of source)
  const [fileA, setFileA] = useState<CSVData | null>(null);
  const [fileB, setFileB] = useState<CSVData | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Mappings
  const [mappingA, setMappingA] = useState<ColumnMappingA>({ phone: '', date: '', extras: [] });
  const [mappingB, setMappingB] = useState<ColumnMappingB>({ phone: '', date: '', extras: [] });

  // Bucket / status presets
  const bucketColA = useMemo(
    () => fileA ? detectCategoricalColumn(fileA.columns, BUCKET_COL_PATTERNS) : null,
    [fileA],
  );
  const bucketValuesA = useMemo(
    () => (fileA && bucketColA) ? uniqueValues(fileA.rows, bucketColA) : [],
    [fileA, bucketColA],
  );
  const [bucketSelA, setBucketSelA] = useState<Set<string>>(new Set());

  const statusColB = useMemo(
    () => fileB ? detectCategoricalColumn(fileB.columns, STATUS_COL_PATTERNS) : null,
    [fileB],
  );
  const statusValuesB = useMemo(
    () => (fileB && statusColB) ? uniqueValues(fileB.rows, statusColB) : [],
    [fileB, statusColB],
  );
  const [statusSelB, setStatusSelB] = useState<Set<string>>(new Set());

  // Custom filters
  const [filtersA, setFiltersA] = useState<FilterRule[]>([]);
  const [filtersB, setFiltersB] = useState<FilterRule[]>([]);

  // Attribution rule
  const [rule, setRule] = useState<AttributionRule>('b_after_a');
  const [countSameDay, setCountSameDay] = useState(true);

  // Results
  const [results, setResults] = useState<Results | null>(null);
  const [running, setRunning] = useState(false);

  // ---- File A: dashboard fetch ----
  const fetchDashboardLeads = useCallback(async (range: DashboardRange) => {
    setParseError(null);
    setLoadingDashboard(true);
    setResults(null);
    try {
      const cfg = RANGE_OPTIONS.find(r => r.key === range);
      const today = todayIST();
      const startIso = cfg?.days
        ? isoMinusDays(today, cfg.days)
        : '2020-01-01';
      const filters: Filters = {
        start: new Date(`${startIso}T00:00:00+05:30`),
        end:   new Date(`${today}T23:59:59+05:30`),
        vendor_ids:   Array.from(vendorIds),
        campaign_ids: Array.from(campaignIds),
      };
      // Agent filter rides as a query param. The export endpoint accepts an
      // `agent_id` filter via parse_filters; we pass the first selected one
      // explicitly if present (the existing endpoint doesn't accept multi).
      // For multi-agent selection we fall back to client-side filtering.
      const url = api.exportCallsUrl(filters, {});
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const parsed = parseCSV(text);
      if (parsed.columns.length === 0 || parsed.rows.length === 0) {
        throw new Error('Dashboard returned no leads for this filter combination.');
      }
      // Client-side agent filter (if user picked specific agents). We match
      // against the `agent` column the export writes — it's a name string, so
      // resolve names from the loaded agent list.
      let rows = parsed.rows;
      if (agentIds.size > 0) {
        const agentNameById = new Map<string, string>();
        for (const a of (agentsQ.data ?? [])) agentNameById.set(a.id, a.name);
        const allowedNames = new Set(
          Array.from(agentIds).map(id => agentNameById.get(id)).filter(Boolean) as string[],
        );
        rows = rows.filter(r => allowedNames.has(r.agent ?? ''));
        if (rows.length === 0) {
          throw new Error('No leads match the selected agent filter.');
        }
      }
      // Enrich every row with a computed bucket
      const enrichedRows = rows.map(r => ({
        ...r,
        _bucket: computeBucket(r),
      }));
      const columns = parsed.columns.includes('_bucket')
        ? parsed.columns
        : [...parsed.columns, '_bucket'];
      const data: CSVData = {
        filename: dashboardFilenameFor(cfg?.label || '', vendorIds.size, campaignIds.size, agentIds.size),
        columns,
        rows: enrichedRows,
      };
      setFileA(data);
      // Auto-populate display extras for the preview — Vendor / Campaign /
      // Agent are useful surfacing in dashboard mode and always present in
      // the export. User can remove any via × in Step 2.
      const autoExtrasA: ExtraMapping[] = [];
      for (const [label, patterns] of Object.entries(EXTRA_PRESET_PATTERNS_A)) {
        const found = findColumn(columns, patterns);
        if (found) autoExtrasA.push({ label, column: found });
      }
      setMappingA({
        phone: 'mobile_number',
        date:  'final_lead_status_date',
        extras: autoExtrasA,
      });
      const uniqueBuckets = uniqueValues(enrichedRows, '_bucket');
      setBucketSelA(defaultBucketSelection(uniqueBuckets));
      setFiltersA([]);
    } catch (e: any) {
      setParseError(`Dashboard fetch failed: ${e?.message || 'unknown error'}`);
      setFileA(null);
    } finally {
      setLoadingDashboard(false);
    }
  }, [vendorIds, campaignIds, agentIds, agentsQ.data]);

  // ---- File handlers (upload mode) ----
  const handleFileLoad = useCallback(
    async (which: 'A' | 'B', file: File) => {
      setParseError(null);
      try {
        const text = await file.text();
        const parsed = parseCSV(text);
        if (parsed.columns.length === 0) {
          setParseError(`${file.name}: no columns detected. Is it a valid CSV?`);
          return;
        }
        const data: CSVData = {
          filename: file.name,
          columns: parsed.columns,
          rows: parsed.rows,
        };
        if (which === 'A') {
          setFileA(data);
          setMappingA(autoDetectA(parsed.columns));
          const col = detectCategoricalColumn(parsed.columns, BUCKET_COL_PATTERNS);
          if (col) {
            const vals = uniqueValues(parsed.rows, col);
            setBucketSelA(defaultBucketSelection(vals));
          } else {
            setBucketSelA(new Set());
          }
          setFiltersA([]);
        } else {
          setFileB(data);
          // Auto-populate default mappings: phone + date (always), plus the
          // useful presets — Amount, Paid, Product, Source. Each is only
          // included if a matching column is found. User can remove any of
          // these via × or add more via the "+" pills below the panel.
          const autoAmount = findColumn(parsed.columns, [...OPTIONAL_B_PATTERNS.amount]);
          const autoPaid   = findColumn(parsed.columns, [...OPTIONAL_B_PATTERNS.amountPaid]);
          const autoExtras: ExtraMapping[] = [];
          for (const [label, patterns] of Object.entries(EXTRA_PRESET_PATTERNS)) {
            const found = findColumn(parsed.columns, patterns);
            if (found) autoExtras.push({ label, column: found });
          }
          setMappingB({
            phone: autoDetectB(parsed.columns).phone,
            date:  autoDetectB(parsed.columns).date,
            amount: autoAmount,
            amountPaid: autoPaid,
            extras: autoExtras,
          });
          // No special status filter — Step 3's File B panel is symmetric
          // with File A's (just "+ Add filter"). Users add a custom filter
          // on `status` (or any other column) if they want it.
          setStatusSelB(new Set());
          setFiltersB([]);
        }
        setResults(null);
      } catch (e: any) {
        setParseError(`${file.name}: ${e?.message || 'failed to read'}`);
      }
    },
    [],
  );

  const clearFile = (which: 'A' | 'B') => {
    if (which === 'A') {
      setFileA(null); setMappingA({ phone: '', date: '', extras: [] });
      setBucketSelA(new Set()); setFiltersA([]);
    } else {
      setFileB(null); setMappingB({ phone: '', date: '', extras: [] });
      setStatusSelB(new Set()); setFiltersB([]);
    }
    setResults(null);
  };

  const resetAll = () => {
    setFileA(null); setFileB(null);
    setMappingA({ phone: '', date: '', extras: [] });
    setMappingB({ phone: '', date: '', extras: [] });
    setBucketSelA(new Set()); setStatusSelB(new Set());
    setFiltersA([]); setFiltersB([]);
    setResults(null); setParseError(null);
    setFileASource('dashboard');
    setDashboardRange('last_30');
  };

  // Switch A source — clears existing A data so the user re-loads it
  const switchASource = (next: FileASource) => {
    if (next === fileASource) return;
    setFileASource(next);
    setFileA(null);
    setBucketSelA(new Set());
    setFiltersA([]);
    setMappingA({ phone: '', date: '', extras: [] });
    setResults(null);
    setParseError(null);
  };

  // ---- Live row counts after filtering ----
  const filteredACount = useMemo(() => {
    if (!fileA) return 0;
    return fileA.rows.filter(row => {
      if (bucketColA && bucketSelA.size > 0) {
        const v = (row[bucketColA] ?? '').trim();
        if (!bucketSelA.has(v)) return false;
      }
      return passesAllFilters(row, filtersA);
    }).length;
  }, [fileA, bucketColA, bucketSelA, filtersA]);

  const filteredBCount = useMemo(() => {
    if (!fileB) return 0;
    return fileB.rows.filter(row => {
      if (statusColB && statusSelB.size > 0) {
        const v = (row[statusColB] ?? '').trim();
        if (!statusSelB.has(v)) return false;
      }
      return passesAllFilters(row, filtersB);
    }).length;
  }, [fileB, statusColB, statusSelB, filtersB]);

  const canRun = !!fileA && !!fileB && !!mappingA.phone && !!mappingA.date && !!mappingB.phone && !!mappingB.date;

  const handleRun = () => {
    if (!canRun || !fileA || !fileB) return;
    setRunning(true);
    setTimeout(() => {
      const r = runAttribution({
        fileA, fileB, mappingA, mappingB,
        filtersA, filtersB,
        bucketColA, bucketSelA, statusColB, statusSelB,
        rule, countSameDay,
      });
      setResults(r);
      setRunning(false);
      setTimeout(() => {
        const el = document.getElementById('attribution-results');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }, 50);
  };

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1100px] mx-auto">
      <header>
        <h1 className="text-xl md:text-2xl font-semibold text-brand-navy flex items-center gap-2">
          <Shuffle size={22} className="text-brand-pink" />
          Lead Attribution
        </h1>
        <p className="text-xs md:text-sm text-surface-500 mt-1">
          Check which leads from this dashboard became paid users in an external file.
          Pull leads directly from the dashboard (default) or upload a custom list, then
          upload your payments / outcomes CSV. Filters apply before matching.
        </p>
      </header>

      <StepStrip active={!fileA || !fileB ? 1 : !results ? 3 : 4} />

      {parseError && (
        <div className="card p-3 flex items-start gap-2 border border-red-200 bg-red-50 text-red-700 text-xs">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <div>{parseError}</div>
        </div>
      )}

      {/* ---- Step 1: Sources ---- */}
      <section>
        <h2 className="text-sm font-medium text-brand-navy mb-2">Step 1 — Sources</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* File A panel */}
          <div className="card p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[11px] uppercase tracking-wider text-surface-500">File A — leads</div>
              <div className="inline-flex bg-surface-100 border border-surface-200 rounded p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => switchASource('dashboard')}
                  className={`px-2 py-0.5 rounded inline-flex items-center gap-1 ${
                    fileASource === 'dashboard'
                      ? 'bg-white text-brand-navy font-medium shadow-sm'
                      : 'text-surface-500 hover:text-brand-navy'
                  }`}
                >
                  <Database size={11} />
                  Dashboard
                </button>
                <button
                  type="button"
                  onClick={() => switchASource('upload')}
                  className={`px-2 py-0.5 rounded inline-flex items-center gap-1 ${
                    fileASource === 'upload'
                      ? 'bg-white text-brand-navy font-medium shadow-sm'
                      : 'text-surface-500 hover:text-brand-navy'
                  }`}
                >
                  <Upload size={11} />
                  Upload
                </button>
              </div>
            </div>

            {fileASource === 'dashboard' ? (
              <DashboardSourcePanel
                range={dashboardRange}
                setRange={setDashboardRange}
                loading={loadingDashboard}
                fileA={fileA}
                onLoad={fetchDashboardLeads}
                onClear={() => clearFile('A')}
                vendors={vendorsQ.data ?? []}
                campaigns={campaignsQ.data ?? []}
                agents={agentsQ.data ?? []}
                vendorIds={vendorIds}     setVendorIds={setVendorIds}
                campaignIds={campaignIds} setCampaignIds={setCampaignIds}
                agentIds={agentIds}       setAgentIds={setAgentIds}
                bucketValues={bucketValuesA}
                bucketSel={bucketSelA}
                setBucketSel={setBucketSelA}
                filteredCount={filteredACount}
              />
            ) : (
              fileA ? (
                <LoadedFileChip data={fileA} onClear={() => clearFile('A')} />
              ) : (
                <UploadDropZone
                  label="Drop leads CSV"
                  sublabel="any list of leads with a phone column"
                  onLoad={f => handleFileLoad('A', f)}
                />
              )
            )}
          </div>

          {/* File B panel */}
          <div className="card p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] uppercase tracking-wider text-surface-500">File B — outcomes / payments</div>
              <div className="text-[11px] text-surface-400">Upload only</div>
            </div>
            {fileB ? (
              <LoadedFileChip data={fileB} onClear={() => clearFile('B')} />
            ) : (
              <UploadDropZone
                label="Drop payments CSV"
                sublabel="CRM transactions, signups, etc."
                onLoad={f => handleFileLoad('B', f)}
              />
            )}
          </div>
        </div>
      </section>

      {/* ---- Step 2: Column mapping ---- */}
      {fileA && fileB && (
        <section>
          <h2 className="text-sm font-medium text-brand-navy mb-2">Step 2 — Map columns</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-wider text-surface-500">File A</div>
                {fileASource === 'dashboard' && (
                  <div className="text-[10px] text-surface-400 italic">auto-mapped</div>
                )}
              </div>
              <ColumnPicker
                label="Phone"
                columns={fileA.columns}
                value={mappingA.phone}
                onChange={v => setMappingA(m => ({ ...m, phone: v }))}
                disabled={fileASource === 'dashboard'}
              />
              <ColumnPicker
                label="Date"
                columns={fileA.columns}
                value={mappingA.date}
                onChange={v => setMappingA(m => ({ ...m, date: v }))}
                disabled={fileASource === 'dashboard'}
              />

              {/* Display-only extras for File A — Vendor, Campaign, Agent or
                  any custom column the user wants visible in the preview
                  table. Editable label per row, removable with ×. */}
              {mappingA.extras.map((extra, idx) => (
                <ExtraMappingRow
                  key={idx}
                  extra={extra}
                  columns={fileA.columns}
                  onChangeLabel={(label) =>
                    setMappingA(m => ({ ...m, extras: m.extras.map((e, i) => i === idx ? { ...e, label } : e) }))
                  }
                  onChangeColumn={(column) =>
                    setMappingA(m => ({ ...m, extras: m.extras.map((e, i) => i === idx ? { ...e, column } : e) }))
                  }
                  onRemove={() =>
                    setMappingA(m => ({ ...m, extras: m.extras.filter((_, i) => i !== idx) }))
                  }
                />
              ))}

              {/* Add pills — symmetric with File B's: presets for the
                  dashboard-export columns plus a Custom row for free-form. */}
              <div className="flex flex-wrap gap-1.5 pt-1.5 border-t border-surface-100">
                <span className="text-[10px] text-surface-400 self-center">Add:</span>
                {Object.entries(EXTRA_PRESET_PATTERNS_A).map(([label, patterns]) => {
                  if (mappingA.extras.some(e => e.label === label)) return null;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        const detected = findColumn(fileA.columns, patterns) ?? fileA.columns[0] ?? '';
                        setMappingA(m => ({ ...m, extras: [...m.extras, { label, column: detected }] }));
                      }}
                      className="text-[10px] px-2 py-0.5 rounded border border-dashed border-surface-300 text-surface-500 hover:border-brand-pink hover:text-brand-pink inline-flex items-center gap-1"
                    >
                      <Plus size={10} /> {label}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    setMappingA(m => ({ ...m, extras: [...m.extras, { label: '', column: fileA.columns[0] ?? '' }] }));
                  }}
                  className="text-[10px] px-2 py-0.5 rounded border border-dashed border-brand-pink/40 text-brand-pink hover:bg-brand-pink/5 inline-flex items-center gap-1"
                >
                  <Plus size={10} /> Custom
                </button>
              </div>
            </div>
            <div className="card p-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-surface-500">File B</div>
              <ColumnPicker label="Phone" columns={fileB.columns} value={mappingB.phone} onChange={v => setMappingB(m => ({ ...m, phone: v }))} />
              <ColumnPicker label="Date"  columns={fileB.columns} value={mappingB.date}  onChange={v => setMappingB(m => ({ ...m, date: v  }))} />

              {/* Algorithm-relevant optional mappings (drive revenue KPIs). */}
              {(['amount', 'amountPaid'] as OptionalMappingB[]).map(key => {
                if (mappingB[key] === undefined) return null;
                return (
                  <ColumnPicker
                    key={key}
                    label={OPTIONAL_B_LABELS[key]}
                    columns={fileB.columns}
                    value={mappingB[key] ?? ''}
                    onChange={v => setMappingB(m => ({ ...m, [key]: v || undefined }))}
                    onRemove={() => setMappingB(m => ({ ...m, [key]: undefined }))}
                  />
                );
              })}

              {/* Display-only extras — Product, Source, or any custom column
                  the user wants visible in the preview / download. The label
                  is editable inline so users can name it whatever they want. */}
              {mappingB.extras.map((extra, idx) => (
                <ExtraMappingRow
                  key={idx}
                  extra={extra}
                  columns={fileB.columns}
                  onChangeLabel={(label) =>
                    setMappingB(m => ({ ...m, extras: m.extras.map((e, i) => i === idx ? { ...e, label } : e) }))
                  }
                  onChangeColumn={(column) =>
                    setMappingB(m => ({ ...m, extras: m.extras.map((e, i) => i === idx ? { ...e, column } : e) }))
                  }
                  onRemove={() =>
                    setMappingB(m => ({ ...m, extras: m.extras.filter((_, i) => i !== idx) }))
                  }
                />
              ))}

              {/* Add pills — preset shortcuts plus "+ Custom" for anything else. */}
              <div className="flex flex-wrap gap-1.5 pt-1.5 border-t border-surface-100">
                <span className="text-[10px] text-surface-400 self-center">Add:</span>
                {(['amount', 'amountPaid'] as OptionalMappingB[]).map(key => {
                  if (mappingB[key] !== undefined) return null;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        const detected = findColumn(fileB.columns, [...OPTIONAL_B_PATTERNS[key]]);
                        setMappingB(m => ({ ...m, [key]: detected ?? fileB.columns[0] ?? '' }));
                      }}
                      className="text-[10px] px-2 py-0.5 rounded border border-dashed border-surface-300 text-surface-500 hover:border-brand-pink hover:text-brand-pink inline-flex items-center gap-1"
                    >
                      <Plus size={10} /> {OPTIONAL_B_LABELS[key]}
                    </button>
                  );
                })}
                {Object.entries(EXTRA_PRESET_PATTERNS).map(([label, patterns]) => {
                  // Skip if an extra row with this exact label already exists
                  if (mappingB.extras.some(e => e.label === label)) return null;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        const detected = findColumn(fileB.columns, patterns) ?? fileB.columns[0] ?? '';
                        setMappingB(m => ({ ...m, extras: [...m.extras, { label, column: detected }] }));
                      }}
                      className="text-[10px] px-2 py-0.5 rounded border border-dashed border-surface-300 text-surface-500 hover:border-brand-pink hover:text-brand-pink inline-flex items-center gap-1"
                    >
                      <Plus size={10} /> {label}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    setMappingB(m => ({ ...m, extras: [...m.extras, { label: '', column: fileB.columns[0] ?? '' }] }));
                  }}
                  className="text-[10px] px-2 py-0.5 rounded border border-dashed border-brand-pink/40 text-brand-pink hover:bg-brand-pink/5 inline-flex items-center gap-1"
                >
                  <Plus size={10} /> Custom
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ---- Step 3: Filters & rule ---- */}
      {fileA && fileB && (
        <section>
          <h2 className="text-sm font-medium text-brand-navy mb-2">Step 3 — Filters &amp; rule</h2>

          <div className="card p-3 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="text-[10px] uppercase tracking-wider text-surface-500">Rule</span>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="radio" checked={rule === 'b_after_a'} onChange={() => setRule('b_after_a')} className="accent-brand-pink" />
              <span>B date <strong>after</strong> A date</span>
              <span className="text-surface-400">(real attribution)</span>
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="radio" checked={rule === 'any_time'} onChange={() => setRule('any_time')} className="accent-brand-pink" />
              <span>Any time match</span>
              <span className="text-surface-400">(includes pre-existing)</span>
            </label>
            <div className="flex-1" />
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={countSameDay} onChange={e => setCountSameDay(e.target.checked)} className="accent-brand-pink" />
              <span>Count same-day matches</span>
            </label>
          </div>

          <FilterPanel
            label="File A — leads"
            totalRows={fileA.rows.length}
            filteredRows={filteredACount}
            bucketColumn={bucketColA}
            bucketColumnLabel="Bucket"
            bucketValues={bucketValuesA}
            bucketSel={bucketSelA}
            setBucketSel={setBucketSelA}
            customFilters={filtersA}
            setCustomFilters={setFiltersA}
            columns={fileA.columns}
            hideDetectionHint={fileASource === 'dashboard'}
            hideBucketSection={fileASource === 'dashboard'}
          />

          <FilterPanel
            label="File B — payments"
            totalRows={fileB.rows.length}
            filteredRows={filteredBCount}
            bucketColumn={statusColB}
            bucketColumnLabel="Status"
            bucketValues={statusValuesB}
            bucketSel={statusSelB}
            setBucketSel={setStatusSelB}
            customFilters={filtersB}
            setCustomFilters={setFiltersB}
            columns={fileB.columns}
            hideBucketSection
          />

          <div className="flex items-center justify-between mt-2">
            <div className="text-[11px] text-surface-500">
              Will match <strong className="text-brand-navy">{fmtInt(filteredACount)}</strong> leads against{' '}
              <strong className="text-brand-navy">{fmtInt(filteredBCount)}</strong> payments
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resetAll}
                className="text-xs px-3 py-1.5 rounded-md text-surface-500 hover:text-brand-navy inline-flex items-center gap-1.5"
              >
                <RotateCcw size={12} /> Reset
              </button>
              <button
                type="button"
                onClick={handleRun}
                disabled={!canRun || running}
                className="text-xs px-4 py-1.5 rounded-md bg-brand-navy text-white font-medium inline-flex items-center gap-1.5 hover:bg-brand-navy/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Play size={13} />
                {running ? 'Running…' : 'Run attribution'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ---- Step 4: Results ---- */}
      {results && fileA && fileB && (
        <section id="attribution-results">
          <h2 className="text-sm font-medium text-brand-navy mb-2">Step 4 — Results</h2>
          <ResultsBlock
            results={results}
            mappingA={mappingA}
            mappingB={mappingB}
            hasAmount={!!mappingB.amount}
            hasPaid={!!mappingB.amountPaid}
          />
        </section>
      )}

      <div className="card p-4 text-[11px] text-surface-500 leading-relaxed">
        <strong className="text-surface-700">How attribution is computed:</strong> phones are normalized
        (strips +91, leading 0, spaces, dashes; keeps last 10 digits if they start with 6-9). For each lead
        in File&nbsp;A, the tool looks for the earliest payment in File&nbsp;B with the same phone where the
        rule passes. "B after A" excludes pre-existing customers — they would have converted anyway, so
        attributing them inflates the number. "Pre-existing" counts phones that exist in File&nbsp;B only
        with earlier dates. "Attributed" counts phones with at least one B-after-A match. Revenue uses the
        matched B row (earliest qualifying). The status filter on File&nbsp;B is purely user-driven — pick the
        status values you want to count (e.g. <code>success</code>, <code>paid</code>, <code>authSuccess</code>)
        and only those rows enter the match. Leaving the filter empty includes every status.
        Bucket pills on File&nbsp;A use the same definitions as the Leads page (Top Priority = interested + callback, etc.).
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function StepStrip({ active }: { active: 1 | 2 | 3 | 4 }) {
  const steps = [
    { n: 1, label: 'Sources' },
    { n: 2, label: 'Map columns' },
    { n: 3, label: 'Configure' },
    { n: 4, label: 'Results' },
  ] as const;
  return (
    <div className="flex items-center gap-1 text-[11px] flex-wrap">
      {steps.map((s, i) => (
        <span key={s.n} className="inline-flex items-center gap-1">
          <span
            className={`px-2.5 py-1 rounded ${
              s.n <= active ? 'bg-brand-pink/10 text-brand-pink font-medium' : 'bg-surface-100 text-surface-500'
            }`}
          >
            {s.n} {s.label}
          </span>
          {i < steps.length - 1 && <ChevronRight size={12} className="text-surface-300" />}
        </span>
      ))}
    </div>
  );
}

function DashboardSourcePanel({
  range, setRange, loading, fileA, onLoad, onClear,
  vendors, campaigns, agents,
  vendorIds, setVendorIds, campaignIds, setCampaignIds, agentIds, setAgentIds,
  bucketValues, bucketSel, setBucketSel,
  filteredCount,
}: {
  range: DashboardRange;
  setRange: (r: DashboardRange) => void;
  loading: boolean;
  fileA: CSVData | null;
  onLoad: (r: DashboardRange) => void;
  onClear: () => void;
  vendors: Vendor[];
  campaigns: Campaign[];
  agents: Agent[];
  vendorIds:   Set<string>; setVendorIds:   (s: Set<string>) => void;
  campaignIds: Set<string>; setCampaignIds: (s: Set<string>) => void;
  agentIds:    Set<string>; setAgentIds:    (s: Set<string>) => void;
  bucketValues: string[];
  bucketSel: Set<string>;
  setBucketSel: (s: Set<string>) => void;
  filteredCount: number;
}) {
  // Campaign list narrows to selected vendors if any vendor is picked, so the
  // dropdown stays scoped to what the user is actually looking at.
  const campaignOpts = useMemo(() => {
    const filtered = vendorIds.size === 0
      ? campaigns
      : campaigns.filter(c => vendorIds.has(c.vendor_id));
    return filtered
      .map(c => ({ value: c.id, label: c.display_name || c.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [campaigns, vendorIds]);

  const vendorOpts = useMemo(
    () => vendors.map(v => ({ value: v.id, label: v.name })).sort((a, b) => a.label.localeCompare(b.label)),
    [vendors],
  );

  const agentOpts = useMemo(() => {
    const filtered = vendorIds.size === 0
      ? agents
      : agents.filter(a => vendorIds.has(a.vendor_id));
    return filtered
      .map(a => ({ value: a.id, label: a.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [agents, vendorIds]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-xs flex-wrap">
        <label className="text-surface-500">Date range</label>
        <select
          value={range}
          onChange={e => {
            const v = e.target.value as DashboardRange;
            setRange(v);
            if (fileA) onLoad(v);
          }}
          className="text-xs px-2 py-1 border border-surface-200 rounded bg-white text-brand-navy hover:border-surface-300 focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
        >
          {RANGE_OPTIONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <div className="flex-1" />
        {fileA ? (
          <button
            type="button"
            onClick={() => onLoad(range)}
            disabled={loading}
            className="text-[11px] px-2 py-1 rounded text-surface-500 hover:text-brand-navy disabled:opacity-50 inline-flex items-center gap-1"
          >
            {loading ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
            Refresh
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onLoad(range)}
            disabled={loading}
            className="text-xs px-3 py-1 rounded-md bg-brand-navy text-white font-medium inline-flex items-center gap-1.5 hover:bg-brand-navy/90 disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Database size={12} />}
            {loading ? 'Loading…' : 'Load leads'}
          </button>
        )}
      </div>

      {/* Dimension filters — vendor, campaign, agent. Empty = all. Picking a
          vendor scopes the campaign + agent dropdowns to that vendor's items
          (a campaign / agent belongs to exactly one vendor in this schema). */}
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        <MultiSelect
          label="Vendor"
          options={vendorOpts}
          selected={vendorIds}
          onChange={(s) => {
            setVendorIds(s);
            // When vendor narrows, drop any campaigns / agents that are no
            // longer in scope. Keeps "X selected" honest.
            if (s.size > 0) {
              const stillValidCamps = new Set(
                Array.from(campaignIds).filter(id => {
                  const c = campaigns.find(x => x.id === id);
                  return c && s.has(c.vendor_id);
                }),
              );
              setCampaignIds(stillValidCamps);
              const stillValidAgents = new Set(
                Array.from(agentIds).filter(id => {
                  const a = agents.find(x => x.id === id);
                  return a && s.has(a.vendor_id);
                }),
              );
              setAgentIds(stillValidAgents);
            }
          }}
          placeholderAll="All vendors"
        />
        <MultiSelect
          label="Campaign"
          options={campaignOpts}
          selected={campaignIds}
          onChange={setCampaignIds}
          placeholderAll="All campaigns"
          disabled={campaignOpts.length === 0}
        />
        <MultiSelect
          label="Agent"
          options={agentOpts}
          selected={agentIds}
          onChange={setAgentIds}
          placeholderAll="All agents"
          disabled={agentOpts.length === 0}
        />
        {(vendorIds.size + campaignIds.size + agentIds.size) > 0 && (
          <button
            type="button"
            onClick={() => { setVendorIds(new Set()); setCampaignIds(new Set()); setAgentIds(new Set()); }}
            className="text-[10px] text-surface-400 hover:text-brand-navy underline underline-offset-2"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Bucket pills — only relevant after a fetch has run, since the bucket
          is computed client-side from each row's interest_level / next_step.
          Until then we can't know what values are in the data. The same state
          drives Step 3's filter, so toggling here = toggling there. */}
      {fileA && bucketValues.length > 0 && (
        <div className="border-t border-surface-100 pt-2 mb-2">
          <BucketPills
            label="Bucket"
            column="_bucket"
            values={bucketValues}
            selected={bucketSel}
            onChange={setBucketSel}
            hideDetectionHint
          />
        </div>
      )}

      {fileA ? (
        <div className="bg-surface-50 border border-surface-100 rounded px-2 py-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium text-brand-navy flex items-center gap-1.5 truncate">
              <Database size={13} className="text-brand-pink shrink-0" />
              <span className="truncate">{fileA.filename}</span>
            </div>
            <div className="text-[10px] text-surface-500 mt-0.5">
              {filteredCount === fileA.rows.length ? (
                <>{fmtInt(fileA.rows.length)} unique leads · {fileA.columns.length} columns</>
              ) : (
                <>
                  <strong className="text-brand-pink">{fmtInt(filteredCount)}</strong>
                  <span> of {fmtInt(fileA.rows.length)} leads after bucket filter · {fileA.columns.length} columns</span>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClear}
            className="text-surface-400 hover:text-red-600 p-0.5"
            aria-label="Clear"
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <div className="text-[11px] text-surface-500 leading-relaxed">
          Pulls deduplicated phone-level leads matching the selected filters.
          The Top Priority / Interested / Callback / No intent bucket is computed
          automatically from each lead's last call. Leave a filter empty to include all.
        </div>
      )}
    </div>
  );
}

// Compact multi-select dropdown — used for vendor / campaign / agent pickers.
// Empty selection displays as `placeholderAll` and means "no filter applied"
// (matches the backend convention where empty vendor_ids = all).
function MultiSelect({
  label, options, selected, onChange, placeholderAll, disabled = false,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  placeholderAll: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Outside-click closes the popover. Bound only while open to avoid the
  // listener thrashing every render.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const display = selected.size === 0
    ? placeholderAll
    : selected.size === 1
      ? options.find(o => selected.has(o.value))?.label ?? '1 selected'
      : `${selected.size} selected`;

  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        className={`text-[11px] px-2 py-1 rounded border inline-flex items-center gap-1.5 transition-colors ${
          disabled
            ? 'border-surface-100 text-surface-300 cursor-not-allowed'
            : selected.size > 0
              ? 'border-brand-pink/40 bg-brand-pink/5 text-brand-navy'
              : 'border-surface-200 bg-white text-surface-600 hover:border-surface-300'
        }`}
      >
        <span className="text-surface-500">{label}:</span>
        <span className={selected.size > 0 ? 'font-medium' : ''}>{display}</span>
        <ChevronDown size={11} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-20 min-w-[220px] max-w-[320px] bg-white border border-surface-200 rounded-md shadow-lg max-h-72 overflow-hidden flex flex-col">
          <div className="px-2 py-1.5 border-b border-surface-100 flex items-center justify-between text-[10px]">
            <button
              type="button"
              onClick={() => onChange(new Set(options.map(o => o.value)))}
              className="text-brand-pink hover:underline"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="text-surface-500 hover:text-brand-navy hover:underline"
            >
              Clear
            </button>
          </div>
          <div className="overflow-y-auto flex-1">
            {options.length === 0 ? (
              <div className="px-2 py-3 text-[11px] text-surface-400 text-center">No options</div>
            ) : (
              options.map(o => (
                <label
                  key={o.value}
                  className="flex items-center gap-2 px-2 py-1 hover:bg-surface-50 cursor-pointer text-xs"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(o.value)}
                    onChange={() => toggle(o.value)}
                    className="accent-brand-pink h-3 w-3"
                  />
                  <span className="truncate" title={o.label}>{o.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadDropZone({
  label, sublabel, onLoad,
}: {
  label: string;
  sublabel: string;
  onLoad: (f: File) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onLoad(f);
  };
  return (
    <label
      className={`cursor-pointer border-dashed border-2 rounded-md transition-colors text-center block py-4 px-3 ${
        dragOver ? 'border-brand-pink bg-brand-pink/5' : 'border-surface-200 hover:border-surface-300'
      }`}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <input
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) onLoad(f);
        }}
      />
      <Upload size={16} className="mx-auto text-surface-400 mb-1" />
      <div className="text-xs font-medium text-brand-navy">{label}</div>
      <div className="text-[10px] text-surface-500 mt-0.5">{sublabel}</div>
      <div className="text-[10px] text-surface-400 mt-1">Drop or click to browse</div>
    </label>
  );
}

function LoadedFileChip({ data, onClear }: { data: CSVData; onClear: () => void }) {
  return (
    <div className="bg-surface-50 border border-surface-100 rounded px-2 py-2 flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-brand-navy flex items-center gap-1.5 truncate">
          <FileSpreadsheet size={13} className="text-brand-pink shrink-0" />
          <span className="truncate" title={data.filename}>{data.filename}</span>
        </div>
        <div className="text-[10px] text-surface-500 mt-0.5">
          {fmtInt(data.rows.length)} rows · {data.columns.length} columns
        </div>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="text-surface-400 hover:text-red-600 p-0.5"
        aria-label="Clear"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function ColumnPicker({
  label, columns, value, onChange, optional = false, disabled = false, onRemove,
}: {
  label: string;
  columns: string[];
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  disabled?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <label className="text-surface-600 w-14 shrink-0">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className={`flex-1 text-xs px-2 py-1 border border-surface-200 rounded bg-white text-brand-navy hover:border-surface-300 focus:outline-none focus:ring-2 focus:ring-brand-pink/30 ${
          disabled ? 'opacity-60 cursor-not-allowed' : ''
        }`}
      >
        {optional && <option value="">(none)</option>}
        {columns.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-surface-400 hover:text-red-600 p-0.5 shrink-0"
          aria-label={`Remove ${label} mapping`}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

// Display-only mapping row with an editable label + column picker. Lives
// only in mappingB.extras — never used for matching or revenue. The label
// becomes a column header in the results preview and a column header in
// the downloaded CSV (prefixed with `_match_`).
function ExtraMappingRow({
  extra, columns, onChangeLabel, onChangeColumn, onRemove,
}: {
  extra: ExtraMapping;
  columns: string[];
  onChangeLabel: (v: string) => void;
  onChangeColumn: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <input
        type="text"
        value={extra.label}
        onChange={e => onChangeLabel(e.target.value)}
        placeholder="Label"
        className="w-14 shrink-0 text-xs px-1 py-1 border-b border-surface-200 bg-transparent focus:outline-none focus:border-brand-pink"
      />
      <select
        value={extra.column}
        onChange={e => onChangeColumn(e.target.value)}
        className="flex-1 text-xs px-2 py-1 border border-surface-200 rounded bg-white text-brand-navy hover:border-surface-300 focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
      >
        {columns.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      <button
        type="button"
        onClick={onRemove}
        className="text-surface-400 hover:text-red-600 p-0.5 shrink-0"
        aria-label={`Remove ${extra.label || 'custom'} mapping`}
      >
        <X size={11} />
      </button>
    </div>
  );
}

function FilterPanel({
  label, totalRows, filteredRows,
  bucketColumn, bucketColumnLabel = 'Bucket', bucketValues, bucketSel, setBucketSel,
  customFilters, setCustomFilters, columns, hideDetectionHint = false, hideBucketSection = false,
}: {
  label: string;
  totalRows: number;
  filteredRows: number;
  bucketColumn: string | null;
  bucketColumnLabel?: string;
  bucketValues: string[];
  bucketSel: Set<string>;
  setBucketSel: (s: Set<string>) => void;
  customFilters: FilterRule[];
  setCustomFilters: (f: FilterRule[]) => void;
  columns: string[];
  hideDetectionHint?: boolean;
  hideBucketSection?: boolean;
}) {
  const addFilter = () => {
    setCustomFilters([
      ...customFilters,
      { id: `f${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, column: columns[0] || '', operator: 'equals', value: '' },
    ]);
  };
  const updateFilter = (id: string, patch: Partial<FilterRule>) => {
    setCustomFilters(customFilters.map(f => f.id === id ? { ...f, ...patch } : f));
  };
  const removeFilter = (id: string) => {
    setCustomFilters(customFilters.filter(f => f.id !== id));
  };
  const showBuckets = !hideBucketSection && !!bucketColumn && bucketValues.length > 0;
  return (
    <div className="card p-3 mb-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider text-surface-500">{label}</div>
        <div className="text-[11px] text-surface-500">
          <strong className="text-brand-navy">{fmtInt(totalRows)}</strong> rows →{' '}
          <strong className="text-brand-pink">{fmtInt(filteredRows)}</strong> after filter
        </div>
      </div>

      {showBuckets && (
        <BucketPills
          label={bucketColumnLabel}
          column={bucketColumn!}
          values={bucketValues}
          selected={bucketSel}
          onChange={setBucketSel}
          hideDetectionHint={hideDetectionHint}
        />
      )}

      <div className={showBuckets ? 'border-t border-surface-100 pt-2' : ''}>
        {customFilters.length > 0 && (
          <div className="text-[10px] text-surface-500 mb-1">Custom filters (AND)</div>
        )}
        {customFilters.map(f => (
          <CustomFilterRow
            key={f.id}
            filter={f}
            columns={columns}
            onUpdate={patch => updateFilter(f.id, patch)}
            onRemove={() => removeFilter(f.id)}
          />
        ))}
        <button
          type="button"
          onClick={addFilter}
          className="text-[11px] px-2 py-1 rounded text-surface-600 hover:text-brand-navy inline-flex items-center gap-1 mt-1"
        >
          <Plus size={11} /> Add filter
        </button>
      </div>
    </div>
  );
}

// Renders the bucket / status preset pills used inside FilterPanel AND inside
// the Dashboard source panel. Same visual treatment in both places — accent
// color for known "positive" buckets (Top Priority, success). State is owned
// by the parent, so toggling in either location updates the same set.
function BucketPills({
  label, column, values, selected, onChange, hideDetectionHint = false,
}: {
  label: string;
  column: string;
  values: string[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  hideDetectionHint?: boolean;
}) {
  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next);
  };
  return (
    <div className="mb-2.5">
      <div className="text-[10px] text-surface-500 mb-1">
        {label}
        {!hideDetectionHint && (
          <span className="italic text-surface-400"> (detected from <code className="text-[9px]">{column}</code>)</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 items-center">
        {values.map(v => {
          const on = selected.has(v);
          const isDashboard = DASHBOARD_BUCKETS.includes(v);
          const labelText = isDashboard ? BUCKET_LABELS[v] : v;
          // Only top_priority gets the emerald "this is the good outcome"
          // accent — it's a known meaningful bucket from the Leads page.
          // We deliberately do NOT pattern-match on values like "success" /
          // "paid" — different teams use different vocabularies (e.g.
          // "authSuccess") and implicit semantics here would silently
          // mis-color rows. Let the user's filter selection drive meaning.
          const accent = v === 'top_priority';
          return (
            <button
              key={v}
              type="button"
              onClick={() => toggle(v)}
              className={`text-[11px] px-2 py-1 rounded inline-flex items-center gap-1 transition-colors ${
                on
                  ? accent
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : 'bg-brand-navy/5 text-brand-navy border border-brand-navy/20'
                  : 'bg-surface-50 text-surface-400 border border-surface-200 hover:text-surface-700'
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => {}}
                className={`h-3 w-3 pointer-events-none ${accent ? 'accent-emerald-600' : 'accent-brand-pink'}`}
              />
              {labelText}
            </button>
          );
        })}
        <span className="text-[10px] text-surface-400 mx-1">·</span>
        <button type="button" onClick={() => onChange(new Set(values))} className="text-[10px] text-brand-pink hover:underline">All</button>
        <span className="text-[10px] text-surface-300">·</span>
        <button type="button" onClick={() => onChange(new Set())} className="text-[10px] text-surface-400 hover:underline">None</button>
      </div>
    </div>
  );
}

function CustomFilterRow({
  filter, columns, onUpdate, onRemove,
}: {
  filter: FilterRule;
  columns: string[];
  onUpdate: (p: Partial<FilterRule>) => void;
  onRemove: () => void;
}) {
  const needsValue = filter.operator !== 'empty' && filter.operator !== 'not_empty';
  const needsSecondValue = filter.operator === 'between';
  return (
    <div className="flex items-center gap-1.5 mb-1.5 text-xs">
      <select
        value={filter.column}
        onChange={e => onUpdate({ column: e.target.value })}
        className="flex-1 min-w-0 text-xs px-2 py-1 border border-surface-200 rounded bg-white"
      >
        {columns.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      <select
        value={filter.operator}
        onChange={e => onUpdate({ operator: e.target.value as FilterOperator })}
        className="text-xs px-2 py-1 border border-surface-200 rounded bg-white shrink-0"
      >
        {(Object.keys(OPERATOR_LABELS) as FilterOperator[]).map(op =>
          <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
        )}
      </select>
      {needsValue && (
        <input
          type="text"
          value={filter.value}
          onChange={e => onUpdate({ value: e.target.value })}
          placeholder="value"
          className="w-24 text-xs px-2 py-1 border border-surface-200 rounded bg-white"
        />
      )}
      {needsSecondValue && (
        <>
          <span className="text-[10px] text-surface-400">and</span>
          <input
            type="text"
            value={filter.value2 ?? ''}
            onChange={e => onUpdate({ value2: e.target.value })}
            placeholder="value"
            className="w-24 text-xs px-2 py-1 border border-surface-200 rounded bg-white"
          />
        </>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="text-surface-400 hover:text-red-600 p-1"
        aria-label="Remove filter"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ResultsBlock({
  results, mappingA, mappingB, hasAmount, hasPaid,
}: {
  results: Results;
  mappingA: ColumnMappingA;
  mappingB: ColumnMappingB;
  hasAmount: boolean;
  hasPaid: boolean;
}) {
  const { totalA, keyMatched, preExisting, attributed, unmatched, revenueTotal, revenuePaid } = results;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <KPI label="Leads (File A)" value={fmtInt(totalA)} />
        <KPI label="Attributed" value={fmtInt(attributed)} sub={fmtPct(attributed, totalA)} accent="green" />
        {hasAmount && <KPI label="Revenue (total)" value={fmtINR(revenueTotal)} />}
        {hasPaid   && <KPI label="Revenue (paid)"  value={fmtINR(revenuePaid)} />}
        {!hasAmount && !hasPaid && (
          <>
            <KPI label="Pre-existing" value={fmtInt(preExisting)} sub={fmtPct(preExisting, totalA)} accent="amber" />
            <KPI label="Unmatched"    value={fmtInt(unmatched)}   sub={fmtPct(unmatched, totalA)} />
          </>
        )}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            <FunnelRow label="Total leads in File A" count={totalA} total={totalA} bold />
            <FunnelRow label="Phone exists in File B (ever)" count={keyMatched} total={totalA} indent={1} />
            <FunnelRow label="B before A — pre-existing customers" count={preExisting} total={totalA} indent={2} chip="amber" chipLabel="Pre-existing" />
            <FunnelRow label="B after A — attributed" count={attributed} total={totalA} indent={2} chip="green" chipLabel="Attributed" emphasize />
            <FunnelRow label="No match in File B" count={unmatched} total={totalA} indent={1} muted />
          </tbody>
        </table>
      </div>

      {(hasAmount || hasPaid) && (
        <div className="card p-3 mt-3">
          <div className="text-[11px] uppercase tracking-wider text-surface-500 mb-2">Attributed revenue</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            {hasAmount && (
              <div>
                <div className="text-xs text-surface-500">Total amount (sum of {mappingB.amount})</div>
                <div className="text-lg font-semibold text-brand-navy">{fmtINR(revenueTotal)}</div>
                <div className="text-[10px] text-surface-400 mt-1">Includes future EMI installments. Optimistic.</div>
              </div>
            )}
            {hasPaid && (
              <div>
                <div className="text-xs text-surface-500">Paid amount (sum of {mappingB.amountPaid})</div>
                <div className="text-lg font-semibold text-brand-navy">{fmtINR(revenuePaid)}</div>
                <div className="text-[10px] text-surface-400 mt-1">Only first-installment receipts. Conservative.</div>
              </div>
            )}
          </div>
          {hasAmount && hasPaid && revenueTotal > 0 && (
            <div className="text-[11px] text-surface-500 mt-2 pt-2 border-t border-surface-100">
              Realized so far: <strong className="text-brand-navy">{((revenuePaid / revenueTotal) * 100).toFixed(0)}%</strong>{' '}
              · Remaining EMI exposure: <strong className="text-brand-navy">{fmtINR(revenueTotal - revenuePaid)}</strong>
            </div>
          )}
        </div>
      )}

      {/* Inline previews — expandable cards that let the user spot-check
          matches without downloading. Each section is independently
          collapsible and paginated (25 rows per page). */}
      <ResultDetailSection
        title="Attributed"
        count={results.attributedPairs.length}
        chip="green"
        matchedPairs={results.attributedPairs}
        mappingA={mappingA}
        mappingB={mappingB}
      />
      <ResultDetailSection
        title="Pre-existing"
        count={results.preExistingPairs.length}
        chip="amber"
        matchedPairs={results.preExistingPairs}
        mappingA={mappingA}
        mappingB={mappingB}
      />
      <ResultDetailSection
        title="Unmatched"
        count={results.unmatchedRows.length}
        chip="gray"
        unmatchedRows={results.unmatchedRows}
        mappingA={mappingA}
        mappingB={mappingB}
      />

      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          onClick={() => downloadCSV(`attributed_leads_${Date.now()}.csv`, flattenPairs(results.attributedPairs, mappingB))}
          disabled={results.attributedPairs.length === 0}
          className="text-xs px-3 py-1.5 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 font-medium hover:bg-emerald-100 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download size={12} /> Attributed ({fmtInt(results.attributedPairs.length)})
        </button>
        <button
          type="button"
          onClick={() => downloadCSV(`preexisting_leads_${Date.now()}.csv`, flattenPairs(results.preExistingPairs, mappingB))}
          disabled={results.preExistingPairs.length === 0}
          className="text-xs px-3 py-1.5 rounded-md border border-amber-200 bg-amber-50 text-amber-700 font-medium hover:bg-amber-100 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download size={12} /> Pre-existing ({fmtInt(results.preExistingPairs.length)})
        </button>
        <button
          type="button"
          onClick={() => downloadCSV(`unmatched_leads_${Date.now()}.csv`, results.unmatchedRows)}
          disabled={results.unmatchedRows.length === 0}
          className="text-xs px-3 py-1.5 rounded-md border border-surface-200 bg-white text-surface-700 font-medium hover:bg-surface-50 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download size={12} /> Unmatched ({fmtInt(results.unmatchedRows.length)})
        </button>
      </div>
    </>
  );
}

// Expandable preview card showing the rows behind one results bucket
// (Attributed / Pre-existing / Unmatched). Lets the user spot-check
// matches inline before deciding to download the full list. Paginated 25
// rows per page so the DOM doesn't explode on large datasets.
function ResultDetailSection({
  title, count, chip,
  matchedPairs, unmatchedRows,
  mappingA, mappingB,
}: {
  title: string;
  count: number;
  chip: 'green' | 'amber' | 'gray';
  matchedPairs?: MatchedPair[];
  unmatchedRows?: Record<string, string>[];
  mappingA: ColumnMappingA;
  mappingB: ColumnMappingB;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showCount, setShowCount] = useState(25);

  if (count === 0) return null;

  // Discriminator: matched view shows lag/B-date/amount/status; unmatched
  // view only has A's columns to show.
  const isUnmatched = !matchedPairs;
  const totalLen = isUnmatched
    ? (unmatchedRows?.length ?? 0)
    : (matchedPairs?.length ?? 0);
  const hasMore = totalLen > showCount;

  const chipClass =
    chip === 'green' ? 'bg-emerald-50 text-emerald-700' :
    chip === 'amber' ? 'bg-amber-50 text-amber-700' :
    'bg-surface-100 text-surface-600';

  return (
    <div className="card overflow-hidden mt-3">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-surface-50 transition-colors"
      >
        {expanded
          ? <ChevronDown size={14} className="text-surface-400" />
          : <ChevronRight size={14} className="text-surface-400" />}
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${chipClass}`}>{title}</span>
        <span className="text-sm text-brand-navy font-medium">{fmtInt(count)} leads</span>
        <span className="text-[11px] text-surface-400 ml-auto">
          {expanded ? 'Tap to collapse' : 'Tap to preview rows'}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-surface-100 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-surface-50 text-[10px] uppercase tracking-wider text-surface-500">
              <tr>
                <th className="text-left py-2 px-3 whitespace-nowrap">Phone</th>
                <th className="text-left py-2 px-3 whitespace-nowrap">Name</th>
                <th className="text-left py-2 px-3 whitespace-nowrap">Bucket</th>
                {mappingA.extras.map((e, i) => (
                  <th key={`ha-${i}`} className="text-left py-2 px-3 whitespace-nowrap">{e.label || '—'}</th>
                ))}
                <th className="text-right py-2 px-3 whitespace-nowrap">A date</th>
                {!isUnmatched && <th className="text-right py-2 px-3 whitespace-nowrap">B date</th>}
                {!isUnmatched && <th className="text-right py-2 px-3 whitespace-nowrap">Lag</th>}
                {!isUnmatched && mappingB.amount && <th className="text-right py-2 px-3 whitespace-nowrap">Amount</th>}
                {!isUnmatched && mappingB.amountPaid && <th className="text-right py-2 px-3 whitespace-nowrap">Paid</th>}
                {!isUnmatched && mappingB.extras.map((e, i) => (
                  <th key={`hb-${i}`} className="text-left py-2 px-3 whitespace-nowrap">{e.label || '—'}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(isUnmatched
                ? (unmatchedRows ?? []).slice(0, showCount).map(r => ({ a: r, b: {} as Record<string, string>, aDateIso: parseDate(r[mappingA.date] ?? ''), bDateIso: null, lagDays: null }))
                : (matchedPairs ?? []).slice(0, showCount)
              ).map((item, i) => {
                const aRow = item.a;
                const bRow = item.b;
                const name = aRow.callee_name || aRow.name || '';
                const bucket = aRow._bucket;
                const amountStr = bRow && mappingB.amount ? (bRow[mappingB.amount] ?? '') : '';
                const amountNum = parseFloat(amountStr);
                const paidStr   = bRow && mappingB.amountPaid ? (bRow[mappingB.amountPaid] ?? '') : '';
                const paidNum   = parseFloat(paidStr);
                return (
                  <tr key={i} className="border-b border-surface-100 last:border-b-0 hover:bg-surface-50/50">
                    <td className="py-2 px-3 tabular-nums text-surface-700 whitespace-nowrap">
                      {normalizePhone(aRow[mappingA.phone] ?? '') || <span className="text-surface-300">—</span>}
                    </td>
                    <td className="py-2 px-3 text-surface-700">
                      {name || <span className="text-surface-300">—</span>}
                    </td>
                    <td className="py-2 px-3">
                      {bucket ? (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          bucket === 'top_priority'
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-surface-100 text-surface-600'
                        }`}>
                          {BUCKET_LABELS[bucket] || bucket}
                        </span>
                      ) : <span className="text-surface-300">—</span>}
                    </td>
                    {/* A extras — Vendor / Campaign / Agent or any custom
                        column the user mapped from File A. Same truncation
                        rule as B extras to keep long values from blowing
                        out the row. */}
                    {mappingA.extras.map((e, ix) => {
                      const val = aRow[e.column] ?? '';
                      return (
                        <td key={`ca-${i}-${ix}`} className="py-2 px-3 text-surface-700 max-w-[140px] truncate" title={val}>
                          {val || <span className="text-surface-300">—</span>}
                        </td>
                      );
                    })}
                    <td className="py-2 px-3 text-right tabular-nums text-surface-700 whitespace-nowrap">
                      {item.aDateIso || <span className="text-surface-300">—</span>}
                    </td>
                    {!isUnmatched && (
                      <td className="py-2 px-3 text-right tabular-nums text-surface-700 whitespace-nowrap">
                        {item.bDateIso || <span className="text-surface-300">—</span>}
                      </td>
                    )}
                    {!isUnmatched && (
                      <td className="py-2 px-3 text-right tabular-nums text-surface-500 whitespace-nowrap">
                        {item.lagDays != null ? `${item.lagDays}d` : <span className="text-surface-300">—</span>}
                      </td>
                    )}
                    {!isUnmatched && mappingB.amount && (
                      <td className="py-2 px-3 text-right tabular-nums text-surface-700 whitespace-nowrap">
                        {!Number.isNaN(amountNum) && amountStr !== ''
                          ? fmtINR(amountNum)
                          : (amountStr || <span className="text-surface-300">—</span>)}
                      </td>
                    )}
                    {!isUnmatched && mappingB.amountPaid && (
                      <td className="py-2 px-3 text-right tabular-nums text-surface-700 whitespace-nowrap">
                        {!Number.isNaN(paidNum) && paidStr !== ''
                          ? fmtINR(paidNum)
                          : (paidStr || <span className="text-surface-300">—</span>)}
                      </td>
                    )}
                    {/* Display extras — Product, Source, or any custom column
                        the user added. Truncated visually with overflow-hidden
                        so a long URL or paragraph doesn't blow out the row. */}
                    {!isUnmatched && mappingB.extras.map((e, ix) => {
                      const val = bRow ? (bRow[e.column] ?? '') : '';
                      return (
                        <td key={`cb-${i}-${ix}`} className="py-2 px-3 text-surface-700 max-w-[140px] truncate" title={val}>
                          {val || <span className="text-surface-300">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {hasMore && (
            <div className="px-3 py-2 border-t border-surface-100 bg-surface-50/50 flex items-center justify-between gap-2 text-[11px]">
              <span className="text-surface-500">
                Showing {fmtInt(showCount)} of {fmtInt(totalLen)} · download the full list below for all rows
              </span>
              <button
                type="button"
                onClick={() => setShowCount(c => c + 25)}
                className="text-brand-pink hover:underline"
              >
                Show next 25
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KPI({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'green' | 'amber' }) {
  const valueColor =
    accent === 'green' ? 'text-emerald-700' :
    accent === 'amber' ? 'text-amber-700'  :
    'text-brand-navy';
  return (
    <div className="card p-3">
      <div className="text-[11px] text-surface-500">{label}</div>
      <div className={`text-xl font-semibold ${valueColor} tabular-nums mt-0.5`}>{value}</div>
      {sub && <div className="text-[10px] text-surface-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function FunnelRow({
  label, count, total, indent = 0, bold, muted, emphasize, chip, chipLabel,
}: {
  label: string;
  count: number;
  total: number;
  indent?: number;
  bold?: boolean;
  muted?: boolean;
  emphasize?: boolean;
  chip?: 'green' | 'amber';
  chipLabel?: string;
}) {
  return (
    <tr className="border-b border-surface-100 last:border-b-0">
      <td
        className={`py-2.5 px-3 ${muted ? 'text-surface-500' : 'text-brand-navy'} ${bold ? 'font-medium' : ''}`}
        style={{ paddingLeft: `${12 + indent * 16}px` }}
      >
        {chip && chipLabel && (
          <span
            className={`inline-block text-[10px] px-1.5 py-0.5 rounded mr-2 ${
              chip === 'green' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
            }`}
          >
            {chipLabel}
          </span>
        )}
        {label}
      </td>
      <td className={`py-2.5 px-3 text-right tabular-nums ${emphasize ? 'font-semibold text-brand-navy' : ''} ${muted ? 'text-surface-500' : ''}`}>
        {fmtInt(count)}
      </td>
      <td className="py-2.5 px-3 text-right tabular-nums text-surface-500 w-16">
        {fmtPct(count, total)}
      </td>
    </tr>
  );
}
