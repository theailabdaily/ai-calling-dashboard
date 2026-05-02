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

export type OverviewMetrics = {
  total_calls: number;
  connected_calls: number;
  failed_calls: number;
  avg_duration_seconds: number;
  engaged_calls: number;
  interested_calls: number;
  follow_up_calls: number;
  connection_rate: number;
  engagement_rate: number;
  interest_rate: number;
  follow_up_rate: number;
  conversion_rate: number;
  unique_leads: number;
  unique_connected_leads: number;
  unique_interested_leads: number;
  attempts_per_lead: number;
  lead_conversion_rate: number;
};

export type TimeBucket = { bucket: string | null; total: number; connected: number; interested: number };
export type HourBucket = {
  hour: number;
  total_calls: number;
  connected_calls: number;
  engaged_calls: number;
  interested_calls: number;
  avg_duration_seconds: number;
  connection_rate: number;
  engagement_rate: number;
  interest_rate: number;
};

export type DowBucket = {
  dow: number;          // 1=Mon ... 7=Sun
  dow_name: string;
  total_calls: number;
  connected_calls: number;
  engaged_calls: number;
  interested_calls: number;
  avg_duration_seconds: number;
  connection_rate: number;
  engagement_rate: number;
  interest_rate: number;
};

export type HeatmapCell = {
  dow: number;
  dow_name: string;
  hour: number;
  total_calls: number;
  connected_calls: number;
  engaged_calls: number;
  interested_calls: number;
  avg_duration_seconds: number;
  connection_rate: number;
  engagement_rate: number;
  interest_rate: number;
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
export type FunnelStage = { stage: string; count: number };

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
  total_calls: number;
  connected_calls: number;
  interested_calls: number;
  connection_rate: number;
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
  attempts: number;        // how many calls a single lead received
  leads: number;           // how many unique leads got exactly this many attempts
  calls_consumed: number;  // = attempts * leads (dial volume in this bucket)
  pct_of_leads: number;    // leads / total_leads
  pct_of_calls: number;    // calls_consumed / total_calls
};

export type AttemptsDistribution = {
  rows: AttemptsRow[];
  total_leads: number;
  total_calls: number;
};
