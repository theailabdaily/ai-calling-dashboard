'use client';
import { useCallback, useMemo, useState } from 'react';
import {
  Upload, X, Plus, Download, Play, ChevronRight,
  RotateCcw, Shuffle, FileSpreadsheet, AlertCircle,
} from 'lucide-react';

// =============================================================================
// Lead Attribution — client-side CSV matching tool
// =============================================================================
// Upload two CSVs:
//   File A = events/leads (e.g. dashboard export from /dod-leads or /calls)
//   File B = outcomes/payments (e.g. CRM transaction export)
// The tool:
//   1. Detects columns + bucket/status presets automatically
//   2. Lets the user filter both files (preset pills + custom column filters)
//   3. Matches by normalized phone, applying a time-based attribution rule
//   4. Reports a funnel: total → key-matched → pre-existing → attributed
//   5. Exports matched / pre-existing / unmatched as separate CSVs
//
// Everything runs in-browser — no upload to server, no API endpoint.
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

type ColumnMappingA = { phone: string; date: string };
type ColumnMappingB = {
  phone: string;
  date: string;
  amount?: string;       // primary amount (typically totalAmount)
  amountPaid?: string;   // secondary (paidAmount) — auto-detected if present
  status?: string;
};

type AttributionRule = 'b_after_a' | 'any_time';

type MatchedPair = {
  a: Record<string, string>;
  b: Record<string, string>;
  bDateIso: string | null;
  aDateIso: string | null;
  lagDays: number | null;
};

type Results = {
  // Counts
  totalA: number;
  keyMatched: number;
  preExisting: number;
  attributed: number;
  attributedSuccess: number;
  unmatched: number;
  // Revenue
  revenueTotal: number;
  revenuePaid: number;
  // Row sets (for CSV download)
  attributedPairs: MatchedPair[];
  preExistingPairs: MatchedPair[];
  unmatchedRows: Record<string, string>[];
  // Echo of inputs (for "filters changed" detection)
  ranAt: number;
};

// ---- Constants -------------------------------------------------------------

// Dashboard-export bucket values. When File A's bucket column matches these
// exactly, we apply the same "actionable three" default selection as the
// Leads page. For arbitrary CSVs we default to all-on.
const DASHBOARD_BUCKETS = ['top_priority', 'interested_only', 'callback_only', 'no_intent', 'unreached'];
const DEFAULT_ON_BUCKETS = ['top_priority', 'interested_only', 'callback_only'];

const BUCKET_LABELS: Record<string, string> = {
  top_priority:    'Top Priority',
  interested_only: 'Interested only',
  callback_only:   'Callback only',
  no_intent:       'No intent',
  unreached:       'Unreached',
};

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals:        'equals',
  not_equals:    'not equals',
  contains:      'contains',
  not_contains:  'does not contain',
  gt:            'greater than',
  lt:            'less than',
  between:       'between',
  empty:         'is empty',
  not_empty:     'is not empty',
};

// ---- CSV parser (state machine, RFC 4180-ish) ------------------------------

function parseCSV(text: string): { columns: string[]; rows: Record<string, string>[] } {
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // Normalize line endings
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
  // Flush last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return { columns: [], rows: [] };

  const columns = rows[0].map(c => c.trim());
  const dataRows: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const raw = rows[r];
    // Skip fully-empty trailing rows
    if (raw.length === 1 && raw[0] === '') continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < columns.length; c++) {
      obj[columns[c]] = (raw[c] ?? '').trim();
    }
    dataRows.push(obj);
  }
  return { columns, rows: dataRows };
}

// ---- Phone normalization (Indian focus) ------------------------------------

function normalizePhone(raw: string): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  // 12 digits starting with 91 → drop country code
  if (digits.length === 12 && digits.startsWith('91')) {
    const tail = digits.slice(2);
    if (/^[6-9]/.test(tail)) return tail;
  }
  // 11 digits starting with 0 → drop leading 0
  if (digits.length === 11 && digits.startsWith('0')) {
    const tail = digits.slice(1);
    if (/^[6-9]/.test(tail)) return tail;
  }
  // Already 10 digits and starts with valid prefix
  if (digits.length === 10 && /^[6-9]/.test(digits)) return digits;
  // Longer than 10 — last 10 if valid prefix
  if (digits.length > 10) {
    const tail = digits.slice(-10);
    if (/^[6-9]/.test(tail)) return tail;
  }
  // Fallback — raw digits (lets non-Indian numbers still match against themselves)
  return digits;
}

