'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Upload, X, Plus, Download, Play, ChevronRight, ChevronDown,
  RotateCcw, Shuffle, FileSpreadsheet, AlertCircle, Database, Loader2,
  Check,
} from 'lucide-react';
import { CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { api } from '@/lib/api';
import type { Agent, Campaign, Filters, Vendor } from '@/types';
import { useRequireProductLine } from '@/lib/use-product-line';

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
  // Per-source bucket column. For the dashboard slot this is set to '_bucket'
  // (a synthetic column the dashboard fetch adds). For uploaded files the user
  // picks the column that contains the lead category (e.g. 'lead_temperature',
  // 'sales_team', 'category'). Unique values from this column are auto-added
  // to the bucket pill filter so newly-uploaded buckets are included by
  // default — the user can deselect individual values via the pills.
  bucket?: string;
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
  // Per-source status column. OPTIONAL — leave empty if your file only
  // contains valid (success/paid) rows. If mapped, unique column values are
  // auto-added to the status pill filter and only matching rows enter the
  // attribution match. Common columns: 'status', 'payment_status', 'state'.
  status?: string;
  // Display-only mappings. Shown as columns in the preview tables and
  // appended to download CSVs. Don't affect the matching algorithm.
  // Each entry has a user-editable label + the source column from File B.
  extras: ExtraMapping[];
};

type ExtraMapping = { label: string; column: string };

type AttributionRule = 'b_after_a' | 'any_time';
type DashboardRange = 'last_7' | 'last_30' | 'last_90' | 'last_180' | 'all_time';

type MatchedPair = {
  a: Record<string, string>;
  b: Record<string, string>;
  bDateIso: string | null;
  aDateIso: string | null;
  lagDays: number | null;
  // Mapping that was used to read the A row. Carries the source-specific
  // phone/date column names. Used by duplicate detection and per-source pivots.
  aMapping: ColumnMappingA;
  // Mapping that was used to read the B row. Lets the preview table /
  // download read amount / paid / extras with the correct source-specific
  // column names rather than assuming a single global mappingB.
  bMapping: ColumnMappingB;
  // Source labels for pivot views. Identifies which A file / B file the
  // matched rows came from (e.g. "Dashboard", "File A.2 · prospects.csv").
  aSourceLabel: string;
  bSourceLabel: string;
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
  // Parallel to unmatchedRows. Carries the source mapping + label for each
  // unmatched row so the duplicate detector can read the right phone column
  // and attribute the duplicate to the right A source.
  unmatchedSources: Array<{ row: Record<string, string>; mapping: ColumnMappingA; label: string }>;
  // Per-source filtered-row counts. Keys are source labels (matching
  // MatchedPair.aSourceLabel / bSourceLabel). Used by SourcePivot to compute
  // CVR (customers / leads) per A source and attribution rate per B source.
  aSourceTotals: Record<string, number>;
  bSourceTotals: Record<string, number>;
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

// ---- XLSX / XLS parser (lazy-loaded SheetJS from CDN) ----------------------

// SheetJS pulled at runtime so the main bundle stays slim. Cached after first
// load — second upload is instant. CDN script tag pattern keeps Next.js
// happy (it would otherwise try to resolve `xlsx` at build time and fail).
let xlsxLibPromise: Promise<any> | null = null;
function loadXLSXLib(): Promise<any> {
  if (xlsxLibPromise) return xlsxLibPromise;
  if (typeof window !== 'undefined' && (window as any).XLSX) {
    xlsxLibPromise = Promise.resolve((window as any).XLSX);
    return xlsxLibPromise;
  }
  xlsxLibPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('SSR cannot load XLSX library'));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    script.async = true;
    script.onload = () => {
      const XLSX = (window as any).XLSX;
      if (XLSX) resolve(XLSX);
      else reject(new Error('XLSX library loaded but global is missing'));
    };
    script.onerror = () => reject(new Error('Failed to load XLSX library from CDN'));
    document.head.appendChild(script);
  });
  return xlsxLibPromise;
}

// Parse a workbook ArrayBuffer. Takes the first sheet by default (most user
// uploads are single-sheet exports). All cells stringified — matches what
// parseCSV returns, so downstream filtering / phone / date logic works
// unchanged. Empty header cells get auto-named "column_N" so the picker
// doesn't show blank options.
async function parseXLSX(buffer: ArrayBuffer): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  const XLSX = await loadXLSXLib();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { columns: [], rows: [] };
  const sheet = workbook.Sheets[sheetName];
  // header:1 returns array-of-arrays. Easier to dedup / clean headers than
  // letting SheetJS auto-derive object keys from the first row.
  const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,        // coerce every cell to string
    defval: '',        // fill blanks with empty string
    blankrows: false,  // skip fully-empty rows
  });
  if (aoa.length === 0) return { columns: [], rows: [] };

  const rawHeaders = aoa[0].map(c => (c == null ? '' : String(c).trim()));
  const columns: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < rawHeaders.length; i++) {
    let name = rawHeaders[i] || `column_${i + 1}`;
    // Disambiguate duplicate column names
    if (seen.has(name)) {
      const count = (seen.get(name) ?? 1) + 1;
      seen.set(name, count);
      name = `${name}_${count}`;
    } else {
      seen.set(name, 1);
    }
    columns.push(name);
  }

  const rows: Record<string, string>[] = [];
  for (let r = 1; r < aoa.length; r++) {
    const raw = aoa[r];
    const obj: Record<string, string> = {};
    let hasValue = false;
    for (let c = 0; c < columns.length; c++) {
      const v = raw[c];
      const s = v == null ? '' : String(v).trim();
      obj[columns[c]] = s;
      if (s) hasValue = true;
    }
    if (hasValue) rows.push(obj);
  }
  return { columns, rows };
}

// Dispatcher — picks the right parser by file extension. Falls back to CSV
// for unknown types since text mode handles both ".tsv" and weird .txt
// exports.
async function parseFile(file: File): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm') || name.endsWith('.xlsb')) {
    const buffer = await file.arrayBuffer();
    return parseXLSX(buffer);
  }
  // .csv, .tsv, or anything else — text mode
  const text = await file.text();
  return parseCSV(text);
}

// Merge multiple CSVData sources into one. Column list is the union (preserves
// first-seen order so dashboard's mobile_number / final_lead_status_date stay
// at the front when present). Rows from a source missing a column get '' for
// that column — the algorithm's `row[col] ?? ''` reads already tolerate this.
// Returns null when parts is empty.
function mergeSources(parts: CSVData[]): CSVData | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];

  const seenCols = new Set<string>();
  const columns: string[] = [];
  for (const p of parts) {
    for (const c of p.columns) {
      if (!seenCols.has(c)) { seenCols.add(c); columns.push(c); }
    }
  }
  const rows: Record<string, string>[] = [];
  for (const p of parts) {
    for (const r of p.rows) {
      // Build a row with every union column present (default '') — keeps
      // downstream code from having to do existence checks everywhere.
      const merged: Record<string, string> = {};
      for (const c of columns) merged[c] = r[c] ?? '';
      rows.push(merged);
    }
  }
  return {
    filename: parts.map(p => p.filename).join(' + '),
    columns,
    rows,
  };
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
  // Bucket column auto-detection. Dashboard data carries '_bucket' (added
  // synthetically); uploaded CSVs typically have 'category', 'lead_status',
  // 'final_lead_status', etc. We always prefer '_bucket' first since the
  // dashboard's vocabulary is most useful, then fall through patterns.
  const bucket = detectCategoricalColumn(columns, BUCKET_COL_PATTERNS) ?? undefined;
  return {
    phone: findColumn(columns, ['mobile_number', 'phone_number', 'mobile', 'phone', 'contact_number', 'contact']) || columns[0] || '',
    date:  findColumn(columns, ['final_lead_status_date', 'final_date', 'ended_at', 'completed_at', 'started_at', 'created_at', '_date', 'date', 'timestamp']) || columns[0] || '',
    bucket,
    extras,
  };
}

