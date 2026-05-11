export type Vendor = {
  id: string;
  slug: string;
  name: string;
  is_active: boolean;
};

export type Campaign = {
  id: string;
  name: string;
  display_name?: string | null;
  vendor_id: string;
  vendor_name?: string | null;
  vendor_request_id: string;
  agent_id: string | null;
  started_at: string | null;
  expected_calls: number | null;
};

export type Agent = {
  id: string;
  vendor_id: string;
  vendor_agent_id: string;
  name: string;
  language: string | null;
  voice_persona: string | null;
  result_schema: Record<string, unknown>;
};

export type ConnectedBreakdown = {
  high: number;
  medium: number;
  low: number;
  not_covered: number;
  not_available: number;
  unclassified: number;
};

export type UnreachedBreakdown = {
  in_progress: number;
  not_connected: number;
  voicemail: number;
  failed: number;
};

export type DuplicateCampaign = {
  campaign_id: string;
  campaign_name: string;
  started_at: string | null;
  shared_leads: number;
};

export type OverviewMetrics = {
  total_calls: number;
  row_count: number;
  connected_calls: number;
  failed_calls: number;
  avg_duration_seconds: number;
  engaged_calls: number;
  interested_calls: number;
  follow_up_calls: number;
  hot_lead_calls: number;
  connection_rate: number;
  engagement_rate: number;
  interest_rate: number;
  follow_up_rate: number;
  hot_lead_rate: number;
  conversion_rate: number;
  unique_leads: number;
  unique_connected_leads: number;
  unique_engaged_leads: number;
  unique_interested_leads: number;
  unique_callback_leads: number;
  unique_top_priority_leads: number;
  unique_callback_only_leads: number;
  unique_interested_only_leads: number;
  unique_no_intent_leads: number;
  attempts_per_lead: number;
  lead_conversion_rate: number;
  connected_breakdown: ConnectedBreakdown;
  unreached_breakdown: UnreachedBreakdown;
  unreached_total: number;
  duplicate_leads: number;
  duplicate_rows: number;
  duplicate_dial_attempts: number;
  duplicate_campaigns: DuplicateCampaign[];
};

export type TimeBucket = { bucket: string | null; total: number; connected: number; interested: number };
export type HourBucket = {
  hour: number;
  total_calls: number;
  connected_calls: number;
  engaged_calls: number;
  interested_calls: number;
  callback_calls?: number;
  avg_duration_seconds: number;
  connection_rate: number;
  engagement_rate: number;
  interest_rate: number;
  callback_rate?: number;
};

export type DowBucket = {
  dow: number;          // 1=Mon ... 7=Sun
  dow_name: string;
  total_calls: number;
  connected_calls: number;
  engaged_calls: number;
  interested_calls: number;
  callback_calls?: number;
  avg_duration_seconds: number;
  connection_rate: number;
  engagement_rate: number;
  interest_rate: number;
  callback_rate?: number;
};

export type HeatmapCell = {
  dow: number;
  dow_name: string;
  hour: number;
  total_calls: number;
  connected_calls: number;
  engaged_calls: number;
  interested_calls: number;
  callback_calls?: number;
  avg_duration_seconds: number;
  connection_rate: number;
  engagement_rate: number;
  interest_rate: number;
  callback_rate?: number;
};

export type VendorHourSplit = {
  vendor_id: string;
  vendor_name: string;
  hours: HourBucket[];
};

export type CampaignHourSplit = {
  campaign_id: string;
  campaign_name: string;
  display_name?: string | null;
  hours: HourBucket[];
};

export type HourlyInsights = {
  hour_breakdown: HourBucket[];
  dow_breakdown:  DowBucket[];
  heatmap:        HeatmapCell[];
  by_vendor:      VendorHourSplit[];
  by_campaign:    CampaignHourSplit[];
};
export type FunnelStageKey =
  | 'leads'
  | 'connected'
  | 'engaged'
  | 'interested'
  | 'callback'
  | 'top_priority'
  | 'callback_only'
  | 'interested_only'
  | 'no_intent'
  // Legacy aliases — older bookmarks may still hit these
  | 'hotleads'
  | 'followup';

export type FunnelStage = {
  key: FunnelStageKey | string;
  stage: string;
  count: number;
  definition: string;
  rate_of_previous: number | null;
  rate_of_top: number;
};

export type VendorRow = {
  vendor_id: string;
  vendor_slug: string;
  vendor_name: string;
  total_calls: number;
  connected_calls: number;
  avg_duration_seconds: number;
  connection_rate: number;
  engagement_rate: number;
  interest_rate: number;
  follow_up_rate: number;
  unique_leads: number;
  attempts_per_lead: number;
};

export type CampaignRow = {
  campaign_id: string;
  campaign_name: string;
  display_name?: string | null;
  vendor_id: string;
  vendor_name?: string | null;
  started_at: string | null;
  unique_leads?: number;        // distinct phones in this campaign = denominator for connection_rate
  total_calls: number;          // total dial attempts (includes retries)
  connected_calls: number;
  engaged_calls?: number;
  interested_calls: number;
  connection_rate: number;
  engagement_rate?: number;
  interest_rate: number;
};

export type CallListItem = {
  id: string;
  vendor_name: string;
  campaign_name: string | null;
  agent_name: string | null;
  callee_name: string | null;
  mobile_number: string | null;
  status: string;
  lifecycle_status: string;
  answered_by: string;
  engagement_status: string;
  duration_seconds: number | null;
  started_at: string | null;
  has_recording: boolean;
  interested: string | null;
  follow_up_at: string | null;
};

export type CallListPage = {
  items: CallListItem[];
  total: number;
  page: number;
  page_size: number;
};