// ---- Date parsing ----------------------------------------------------------

// Returns YYYY-MM-DD or null. Handles ISO, DD/MM/YYYY (Indian default),
// MM/DD/YYYY (US), and falls back to Date() parsing for other formats.
function parseDate(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // ISO: YYYY-MM-DD at start (with or without time suffix)
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY (with optional time)
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmy) {
    let [, a, b, y] = dmy;
    if (y.length === 2) y = '20' + y;
    const an = parseInt(a, 10);
    const bn = parseInt(b, 10);
    // Day-month disambiguation. If first part > 12, definitely DD/MM. If
    // second > 12, definitely MM/DD. Otherwise default to DD/MM (Indian
    // convention is what this dashboard expects).
    if (an > 12 && bn <= 12) {
      return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    }
    if (bn > 12 && an <= 12) {
      return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
    }
    return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
  }

  // Last resort
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
  // Exact match first
  for (const p of patterns) {
    const i = lower.indexOf(p);
    if (i >= 0) return columns[i];
  }
  // Substring match
  for (const p of patterns) {
    const i = lower.findIndex(c => c.includes(p));
    if (i >= 0) return columns[i];
  }
  return undefined;
}

function autoDetectA(columns: string[]): ColumnMappingA {
  return {
    phone: findColumn(columns, ['mobile_number', 'phone_number', 'mobile', 'phone', 'contact_number', 'contact']) || columns[0] || '',
    date:  findColumn(columns, ['final_lead_status_date', 'final_date', 'ended_at', 'completed_at', 'started_at', 'created_at', '_date', 'date', 'timestamp']) || columns[0] || '',
  };
}

function autoDetectB(columns: string[]): ColumnMappingB {
  return {
    phone:      findColumn(columns, ['mobile_number', 'phone_number', 'mobile', 'phone', 'user_phone', 'contact']) || columns[0] || '',
    date:       findColumn(columns, ['payment_date', 'paid_at', 'transaction_date', 'order_date', 'purchase_date', 'created_at', '_date', 'date', 'timestamp']) || columns[0] || '',
    amount:     findColumn(columns, ['totalamount', 'total_amount', 'total', 'amount', 'order_value', 'price']),
    amountPaid: findColumn(columns, ['paidamount', 'paid_amount', 'paid', 'amount_paid']),
    status:     findColumn(columns, ['status', 'payment_status', 'order_status', 'state']),
  };
}

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

const BUCKET_COL_PATTERNS  = ['funnel_stage', 'bucket', 'lead_category', 'final_lead_status', 'category', 'tag'];
const STATUS_COL_PATTERNS  = ['status', 'payment_status', 'order_status', 'state'];

function uniqueValues(rows: Record<string, string>[], column: string, limit = 50): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = (r[column] ?? '').trim();
    if (v) set.add(v);
    if (set.size >= limit) break;
  }
  return Array.from(set).sort();
}

function defaultBucketSelection(values: string[]): Set<string> {
  // If all detected values are from the dashboard's known bucket set, default
  // to the "actionable three" — matches the Leads page default state. For any
  // other column shape, default to all-on (user narrows from there).
  const isDashboard = values.every(v => DASHBOARD_BUCKETS.includes(v));
  if (isDashboard) {
    return new Set(values.filter(v => DEFAULT_ON_BUCKETS.includes(v)));
  }
  return new Set(values);
}

// ---- Currency format (Indian) ----------------------------------------------

function fmtINR(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '₹0';
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000)   return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000)     return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-IN');
}