function autoDetectB(columns: string[]): ColumnMappingB {
  // Only phone + date are auto-mapped by default. Amount / Paid / Product /
  // Source / Custom mappings are user-opt-in via the "+ Add" pills below.
  // Date patterns put transaction-style names (TxnOn, txn_date) first so they
  // win over generic "*Date" columns like "successDate" on CSVs that have both.
  const status = detectCategoricalColumn(columns, STATUS_COL_PATTERNS) ?? undefined;
  return {
    phone: findColumn(columns, ['mobile_number', 'phone_number', 'mobile', 'phone', 'user_phone', 'contact']) || columns[0] || '',
    date:  findColumn(columns, ['txnon', 'txn_on', 'txn_date', 'transaction_date', 'transaction_at', 'transaction_on', 'payment_date', 'paid_at', 'order_date', 'purchase_date', 'created_at', '_date', 'date', 'timestamp']) || columns[0] || '',
    status,
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

// Each A or B source feeds into the algorithm as a (rows, mapping) pair.
// The algorithm reads phone/date/amount/etc from `mapping`, so files with
// different column names (mobile vs phone, TxnOn vs created_at) still work.
type SourceWithMappingA = { rows: Record<string, string>[]; mapping: ColumnMappingA; label: string };
type SourceWithMappingB = { rows: Record<string, string>[]; mapping: ColumnMappingB; label: string };

type RunInput = {
  sourcesA: SourceWithMappingA[];
  sourcesB: SourceWithMappingB[];
  filtersA: FilterRule[];
  filtersB: FilterRule[];
  // Pill selections. Empty set = no filter (pass all). When non-empty, only
  // rows whose source-specific bucket/status column matches one of these
  // values are kept. The bucket column itself lives on each source's mapping
  // (mapping.bucket / mapping.status) — no global bucketColA anymore.
  bucketSelA: Set<string>;
  statusSelB: Set<string>;
  rule: AttributionRule;
  countSameDay: boolean;
};

function runAttribution(input: RunInput): Results {
  const {
    sourcesA, sourcesB,
    filtersA, filtersB,
    bucketSelA, statusSelB,
    rule, countSameDay,
  } = input;

  // Per-source filter pass. Each source declares its own bucket / status
  // column. Empty value (or no column mapped) = the row has no category, so
  // the pill filter doesn't exclude it (only custom-filter rules apply).
  // Unique values from the column are auto-added to the pill selection when
  // the upload is mapped — see the useEffect that watches uploadsA above.
  const passesA = (row: Record<string, string>, mapping: ColumnMappingA): boolean => {
    if (mapping.bucket && bucketSelA.size > 0) {
      const v = (row[mapping.bucket] ?? '').trim();
      if (v && !bucketSelA.has(v)) return false;
    }
    return passesAllFilters(row, filtersA);
  };
  const passesB = (row: Record<string, string>, mapping: ColumnMappingB): boolean => {
    if (mapping.status && statusSelB.size > 0) {
      const v = (row[mapping.status] ?? '').trim();
      if (v && !statusSelB.has(v)) return false;
    }
    return passesAllFilters(row, filtersB);
  };

  // Build B index by normalized phone across all sources. Each entry carries
  // the source-specific mapping so we read amount / paid from the right column
  // for that source.
  type IndexedB = {
    row: Record<string, string>;
    bDateIso: string | null;
    amount: number;
    amountPaid: number;
    mapping: ColumnMappingB;
    sourceLabel: string;
  };

  const bIndex = new Map<string, IndexedB[]>();
  // Per-source filtered count. Keyed by source label, written as we walk
  // each B source so callers can show "of X transactions, Y were attributed"
  // per source row.
  const bSourceTotals: Record<string, number> = {};
  for (const src of sourcesB) {
    const { rows, mapping, label } = src;
    if (!(label in bSourceTotals)) bSourceTotals[label] = 0;
    for (const row of rows) {
      if (!passesB(row, mapping)) continue;
      bSourceTotals[label]++;
      const phone = normalizePhone(row[mapping.phone] ?? '');
      if (!phone) continue;
      const entry: IndexedB = {
        row,
        bDateIso: parseDate(row[mapping.date] ?? ''),
        amount: mapping.amount ? (parseFloat(row[mapping.amount]) || 0) : 0,
        amountPaid: mapping.amountPaid ? (parseFloat(row[mapping.amountPaid]) || 0) : 0,
        mapping,
        sourceLabel: label,
      };
      if (!bIndex.has(phone)) bIndex.set(phone, []);
      bIndex.get(phone)!.push(entry);
    }
  }
  bIndex.forEach(list => {
    list.sort((x, y) => (x.bDateIso ?? '\uffff').localeCompare(y.bDateIso ?? '\uffff'));
  });

  // Walk A across all sources using each one's own mapping.
  const attributedPairs: MatchedPair[] = [];
  const preExistingPairs: MatchedPair[] = [];
  const unmatchedRows: Record<string, string>[] = [];
  const unmatchedSources: Array<{ row: Record<string, string>; mapping: ColumnMappingA; label: string }> = [];
  let revenueTotal = 0;
  let revenuePaid = 0;
  let totalARowsKept = 0;

  const pushUnmatched = (row: Record<string, string>, mapping: ColumnMappingA, label: string) => {
    unmatchedRows.push(row);
    unmatchedSources.push({ row, mapping, label });
  };

  // Per-source filtered count for A. We increment for every A row that
  // passes filters (regardless of whether it later matches a B row). This is
  // the "total leads from this source we considered" denominator for CVR.
  const aSourceTotals: Record<string, number> = {};

  for (const src of sourcesA) {
    const { rows, mapping, label: aLabel } = src;
    if (!(aLabel in aSourceTotals)) aSourceTotals[aLabel] = 0;
    for (const aRow of rows) {
      if (!passesA(aRow, mapping)) continue;
      totalARowsKept++;
      aSourceTotals[aLabel]++;
      const aPhone = normalizePhone(aRow[mapping.phone] ?? '');
      const aDateIso = parseDate(aRow[mapping.date] ?? '');

      if (!aPhone) { pushUnmatched(aRow, mapping, aLabel); continue; }

      const candidates = bIndex.get(aPhone);
      if (!candidates || candidates.length === 0) {
        pushUnmatched(aRow, mapping, aLabel);
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
          aMapping: mapping,
          bMapping: matched.mapping,
          aSourceLabel: aLabel,
          bSourceLabel: matched.sourceLabel,
        });
        revenueTotal += matched.amount;
        revenuePaid  += matched.amountPaid;
      } else if (earliestBefore || candidates.length > 0) {
        const b = earliestBefore ?? candidates[0];
        preExistingPairs.push({
          a: aRow, b: b.row,
          bDateIso: b.bDateIso, aDateIso,
          lagDays: daysBetween(aDateIso, b.bDateIso),
          aMapping: mapping,
          bMapping: b.mapping,
          aSourceLabel: aLabel,
          bSourceLabel: b.sourceLabel,
        });
      } else {
        pushUnmatched(aRow, mapping, aLabel);
      }
    }
  }

  return {
    totalA: totalARowsKept,
    keyMatched: attributedPairs.length + preExistingPairs.length,
    preExisting: preExistingPairs.length,
    attributed: attributedPairs.length,
    unmatched: unmatchedRows.length,
    revenueTotal, revenuePaid,
    attributedPairs, preExistingPairs, unmatchedRows, unmatchedSources,
    aSourceTotals, bSourceTotals,
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

function flattenPairs(pairs: MatchedPair[]): Record<string, unknown>[] {
  return pairs.map(p => {
    const mb = p.bMapping;
    const out: Record<string, unknown> = { ...p.a };
    out['_match_b_phone']  = normalizePhone(p.b[mb.phone] ?? '');
    out['_match_b_date']   = p.bDateIso ?? '';
    out['_match_lag_days'] = p.lagDays ?? '';
    if (mb.amount)     out['_match_amount']      = p.b[mb.amount] ?? '';
    if (mb.amountPaid) out['_match_amount_paid'] = p.b[mb.amountPaid] ?? '';
    // Display extras flow into the CSV too, prefixed with `_match_` and
    // slug-cased so they don't collide with A's existing column names.
    // Empty labels are skipped (user added the row but never typed a name).
    for (const extra of mb.extras) {
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
  const ready = useRequireProductLine();

  // Dashboard fetch config
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

  // File A sources — dashboard fetch (one slot) PLUS any number of uploaded
  // files. They merge into a single CSVData via union of columns. File B is
  // upload-only, so it's just an array. Each source has its own × chip so the
  // user can drop one without losing the rest.
  const [dashboardData, setDashboardData] = useState<CSVData | null>(null);
  const [uploadsA, setUploadsA] = useState<CSVData[]>([]);
  const [uploadsB, setUploadsB] = useState<CSVData[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState<'A' | 'B' | null>(null);

  // The merged datasets we hand to the algorithm. Re-derived whenever any
  // source changes. mergeSources unions the column lists; rows from a source
  // missing a column get '' for that column.
  const fileA: CSVData | null = useMemo(() => {
    const parts: CSVData[] = [];
    if (dashboardData) parts.push(dashboardData);
    parts.push(...uploadsA);
    return mergeSources(parts);
  }, [dashboardData, uploadsA]);

  const fileB: CSVData | null = useMemo(() => mergeSources(uploadsB), [uploadsB]);

  // True when ANY File A source comes from the dashboard. Drives auto-mapping
  // lock + the "auto-mapped" hint in Step 2.
  const hasDashboardA = !!dashboardData;

  // Per-source mappings. Dashboard gets its own slot since it survives upload
  // add/remove; uploads use parallel arrays so indexes stay stable. The
  // algorithm reads `mappingDashboardA` for dashboard rows and `mappingsUploadsA[i]`
  // for the i-th uploaded A file. Each B file has its own mapping in mappingsB[i].
  // This lets File A.1 use `mobile_number` while File A.2 uses `phone` — both
  // become "phone column for that source" when matching.
  const [mappingDashboardA, setMappingDashboardA] = useState<ColumnMappingA | null>(null);
  const [mappingsUploadsA, setMappingsUploadsA] = useState<ColumnMappingA[]>([]);
  const [mappingsB, setMappingsB] = useState<ColumnMappingB[]>([]);

  // Bucket / status pill values — union across all sources' mapped bucket
  // (or status) columns. Each source carries its own column name on its
  // mapping, so this loop walks the dashboard row set and every uploaded
  // file, reading each one's mapped bucket/status column.
  //
  // We deliberately compute this BEFORE the `sourcesA` useMemo so the pills
  // populate immediately when files load — `sourcesA` includes more derived
  // state (filtering) that's irrelevant for choosing which pills to show.
  const bucketValuesA = useMemo(() => {
    const set = new Set<string>();
    const collect = (rows: Record<string, string>[], col: string | undefined) => {
      if (!col) return;
      for (const r of rows) {
        const v = (r[col] ?? '').trim();
        if (v) set.add(v);
        if (set.size >= 100) return; // safety cap; pills above ~50 are unusable anyway
      }
    };
    if (dashboardData && mappingDashboardA) collect(dashboardData.rows, mappingDashboardA.bucket);
    uploadsA.forEach((u, i) => collect(u.rows, mappingsUploadsA[i]?.bucket));
    const values = Array.from(set);
    values.sort((a, b) => {
      const oa = BUCKET_ORDER[a];
      const ob = BUCKET_ORDER[b];
      if (oa !== undefined && ob !== undefined) return oa - ob;
      if (oa !== undefined) return -1;
      if (ob !== undefined) return 1;
      return a.localeCompare(b);
    });
    return values;
  }, [dashboardData, mappingDashboardA, uploadsA, mappingsUploadsA]);
  const [bucketSelA, setBucketSelA] = useState<Set<string>>(new Set());

  const statusValuesB = useMemo(() => {
    const set = new Set<string>();
    uploadsB.forEach((u, i) => {
      const col = mappingsB[i]?.status;
      if (!col) return;
      for (const r of u.rows) {
        const v = (r[col] ?? '').trim();
        if (v) set.add(v);
        if (set.size >= 100) return;
      }
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [uploadsB, mappingsB]);
  const [statusSelB, setStatusSelB] = useState<Set<string>>(new Set());

  // Auto-include unique bucket values from uploaded A sources into bucketSelA.
  //
  // The pain point this fixes: user uploads a CSV with a `lead_temperature`
  // column (values: hot/warm/cold), maps it to Bucket, runs attribution → zero
  // rows pass because bucketSelA only contained the dashboard defaults
  // (top_priority, interested_only, callback_only). The uploaded values weren't
  // selected so passesA filtered every row.
  //
  // Fix: when an upload's bucket column is mapped, scan its values and add any
  // NEW ones to bucketSelA. A ref tracks "ever-seen" values so we only add
  // each value once — if the user later deselects a value via the pills, we
  // don't undo their choice on the next render.
  const seenUploadBucketValuesA = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh: string[] = [];
    for (let i = 0; i < uploadsA.length; i++) {
      const u = uploadsA[i];
      const m = mappingsUploadsA[i];
      if (!m || !m.bucket) continue;
      for (const row of u.rows) {
        const v = (row[m.bucket] ?? '').trim();
        if (!v) continue;
        if (seenUploadBucketValuesA.current.has(v)) continue;
        seenUploadBucketValuesA.current.add(v);
        fresh.push(v);
        // Cap to avoid stalling on huge files with many distinct values
        if (fresh.length >= 100) break;
      }
      if (fresh.length >= 100) break;
    }
    if (fresh.length === 0) return;
    setBucketSelA(prev => {
      const next = new Set(prev);
      for (const v of fresh) next.add(v);
      return next;
    });
  }, [uploadsA, mappingsUploadsA]);

  // Same auto-include logic for File B status values from uploaded payment
  // files. Skipped when no status column is mapped (status is optional now).
  const seenUploadStatusValuesB = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh: string[] = [];
    for (let i = 0; i < uploadsB.length; i++) {
      const u = uploadsB[i];
      const m = mappingsB[i];
      if (!m || !m.status) continue;
      for (const row of u.rows) {
        const v = (row[m.status] ?? '').trim();
        if (!v) continue;
        if (seenUploadStatusValuesB.current.has(v)) continue;
        seenUploadStatusValuesB.current.add(v);
        fresh.push(v);
        if (fresh.length >= 100) break;
      }
      if (fresh.length >= 100) break;
    }
    if (fresh.length === 0) return;
    setStatusSelB(prev => {
      const next = new Set(prev);
      for (const v of fresh) next.add(v);
      return next;
    });
  }, [uploadsB, mappingsB]);

  // Custom filters
  const [filtersA, setFiltersA] = useState<FilterRule[]>([]);
  const [filtersB, setFiltersB] = useState<FilterRule[]>([]);

  // Attribution rule
  const [rule, setRule] = useState<AttributionRule>('b_after_a');
  const [countSameDay, setCountSameDay] = useState(true);

  // Results
  const [results, setResults] = useState<Results | null>(null);
  const [running, setRunning] = useState(false);

  // Per-source auto-mapping. When the dashboard fetch arrives or a new file is
  // uploaded, initialize a mapping for it (auto-detect Phone/Date/Amount/etc
  // from its own columns). When a source is removed, drop its mapping. We sync
  // the parallel arrays length to the source arrays on every change.

  // Dashboard mapping — null when no dashboard, locked-mapped (mobile_number /
  // final_lead_status_date) when present since we know what export columns look like.
  useEffect(() => {
    if (!dashboardData) {
      setMappingDashboardA(null);
      return;
    }
    setMappingDashboardA(prev => {
      if (prev && dashboardData.columns.includes(prev.phone) && dashboardData.columns.includes(prev.date)) {
        // Already has a valid mapping (e.g. user re-fetched the dashboard). Preserve
        // user-edited extras whose columns still exist; add new presets.
        const extras: ExtraMapping[] = [];
        for (const e of prev.extras) {
          if (dashboardData.columns.includes(e.column)) extras.push(e);
        }
        for (const [label, patterns] of Object.entries(EXTRA_PRESET_PATTERNS_A)) {
          if (extras.some(e => e.label === label)) continue;
          const found = findColumn(dashboardData.columns, patterns);
          if (found) extras.push({ label, column: found });
        }
        // Force bucket to '_bucket' since the dashboard fetch always adds this
        // synthetic column. (Older mappings from before bucket-per-source
        // existed would have undefined here.)
        return { ...prev, bucket: '_bucket', extras };
      }
      // Fresh mapping. Dashboard export columns are known, so we hardcode the
      // phone / date / bucket columns rather than relying on autoDetectA pattern matching.
      // The bucket is always '_bucket' (synthetic, added during fetch from
      // computeBucket()). This lets the dashboard's bucket pills work without
      // needing user mapping — every dashboard row has a populated bucket.
      const extras: ExtraMapping[] = [];
      for (const [label, patterns] of Object.entries(EXTRA_PRESET_PATTERNS_A)) {
        const found = findColumn(dashboardData.columns, patterns);
        if (found) extras.push({ label, column: found });
      }
      return {
        phone: 'mobile_number',
        date: 'final_lead_status_date',
        bucket: '_bucket',
        extras,
      };
    });
  }, [dashboardData]);

  // Uploads A mapping — sync parallel array length. New uploads get auto-detected
  // mappings via autoDetectA; existing slots are preserved across re-renders.
  useEffect(() => {
    setMappingsUploadsA(prev => {
      // Trim if uploads shrank
      if (prev.length > uploadsA.length) return prev.slice(0, uploadsA.length);
      // Extend with fresh mappings for newly added uploads
      const additions: ColumnMappingA[] = [];
      for (let i = prev.length; i < uploadsA.length; i++) {
        additions.push(autoDetectA(uploadsA[i].columns));
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, [uploadsA]);

  // Uploads B mapping — same pattern. Each B file detects amount / paid /
  // product / source independently against its own column list.
  useEffect(() => {
    setMappingsB(prev => {
      if (prev.length > uploadsB.length) return prev.slice(0, uploadsB.length);
      const additions: ColumnMappingB[] = [];
      for (let i = prev.length; i < uploadsB.length; i++) {
        const cols = uploadsB[i].columns;
        const autoAmount = findColumn(cols, [...OPTIONAL_B_PATTERNS.amount]);
        const autoPaid   = findColumn(cols, [...OPTIONAL_B_PATTERNS.amountPaid]);
        const extras: ExtraMapping[] = [];
        for (const [label, patterns] of Object.entries(EXTRA_PRESET_PATTERNS)) {
          const found = findColumn(cols, patterns);
          if (found) extras.push({ label, column: found });
        }
        const detect = autoDetectB(cols);
        additions.push({
          phone: detect.phone,
          date: detect.date,
          amount: autoAmount,
          amountPaid: autoPaid,
          extras,
        });
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, [uploadsB]);

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
      const url = api.exportCallsUrl(filters, {});
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const parsed = parseCSV(text);
      if (parsed.columns.length === 0 || parsed.rows.length === 0) {
        throw new Error('Dashboard returned no leads for this filter combination.');
      }
      // Client-side agent filter (if user picked specific agents). We match
      // against the `agent` column the export writes — resolve names from the
      // loaded agent list since the column stores names, not ids.
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
      // Enrich every row with a computed bucket — present in dashboard rows
      // only. Uploaded files won't have _bucket; merging is fine since the
      // bucket detection uses the column existence check.
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
      setDashboardData(data);
      // Bucket selection defaults to the actionable three on initial fetch.
      // Skip if user already has a selection (re-fetching after a range change
      // should preserve their bucket toggles).
      if (bucketSelA.size === 0) {
        const uniqueBuckets = uniqueValues(enrichedRows, '_bucket');
        setBucketSelA(defaultBucketSelection(uniqueBuckets));
      }
    } catch (e: any) {
      setParseError(`Dashboard fetch failed: ${e?.message || 'unknown error'}`);
      setDashboardData(null);
    } finally {
      setLoadingDashboard(false);
    }
  // bucketSelA intentionally NOT in deps — we read it for the initial-fetch
  // guard but don't want to re-fire fetchDashboardLeads on every bucket toggle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorIds, campaignIds, agentIds, agentsQ.data]);

  // ---- File handlers — append-mode for both A and B ----
  // Uploaded files are appended to the source array, not replacing prior data.
  // For File A, an upload can coexist with a dashboard fetch (the merged
  // dataset is recomputed via useMemo). For File B, multiple uploads simply
  // concatenate. Each source has its own × button to remove individually.
  const handleFileLoad = useCallback(
    async (which: 'A' | 'B', file: File) => {
      setParseError(null);
      setLoadingFile(which);
      try {
        const parsed = await parseFile(file);
        if (parsed.columns.length === 0) {
          setParseError(`${file.name}: no columns detected. Is the file empty?`);
          return;
        }
        const data: CSVData = {
          filename: file.name,
          columns: parsed.columns,
          rows: parsed.rows,
        };
        if (which === 'A') {
          setUploadsA(prev => [...prev, data]);
        } else {
          setUploadsB(prev => [...prev, data]);
        }
        setResults(null);
      } catch (e: any) {
        setParseError(`${file.name}: ${e?.message || 'failed to read'}`);
      } finally {
        setLoadingFile(null);
      }
    },
    [],
  );

  // Remove one specific source. For File A this is either the dashboard fetch
  // (clears dashboardData) or one indexed upload from uploadsA. For File B,
  // always an indexed upload.
  const removeSourceA = (kind: 'dashboard' | 'upload', index?: number) => {
    if (kind === 'dashboard') {
      setDashboardData(null);
    } else if (typeof index === 'number') {
      setUploadsA(prev => prev.filter((_, i) => i !== index));
    }
    setResults(null);
  };
  const removeSourceB = (index: number) => {
    setUploadsB(prev => prev.filter((_, i) => i !== index));
    setResults(null);
  };

  const resetAll = () => {
    setDashboardData(null);
    setUploadsA([]);
    setUploadsB([]);
    setMappingDashboardA(null);
    setMappingsUploadsA([]);
    setMappingsB([]);
    setBucketSelA(new Set());
    setStatusSelB(new Set());
    setFiltersA([]);
    setFiltersB([]);
    setResults(null);
    setParseError(null);
    setDashboardRange('last_30');
    setVendorIds(new Set());
    setCampaignIds(new Set());
    setAgentIds(new Set());
  };

  // ---- Live row counts after filtering ----
  // Walk per-source. Each source applies its OWN bucket / status column.
  // Sources that haven't mapped a category column pass through the pill
  // filter without category-based exclusion (only custom-filter rules apply).
  const filteredACount = useMemo(() => {
    let n = 0;
    const countSource = (rows: Record<string, string>[], mapping: ColumnMappingA | null) => {
      if (!mapping) return;
      for (const row of rows) {
        if (mapping.bucket && bucketSelA.size > 0) {
          const v = (row[mapping.bucket] ?? '').trim();
          if (v && !bucketSelA.has(v)) continue;
        }
        if (passesAllFilters(row, filtersA)) n++;
      }
    };
    if (dashboardData) countSource(dashboardData.rows, mappingDashboardA);
    uploadsA.forEach((u, i) => countSource(u.rows, mappingsUploadsA[i] ?? null));
    return n;
  }, [dashboardData, mappingDashboardA, uploadsA, mappingsUploadsA, bucketSelA, filtersA]);

  const filteredBCount = useMemo(() => {
    let n = 0;
    uploadsB.forEach((u, i) => {
      const mapping = mappingsB[i];
      if (!mapping) return;
      for (const row of u.rows) {
        if (mapping.status && statusSelB.size > 0) {
          const v = (row[mapping.status] ?? '').trim();
          if (v && !statusSelB.has(v)) continue;
        }
        if (passesAllFilters(row, filtersB)) n++;
      }
    });
    return n;
  }, [uploadsB, mappingsB, statusSelB, filtersB]);

  // Build per-source data for the algorithm. Each entry pairs raw rows with
  // that source's mapping. Dashboard slot first (if present), then uploads in
  // their stored order.
  const sourcesA: SourceWithMappingA[] = useMemo(() => {
    const out: SourceWithMappingA[] = [];
    const hasMultiple = (dashboardData ? 1 : 0) + uploadsA.length > 1;
    if (dashboardData && mappingDashboardA) {
      out.push({
        rows: dashboardData.rows,
        mapping: mappingDashboardA,
        label: hasMultiple ? 'A.1 · Dashboard' : 'Dashboard',
      });
    }
    for (let i = 0; i < uploadsA.length; i++) {
      const m = mappingsUploadsA[i];
      if (!m) continue;
      const idx = dashboardData ? i + 2 : i + 1;
      const label = hasMultiple
        ? `A.${idx} · ${uploadsA[i].filename}`
        : uploadsA[i].filename;
      out.push({ rows: uploadsA[i].rows, mapping: m, label });
    }
    return out;
  }, [dashboardData, mappingDashboardA, uploadsA, mappingsUploadsA]);

  const sourcesB: SourceWithMappingB[] = useMemo(() => {
    const out: SourceWithMappingB[] = [];
    const hasMultiple = uploadsB.length > 1;
    for (let i = 0; i < uploadsB.length; i++) {
      const m = mappingsB[i];
      if (!m) continue;
      const label = hasMultiple
        ? `B.${i + 1} · ${uploadsB[i].filename}`
        : uploadsB[i].filename;
      out.push({ rows: uploadsB[i].rows, mapping: m, label });
    }
    return out;
  }, [uploadsB, mappingsB]);

  // Primary mappings — used by UI surfaces that show a single mapping for
  // legacy reasons (preview table headers, KPI labels). For File A this is
  // the dashboard mapping if present, otherwise the first upload's mapping.
  // For B it's the first upload's mapping. Algorithm itself does NOT use
  // these — it reads source-specific mappings from sourcesA / sourcesB.
  const primaryMappingA: ColumnMappingA = mappingDashboardA ?? mappingsUploadsA[0] ?? { phone: '', date: '', extras: [] };
  const primaryMappingB: ColumnMappingB = mappingsB[0] ?? { phone: '', date: '', extras: [] };

  // Union of every B mapping's extras — drives the preview table's B columns.
  // If File B.1 has Product mapped and File B.2 has Source mapped, both show.
  const allBExtras: ExtraMapping[] = useMemo(() => {
    const seen = new Set<string>();
    const out: ExtraMapping[] = [];
    for (const m of mappingsB) {
      for (const e of m.extras) {
        if (!e.label) continue;
        if (seen.has(e.label)) continue;
        seen.add(e.label);
        out.push(e);
      }
    }
    return out;
  }, [mappingsB]);

  // Same for A — primary's extras are the union across all A sources.
  const allAExtras: ExtraMapping[] = useMemo(() => {
    const seen = new Set<string>();
    const out: ExtraMapping[] = [];
    const all: ColumnMappingA[] = [];
    if (mappingDashboardA) all.push(mappingDashboardA);
    all.push(...mappingsUploadsA);
    for (const m of all) {
      for (const e of m.extras) {
        if (!e.label) continue;
        if (seen.has(e.label)) continue;
        seen.add(e.label);
        out.push(e);
      }
    }
    return out;
  }, [mappingDashboardA, mappingsUploadsA]);

  // Run-readiness: at least one A source with a phone+date mapping, same for B
  const canRun = sourcesA.length > 0 && sourcesB.length > 0
    && sourcesA.every(s => s.mapping.phone && s.mapping.date)
    && sourcesB.every(s => s.mapping.phone && s.mapping.date);

  const handleRun = () => {
    if (!canRun) return;
    setRunning(true);
    setTimeout(() => {
      const r = runAttribution({
        sourcesA, sourcesB,
        filtersA, filtersB,
        bucketSelA, statusSelB,
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

  // Hard scope gate — render nothing until we know the product line
  if (!ready) return null;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1100px] mx-auto">
      <header className="flex items-start gap-3">
        {/* Branded badge — rounded-square chip with a custom funnel-and-arrow
            mark drawn as inline SVG. Matches the chip style of major SaaS
            apps (Anthropic, ChatGPT, Google etc.) and gives the page a
            recognizable visual anchor instead of just a small lucide icon. */}
        <div className="shrink-0 mt-0.5">
          <div className="w-11 h-11 md:w-12 md:h-12 rounded-xl bg-gradient-to-br from-brand-pink to-[#e11d48] shadow-sm flex items-center justify-center ring-1 ring-brand-pink/20">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-6 h-6 md:w-7 md:h-7 text-white"
              aria-hidden="true"
            >
              {/* Two-track flow merging into one outcome — visual metaphor
                  for "leads + payments → attribution match". Top track is
                  the lead source, bottom is the payment source, the right
                  side is the attributed result. */}
              <path d="M3 6h6l4 6 4-6h4" />
              <path d="M3 18h6l4-6" />
              <circle cx="20" cy="12" r="1.5" fill="currentColor" />
            </svg>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl md:text-2xl font-semibold text-brand-navy">
            Lead Attribution
          </h1>
          <p className="text-xs md:text-sm text-surface-500 mt-1">
            Check which leads from this dashboard became paid users in an external file.
            Pull leads directly from the dashboard (default) or upload a custom list, then
            upload your payments / outcomes file. Accepts CSV, XLSX, and XLS. Filters apply
            before matching.
          </p>
        </div>
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
          {/* File A — Dashboard + Upload coexist. Both contribute rows. */}
          <div className="card p-3 space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-surface-500">File A — leads</div>

            {/* Dashboard source — always visible. Either has data or shows
                the pull controls; clears via × on its chip. */}
            <DashboardSourcePanel
              range={dashboardRange}
              setRange={setDashboardRange}
              loading={loadingDashboard}
              dashboardData={dashboardData}
              onLoad={fetchDashboardLeads}
              onClear={() => removeSourceA('dashboard')}
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
              fileARowsTotal={fileA?.rows.length ?? 0}
            />

            {/* Upload source — additive. Each uploaded file gets its own chip
                below; users can drop multiple in a row. */}
            <div className="border-t border-surface-100 pt-3">
              <div className="text-[10px] text-surface-500 mb-1.5">
                {uploadsA.length === 0 ? 'Or upload extra files' : `${uploadsA.length} uploaded file${uploadsA.length === 1 ? '' : 's'}`}
              </div>
              {uploadsA.map((u, i) => (
                <div key={`a-${i}-${u.filename}`} className="mb-1.5">
                  <LoadedFileChip data={u} onClear={() => removeSourceA('upload', i)} />
                </div>
              ))}
              <UploadDropZone
                label={uploadsA.length === 0 ? 'Drop leads file' : 'Drop another file'}
                sublabel={uploadsA.length === 0 ? 'merged into File A on top of dashboard fetch' : 'merged with the files above'}
                onLoad={f => handleFileLoad('A', f)}
                loading={loadingFile === 'A'}
              />
            </div>
          </div>

          {/* File B — upload-only, multi-file. Each upload appends. */}
          <div className="card p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-surface-500">File B — outcomes / payments</div>
              <div className="text-[11px] text-surface-400">
                {uploadsB.length === 0 ? 'Upload one or more files' : `${uploadsB.length} file${uploadsB.length === 1 ? '' : 's'} loaded`}
              </div>
            </div>
            {uploadsB.map((u, i) => (
              <LoadedFileChip key={`b-${i}-${u.filename}`} data={u} onClear={() => removeSourceB(i)} />
            ))}
            <UploadDropZone
              label={uploadsB.length === 0 ? 'Drop payments file' : 'Drop another file'}
              sublabel={uploadsB.length === 0 ? 'CRM transactions, signups, etc.' : 'merged with the files above'}
              onLoad={f => handleFileLoad('B', f)}
              loading={loadingFile === 'B'}
            />
          </div>
        </div>
      </section>

      {/* ---- Step 2: Column mapping ---- */}
      {fileA && fileB && (
        <section>
          <h2 className="text-sm font-medium text-brand-navy mb-2">Step 2 — Map columns</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
            {/* File A column — one card per A source. Dashboard slot first
                if present, then each upload in load order. Each card maps to
                ITS OWN file's columns, so different uploads can use different
                column names for phone/date. */}
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-surface-500 px-1">
                File A {sourcesA.length > 1 && <span className="text-surface-400 normal-case">· {sourcesA.length} sources</span>}
              </div>
              {dashboardData && mappingDashboardA && (
                <SourceMappingCardA
                  sourceLabel={sourcesA.length > 1 ? 'File A.1 · Dashboard' : null}
                  data={dashboardData}
                  mapping={mappingDashboardA}
                  setMapping={(updater) =>
                    setMappingDashboardA(m => (m ? updater(m) : m))
                  }
                  showAutoHint={uploadsA.length === 0}
                  isDashboard
                />
              )}
              {uploadsA.map((file, i) => {
                const m = mappingsUploadsA[i];
                if (!m) return null;
                const label = sourcesA.length > 1
                  ? `File A.${dashboardData ? i + 2 : i + 1} · ${file.filename}`
                  : null;
                return (
                  <SourceMappingCardA
                    key={`a-map-${i}`}
                    sourceLabel={label}
                    data={file}
                    mapping={m}
                    setMapping={(updater) =>
                      setMappingsUploadsA(prev => prev.map((x, idx) => idx === i ? updater(x) : x))
                    }
                  />
                );
              })}
            </div>

            {/* File B column — one card per B upload, same per-source pattern. */}
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-surface-500 px-1">
                File B {sourcesB.length > 1 && <span className="text-surface-400 normal-case">· {sourcesB.length} sources</span>}
              </div>
              {uploadsB.map((file, i) => {
                const m = mappingsB[i];
                if (!m) return null;
                const label = sourcesB.length > 1
                  ? `File B.${i + 1} · ${file.filename}`
                  : null;
                return (
                  <SourceMappingCardB
                    key={`b-map-${i}`}
                    sourceLabel={label}
                    data={file}
                    mapping={m}
                    setMapping={(updater) =>
                      setMappingsB(prev => prev.map((x, idx) => idx === i ? updater(x) : x))
                    }
                  />
                );
              })}
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
            // Pills render when ANY source has a bucket column mapped — the
            // values themselves come from the union across all sources.
            bucketColumn={
              (mappingDashboardA?.bucket) ||
              mappingsUploadsA.find(m => m.bucket)?.bucket ||
              null
            }
            bucketColumnLabel="Bucket"
            bucketValues={bucketValuesA}
            bucketSel={bucketSelA}
            setBucketSel={setBucketSelA}
            customFilters={filtersA}
            setCustomFilters={setFiltersA}
            columns={fileA.columns}
            hideDetectionHint={hasDashboardA}
            hideBucketSection={hasDashboardA}
          />

          <FilterPanel
            label="File B — payments"
            totalRows={fileB.rows.length}
            filteredRows={filteredBCount}
            bucketColumn={mappingsB.find(m => m.status)?.status || null}
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
            mappingA={primaryMappingA}
            mappingB={primaryMappingB}
            hasAmount={mappingsB.some(m => !!m.amount)}
            hasPaid={mappingsB.some(m => !!m.amountPaid)}
            aExtras={allAExtras}
            bExtras={allBExtras}
            aSourceCount={sourcesA.length}
            bSourceCount={sourcesB.length}
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
  range, setRange, loading, dashboardData, onLoad, onClear,
  vendors, campaigns, agents,
  vendorIds, setVendorIds, campaignIds, setCampaignIds, agentIds, setAgentIds,
  bucketValues, bucketSel, setBucketSel,
  filteredCount, fileARowsTotal,
}: {
  range: DashboardRange;
  setRange: (r: DashboardRange) => void;
  loading: boolean;
  dashboardData: CSVData | null;
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
  fileARowsTotal: number;
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
            if (dashboardData) onLoad(v);
          }}
          className="text-xs px-2 py-1 border border-surface-200 rounded bg-white text-brand-navy hover:border-surface-300 focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
        >
          {RANGE_OPTIONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <div className="flex-1" />
        {dashboardData ? (
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
      {dashboardData && bucketValues.length > 0 && (
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

      {dashboardData ? (
        <div className="bg-surface-50 border border-surface-100 rounded px-2 py-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium text-brand-navy flex items-center gap-1.5 truncate">
              <Database size={13} className="text-brand-pink shrink-0" />
              <span className="truncate">{dashboardData.filename}</span>
            </div>
            <div className="text-[10px] text-surface-500 mt-0.5">
              {filteredCount === fileARowsTotal ? (
                <>{fmtInt(dashboardData.rows.length)} unique leads from dashboard · {dashboardData.columns.length} columns</>
              ) : (
                <>
                  <strong className="text-brand-pink">{fmtInt(filteredCount)}</strong>
                  <span> of {fmtInt(fileARowsTotal)} merged leads after bucket filter</span>
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
  label, sublabel, onLoad, loading = false,
}: {
  label: string;
  sublabel: string;
  onLoad: (f: File) => void;
  loading?: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (loading) return;
    const f = e.dataTransfer.files?.[0];
    if (f) onLoad(f);
  };
  return (
    <label
      className={`cursor-pointer border-dashed border-2 rounded-md transition-colors text-center block py-4 px-3 ${
        loading
          ? 'border-surface-200 bg-surface-50 cursor-wait opacity-70'
          : dragOver ? 'border-brand-pink bg-brand-pink/5' : 'border-surface-200 hover:border-surface-300'
      }`}
      onDragOver={e => { e.preventDefault(); if (!loading) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <input
        type="file"
        accept=".csv,.tsv,.xlsx,.xls,.xlsm,.xlsb,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        disabled={loading}
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) onLoad(f);
          // Reset value so re-uploading the same file triggers onChange again
          e.target.value = '';
        }}
      />
      {loading
        ? <Loader2 size={16} className="mx-auto text-surface-400 mb-1 animate-spin" />
        : <Upload size={16} className="mx-auto text-surface-400 mb-1" />}
      <div className="text-xs font-medium text-brand-navy">{loading ? 'Reading file…' : label}</div>
      <div className="text-[10px] text-surface-500 mt-0.5">{sublabel}</div>
      <div className="text-[10px] text-surface-400 mt-1">Drop or click · CSV / XLSX / XLS</div>
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

// Per-source mapping card for File A. One card per A source — dashboard
// gets a card, each upload gets a card. Mapping is local to the card; the
// dropdowns list ONLY that source's own columns.
function SourceMappingCardA({
  sourceLabel, data, mapping, setMapping, showAutoHint = false, isDashboard = false,
}: {
  sourceLabel: string | null;
  data: CSVData;
  mapping: ColumnMappingA;
  setMapping: (updater: (m: ColumnMappingA) => ColumnMappingA) => void;
  showAutoHint?: boolean;
  // Dashboard slot has its bucket column hardcoded ('_bucket'); we hide the
  // Bucket picker for it to avoid exposing the synthetic column name.
  isDashboard?: boolean;
}) {
  // Bucket is required for uploaded sources — pick the column from the CSV
  // that categorizes leads (e.g. 'lead_temperature', 'sales_team', 'category').
  // Column values are auto-added to the bucket pill filter so the upload's
  // categories are included by default — the user can toggle them off via pills.
  const showBucketPicker = !isDashboard;
  const bucketMissing = showBucketPicker && !mapping.bucket;

  return (
    <div className="card p-3 space-y-2">
      {sourceLabel && (
        <div className="flex items-center justify-between border-b border-surface-100 pb-1.5 mb-0.5">
          <div className="text-[11px] font-medium text-brand-pink">
            {sourceLabel}
          </div>
          <div className="text-[10px] text-surface-400">
            {fmtInt(data.rows.length)} rows · {data.columns.length} cols
          </div>
        </div>
      )}
      {showAutoHint && (
        <div className="flex justify-end -mt-0.5 mb-0.5">
          <div className="text-[10px] text-surface-400 italic">auto-mapped</div>
        </div>
      )}
      <ColumnPicker
        label="Phone"
        columns={data.columns}
        value={mapping.phone}
        onChange={v => setMapping(m => ({ ...m, phone: v }))}
      />
      <ColumnPicker
        label="Date"
        columns={data.columns}
        value={mapping.date}
        onChange={v => setMapping(m => ({ ...m, date: v }))}
      />
      {showBucketPicker && (
        <div>
          <ColumnPicker
            label="Bucket *"
            columns={data.columns}
            value={mapping.bucket ?? ''}
            onChange={v => setMapping(m => ({ ...m, bucket: v || undefined }))}
            allowEmpty
            emptyLabel="(no bucket column)"
          />
          {bucketMissing ? (
            <p className="text-[10px] text-amber-700 mt-1 flex items-start gap-1">
              <AlertCircle size={10} className="mt-0.5 shrink-0" />
              <span>
                Pick the column that categorizes leads (e.g. <code className="font-mono">lead_temperature</code>,
                {' '}<code className="font-mono">category</code>, <code className="font-mono">sales_team</code>).
                Unique values from this column will be auto-included in the bucket pill filter.
              </span>
            </p>
          ) : (
            <p className="text-[10px] text-surface-400 mt-1">
              All unique values from this column are auto-added to the bucket filter (pills below). Toggle individual values via the pills.
            </p>
          )}
        </div>
      )}
      {mapping.extras.map((extra, idx) => (
        <ExtraMappingRow
          key={idx}
          extra={extra}
          columns={data.columns}
          onChangeLabel={(label) =>
            setMapping(m => ({ ...m, extras: m.extras.map((e, i) => i === idx ? { ...e, label } : e) }))
          }
          onChangeColumn={(column) =>
            setMapping(m => ({ ...m, extras: m.extras.map((e, i) => i === idx ? { ...e, column } : e) }))
          }
          onRemove={() =>
            setMapping(m => ({ ...m, extras: m.extras.filter((_, i) => i !== idx) }))
          }
        />
      ))}
      <div className="flex flex-wrap gap-1.5 pt-1.5 border-t border-surface-100">
        <span className="text-[10px] text-surface-400 self-center">Add:</span>
        {Object.entries(EXTRA_PRESET_PATTERNS_A).map(([label, patterns]) => {
          if (mapping.extras.some(e => e.label === label)) return null;
          return (
            <button
              key={label}
              type="button"
              onClick={() => {
                const detected = findColumn(data.columns, patterns) ?? data.columns[0] ?? '';
                setMapping(m => ({ ...m, extras: [...m.extras, { label, column: detected }] }));
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
            setMapping(m => ({ ...m, extras: [...m.extras, { label: '', column: data.columns[0] ?? '' }] }));
          }}
          className="text-[10px] px-2 py-0.5 rounded border border-dashed border-brand-pink/40 text-brand-pink hover:bg-brand-pink/5 inline-flex items-center gap-1"
        >
          <Plus size={10} /> Custom
        </button>
      </div>
    </div>
  );
}

// Per-source mapping card for File B. Same shape as A's, plus Amount / Paid /
// Product / Source presets and the named optional mappings.
function SourceMappingCardB({
  sourceLabel, data, mapping, setMapping,
}: {
  sourceLabel: string | null;
  data: CSVData;
  mapping: ColumnMappingB;
  setMapping: (updater: (m: ColumnMappingB) => ColumnMappingB) => void;
}) {
  // Status is OPTIONAL. If your B file only contains valid (success/paid)
  // rows, leave this empty and every row will count toward attribution. If
  // your file mixes failed/pending/etc., map the column to enable filtering
  // via the status pills. Column values are auto-added to the pill selection
  // when first seen, so newly-uploaded statuses are included by default.
  return (
    <div className="card p-3 space-y-2">
      {sourceLabel && (
        <div className="flex items-center justify-between border-b border-surface-100 pb-1.5 mb-0.5">
          <div className="text-[11px] font-medium text-brand-pink truncate" title={sourceLabel}>
            {sourceLabel}
          </div>
          <div className="text-[10px] text-surface-400 shrink-0 ml-2">
            {fmtInt(data.rows.length)} rows · {data.columns.length} cols
          </div>
        </div>
      )}
      <ColumnPicker
        label="Phone"
        columns={data.columns}
        value={mapping.phone}
        onChange={v => setMapping(m => ({ ...m, phone: v }))}
      />
      <ColumnPicker
        label="Date"
        columns={data.columns}
        value={mapping.date}
        onChange={v => setMapping(m => ({ ...m, date: v }))}
      />
      <div>
        <ColumnPicker
          label="Status (optional)"
          columns={data.columns}
          value={mapping.status ?? ''}
          onChange={v => setMapping(m => ({ ...m, status: v || undefined }))}
          allowEmpty
          emptyLabel="(no status — all rows counted)"
        />
        <p className="text-[10px] text-surface-400 mt-1">
          {mapping.status
            ? 'Column values are auto-added to the status filter (pills below). Use this when your file has mixed payment outcomes.'
            : 'Skip if all rows in this file are valid payments. Map a status column (e.g. payment_status) only if your file mixes success / failed / pending.'}
        </p>
      </div>
      {(['amount', 'amountPaid'] as OptionalMappingB[]).map(key => {
        if (mapping[key] === undefined) return null;
        return (
          <ColumnPicker
            key={key}
            label={OPTIONAL_B_LABELS[key]}
            columns={data.columns}
            value={mapping[key] ?? ''}
            onChange={v => setMapping(m => ({ ...m, [key]: v || undefined }))}
            onRemove={() => setMapping(m => ({ ...m, [key]: undefined }))}
          />
        );
      })}
      {mapping.extras.map((extra, idx) => (
        <ExtraMappingRow
          key={idx}
          extra={extra}
          columns={data.columns}
          onChangeLabel={(label) =>
            setMapping(m => ({ ...m, extras: m.extras.map((e, i) => i === idx ? { ...e, label } : e) }))
          }
          onChangeColumn={(column) =>
            setMapping(m => ({ ...m, extras: m.extras.map((e, i) => i === idx ? { ...e, column } : e) }))
          }
          onRemove={() =>
            setMapping(m => ({ ...m, extras: m.extras.filter((_, i) => i !== idx) }))
          }
        />
      ))}
      <div className="flex flex-wrap gap-1.5 pt-1.5 border-t border-surface-100">
        <span className="text-[10px] text-surface-400 self-center">Add:</span>
        {(['amount', 'amountPaid'] as OptionalMappingB[]).map(key => {
          if (mapping[key] !== undefined) return null;
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                const detected = findColumn(data.columns, [...OPTIONAL_B_PATTERNS[key]]);
                setMapping(m => ({ ...m, [key]: detected ?? data.columns[0] ?? '' }));
              }}
              className="text-[10px] px-2 py-0.5 rounded border border-dashed border-surface-300 text-surface-500 hover:border-brand-pink hover:text-brand-pink inline-flex items-center gap-1"
            >
              <Plus size={10} /> {OPTIONAL_B_LABELS[key]}
            </button>
          );
        })}
        {Object.entries(EXTRA_PRESET_PATTERNS).map(([label, patterns]) => {
          if (mapping.extras.some(e => e.label === label)) return null;
          return (
            <button
              key={label}
              type="button"
              onClick={() => {
                const detected = findColumn(data.columns, patterns) ?? data.columns[0] ?? '';
                setMapping(m => ({ ...m, extras: [...m.extras, { label, column: detected }] }));
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
            setMapping(m => ({ ...m, extras: [...m.extras, { label: '', column: data.columns[0] ?? '' }] }));
          }}
          className="text-[10px] px-2 py-0.5 rounded border border-dashed border-brand-pink/40 text-brand-pink hover:bg-brand-pink/5 inline-flex items-center gap-1"
        >
          <Plus size={10} /> Custom
        </button>
      </div>
    </div>
  );
}

function ColumnPicker({
  label, columns, value, onChange, optional = false, disabled = false, onRemove,
  allowEmpty = false, emptyLabel = '(none)',
}: {
  label: string;
  columns: string[];
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  disabled?: boolean;
  onRemove?: () => void;
  // allowEmpty is functionally identical to `optional` but with a custom empty
  // label — used for the Bucket / Status pickers which need clearer prompts
  // than just "(none)". When set, the picker also visually emphasises the
  // empty state since it represents an intentional "this file has no buckets"
  // choice rather than an unused optional mapping.
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  const showEmptyOption = optional || allowEmpty;
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
        {showEmptyOption && <option value="">{emptyLabel}</option>}
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
  results, mappingA, mappingB, hasAmount, hasPaid, aExtras, bExtras, aSourceCount, bSourceCount,
}: {
  results: Results;
  mappingA: ColumnMappingA;
  mappingB: ColumnMappingB;
  hasAmount: boolean;
  hasPaid: boolean;
  aExtras: ExtraMapping[];
  bExtras: ExtraMapping[];
  aSourceCount: number;
  bSourceCount: number;
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

      {/* Product pivot — only renders when any B source has Product mapped.
          Aggregates attributed matches by product name (read from each pair's
          own bMapping, so different B files can use different product column
          names). Sortable by clicking any column header. */}
      <ProductPivot pairs={results.attributedPairs} bExtras={bExtras} />

      {/* Source pivot — only renders when 2+ sources exist on either side.
          Shows which A file converted what and which B file accounted for
          what revenue. Useful for multi-file workflows. */}
      <SourcePivot
        pairs={results.attributedPairs}
        aSourceCount={aSourceCount}
        bSourceCount={bSourceCount}
        aSourceTotals={results.aSourceTotals}
        bSourceTotals={results.bSourceTotals}
      />

      {/* Duplicate phones — warn the user if their A sources share leads.
          The algorithm uses the first occurrence by phone, so duplicates are
          silently dropped from the match. This card surfaces them. */}
      <DuplicatesCard
        pairs={[...results.attributedPairs, ...results.preExistingPairs]}
        unmatchedSources={results.unmatchedSources}
      />

      {/* Visualizations — moved to the bottom of the results so the tables /
          preview / download buttons stay above the fold. Each card is default-
          closed so it doesn't displace the rest of the page until requested.
          Source share has Leads/Customers/Revenue donuts; Product share has
          Customers/Revenue; Trend has a daily line chart for all three. */}
      <Visualizations
        results={results}
        aSourceTotals={results.aSourceTotals}
        bExtras={bExtras}
      />

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
        aExtras={aExtras}
        bExtras={bExtras}
      />
      <ResultDetailSection
        title="Pre-existing"
        count={results.preExistingPairs.length}
        chip="amber"
        matchedPairs={results.preExistingPairs}
        mappingA={mappingA}
        mappingB={mappingB}
        aExtras={aExtras}
        bExtras={bExtras}
      />
      <ResultDetailSection
        title="Unmatched"
        count={results.unmatchedRows.length}
        chip="gray"
        unmatchedRows={results.unmatchedRows}
        mappingA={mappingA}
        mappingB={mappingB}
        aExtras={aExtras}
        bExtras={bExtras}
      />

      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          onClick={() => downloadCSV(`attributed_leads_${Date.now()}.csv`, flattenPairs(results.attributedPairs))}
          disabled={results.attributedPairs.length === 0}
          className="text-xs px-3 py-1.5 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 font-medium hover:bg-emerald-100 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download size={12} /> Attributed ({fmtInt(results.attributedPairs.length)})
        </button>
        <button
          type="button"
          onClick={() => downloadCSV(`preexisting_leads_${Date.now()}.csv`, flattenPairs(results.preExistingPairs))}
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

// Product pivot — aggregates attributed matches by product, showing leads,
// revenue total/paid, and avg amount per product. Sortable. Self-suppressing
// when no B source has Product mapped or when the resulting table is empty.
// Reads product per match via each pair's own bMapping so multi-source B
// with different product column names works correctly.
type ProductPivotSort = 'leads' | 'revenue' | 'paid' | 'avg' | 'product';
function ProductPivot({
  pairs, bExtras,
}: {
  pairs: MatchedPair[];
  bExtras: ExtraMapping[];
}) {
  const hasProductMapping = bExtras.some(e => e.label === 'Product');
  const [sortBy, setSortBy] = useState<ProductPivotSort>('leads');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expanded, setExpanded] = useState(true);

  // Aggregate pairs into per-product rows. Empty product values get grouped
  // under "(no product)" so the user sees how many attributed matches lacked
  // a product tag — useful for spotting CRM data quality issues.
  type PivotRow = {
    product: string;
    leads: number;
    revenue: number;
    paid: number;
  };
  const rows: PivotRow[] = useMemo(() => {
    if (!hasProductMapping) return [];
    const acc = new Map<string, PivotRow>();
    for (const p of pairs) {
      const productCol = p.bMapping.extras.find(e => e.label === 'Product')?.column;
      if (!productCol) continue; // This pair's B source has no Product mapped
      const product = (p.b[productCol] ?? '').trim() || '(no product)';
      const amountCol = p.bMapping.amount;
      const paidCol   = p.bMapping.amountPaid;
      const amount = amountCol ? (parseFloat(p.b[amountCol]) || 0) : 0;
      const paid   = paidCol   ? (parseFloat(p.b[paidCol])   || 0) : 0;
      const existing = acc.get(product);
      if (existing) {
        existing.leads   += 1;
        existing.revenue += amount;
        existing.paid    += paid;
      } else {
        acc.set(product, { product, leads: 1, revenue: amount, paid });
      }
    }
    return Array.from(acc.values());
  }, [pairs, hasProductMapping]);

  const sortedRows = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      let cmp = 0;
      if      (sortBy === 'product') cmp = a.product.localeCompare(b.product);
      else if (sortBy === 'leads')   cmp = a.leads - b.leads;
      else if (sortBy === 'revenue') cmp = a.revenue - b.revenue;
      else if (sortBy === 'paid')    cmp = a.paid - b.paid;
      else if (sortBy === 'avg')     cmp = (a.leads ? a.revenue / a.leads : 0) - (b.leads ? b.revenue / b.leads : 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [rows, sortBy, sortDir]);

  // Totals row at the bottom — sums across products. Useful for spot-check
  // that the pivot adds up to the headline revenue numbers from KPI strip.
  const totals = useMemo(() => {
    return rows.reduce((acc, r) => ({
      leads: acc.leads + r.leads,
      revenue: acc.revenue + r.revenue,
      paid: acc.paid + r.paid,
    }), { leads: 0, revenue: 0, paid: 0 });
  }, [rows]);

  if (!hasProductMapping) return null;
  if (rows.length === 0) return null;

  // Detect whether ANY product has non-zero amounts. If revenue is all-zeros
  // we hide those columns to keep the table tight (e.g. B file has Product
  // mapped but no Amount).
  const anyRevenue = rows.some(r => r.revenue > 0);
  const anyPaid    = rows.some(r => r.paid > 0);

  const flip = (col: ProductPivotSort) => {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      // Sensible defaults — product sorts asc by name, numeric sorts desc
      setSortDir(col === 'product' ? 'asc' : 'desc');
    }
  };
  const SortHead = ({ label, col, align = 'left' }: { label: string; col: ProductPivotSort; align?: 'left' | 'right' }) => (
    <th
      onClick={() => flip(col)}
      className={`py-2 px-3 whitespace-nowrap cursor-pointer hover:text-brand-pink select-none ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      {label}
      {sortBy === col && <span className="ml-1 text-brand-pink">{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  );

  return (
    <div className="card mt-3 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-surface-50"
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-surface-500">Product pivot</span>
          <span className="text-[11px] bg-brand-pink/10 text-brand-pink px-1.5 py-0.5 rounded font-medium">
            {fmtInt(rows.length)} {rows.length === 1 ? 'product' : 'products'}
          </span>
        </div>
        <span className="text-surface-400 text-xs">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="border-t border-surface-100 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-surface-50 text-[10px] uppercase tracking-wider text-surface-500">
              <tr>
                <SortHead label="Product" col="product" />
                <SortHead label="Leads" col="leads" align="right" />
                {anyRevenue && <SortHead label="Revenue total" col="revenue" align="right" />}
                {anyPaid    && <SortHead label="Revenue paid"  col="paid"    align="right" />}
                {anyRevenue && <SortHead label="Avg / lead"    col="avg"     align="right" />}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r, i) => (
                <tr key={i} className="border-b border-surface-100 last:border-b-0 hover:bg-surface-50/50">
                  <td className="py-2 px-3 text-surface-700 max-w-[260px] truncate" title={r.product}>
                    {r.product === '(no product)'
                      ? <span className="text-surface-400 italic">{r.product}</span>
                      : r.product}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-surface-700 whitespace-nowrap">
                    {fmtInt(r.leads)}
                  </td>
                  {anyRevenue && (
                    <td className="py-2 px-3 text-right tabular-nums text-surface-700 whitespace-nowrap">
                      {r.revenue > 0 ? fmtINR(r.revenue) : <span className="text-surface-300">—</span>}
                    </td>
                  )}
                  {anyPaid && (
                    <td className="py-2 px-3 text-right tabular-nums text-surface-700 whitespace-nowrap">
                      {r.paid > 0 ? fmtINR(r.paid) : <span className="text-surface-300">—</span>}
                    </td>
                  )}
                  {anyRevenue && (
                    <td className="py-2 px-3 text-right tabular-nums text-surface-500 whitespace-nowrap">
                      {r.leads > 0 && r.revenue > 0
                        ? fmtINR(Math.round(r.revenue / r.leads))
                        : <span className="text-surface-300">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-surface-50 text-[11px] font-medium text-brand-navy">
              <tr className="border-t border-surface-200">
                <td className="py-2 px-3">All products</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtInt(totals.leads)}</td>
                {anyRevenue && <td className="py-2 px-3 text-right tabular-nums">{fmtINR(totals.revenue)}</td>}
                {anyPaid    && <td className="py-2 px-3 text-right tabular-nums">{fmtINR(totals.paid)}</td>}
                {anyRevenue && (
                  <td className="py-2 px-3 text-right tabular-nums text-surface-500">
                    {totals.leads > 0 && totals.revenue > 0
                      ? fmtINR(Math.round(totals.revenue / totals.leads))
                      : '—'}
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
          <div className="px-3 py-2 text-[10px] text-surface-400 border-t border-surface-100 bg-surface-50/50">
            Click any column header to sort. Aggregates only ATTRIBUTED matches (B-after-A).
            Pre-existing customers and unmatched leads aren't counted here.
          </div>
        </div>
      )}
    </div>
  );
}


// Pivot by source file. Two stacked tables: one grouped by File A source
// (which lead list produced what), one grouped by File B source (which
// payment file accounted for what revenue). Renders only when 2+ sources
// exist on either side — single-source runs hide the pivot since there's
// nothing to compare.
function SourcePivot({ pairs, aSourceCount, bSourceCount, aSourceTotals, bSourceTotals }: {
  pairs: MatchedPair[];
  aSourceCount: number;
  bSourceCount: number;
  // Source label → count of filtered rows BEFORE attribution matching.
  // Used as the denominator for CVR ("how many of the leads we considered
  // ended up paying"). For A-side, this is "leads we tried to attribute".
  // For B-side, it's "transactions we tried to attribute back to a lead".
  aSourceTotals: Record<string, number>;
  bSourceTotals: Record<string, number>;
}) {
  type Row = { label: string; total: number; leads: number; revenue: number; paid: number };

  const byA: Row[] = useMemo(() => {
    if (aSourceCount < 2) return [];
    const agg = new Map<string, Row>();
    for (const p of pairs) {
      const cur = agg.get(p.aSourceLabel) ?? {
        label: p.aSourceLabel,
        total: aSourceTotals[p.aSourceLabel] ?? 0,
        leads: 0, revenue: 0, paid: 0,
      };
      cur.leads += 1;
      cur.revenue += p.bMapping.amount ? (parseFloat(p.b[p.bMapping.amount]) || 0) : 0;
      cur.paid += p.bMapping.amountPaid ? (parseFloat(p.b[p.bMapping.amountPaid]) || 0) : 0;
      agg.set(p.aSourceLabel, cur);
    }
    // Also include sources that had leads but zero conversions — without
    // this they'd be invisible despite contributing to total leads. CVR for
    // these rows will read 0%, which is the correct answer.
    for (const [label, total] of Object.entries(aSourceTotals)) {
      if (!agg.has(label)) {
        agg.set(label, { label, total, leads: 0, revenue: 0, paid: 0 });
      }
    }
    return Array.from(agg.values()).sort((x, y) => y.leads - x.leads);
  }, [pairs, aSourceCount, aSourceTotals]);

  const byB: Row[] = useMemo(() => {
    if (bSourceCount < 2) return [];
    const agg = new Map<string, Row>();
    for (const p of pairs) {
      const cur = agg.get(p.bSourceLabel) ?? {
        label: p.bSourceLabel,
        total: bSourceTotals[p.bSourceLabel] ?? 0,
        leads: 0, revenue: 0, paid: 0,
      };
      cur.leads += 1;
      cur.revenue += p.bMapping.amount ? (parseFloat(p.b[p.bMapping.amount]) || 0) : 0;
      cur.paid += p.bMapping.amountPaid ? (parseFloat(p.b[p.bMapping.amountPaid]) || 0) : 0;
      agg.set(p.bSourceLabel, cur);
    }
    return Array.from(agg.values()).sort((x, y) => y.leads - x.leads);
  }, [pairs, bSourceCount, bSourceTotals]);

  if (byA.length === 0 && byB.length === 0) return null;

  const totals = (rows: Row[]) => ({
    total: rows.reduce((s, r) => s + r.total, 0),
    leads: rows.reduce((s, r) => s + r.leads, 0),
    revenue: rows.reduce((s, r) => s + r.revenue, 0),
    paid: rows.reduce((s, r) => s + r.paid, 0),
  });

  const SourceTable = ({ title, rows, kind }: { title: string; rows: Row[]; kind: 'A' | 'B' }) => {
    const t = totals(rows);
    const hasRevenue = rows.some(r => r.revenue > 0);
    const hasPaid = rows.some(r => r.paid > 0);
    // For A: "Leads" = total leads in that A source (filtered);
    //         "Customers" = leads matched to a payment (CVR numerator).
    // For B: "Txns" = total transactions in that B source (filtered);
    //         "Attributed" = txns matched to an A lead (rate numerator).
    // Conversion column shows numerator/denominator as a percentage; if the
    // denominator is 0 we render "—" to avoid 0/0 confusion.
    const headerLeads = kind === 'A' ? 'Leads' : 'Txns';
    const headerCustomers = kind === 'A' ? 'Customers' : 'Attributed';
    const headerRate = kind === 'A' ? 'CVR' : 'Rate';
    const tooltipLeads = kind === 'A'
      ? 'Total leads from this source that passed bucket/filter rules.'
      : 'Total transactions from this source that passed status/filter rules.';
    const tooltipCustomers = kind === 'A'
      ? 'Leads from this source attributed to a payment (B-after-A).'
      : 'Transactions attributed back to an upstream lead.';
    const tooltipRate = kind === 'A'
      ? 'Customers ÷ Leads. The conversion rate for this lead source.'
      : 'Attributed ÷ Txns. The fraction of this payment file we could trace back.';

    return (
      <div className="card overflow-hidden">
        <div className="px-3 py-2 border-b border-surface-100 flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-surface-500">{title}</div>
          <div className="text-[10px] text-surface-400">{rows.length} source{rows.length === 1 ? '' : 's'}</div>
        </div>
        {/* No overflow-x-auto — we size columns to fit. The Source column gets
            flexible space (text-truncate to whatever the parent allows); all
            numeric columns get fixed-ish widths via tabular-nums. */}
        <table className="w-full text-xs table-fixed">
          <colgroup>
            <col />{/* Source — flexible */}
            <col className="w-[14%]" />{/* Leads/Txns */}
            <col className="w-[14%]" />{/* Customers/Attributed */}
            <col className="w-[10%]" />{/* CVR/Rate */}
            {hasRevenue && <col className="w-[14%]" />}{/* Revenue */}
            {hasPaid && <col className="w-[14%]" />}{/* Paid */}
            <col className="w-[10%]" />{/* Share */}
          </colgroup>
          <thead className="bg-surface-50 text-[10px] uppercase tracking-wider text-surface-500">
            <tr>
              <th className="text-left py-2 px-2.5">Source</th>
              <th className="text-right py-2 px-2" title={tooltipLeads}>{headerLeads}</th>
              <th className="text-right py-2 px-2" title={tooltipCustomers}>{headerCustomers}</th>
              <th className="text-right py-2 px-2" title={tooltipRate}>{headerRate}</th>
              {hasRevenue && <th className="text-right py-2 px-2">Revenue</th>}
              {hasPaid && <th className="text-right py-2 px-2">Paid</th>}
              <th className="text-right py-2 px-2.5">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label} className="border-b border-surface-100 last:border-b-0 hover:bg-surface-50/50">
                <td className="py-2 px-2.5 text-surface-700 truncate" title={r.label}>{r.label}</td>
                <td className="py-2 px-2 text-right tabular-nums text-surface-700">{fmtInt(r.total)}</td>
                <td className="py-2 px-2 text-right tabular-nums text-surface-700">{fmtInt(r.leads)}</td>
                <td className="py-2 px-2 text-right tabular-nums text-surface-700">
                  {r.total > 0 ? `${((r.leads / r.total) * 100).toFixed(1)}%` : <span className="text-surface-300">—</span>}
                </td>
                {hasRevenue && <td className="py-2 px-2 text-right tabular-nums text-surface-700">{fmtINR(r.revenue)}</td>}
                {hasPaid && <td className="py-2 px-2 text-right tabular-nums text-surface-700">{fmtINR(r.paid)}</td>}
                <td className="py-2 px-2.5 text-right tabular-nums text-surface-500">{fmtPct(r.leads, t.leads)}</td>
              </tr>
            ))}
            <tr className="bg-surface-50 font-medium">
              <td className="py-2 px-2.5 text-surface-700">Total</td>
              <td className="py-2 px-2 text-right tabular-nums text-surface-700">{fmtInt(t.total)}</td>
              <td className="py-2 px-2 text-right tabular-nums text-surface-700">{fmtInt(t.leads)}</td>
              <td className="py-2 px-2 text-right tabular-nums text-surface-700">
                {t.total > 0 ? `${((t.leads / t.total) * 100).toFixed(1)}%` : <span className="text-surface-300">—</span>}
              </td>
              {hasRevenue && <td className="py-2 px-2 text-right tabular-nums text-surface-700">{fmtINR(t.revenue)}</td>}
              {hasPaid && <td className="py-2 px-2 text-right tabular-nums text-surface-700">{fmtINR(t.paid)}</td>}
              <td className="py-2 px-2.5 text-right tabular-nums text-surface-500">100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-3 mt-3">
      {/* Tables stacked vertically — A is 7 columns (after the CVR/Customers
          additions) and needs full width to breathe. B is 5 columns and
          could fit side-by-side, but stacking keeps things consistent and
          gives both tables the same visual prominence. The visual donuts
          chart that used to live here was moved to the bottom of the page
          into the collapsible Visualizations section. */}
      <div className="space-y-3">
        {byA.length > 0 && <SourceTable title="By File A source (where leads came from)" rows={byA} kind="A" />}
        {byB.length > 0 && <SourceTable title="By File B source (where revenue landed)" rows={byB} kind="B" />}
      </div>
    </div>
  );
}


// ============================================================================
// Visualizations — collapsible bottom section with donut + line charts.
// ============================================================================
// Three independently collapsible cards, all default-closed so they don't
// occupy vertical space until the user wants them:
//   1. Source share: donuts for Leads/Customers/Revenue, pivoted by A source
//   2. Product share: donuts for Customers/Revenue, pivoted by product (B-side)
//   3. Trend over time: line chart with Leads/Customers/Revenue per day
//
// Each viz card has metric checkboxes so the user can show only what they care
// about. Source/Product donuts also have a toggleable legend (click a source/
// product to exclude it; percentages recompute on the remaining ones).

const SOURCE_COLORS = [
  '#E8345C', // brand pink — first source, usually dominant
  '#1B1A36', // brand navy
  '#10B981', // green
  '#F59E0B', // amber
  '#3B82F6', // blue
  '#8B5CF6', // purple
  '#06B6D4', // cyan
  '#F472B6', // light pink
  '#84CC16', // lime
  '#EF4444', // red
];

// Per-metric color used in trend line chart + checkbox swatches. These are
// brand-consistent — Pink is the hero metric, Navy is for secondary, Emerald
// for revenue (universally read as $).
const METRIC_COLORS: Record<string, string> = {
  leads: '#E8345C',
  customers: '#1B1A36',
  revenue: '#10B981',
};
const METRIC_LABELS: Record<string, string> = {
  leads: 'Leads',
  customers: 'Customers',
  revenue: 'Revenue',
};

// Generic collapsible card. Default closed so the visualizations section
// doesn't push the rest of the page down until the user opts in.
function CollapsibleCard({
  title, subtitle, defaultOpen = false, children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-surface-50/60 transition-colors text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={14} className="text-surface-500" /> : <ChevronRight size={14} className="text-surface-500" />}
          <div>
            <div className="text-sm font-semibold text-brand-navy">{title}</div>
            {subtitle && <div className="text-[11px] text-surface-500 mt-0.5">{subtitle}</div>}
          </div>
        </div>
        <span className="text-[10px] text-surface-400 uppercase tracking-wider">
          {open ? 'Tap to collapse' : 'Tap to expand'}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-surface-100">
          {children}
        </div>
      )}
    </div>
  );
}

// Row shape for MultiDonutChart. Each row is one slice (one source or one
// product); values is a metric key → number map. The metric key list (passed
// separately) determines which metrics are even POSSIBLE in this chart — not
// every chart shows all 3 metrics (e.g. product view has no Leads).
type DonutRow = { label: string; values: Record<string, number> };
type MetricDef = {
  key: string;                            // 'leads' | 'customers' | 'revenue'
  label: string;                          // 'Leads' | 'Customers' | 'Revenue'
  format: (n: number) => string;          // fmtInt or fmtINR
};

// Multi-metric donut chart with per-source toggleable legend AND per-metric
// checkboxes. Replaces the old SourceShareChart — now generalized so it
// works for both "by source" (3 metrics) and "by product" (2 metrics).
function MultiDonutChart({
  rows, metrics, sourceWord = 'Sources',
}: {
  rows: DonutRow[];
  metrics: MetricDef[];
  sourceWord?: string;  // 'Sources' or 'Products' — used in legend header
}) {
  // Disabled rows (hidden from donuts and percentage computation).
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  // Hovered row, used to dim other slices for visual emphasis.
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);
  // Active metrics — defaults to all enabled. The user toggles checkboxes
  // above the donuts to hide/show metric donuts.
  const [activeMetrics, setActiveMetrics] = useState<Set<string>>(
    () => new Set(metrics.map(m => m.key))
  );

  // Stable color assignment by input index — so toggling rows in/out never
  // reshuffles colors. Same convention as the old chart.
  const colorMap = useMemo(() => {
    const m: Record<string, string> = {};
    rows.forEach((r, i) => { m[r.label] = SOURCE_COLORS[i % SOURCE_COLORS.length]; });
    return m;
  }, [rows]);

  const visibleRows = rows.filter(r => !disabled.has(r.label));
  const visibleMetrics = metrics.filter(m => activeMetrics.has(m.key));

  // Per-metric totals across visible rows — used as the denominator for
  // % share displayed in tooltips and the legend.
  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const m of metrics) t[m.key] = visibleRows.reduce((s, r) => s + (r.values[m.key] ?? 0), 0);
    return t;
  }, [visibleRows, metrics]);

  function toggleRow(label: string) {
    setDisabled(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      // Refuse to disable every row — empty chart is worse than confusing.
      if (next.size === rows.length) return prev;
      return next;
    });
  }
  function toggleMetric(key: string) {
    setActiveMetrics(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      // Refuse to disable every metric.
      if (next.size === 0) return prev;
      return next;
    });
  }

  // Custom tooltip — shows row name, value for that metric, and %-of-visible.
  const makeTooltip = (metric: MetricDef) =>
    ({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number }> }) => {
      if (!active || !payload || payload.length === 0) return null;
      const item = payload[0];
      const total = totals[metric.key] || 0;
      const pct = total > 0 ? (item.value / total) * 100 : 0;
      return (
        <div className="bg-white border border-surface-200 rounded-lg shadow-sm px-3 py-2 text-xs">
          <div className="font-medium text-brand-navy mb-0.5 max-w-[240px] truncate" title={item.name}>
            {item.name}
          </div>
          <div className="text-surface-600">
            {metric.label}: <span className="font-semibold tabular-nums">{metric.format(item.value)}</span>
            <span className="text-surface-400"> · {pct.toFixed(1)}%</span>
          </div>
        </div>
      );
    };

  if (rows.length === 0) {
    return (
      <div className="text-[12px] text-surface-400 py-6 text-center">
        Nothing to show — run attribution first.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Metric checkboxes — control which donuts are visible. */}
      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        <span className="text-surface-500 uppercase tracking-wider">Show:</span>
        {metrics.map(m => {
          const on = activeMetrics.has(m.key);
          const color = METRIC_COLORS[m.key] ?? '#6B7280';
          return (
            <label
              key={m.key}
              className={`inline-flex items-center gap-1.5 cursor-pointer select-none ${on ? '' : 'opacity-50'}`}
            >
              <span
                className="w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors"
                style={{
                  background: on ? color : 'transparent',
                  borderColor: on ? color : '#CBD0D9',
                }}
              >
                {on && <Check size={9} className="text-white" strokeWidth={3} />}
              </span>
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggleMetric(m.key)}
                className="sr-only"
              />
              <span className="text-surface-700">{m.label}</span>
            </label>
          );
        })}
      </div>

      {/* Donut grid — one column per active metric. Auto-balances width. */}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, visibleMetrics.length)}, minmax(0, 1fr))` }}
      >
        {visibleMetrics.map(m => (
          <DonutColumn
            key={m.key}
            data={visibleRows.map(r => ({ name: r.label, value: r.values[m.key] ?? 0 }))}
            colorMap={colorMap}
            hoverLabel={hoverLabel}
            label={m.label}
            total={totals[m.key]}
            formatTotal={m.format}
            tooltip={makeTooltip(m)}
          />
        ))}
      </div>

      {/* Interactive legend — click toggles a row off/on; hover highlights it
          across all donuts. Each legend item also shows its share for every
          active metric, so the legend doubles as a comparison table. */}
      <div className="pt-3 border-t border-surface-100">
        <div className="text-[10px] uppercase tracking-wider text-surface-500 mb-2">
          {sourceWord} — click to toggle, hover to highlight
        </div>
        <div className="space-y-1">
          {rows.map(r => {
            const off = disabled.has(r.label);
            const color = colorMap[r.label];
            return (
              <button
                key={r.label}
                type="button"
                onClick={() => toggleRow(r.label)}
                onMouseEnter={() => setHoverLabel(r.label)}
                onMouseLeave={() => setHoverLabel(null)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded transition-colors text-left ${
                  off ? 'opacity-40 hover:opacity-60' : 'hover:bg-surface-50'
                }`}
              >
                <span
                  className="w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0"
                  style={{
                    background: off ? 'transparent' : color,
                    borderColor: off ? '#CBD0D9' : color,
                  }}
                >
                  {!off && <Check size={9} className="text-white" strokeWidth={3} />}
                </span>
                <span className="flex-1 text-xs text-surface-700 truncate" title={r.label}>
                  {r.label}
                </span>
                {/* Per-metric share inline — shown only for active metrics. */}
                <span className="flex items-center gap-3 text-[11px] tabular-nums">
                  {visibleMetrics.map(m => {
                    const v = r.values[m.key] ?? 0;
                    const total = totals[m.key] || 0;
                    const pct = !off && total > 0 ? (v / total) * 100 : 0;
                    return (
                      <span key={m.key} className="text-surface-500 w-14 text-right" title={`${m.label}: ${m.format(v)}`}>
                        {off ? <span className="text-surface-300">—</span> : `${pct.toFixed(1)}%`}
                      </span>
                    );
                  })}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DonutColumn({
  data, colorMap, hoverLabel, label, total, formatTotal, tooltip,
}: {
  data: Array<{ name: string; value: number }>;
  colorMap: Record<string, string>;
  hoverLabel: string | null;
  label: string;
  total: number;
  // Custom formatter for the center "Total" number — fmtInt for counts,
  // fmtINR for revenue donuts.
  formatTotal: (n: number) => string;
  tooltip: React.ComponentType<{ active?: boolean; payload?: Array<{ name: string; value: number }> }>;
}) {
  return (
    <div className="flex flex-col items-center">
      <div className="text-[10px] uppercase tracking-wider text-surface-500 mb-1">
        {label}
      </div>
      <div className="h-44 w-full relative">
        {data.length === 0 || total === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-surface-400">
            No data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={42}
                outerRadius={72}
                paddingAngle={1}
                stroke="#FFFFFF"
                strokeWidth={2}
              >
                {data.map(d => (
                  <Cell
                    key={d.name}
                    fill={colorMap[d.name] ?? '#CBD0D9'}
                    fillOpacity={hoverLabel == null || hoverLabel === d.name ? 1 : 0.25}
                  />
                ))}
              </Pie>
              <RTooltip content={tooltip as any} />
            </PieChart>
          </ResponsiveContainer>
        )}
        {total > 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className="text-xs text-surface-500">Total</div>
            <div className="text-lg font-semibold text-brand-navy tabular-nums">{formatTotal(total)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// Time-series line chart over the date the A row was created. All three lines
// share an x-axis (date) but revenue has a vastly different scale than counts,
// so we put it on a right-side y-axis. Both axes auto-scale to the visible
// data range, and toggling a metric off resets the axis it owns.
type TrendDailyPoint = { date: string; leads: number; customers: number; revenue: number };
function TrendChart({ data }: { data: TrendDailyPoint[] }) {
  const [activeMetrics, setActiveMetrics] = useState<Set<string>>(
    () => new Set(['leads', 'customers', 'revenue'])
  );

  function toggleMetric(key: string) {
    setActiveMetrics(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (next.size === 0) return prev;
      return next;
    });
  }

  const showLeads = activeMetrics.has('leads');
  const showCustomers = activeMetrics.has('customers');
  const showRevenue = activeMetrics.has('revenue');
  // Use a right-side Y axis for revenue only when revenue is the sole metric
  // OR when revenue is shown alongside counts (so the two scales don't fight).
  const needsRightAxis = showRevenue && (showLeads || showCustomers);

  if (data.length === 0) {
    return (
      <div className="text-[12px] text-surface-400 py-6 text-center">
        Nothing to show — run attribution first.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        <span className="text-surface-500 uppercase tracking-wider">Show:</span>
        {(['leads', 'customers', 'revenue'] as const).map(key => {
          const on = activeMetrics.has(key);
          const color = METRIC_COLORS[key];
          return (
            <label
              key={key}
              className={`inline-flex items-center gap-1.5 cursor-pointer select-none ${on ? '' : 'opacity-50'}`}
            >
              <span
                className="w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors"
                style={{
                  background: on ? color : 'transparent',
                  borderColor: on ? color : '#CBD0D9',
                }}
              >
                {on && <Check size={9} className="text-white" strokeWidth={3} />}
              </span>
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggleMetric(key)}
                className="sr-only"
              />
              <span className="text-surface-700">{METRIC_LABELS[key]}</span>
            </label>
          );
        })}
      </div>

      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: needsRightAxis ? 20 : 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E8EE" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: '#6B7280' }}
              tickFormatter={(d: string) => {
                // ISO date → DD MMM. Compact for axis readability.
                if (!d) return '';
                const dt = new Date(d);
                if (isNaN(dt.getTime())) return d;
                return `${dt.getDate()} ${dt.toLocaleString('en-IN', { month: 'short' })}`;
              }}
            />
            <YAxis
              yAxisId="count"
              tick={{ fontSize: 11, fill: '#6B7280' }}
              allowDecimals={false}
            />
            {needsRightAxis && (
              <YAxis
                yAxisId="revenue"
                orientation="right"
                tick={{ fontSize: 11, fill: '#10B981' }}
                tickFormatter={(v: number) => v >= 100000 ? `₹${(v/100000).toFixed(1)}L` : v >= 1000 ? `₹${(v/1000).toFixed(0)}K` : `₹${v}`}
              />
            )}
            <RTooltip
              contentStyle={{ borderRadius: 8, border: '1px solid #E5E8EE', fontSize: 12 }}
              labelFormatter={(d: string) => {
                if (!d) return '';
                const dt = new Date(d);
                if (isNaN(dt.getTime())) return d;
                return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
              }}
              formatter={(value: number, name: string) => {
                if (name === 'Revenue') return [fmtINR(value), name];
                return [fmtInt(value), name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {showLeads && (
              <Line
                yAxisId="count"
                type="monotone"
                dataKey="leads"
                name="Leads"
                stroke={METRIC_COLORS.leads}
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 5 }}
              />
            )}
            {showCustomers && (
              <Line
                yAxisId="count"
                type="monotone"
                dataKey="customers"
                name="Customers"
                stroke={METRIC_COLORS.customers}
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 5 }}
              />
            )}
            {showRevenue && (
              <Line
                yAxisId={needsRightAxis ? "revenue" : "count"}
                type="monotone"
                dataKey="revenue"
                name="Revenue"
                stroke={METRIC_COLORS.revenue}
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 5 }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[10px] text-surface-400 leading-relaxed">
        Counts on the left axis, revenue on the right (when both are shown).
        Customers and revenue are <em>cohort</em>-attributed — they're plotted on
        the date the lead was created, not the date the payment landed. This
        lets you see "leads created on May 1 produced X customers and ₹Y revenue
        eventually" at a glance.
      </p>
    </div>
  );
}

// Top-level visualizations container — renders after Duplicates / preview as
// an opt-in section. All three cards are default-closed; they share computed
// data (source rows, product rows, daily trend) via memos so toggling one open
// doesn't recompute the others.
function Visualizations({
  results, aSourceTotals, bExtras,
}: {
  results: Results;
  aSourceTotals: Record<string, number>;
  bExtras: ExtraMapping[];
}) {
  // Source-level pivot. Lead count comes from the per-source filtered totals
  // (which include unmatched + pre-existing + attributed); customers/revenue
  // come from attributed pairs only.
  const sourceRows: DonutRow[] = useMemo(() => {
    const agg = new Map<string, { leads: number; customers: number; revenue: number }>();
    for (const [label, total] of Object.entries(aSourceTotals)) {
      agg.set(label, { leads: total, customers: 0, revenue: 0 });
    }
    for (const p of results.attributedPairs) {
      const cur = agg.get(p.aSourceLabel);
      if (!cur) continue;
      cur.customers += 1;
      cur.revenue += p.bMapping.amount ? (parseFloat(p.b[p.bMapping.amount]) || 0) : 0;
    }
    return Array.from(agg.entries())
      .map(([label, v]) => ({
        label,
        values: { leads: v.leads, customers: v.customers, revenue: v.revenue },
      }))
      .sort((a, b) => (b.values.leads ?? 0) - (a.values.leads ?? 0));
  }, [results, aSourceTotals]);

  // Product-level pivot. Customers (= attributed count) and revenue per product
  // name. "Leads per product" is meaningless because raw leads have no product
  // — products only attach to paying customers via the B side.
  const hasProductMapping = bExtras.some(e => e.label === 'Product');
  const productRows: DonutRow[] = useMemo(() => {
    if (!hasProductMapping) return [];
    const agg = new Map<string, { customers: number; revenue: number }>();
    for (const p of results.attributedPairs) {
      const productCol = p.bMapping.extras.find(e => e.label === 'Product')?.column;
      if (!productCol) continue;
      const product = (p.b[productCol] ?? '').trim() || '(no product)';
      const cur = agg.get(product) ?? { customers: 0, revenue: 0 };
      cur.customers += 1;
      cur.revenue += p.bMapping.amount ? (parseFloat(p.b[p.bMapping.amount]) || 0) : 0;
      agg.set(product, cur);
    }
    return Array.from(agg.entries())
      .map(([label, v]) => ({
        label,
        values: { customers: v.customers, revenue: v.revenue },
      }))
      .sort((a, b) => (b.values.revenue ?? 0) - (a.values.revenue ?? 0));
  }, [results, hasProductMapping]);

  // Daily trend — leads from ALL A rows (attributed + preexisting + unmatched)
  // by the A-side date; customers + revenue from attributedPairs by their
  // a date (cohort view). Sources without a usable date column contribute 0.
  const trendData: TrendDailyPoint[] = useMemo(() => {
    const buckets = new Map<string, { leads: number; customers: number; revenue: number }>();
    const ensure = (d: string) => {
      if (!buckets.has(d)) buckets.set(d, { leads: 0, customers: 0, revenue: 0 });
      return buckets.get(d)!;
    };

    const countLead = (row: Record<string, string>, mapping: ColumnMappingA) => {
      const d = parseDate(row[mapping.date] ?? '');
      if (d) ensure(d).leads += 1;
    };
    // All A rows = attributed + preexisting + unmatched. We avoid double-
    // counting because each row appears in exactly one of these buckets.
    for (const p of results.attributedPairs)   countLead(p.a, p.aMapping);
    for (const p of results.preExistingPairs)  countLead(p.a, p.aMapping);
    for (const u of results.unmatchedSources)  countLead(u.row, u.mapping);

    // Customers + revenue from attributed pairs (cohort view via A date).
    for (const p of results.attributedPairs) {
      if (!p.aDateIso) continue;
      const e = ensure(p.aDateIso);
      e.customers += 1;
      e.revenue += p.bMapping.amount ? (parseFloat(p.b[p.bMapping.amount]) || 0) : 0;
    }

    return Array.from(buckets.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [results]);

  const sourceMetrics: MetricDef[] = [
    { key: 'leads',     label: 'Leads',     format: fmtInt },
    { key: 'customers', label: 'Customers', format: fmtInt },
    { key: 'revenue',   label: 'Revenue',   format: fmtINR },
  ];
  const productMetrics: MetricDef[] = [
    { key: 'customers', label: 'Customers', format: fmtInt },
    { key: 'revenue',   label: 'Revenue',   format: fmtINR },
  ];

  return (
    <div className="space-y-3 mt-4">
      <div className="text-[11px] uppercase tracking-wider text-surface-500 px-1">
        Visualizations
      </div>
      <CollapsibleCard
        title="Share by source"
        subtitle="Donuts showing % share of leads, customers, and revenue by File A source. Click any source in the legend to exclude it."
      >
        <MultiDonutChart rows={sourceRows} metrics={sourceMetrics} sourceWord="Sources" />
      </CollapsibleCard>
      <CollapsibleCard
        title="Share by product"
        subtitle={hasProductMapping
          ? 'Customers and revenue split by product (read from each B file\'s Product column).'
          : 'Add a "Product" mapping on any File B card to enable this view.'}
      >
        {hasProductMapping ? (
          <MultiDonutChart rows={productRows} metrics={productMetrics} sourceWord="Products" />
        ) : (
          <div className="text-[12px] text-surface-400 py-6 text-center">
            No product mapping detected on any File B source.
          </div>
        )}
      </CollapsibleCard>
      <CollapsibleCard
        title="Trend over time"
        subtitle="Daily counts of leads created (File A), customers attributed, and revenue — plotted by the lead-creation date (cohort view)."
      >
        <TrendChart data={trendData} />
      </CollapsibleCard>
    </div>
  );
}



function DuplicatesCard({
  pairs,
  unmatchedSources,
}: {
  pairs: MatchedPair[];
  unmatchedSources: Array<{ row: Record<string, string>; mapping: ColumnMappingA; label: string }>;
}) {
  type DupRow = { phone: string; sources: Map<string, number> };

  const dupes: DupRow[] = useMemo(() => {
    const byPhone = new Map<string, Map<string, number>>();
    const accumulate = (phoneRaw: string, source: string) => {
      const ph = normalizePhone(phoneRaw);
      if (!ph) return;
      if (!byPhone.has(ph)) byPhone.set(ph, new Map());
      const m = byPhone.get(ph)!;
      m.set(source, (m.get(source) ?? 0) + 1);
    };
    for (const p of pairs) {
      accumulate(p.a[p.aMapping.phone] ?? '', p.aSourceLabel);
    }
    for (const u of unmatchedSources) {
      accumulate(u.row[u.mapping.phone] ?? '', u.label);
    }
    const dups: DupRow[] = [];
    for (const [phone, sources] of byPhone.entries()) {
      const total = Array.from(sources.values()).reduce((s, n) => s + n, 0);
      if (total > 1) dups.push({ phone, sources });
    }
    dups.sort((a, b) => {
      const ta = Array.from(a.sources.values()).reduce((s, n) => s + n, 0);
      const tb = Array.from(b.sources.values()).reduce((s, n) => s + n, 0);
      return tb - ta;
    });
    return dups;
  }, [pairs, unmatchedSources]);

  const [expanded, setExpanded] = useState(false);
  const [showCount, setShowCount] = useState(25);

  if (dupes.length === 0) return null;

  const totalExtra = dupes.reduce((s, d) => {
    const t = Array.from(d.sources.values()).reduce((x, n) => x + n, 0);
    return s + (t - 1);
  }, 0);

  return (
    <div className="card overflow-hidden mt-3">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full px-3 py-2 flex items-center justify-between hover:bg-surface-50/50"
      >
        <div className="flex items-center gap-2 text-left">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">{fmtInt(dupes.length)}</span>
          <span className="text-sm font-medium text-brand-navy">Duplicate phones in File A</span>
          <span className="text-[11px] text-surface-500">
            {fmtInt(totalExtra)} extra row{totalExtra === 1 ? '' : 's'} ignored — first occurrence wins
          </span>
        </div>
        <span className="text-[11px] text-surface-500">{expanded ? 'Hide' : 'Show'}</span>
      </button>
      {expanded && (
        <div className="border-t border-surface-100 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-surface-50 text-[10px] uppercase tracking-wider text-surface-500">
              <tr>
                <th className="text-left py-2 px-3 whitespace-nowrap">Phone</th>
                <th className="text-right py-2 px-3 whitespace-nowrap">Occurrences</th>
                <th className="text-left py-2 px-3 whitespace-nowrap">Sources</th>
              </tr>
            </thead>
            <tbody>
              {dupes.slice(0, showCount).map(d => {
                const total = Array.from(d.sources.values()).reduce((s, n) => s + n, 0);
                const sourceBreakdown = Array.from(d.sources.entries())
                  .map(([src, n]) => n > 1 ? `${src} (×${n})` : src)
                  .join(', ');
                return (
                  <tr key={d.phone} className="border-b border-surface-100 last:border-b-0 hover:bg-surface-50/50">
                    <td className="py-2 px-3 tabular-nums text-surface-700 whitespace-nowrap">{d.phone}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-surface-700">{fmtInt(total)}</td>
                    <td className="py-2 px-3 text-surface-600 truncate max-w-[420px]" title={sourceBreakdown}>{sourceBreakdown}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {dupes.length > showCount && (
            <div className="px-3 py-2 border-t border-surface-100 bg-surface-50/50 flex items-center justify-between text-[11px]">
              <span className="text-surface-500">Showing {fmtInt(showCount)} of {fmtInt(dupes.length)}</span>
              <button
                type="button"
                onClick={() => setShowCount(c => c + 25)}
                className="text-brand-pink hover:underline"
              >
                Show 25 more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultDetailSection({
  title, count, chip,
  matchedPairs, unmatchedRows,
  mappingA, mappingB,
  aExtras, bExtras,
}: {
  title: string;
  count: number;
  chip: 'green' | 'amber' | 'gray';
  matchedPairs?: MatchedPair[];
  unmatchedRows?: Record<string, string>[];
  mappingA: ColumnMappingA;
  mappingB: ColumnMappingB;
  aExtras: ExtraMapping[];
  bExtras: ExtraMapping[];
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
                {aExtras.map((e, i) => (
                  <th key={`ha-${i}`} className="text-left py-2 px-3 whitespace-nowrap">{e.label || '—'}</th>
                ))}
                <th className="text-right py-2 px-3 whitespace-nowrap">A date</th>
                {!isUnmatched && <th className="text-right py-2 px-3 whitespace-nowrap">B date</th>}
                {!isUnmatched && <th className="text-right py-2 px-3 whitespace-nowrap">Lag</th>}
                {!isUnmatched && mappingB.amount && <th className="text-right py-2 px-3 whitespace-nowrap">Amount</th>}
                {!isUnmatched && mappingB.amountPaid && <th className="text-right py-2 px-3 whitespace-nowrap">Paid</th>}
                {!isUnmatched && bExtras.map((e, i) => (
                  <th key={`hb-${i}`} className="text-left py-2 px-3 whitespace-nowrap">{e.label || '—'}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(isUnmatched
                ? (unmatchedRows ?? []).slice(0, showCount).map(r => ({ a: r, b: {} as Record<string, string>, aDateIso: parseDate(r[mappingA.date] ?? ''), bDateIso: null, lagDays: null, aMapping: mappingA, bMapping: mappingB, aSourceLabel: '', bSourceLabel: '' }))
                : (matchedPairs ?? []).slice(0, showCount)
              ).map((item, i) => {
                const aRow = item.a;
                const bRow = item.b;
                const am = item.aMapping;
                const bm = (item as any).bMapping as ColumnMappingB | undefined;
                const name = aRow.callee_name || aRow.name || '';
                // Read bucket from THIS pair's source mapping. For dashboard
                // pairs that's '_bucket' (synthetic); for uploaded pairs it's
                // whatever column the user mapped on the corresponding
                // SourceMappingCardA. Falls back to legacy `_bucket` for old
                // saved sessions before bucket-per-source existed.
                const bucket = (am?.bucket ? aRow[am.bucket] : aRow._bucket) || '';
                // Read amount / paid using the matched pair's own bMapping —
                // each B source can have different amount/paid column names.
                const amountCol = bm?.amount;
                const paidCol = bm?.amountPaid;
                const amountStr = bRow && amountCol ? (bRow[amountCol] ?? '') : '';
                const amountNum = parseFloat(amountStr);
                const paidStr   = bRow && paidCol ? (bRow[paidCol] ?? '') : '';
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
                        column the user mapped. Cells read directly from aRow,
                        so the column needs to exist in that source's data.
                        Sources without that column show — for that cell. */}
                    {aExtras.map((e, ix) => {
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
                    {/* B display extras — same idea as A's: read from bRow
                        for whatever column maps to this label in this pair's
                        bMapping. Falls back to the union-level extra's column
                        name if this pair's mapping doesn't have a match. */}
                    {!isUnmatched && bExtras.map((e, ix) => {
                      const colInPairMapping = bm?.extras.find(x => x.label === e.label)?.column;
                      const col = colInPairMapping ?? e.column;
                      const val = bRow ? (bRow[col] ?? '') : '';
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
