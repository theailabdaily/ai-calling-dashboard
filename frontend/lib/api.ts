import type {
  Agent, AgentPerformanceRow, AttemptsDistribution, AuthEventRow, CallDetail, CallListPage, Campaign, CampaignRow,
  DodLeadsResponse, Filters,
  FunnelStage, HourBucket, HourlyInsights, LedgerEntry, LedgerEntryInput, LedgerEntryType, LedgerListResponse,
  LedgerLiveStats, LookupResult, OutcomeDistribution, OverviewMetrics, PendingCampaignsResponse, ProductLineCard, TimeBucket,
  TriggerCampaignRequest, TriggerCampaignResponse, Vendor, VendorRow,
} from '@/types';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

// Cookie name read by every API call to scope queries to one product line.
// Set by the picker page, read here, sent to backend as ?product_line=<slug>.
// Server-rendered pages won't have document; that's fine — they just send no scope.
export const PRODUCT_LINE_COOKIE = 'product_line_slug';

export function getActiveProductLine(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${PRODUCT_LINE_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function setActiveProductLine(slug: string | null): void {
  if (typeof document === 'undefined') return;
  if (slug === null) {
    document.cookie = `${PRODUCT_LINE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  } else {
    // 90 days. Lax so it survives normal navigation.
    document.cookie = `${PRODUCT_LINE_COOKIE}=${encodeURIComponent(slug)}; path=/; max-age=${60 * 60 * 24 * 90}; SameSite=Lax`;
  }
}

function buildQuery(f: Filters): string {
  const p = new URLSearchParams();
  p.set('start', f.start.toISOString());
  p.set('end', f.end.toISOString());
  for (const v of f.vendor_ids) p.append('vendor_ids', v);
  for (const c of f.campaign_ids) p.append('campaign_ids', c);
  const pl = getActiveProductLine();
  if (pl) p.set('product_line', pl);
  return p.toString();
}

async function jget<T>(path: string): Promise<T> {
  // Auto-append product_line to any path that doesn't already include it.
  // Belt-and-suspenders — buildQuery already injects, but some calls bypass
  // it (e.g. simple list endpoints). The scope cookie is the source of truth.
  let finalPath = path;
  const pl = getActiveProductLine();
  if (pl && !path.includes('product_line=')) {
    const sep = path.includes('?') ? '&' : '?';
    finalPath = `${path}${sep}product_line=${encodeURIComponent(pl)}`;
  }
  const r = await fetch(`${API_BASE}${finalPath}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export const api = {
  vendors: () => jget<Vendor[]>('/api/vendors'),
  campaigns: () => jget<Campaign[]>('/api/campaigns'),
  agents: () => jget<Agent[]>('/api/agents'),
  productLines: () => jget<ProductLineCard[]>('/api/product-lines'),
  adminAuthEvents: (limit = 100) =>
    jget<AuthEventRow[]>(`/api/admin/auth-events?limit=${limit}`),

  overviewMetrics: (f: Filters) =>
    jget<OverviewMetrics>(`/api/overview/metrics?${buildQuery(f)}`),
  timeSeries: (f: Filters, bucket = 'day') =>
    jget<TimeBucket[]>(`/api/overview/time-series?bucket=${bucket}&${buildQuery(f)}`),
  funnel: (f: Filters) =>
    jget<FunnelStage[]>(`/api/overview/funnel?${buildQuery(f)}`),
  vendorComparison: (f: Filters) =>
    jget<VendorRow[]>(`/api/overview/vendor-comparison?${buildQuery(f)}`),
  hourly: (f: Filters) =>
    jget<HourBucket[]>(`/api/overview/hourly?${buildQuery(f)}`),
  outcomes: (f: Filters) =>
    jget<OutcomeDistribution>(`/api/overview/outcomes?${buildQuery(f)}`),
  attemptsDistribution: (f: Filters) =>
    jget<AttemptsDistribution>(`/api/overview/attempts-distribution?${buildQuery(f)}`),
  hourlyInsights: (f: Filters) =>
    jget<HourlyInsights>(`/api/hourly/insights?${buildQuery(f)}`),
  campaignBreakdown: (f: Filters) =>
    jget<CampaignRow[]>(`/api/campaigns/breakdown?${buildQuery(f)}`),

  // Build the export URL. Mirrors every filter param accepted by /api/calls
  // so the CSV matches what the user is currently looking at — top-level
  // filters PLUS in-table filters (search, status, pickup, recording,
  // interested-only, failed-only, funnel stage). Keep this in sync with
  // backend/app/api/exports.py and backend/app/api/calls.py.
  exportCallsUrl: (
    f: Filters,
    opts: {
      search?: string;
      status?: string;
      answered_by?: string;
      only_with_recording?: boolean;
      only_interested?: boolean;
      failed_only?: boolean;
      funnel_stage?: string;
    } = {},
  ) => {
    const q = new URLSearchParams(buildQuery(f));
    if (opts.search) q.set('search', opts.search);
    if (opts.status) q.set('status', opts.status);
    if (opts.answered_by) q.set('answered_by', opts.answered_by);
    if (opts.only_with_recording) q.set('only_with_recording', 'true');
    if (opts.only_interested) q.set('only_interested', 'true');
    if (opts.failed_only) q.set('failed_only', 'true');
    if (opts.funnel_stage) q.set('funnel_stage', opts.funnel_stage);
    return `${API_BASE}/api/export/calls.csv?${q.toString()}`;
  },

  triggerSync: (slug: string) =>
    fetch(`${API_BASE}/api/vendors/${slug}/sync`, { method: 'POST' }).then(r => r.json()),

  importSheet: (sheet_id: string, worksheet_name?: string) =>
    fetch(`${API_BASE}/api/ingest/google-sheets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet_id, worksheet_name }),
    }).then(r => r.json()),

  // Calls list + detail
  callsList: (params: {
    f: Filters;
    page?: number;
    page_size?: number;
    search?: string;
    status?: string;
    answered_by?: string;
    only_with_recording?: boolean;
    only_interested?: boolean;
    funnel_stage?: string;
    failed_only?: boolean;
    sort_by?: 'when' | 'duration' | 'status';
    sort_order?: 'asc' | 'desc';
  }): Promise<CallListPage> => {
    const q = new URLSearchParams(buildQuery(params.f));
    if (params.page) q.set('page', String(params.page));
    if (params.page_size) q.set('page_size', String(params.page_size));
    if (params.search) q.set('search', params.search);
    if (params.status) q.set('status', params.status);
    if (params.answered_by) q.set('answered_by', params.answered_by);
    if (params.only_with_recording) q.set('only_with_recording', 'true');
    if (params.only_interested) q.set('only_interested', 'true');
    if (params.funnel_stage) q.set('funnel_stage', params.funnel_stage);
    if (params.failed_only) q.set('failed_only', 'true');
    if (params.sort_by) q.set('sort_by', params.sort_by);
    if (params.sort_order) q.set('sort_order', params.sort_order);
    return jget<CallListPage>(`/api/calls?${q.toString()}`);
  },

  callDetail: (id: string) => jget<CallDetail>(`/api/calls/${id}`),

  // Agents
  agentPerformance: (f: Filters) =>
    jget<AgentPerformanceRow[]>(`/api/agents/performance?${buildQuery(f)}`),

  // Trigger campaign
  triggerCampaign: (body: TriggerCampaignRequest) =>
    fetch(`${API_BASE}/api/ingest/push-to-vendor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json() as Promise<TriggerCampaignResponse>),

  // CSV upload path — recipients already parsed client-side
  pushRecipients: (body: {
    vendor_slug: string;
    vendor_agent_id: string;
    campaign_name?: string;
    recipients: Array<{
      callee_name: string;
      mobile_number: string;
      custom_data?: Record<string, string>;
    }>;
  }) =>
    fetch(`${API_BASE}/api/ingest/push-recipients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => {
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<TriggerCampaignResponse>;
    }),

  // Activity log / ledger
  ledgerList: (params: {
    entry_type?: LedgerEntryType;
    vendor_id?: string;
    campaign_id?: string;
    start?: string;
    end?: string;
    search?: string;
    page?: number;
    page_size?: number;
  } = {}): Promise<LedgerListResponse> => {
    const q = new URLSearchParams();
    if (params.entry_type) q.set('entry_type', params.entry_type);
    if (params.vendor_id) q.set('vendor_id', params.vendor_id);
    if (params.campaign_id) q.set('campaign_id', params.campaign_id);
    if (params.start) q.set('start', params.start);
    if (params.end) q.set('end', params.end);
    if (params.search) q.set('search', params.search);
    if (params.page) q.set('page', String(params.page));
    if (params.page_size) q.set('page_size', String(params.page_size));
    const qs = q.toString();
    return jget<LedgerListResponse>(`/api/ledger${qs ? `?${qs}` : ''}`);
  },

  ledgerCreate: (body: LedgerEntryInput): Promise<LedgerEntry> =>
    fetch(`${API_BASE}/api/ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => {
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<LedgerEntry>;
    }),

  ledgerUpdate: (id: string, body: Partial<LedgerEntryInput>): Promise<LedgerEntry> =>
    fetch(`${API_BASE}/api/ledger/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => {
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<LedgerEntry>;
    }),

  ledgerDelete: (id: string): Promise<void> =>
    fetch(`${API_BASE}/api/ledger/${id}`, { method: 'DELETE' }).then(async r => {
      if (!r.ok) throw new Error(await r.text());
    }),

  // Campaigns that don't yet have a ledger entry — drives the "X pending"
  // banner on the Activity Log page.
  ledgerPendingCampaigns: (days = 30): Promise<PendingCampaignsResponse> =>
    jget<PendingCampaignsResponse>(`/api/ledger/pending-campaigns?days=${days}`),

  // Live stats for one campaign — used by the New Entry form to auto-fill
  // leads_total / leads_unique when the user picks a campaign.
  ledgerCampaignStats: (campaignId: string): Promise<LedgerLiveStats> =>
    jget<LedgerLiveStats>(`/api/ledger/campaign-stats/${campaignId}`),

  // DoD Leads — leads grouped by upload date with campaign-level expansion.
  // No filter args in v1 — the table is naturally small (one row per upload
  // day) and the page renders the full history.
  dodLeads: (): Promise<DodLeadsResponse> =>
    jget<DodLeadsResponse>(`/api/dod-leads`),

  // BDA phone-number lookup — vendor-anonymous summary + per-call history.
  lookup: (phone: string): Promise<LookupResult> =>
    jget<LookupResult>(`/api/lookup?phone=${encodeURIComponent(phone)}`),

  // Browser <audio> hits this URL. We don't fetch — the audio element does
  // the GET so it can range-request properly. URL points to backend proxy
  // which streams the recording so the underlying vendor URL never reaches
  // the browser.
  recordingUrl: (callId: string): string =>
    `${API_BASE}/api/lookup/recording/${callId}`,
};

// Number formatting helpers (Indian locale)
export const fmt = {
  int: (n: number) => new Intl.NumberFormat('en-IN').format(Math.round(n)),
  pct: (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`,
  duration: (sec: number) => {
    if (!sec || sec < 1) return '0s';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return m ? `${m}m ${s}s` : `${s}s`;
  },
};

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