function fmtPct(num: number, denom: number): string {
  if (denom === 0) return '—';
  return `${((num / denom) * 100).toFixed(1)}%`;
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

  // Combine preset filters (bucket / status) with custom filters by mapping
  // preset selection sets into a synthetic filter rule we evaluate inline.
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

  // Index B by normalized phone. Each value is a list of B rows enriched
  // with parsed bDate so we can pick the earliest qualifying one per A row.
  type IndexedB = {
    row: Record<string, string>;
    bDateIso: string | null;
    amount: number;
    amountPaid: number;
    statusIsSuccess: boolean;
  };

  const isSuccess = (statusRaw: string): boolean => {
    const s = statusRaw.toLowerCase();
    return s === 'success' || s === 'successful' || s === 'paid'
      || s === 'completed' || s === 'complete' || s === 'captured';
  };

  const bIndex = new Map<string, IndexedB[]>();
  for (const row of filteredB) {
    const phoneRaw = row[mappingB.phone] ?? '';
    const phone = normalizePhone(phoneRaw);
    if (!phone) continue;
    const entry: IndexedB = {
      row,
      bDateIso: parseDate(row[mappingB.date] ?? ''),
      amount: mappingB.amount ? (parseFloat(row[mappingB.amount]) || 0) : 0,
      amountPaid: mappingB.amountPaid ? (parseFloat(row[mappingB.amountPaid]) || 0) : 0,
      statusIsSuccess: mappingB.status ? isSuccess(row[mappingB.status] ?? '') : true,
    };
    if (!bIndex.has(phone)) bIndex.set(phone, []);
    bIndex.get(phone)!.push(entry);
  }
  // Sort each phone's B rows by date ascending — earliest first.
  bIndex.forEach(list => {
    list.sort((x, y) => (x.bDateIso ?? '\uffff').localeCompare(y.bDateIso ?? '\uffff'));
  });

  // Walk A; classify each row.
  const attributedPairs: MatchedPair[] = [];
  const preExistingPairs: MatchedPair[] = [];
  const unmatchedRows: Record<string, string>[] = [];
  let revenueTotal = 0;
  let revenuePaid = 0;
  let attributedSuccess = 0;

  for (const aRow of filteredA) {
    const aPhone = normalizePhone(aRow[mappingA.phone] ?? '');
    const aDateIso = parseDate(aRow[mappingA.date] ?? '');

    if (!aPhone) { unmatchedRows.push(aRow); continue; }

    const candidates = bIndex.get(aPhone);
    if (!candidates || candidates.length === 0) {
      unmatchedRows.push(aRow);
      continue;
    }

    // Find first B that satisfies the attribution rule.
    let matched: IndexedB | null = null;
    let earliestBefore: IndexedB | null = null;
    for (const b of candidates) {
      if (rule === 'any_time') {
        matched = b; break;
      }
      // rule === 'b_after_a'
      if (!aDateIso || !b.bDateIso) continue;
      if (b.bDateIso > aDateIso) { matched = b; break; }
      if (b.bDateIso === aDateIso && countSameDay) { matched = b; break; }
      // Record the earliest before-A match (for pre-existing classification)
      if (!earliestBefore) earliestBefore = b;
    }

    if (matched) {
      const pair: MatchedPair = {
        a: aRow,
        b: matched.row,
        bDateIso: matched.bDateIso,
        aDateIso,
        lagDays: daysBetween(aDateIso, matched.bDateIso),
      };
      attributedPairs.push(pair);
      revenueTotal += matched.amount;
      revenuePaid  += matched.amountPaid;
      if (matched.statusIsSuccess) attributedSuccess++;
    } else if (earliestBefore || candidates.length > 0) {
      // Phone exists in B but no time-valid match → pre-existing customer
      const b = earliestBefore ?? candidates[0];
      preExistingPairs.push({
        a: aRow,
        b: b.row,
        bDateIso: b.bDateIso,
        aDateIso,
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
    attributedSuccess,
    unmatched: unmatchedRows.length,
    revenueTotal,
    revenuePaid,
    attributedPairs,
    preExistingPairs,
    unmatchedRows,
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
  // Union of keys preserves enrichment columns added at the end
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

// Build the download payload for a matched-pair set — A row + selected B
// columns prefixed with `_match_` so they don't collide with A columns.
function flattenPairs(pairs: MatchedPair[], mappingB: ColumnMappingB): Record<string, unknown>[] {
  return pairs.map(p => {
    const out: Record<string, unknown> = { ...p.a };
    out['_match_b_phone']  = normalizePhone(p.b[mappingB.phone] ?? '');
    out['_match_b_date']   = p.bDateIso ?? '';
    out['_match_lag_days'] = p.lagDays ?? '';
    if (mappingB.amount)     out['_match_amount']      = p.b[mappingB.amount] ?? '';
    if (mappingB.amountPaid) out['_match_amount_paid'] = p.b[mappingB.amountPaid] ?? '';
    if (mappingB.status)     out['_match_status']      = p.b[mappingB.status] ?? '';
    return out;
  });
}

// =============================================================================
// Page component
// =============================================================================

export default function LeadAttributionPage() {
  // Files
  const [fileA, setFileA] = useState<CSVData | null>(null);
  const [fileB, setFileB] = useState<CSVData | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Mappings
  const [mappingA, setMappingA] = useState<ColumnMappingA>({ phone: '', date: '' });
  const [mappingB, setMappingB] = useState<ColumnMappingB>({ phone: '', date: '' });

  // Bucket / status presets — detected from File A / File B
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

  // Live row counts after filtering — shown in each panel header
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

  // ---- File handlers ----
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
          setMappingB(autoDetectB(parsed.columns));
          const col = detectCategoricalColumn(parsed.columns, STATUS_COL_PATTERNS);
          if (col) {
            const vals = uniqueValues(parsed.rows, col);
            // Default to ALL on for status — user narrows from there
            setStatusSelB(new Set(vals));
          } else {
            setStatusSelB(new Set());
          }
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
      setFileA(null); setMappingA({ phone: '', date: '' });
      setBucketSelA(new Set()); setFiltersA([]);
    } else {
      setFileB(null); setMappingB({ phone: '', date: '' });
      setStatusSelB(new Set()); setFiltersB([]);
    }
    setResults(null);
  };

  const resetAll = () => {
    setFileA(null); setFileB(null);
    setMappingA({ phone: '', date: '' });
    setMappingB({ phone: '', date: '' });
    setBucketSelA(new Set()); setStatusSelB(new Set());
    setFiltersA([]); setFiltersB([]);
    setResults(null); setParseError(null);
  };

  // ---- Run ----
  const canRun = fileA && fileB && mappingA.phone && mappingA.date && mappingB.phone && mappingB.date;

  const handleRun = () => {
    if (!canRun || !fileA || !fileB) return;
    setRunning(true);
    // Yield to browser so the "Running…" state actually renders
    setTimeout(() => {
      const r = runAttribution({
        fileA, fileB, mappingA, mappingB,
        filtersA, filtersB,
        bucketColA, bucketSelA, statusColB, statusSelB,
        rule, countSameDay,
      });
      setResults(r);
      setRunning(false);
      // Scroll to results
      setTimeout(() => {
        const el = document.getElementById('attribution-results');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }, 50);
  };

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1100px] mx-auto">
      {/* ---- Header ---- */}
      <header>
        <h1 className="text-xl md:text-2xl font-semibold text-brand-navy flex items-center gap-2">
          <Shuffle size={22} className="text-brand-pink" />
          Lead Attribution
        </h1>
        <p className="text-xs md:text-sm text-surface-500 mt-1">
          Upload two CSVs to check which leads from File&nbsp;A actually converted into paid users in File&nbsp;B.
          Filters apply before matching. Everything runs in your browser — no data leaves this page.
        </p>
      </header>

      {/* ---- Step strip ---- */}
      <StepStrip
        active={
          !fileA || !fileB ? 1
          : !results ? 3
          : 4
        }
      />

      {/* ---- Parse error ---- */}
      {parseError && (
        <div className="card p-3 flex items-start gap-2 border border-red-200 bg-red-50 text-red-700 text-xs">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <div>{parseError}</div>
        </div>
      )}

      {/* ---- Step 1: Files ---- */}
      <section>
        <h2 className="text-sm font-medium text-brand-navy mb-2">Step 1 — Files</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FileDropZone
            label="File A — events / leads"
            sublabel="dashboard export, lead list, calls"
            data={fileA}
            onLoad={(f) => handleFileLoad('A', f)}
            onClear={() => clearFile('A')}
          />
          <FileDropZone
            label="File B — outcomes / payments"
            sublabel="CRM payments, signups, conversions"
            data={fileB}
            onLoad={(f) => handleFileLoad('B', f)}
            onClear={() => clearFile('B')}
          />
        </div>
      </section>

      {/* ---- Step 2: Column mapping ---- */}
      {fileA && fileB && (
        <section>
          <h2 className="text-sm font-medium text-brand-navy mb-2">Step 2 — Map columns</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="card p-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-surface-500">File A</div>
              <ColumnPicker label="Phone" columns={fileA.columns} value={mappingA.phone} onChange={v => setMappingA(m => ({ ...m, phone: v }))} />
              <ColumnPicker label="Date"  columns={fileA.columns} value={mappingA.date}  onChange={v => setMappingA(m => ({ ...m, date: v  }))} />
            </div>
            <div className="card p-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-surface-500">File B</div>
              <ColumnPicker label="Phone"  columns={fileB.columns} value={mappingB.phone} onChange={v => setMappingB(m => ({ ...m, phone: v }))} />
              <ColumnPicker label="Date"   columns={fileB.columns} value={mappingB.date}  onChange={v => setMappingB(m => ({ ...m, date: v  }))} />
              <ColumnPicker label="Amount" columns={fileB.columns} value={mappingB.amount ?? ''}     onChange={v => setMappingB(m => ({ ...m, amount: v || undefined }))}     optional />
              <ColumnPicker label="Paid"   columns={fileB.columns} value={mappingB.amountPaid ?? ''} onChange={v => setMappingB(m => ({ ...m, amountPaid: v || undefined }))} optional />
              <ColumnPicker label="Status" columns={fileB.columns} value={mappingB.status ?? ''}     onChange={v => setMappingB(m => ({ ...m, status: v || undefined }))}     optional />
            </div>
          </div>
        </section>
      )}

      {/* ---- Step 3: Filters & rule ---- */}
      {fileA && fileB && (
        <section>
          <h2 className="text-sm font-medium text-brand-navy mb-2">Step 3 — Filters &amp; rule</h2>

          {/* Rule strip */}
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

          {/* File A filters */}
          <FilterPanel
            label="File A — leads"
            totalRows={fileA.rows.length}
            filteredRows={filteredACount}
            bucketColumn={bucketColA}
            bucketValues={bucketValuesA}
            bucketSel={bucketSelA}
            setBucketSel={setBucketSelA}
            customFilters={filtersA}
            setCustomFilters={setFiltersA}
            columns={fileA.columns}
          />

          {/* File B filters */}
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
          />

          {/* Run row */}
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
            mappingB={mappingB}
            hasAmount={!!mappingB.amount}
            hasPaid={!!mappingB.amountPaid}
            hasStatus={!!mappingB.status}
          />
        </section>
      )}

      {/* ---- Helper note ---- */}
      <div className="card p-4 text-[11px] text-surface-500 leading-relaxed">
        <strong className="text-surface-700">How attribution is computed:</strong> phones are normalized
        (strips +91, leading 0, spaces, dashes; keeps last 10 digits if they start with 6-9). For each lead
        in File&nbsp;A, we look for the earliest payment in File&nbsp;B with the same phone where the rule
        passes. "B after A" excludes pre-existing customers — they would have converted anyway, so attributing
        them to your event would inflate the number. "Pre-existing" counts phones that exist in File&nbsp;B
        only with earlier dates. "Attributed" counts phones with at least one B-after-A match. Revenue uses
        the matched B row (earliest qualifying). Amount = primary total (typically <code>totalAmount</code>),
        Paid = first-installment receipts (typically <code>paidAmount</code>) — the gap reflects EMI plans
        that haven't fully cleared yet.
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function StepStrip({ active }: { active: 1 | 2 | 3 | 4 }) {
  const steps = [
    { n: 1, label: 'Upload' },
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
              s.n <= active
                ? 'bg-brand-pink/10 text-brand-pink font-medium'
                : 'bg-surface-100 text-surface-500'
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

function FileDropZone({
  label, sublabel, data, onLoad, onClear,
}: {
  label: string;
  sublabel: string;
  data: CSVData | null;
  onLoad: (f: File) => void;
  onClear: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onLoad(f);
  };

  if (data) {
    return (
      <div className="card p-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] text-surface-500">{label}</div>
          <div className="text-sm font-medium text-brand-navy flex items-center gap-1.5 truncate">
            <FileSpreadsheet size={14} className="text-brand-pink shrink-0" />
            <span className="truncate" title={data.filename}>{data.filename}</span>
          </div>
          <div className="text-[10px] text-surface-400 mt-0.5">
            {fmtInt(data.rows.length)} rows · {data.columns.length} columns
          </div>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="text-surface-400 hover:text-red-600 p-1"
          aria-label="Remove file"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <label
      className={`card p-4 cursor-pointer border-dashed border-2 transition-colors text-center block ${
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
      <Upload size={18} className="mx-auto text-surface-400 mb-1" />
      <div className="text-xs font-medium text-brand-navy">{label}</div>
      <div className="text-[10px] text-surface-500 mt-0.5">{sublabel}</div>
      <div className="text-[10px] text-surface-400 mt-1">Drop CSV here or click to browse</div>
    </label>
  );
}

function ColumnPicker({
  label, columns, value, onChange, optional = false,
}: {
  label: string;
  columns: string[];
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <label className="text-surface-600 w-14 shrink-0">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="flex-1 text-xs px-2 py-1 border border-surface-200 rounded bg-white text-brand-navy hover:border-surface-300 focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
      >
        {optional && <option value="">(none)</option>}
        {columns.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>
  );
}

function FilterPanel({
  label, totalRows, filteredRows,
  bucketColumn, bucketColumnLabel = 'Bucket', bucketValues, bucketSel, setBucketSel,
  customFilters, setCustomFilters, columns,
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
}) {
  const toggleBucket = (v: string) => {
    const next = new Set(bucketSel);
    if (next.has(v)) next.delete(v); else next.add(v);
    setBucketSel(next);
  };
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
  return (
    <div className="card p-3 mb-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider text-surface-500">{label}</div>
        <div className="text-[11px] text-surface-500">
          <strong className="text-brand-navy">{fmtInt(totalRows)}</strong> rows →{' '}
          <strong className="text-brand-pink">{fmtInt(filteredRows)}</strong> after filter
        </div>
      </div>

      {/* Bucket / status preset pills */}
      {bucketColumn && bucketValues.length > 0 && (
        <div className="mb-2.5">
          <div className="text-[10px] text-surface-500 mb-1">
            {bucketColumnLabel} <span className="italic text-surface-400">(detected from <code className="text-[9px]">{bucketColumn}</code>)</span>
          </div>
          <div className="flex flex-wrap gap-1.5 items-center">
            {bucketValues.map(v => {
              const on = bucketSel.has(v);
              const isDashboard = DASHBOARD_BUCKETS.includes(v);
              const label = isDashboard ? BUCKET_LABELS[v] : v;
              const accent = v === 'top_priority' || v === 'success' || v === 'successful' || v === 'paid';
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => toggleBucket(v)}
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
                  {label}
                </button>
              );
            })}
            <span className="text-[10px] text-surface-400 mx-1">·</span>
            <button type="button" onClick={() => setBucketSel(new Set(bucketValues))} className="text-[10px] text-brand-pink hover:underline">All</button>
            <span className="text-[10px] text-surface-300">·</span>
            <button type="button" onClick={() => setBucketSel(new Set())} className="text-[10px] text-surface-400 hover:underline">None</button>
          </div>
        </div>
      )}

      {/* Custom filters */}
      <div className={bucketColumn ? 'border-t border-surface-100 pt-2' : ''}>
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
  results, mappingB, hasAmount, hasPaid, hasStatus,
}: {
  results: Results;
  mappingB: ColumnMappingB;
  hasAmount: boolean;
  hasPaid: boolean;
  hasStatus: boolean;
}) {
  const { totalA, keyMatched, preExisting, attributed, attributedSuccess, unmatched, revenueTotal, revenuePaid } = results;

  return (
    <>
      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <KPI label="Leads (File A)" value={fmtInt(totalA)} />
        <KPI label="Attributed"     value={fmtInt(attributed)} sub={fmtPct(attributed, totalA)} accent="green" />
        {hasAmount && <KPI label="Revenue (total)" value={fmtINR(revenueTotal)} />}
        {hasPaid   && <KPI label="Revenue (paid)"  value={fmtINR(revenuePaid)} />}
        {!hasAmount && !hasPaid && (
          <>
            <KPI label="Pre-existing" value={fmtInt(preExisting)} sub={fmtPct(preExisting, totalA)} accent="amber" />
            <KPI label="Unmatched"    value={fmtInt(unmatched)}   sub={fmtPct(unmatched, totalA)} />
          </>
        )}
      </div>

      {/* Funnel */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            <FunnelRow label="Total leads in File A" count={totalA} total={totalA} bold />
            <FunnelRow label="Phone exists in File B (ever)" count={keyMatched} total={totalA} indent={1} />
            <FunnelRow label="B before A — pre-existing customers" count={preExisting} total={totalA} indent={2} chip="amber" chipLabel="Pre-existing" />
            <FunnelRow label="B after A — attributed" count={attributed} total={totalA} indent={2} chip="green" chipLabel="Attributed" emphasize />
            {hasStatus && (
              <FunnelRow label={`Status = success (paid / successful / completed)`} count={attributedSuccess} total={totalA} indent={3} />
            )}
            <FunnelRow label="No match in File B" count={unmatched} total={totalA} indent={1} muted />
          </tbody>
        </table>
      </div>

      {/* Revenue breakdown if amount info exists */}
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

      {/* Downloads */}
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