export type CallDetail = {
  id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_call_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  callee_name: string | null;
  mobile_number: string | null;
  from_phone_number: string | null;
  language: string | null;
  status: string;
  lifecycle_status: string;
  engagement_status: string;
  answered_by: string;
  call_ended_by: string;
  duration_seconds: number | null;
  duration_minutes: number | null;
  user_speech_duration: number | null;
  max_retries: number;
  retry_count: number;
  retries_left: number;
  recording_url: string | null;
  custom_data: Record<string, unknown>;
  result: Record<string, unknown>;
  started_at: string | null;
  ended_at: string | null;
};

export type AgentPerformanceRow = {
  agent_id: string;
  agent_name: string;
  vendor_name: string;
  language: string | null;
  voice_persona: string | null;
  total_calls: number;
  connected_calls: number;
  avg_duration_seconds: number;
  connection_rate: number;
  engagement_rate: number;
  interest_rate: number;
  follow_up_rate: number;
};

export type TriggerCampaignRequest = {
  vendor_slug: string;
  vendor_agent_id: string;
  sheet_id: string;
  worksheet_name?: string;
  campaign_name?: string;
  max_recipients?: number;
};

export type TriggerCampaignResponse = {
  status: string;
  request_id: string;
  sheet_rows_inserted: number;
  recipients_pushed: number;
  vendor_response?: Record<string, unknown>;
  warning?: string;
};

export type Filters = {
  start: Date;
  end: Date;
  vendor_ids: string[];
  campaign_ids: string[];
};

export type OutcomeRow = {
  outcome: string;
  count: number;
  pct: number;
};

export type OutcomeDistribution = {
  by_call: OutcomeRow[];
  by_lead: OutcomeRow[];
};

export type AttemptsRow = {
  attempts: number;       // total dial attempts on the lead (retry_count + 1, summed across rows)
  leads: number;          // unique leads that received exactly this many attempts
  connected: number;      // of those leads, how many ever picked up (HUMAN + COMPLETED)
  pct_of_leads: number;   // leads / total_leads
  connect_rate: number;   // connected / leads — the cohort pickup rate (most useful column)
};

export type AttemptsDistribution = {
  rows: AttemptsRow[];
  total_leads: number;
  total_connected: number;
  total_calls: number;
};

// ---------------------------------------------------------------------------
// Activity log / ledger — operational journal
// ---------------------------------------------------------------------------

export const LEDGER_ENTRY_TYPES = ['leads_given', 'campaign_created', 'note', 'config_change'] as const;
export type LedgerEntryType = typeof LEDGER_ENTRY_TYPES[number];

export type LedgerLiveStats = {
  total_calls: number;
  unique_leads: number;
  connected: number;
  interested: number;
  avg_duration_seconds: number;
};

export type LedgerEntry = {
  id: string;
  entry_type: LedgerEntryType;
  title: string;
  occurred_at: string;
  vendor_id: string | null;
  vendor_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_vendor_request_id: string | null;
  leads_total: number | null;
  leads_unique: number | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  live_stats: LedgerLiveStats | null;
  created_at: string;
  updated_at: string;
};

export type LedgerEntryInput = {
  entry_type: LedgerEntryType;
  title: string;
  occurred_at?: string;
  vendor_id?: string | null;
  campaign_id?: string | null;
  leads_total?: number | null;
  leads_unique?: number | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
};

export type LedgerListResponse = {
  items: LedgerEntry[];
  total: number;
  page: number;
  page_size: number;
};

export type PendingCampaign = {
  campaign_id: string;
  campaign_name: string;
  vendor_id: string;
  vendor_name: string;
  vendor_request_id: string;
  started_at: string | null;
  expected_calls: number | null;
  total_calls: number;
  unique_leads: number;
};

export type PendingCampaignsResponse = {
  items: PendingCampaign[];
  total: number;
  days: number;
};

// DoD Leads — Day-over-Day breakdown by upload date with campaign expansion
export type DodLeadCampaign = {
  campaign_id: string;
  campaign_name: string;
  total_leads: number;
  top_priority: number;
  interested_only: number;
  callback_only: number;
  no_intent: number;
  unreached: number;
};

export type DodLeadDay = {
  date: string;            // ISO calendar date in IST, e.g. "2026-05-05"
  total_leads: number;
  top_priority: number;
  interested_only: number;
  callback_only: number;
  no_intent: number;
  unreached: number;
  campaigns: DodLeadCampaign[];
};

export type DodLeadsResponse = {
  days: DodLeadDay[];
  total_days: number;
};

// ---------------------------------------------------------------------------
// BDA lookup tool types — phone-number search. Mirrors backend LookupResult
// schema. NB: deliberately no vendor/agent/campaign IDs in this shape —
// even the type system reinforces "BDAs don't see vendor".
// ---------------------------------------------------------------------------

export type LookupCall = {
  id: string;            // opaque — only used to hit the recording proxy
  when: string | null;
  status: string;
  answered_by: string;
  duration_seconds: number;
  retry_count: number;
  has_recording: boolean;
  interest: string | null;
  objection_text: string | null;
  next_step: string | null;
  follow_up_at: string | null;
  language: string | null;
  summary: string | null;        // ← ADD THIS LINE
};

export type LookupSummary = {
  callee_name: string | null;
  total_calls: number;
  total_attempts: number;
  connected_count: number;
  longest_duration_seconds: number;
  latest_interest: string | null;
  latest_objection: string | null;
  latest_follow_up: string | null;
  first_call_at: string | null;
  last_call_at: string | null;
  narrative: string | null;      // ← ADD THIS LINE
};

export type LookupResult = {
  normalized_phone: string | null;
  input_phone: string;
  found: boolean;
  summary: LookupSummary | null;
  calls: LookupCall[];
};
