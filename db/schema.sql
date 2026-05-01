-- =============================================================================
-- AI Calling Vendor Analytics — Postgres Schema
-- =============================================================================
-- Design principles:
--   1. Vendor-agnostic core columns + JSONB for vendor-specific fields.
--   2. Always store raw_payload (source of truth) so we can re-parse later.
--   3. UNIQUE (vendor_id, vendor_call_id) for idempotent upserts.
--   4. Indexes biased toward dashboard query patterns (date + vendor + campaign).
--   5. No materialized views in v1 — compute rollups on demand. Add MVs when slow.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;          -- For lead name fuzzy search

-- -----------------------------------------------------------------------------
-- vendors: One row per AI calling vendor (Hunar, SquadStack, ...)
-- -----------------------------------------------------------------------------
CREATE TABLE vendors (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug            TEXT NOT NULL UNIQUE,                  -- 'hunar', 'squadstack'
    name            TEXT NOT NULL,
    api_base_url    TEXT NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,    -- non-secret config
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- agents: AI agent personas inside a vendor.
-- (Hunar calls them "agents", SquadStack uses "scripts/bots" — we normalize.)
-- -----------------------------------------------------------------------------
CREATE TABLE agents (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id           UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    vendor_agent_id     TEXT NOT NULL,                     -- ID in vendor's system
    name                TEXT NOT NULL,
    language            TEXT,                              -- 'ENGLISH', 'HINDI', ...
    voice_persona       TEXT,
    -- Describes the keys that will appear in call_logs.result for this agent.
    -- e.g. {"interested": "boolean", "follow_up_at": "string"}
    result_schema       JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_payload         JSONB,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (vendor_id, vendor_agent_id)
);
CREATE INDEX idx_agents_vendor ON agents(vendor_id);

-- -----------------------------------------------------------------------------
-- campaigns: A logical grouping of calls.
-- For Hunar: maps to request_id (the bulk-call batch identifier).
-- For SquadStack: will map to their campaign/job ID.
-- We may also create campaigns ourselves when triggering bulk calls from this app.
-- -----------------------------------------------------------------------------
CREATE TYPE campaign_source AS ENUM ('vendor_ui', 'sheets_import', 'api', 'manual');

CREATE TABLE campaigns (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    -- vendor_request_id is the vendor's batch identifier.
    -- For Hunar this is `request_id`. For SquadStack it'll be their campaign_id.
    vendor_request_id   TEXT NOT NULL,
    name            TEXT NOT NULL,
    agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
    source          campaign_source NOT NULL DEFAULT 'vendor_ui',
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Lead count we *expected* to dial when campaign was created (from upload size).
    -- Useful because Hunar's API doesn't tell you total dials until you list calls.
    expected_calls  INTEGER,
    started_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (vendor_id, vendor_request_id)
);
CREATE INDEX idx_campaigns_vendor_started ON campaigns(vendor_id, started_at DESC);
CREATE INDEX idx_campaigns_agent ON campaigns(agent_id);

-- -----------------------------------------------------------------------------
-- leads: Source-of-truth for people we're calling.
-- Pulled from Google Sheets imports or pushed via API.
-- A lead may be dialed multiple times across campaigns/vendors.
-- -----------------------------------------------------------------------------
CREATE TYPE lead_source AS ENUM ('google_sheets', 'api', 'manual', 'csv_upload');

CREATE TABLE leads (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source          lead_source NOT NULL,
    -- Pointer back to the source row (e.g. "sheet:<id>:row:42")
    source_ref      TEXT,
    name            TEXT NOT NULL,
    mobile_number   TEXT NOT NULL,                         -- E.164 normalized
    email           TEXT,
    custom_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- A canonical key that lets us dedupe across imports — typically phone number.
    dedupe_key      TEXT GENERATED ALWAYS AS (mobile_number) STORED,
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (dedupe_key, source, source_ref)
);
CREATE INDEX idx_leads_phone ON leads(mobile_number);
CREATE INDEX idx_leads_name_trgm ON leads USING gin (name gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- call_logs: The fact table. One row per call attempt across all vendors.
-- This is the heart of the dashboard.
-- -----------------------------------------------------------------------------
CREATE TYPE call_status AS ENUM (
    'NOT_STARTED', 'SCHEDULED', 'INITIATED', 'RINGING', 'IN_PROGRESS',
    'COMPLETED', 'NOT_CONNECTED', 'CANCELLED', 'FAILED', 'UNKNOWN'
);

CREATE TYPE engagement_status AS ENUM ('ENGAGED', 'NOT_ENGAGED', 'UNKNOWN');
CREATE TYPE answered_by AS ENUM ('HUMAN', 'MACHINE', 'UNKNOWN');
CREATE TYPE call_ended_by AS ENUM ('AGENT', 'USER', 'UNKNOWN');

CREATE TABLE call_logs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id           UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    vendor_call_id      TEXT NOT NULL,                     -- vendor's PK
    campaign_id         UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    agent_id            UUID REFERENCES agents(id) ON DELETE SET NULL,
    lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,

    -- Identity
    callee_name         TEXT,
    mobile_number       TEXT,
    from_phone_number   TEXT,
    language            TEXT,

    -- Status (normalized)
    status              call_status NOT NULL DEFAULT 'UNKNOWN',
    lifecycle_status    call_status NOT NULL DEFAULT 'UNKNOWN',
    engagement_status   engagement_status NOT NULL DEFAULT 'UNKNOWN',
    answered_by         answered_by NOT NULL DEFAULT 'UNKNOWN',
    call_ended_by       call_ended_by NOT NULL DEFAULT 'UNKNOWN',

    -- Duration
    duration_seconds        NUMERIC(10, 2),
    duration_minutes        NUMERIC(10, 2),
    user_speech_duration    NUMERIC(10, 2),

    -- Retry
    max_retries         INTEGER DEFAULT 0,
    retry_count         INTEGER DEFAULT 0,
    retries_left        INTEGER DEFAULT 0,

    -- Artifacts
    recording_url       TEXT,

    -- Vendor-specific
    custom_data         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- result is dynamic per agent.result_schema. Index hot keys via GIN.
    -- Common Hunar keys we care about: interested, qualified, follow_up_at,
    -- objection, engagement_level, next_steps, interest_level
    result              JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_payload         JSONB NOT NULL,                    -- source of truth

    -- Timestamps
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    vendor_created_at   TIMESTAMPTZ,                       -- per vendor's clock
    ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (vendor_id, vendor_call_id)
);

-- Hot indexes for dashboard queries.
-- The combo (vendor_id, started_at) covers most filtering paths.
CREATE INDEX idx_calls_vendor_started ON call_logs(vendor_id, started_at DESC);
CREATE INDEX idx_calls_campaign ON call_logs(campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX idx_calls_agent ON call_logs(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_calls_lead ON call_logs(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX idx_calls_status ON call_logs(status);
CREATE INDEX idx_calls_lifecycle ON call_logs(lifecycle_status);
CREATE INDEX idx_calls_started ON call_logs(started_at DESC);
CREATE INDEX idx_calls_phone ON call_logs(mobile_number);
-- GIN on result for ad-hoc filtering on dynamic keys (e.g. result->>'interested' = 'Yes')
CREATE INDEX idx_calls_result_gin ON call_logs USING gin (result jsonb_path_ops);

-- -----------------------------------------------------------------------------
-- sync_runs: Audit log for cron jobs. Lets us answer "when did we last sync?"
-- and recover from partial failures.
-- -----------------------------------------------------------------------------
CREATE TYPE sync_status AS ENUM ('running', 'success', 'partial', 'failed');
CREATE TYPE sync_job AS ENUM ('agents', 'calls', 'campaigns', 'sheets_leads');

CREATE TABLE sync_runs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id           UUID REFERENCES vendors(id) ON DELETE CASCADE,
    job_type            sync_job NOT NULL,
    status              sync_status NOT NULL DEFAULT 'running',
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ,
    records_seen        INTEGER NOT NULL DEFAULT 0,
    records_upserted    INTEGER NOT NULL DEFAULT 0,
    high_water_mark     TIMESTAMPTZ,                       -- max(vendor_created_at) seen
    error_message       TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_sync_runs_vendor_started ON sync_runs(vendor_id, started_at DESC);

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_vendors_updated  BEFORE UPDATE ON vendors  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_agents_updated   BEFORE UPDATE ON agents   FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_campaigns_updated BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- Seed: insert known vendors
-- -----------------------------------------------------------------------------
INSERT INTO vendors (slug, name, api_base_url, config) VALUES
    ('hunar', 'Hunar', 'https://api.voice.hunar.ai/external/v1', '{"webhooks_supported": true}'::jsonb),
    ('squadstack', 'SquadStack', 'https://api.squadstack.com', '{"webhooks_supported": true}'::jsonb)
ON CONFLICT (slug) DO NOTHING;
