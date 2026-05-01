# AI Calling Vendor Analytics

Unified analytics dashboard for AI calling vendors (Hunar today, SquadStack next, more later). Built for Testbook Supercoaching's user-acquisition team.

```
┌─────────────────┐    ┌──────────────┐    ┌──────────────┐
│  Google Sheets  │ ─▶ │   Backend    │ ─▶ │  Postgres    │
└─────────────────┘    │  (FastAPI)   │    └──────────────┘
                       │              │           ▲
┌─────────────────┐    │  Adapters:   │           │
│  Hunar API      │ ⇄  │  - Hunar     │ ──────────┘
│  (REST + Hooks) │    │  - SquadStk* │
└─────────────────┘    └──────┬───────┘
                              │
                       ┌──────▼───────┐
                       │   Next.js    │  ← you look here
                       │  Dashboard   │
                       └──────────────┘
*stub
```

## What's in here

| Path | What |
|---|---|
| `db/schema.sql` | Postgres schema. Vendor-agnostic core + JSONB for vendor specifics. |
| `backend/app/adapters/base.py` | The contract every vendor implements. |
| `backend/app/adapters/hunar.py` | Working Hunar integration (calls, agents, webhooks, bulk create). |
| `backend/app/adapters/squadstack.py` | Stub — fill in when integrating. |
| `backend/app/services/metrics.py` | All dashboard math. Definitions documented inline. |
| `backend/app/services/upsert.py` | Idempotent writers — used by both sync jobs and webhooks. |
| `backend/app/jobs/sync.py` | Cron-driven sync. Uses high-water-mark pattern. |
| `backend/app/api/*.py` | REST endpoints (overview, vendors, exports, ingestion). |
| `backend/app/api/calls.py` | Calls list (paginated, searchable, filterable) + detail. |
| `backend/app/api/agents.py` | Per-agent performance breakdown. |
| `backend/app/api/ingestion.py` | Webhooks, Sheets import, **Sheets→vendor campaign launcher** (end-to-end). |
| `frontend/app/page.tsx` | Overview dashboard. |
| `frontend/app/vendors/page.tsx` | Vendor analysis with multi-select comparison. |
| `frontend/app/agents/page.tsx` | Agent performance table + top-10 chart. |
| `frontend/app/calls/page.tsx` | Call logs with search, filters, click-through detail drawer + audio playback. |
| `frontend/app/campaigns/new/page.tsx` | Launch a campaign from a Google Sheet in one form. |

## Quick start (local)

```bash
# 1. Get the API key into env
cp backend/.env.example backend/.env
# edit backend/.env, set HUNAR_API_KEY

# 2. Boot everything
docker compose up

# 3. Trigger a first sync (otherwise dashboard is empty)
curl -X POST http://localhost:8000/api/vendors/hunar/sync

# 4. Open the dashboard
open http://localhost:3000
```

The schema is loaded automatically by Postgres on first boot via the `docker-entrypoint-initdb.d` mount. If you change `db/schema.sql`, run `docker compose down -v` to wipe the volume.

## Without Docker

```bash
# DB
createdb aicalling
psql aicalling < db/schema.sql

# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill in HUNAR_API_KEY, DATABASE_URL
uvicorn app.main:app --reload

# Frontend
cd frontend
npm install
npm run dev
```

## How data flows

**Real-time path (preferred): Webhooks**
1. When you create calls via `POST /api/ingest/push-to-vendor`, the backend supplies `callback_config.call_summary_callback_url = $PUBLIC_WEBHOOK_BASE_URL/webhooks/hunar/summary`.
2. Hunar fires the webhook on call completion. Our handler normalizes the payload and upserts into `call_logs`.
3. Dashboard polls every 60s — the data is already in the DB.

**Backstop path: Cron polling**
- APScheduler runs every 15 min (configurable). Calls `sync_all_vendors()`.
- For each vendor, checks `MAX(vendor_created_at)` in `call_logs`, subtracts 5 min overlap, and pulls everything newer from the vendor API.
- Idempotent: hitting the same call twice does an UPDATE, not a duplicate INSERT.

**Bootstrap (first run, historical backfill)**
```bash
# inside backend container, or with venv activated
python -m scripts.run_sync --vendor hunar
```
The sync paginates from newest → oldest until it exhausts the vendor's history (Hunar has no date filter, so initial backfill walks the whole list once). Subsequent runs short-circuit at the high-water mark.

## Adding a new vendor (the SquadStack playbook)

1. Open `backend/app/adapters/squadstack.py`.
2. Implement the four methods: `list_agents`, `iter_calls`, `get_call`, `parse_webhook`. Each one normalizes vendor responses into our `NormalizedAgent` / `NormalizedCall` dataclasses.
3. Add `SQUADSTACK_API_KEY` and `SQUADSTACK_BASE_URL` to `.env`. The registry in `backend/app/adapters/__init__.py` already wires it up.
4. (Optional) Add a webhook route in `backend/app/api/ingestion.py` if SquadStack pushes events.
5. `python -m scripts.run_sync --vendor squadstack`. Done. Frontend automatically picks it up via `/api/vendors`.

The frontend never needs a code change to support a new vendor. The vendor list, filter dropdowns, comparison charts, and tables are all data-driven.

## Key design decisions (and why)

| Decision | Why |
|---|---|
| `request_id` = our `campaigns.vendor_request_id` | Hunar has no campaign resource. `request_id` is the only batch identifier they expose. Treat it as the canonical campaign key. |
| Always store `raw_payload` (JSONB) | Source of truth. Lets us re-derive normalized fields if our parsing changes. Cheap insurance. |
| `result` is JSONB, indexed with GIN | Result keys are dynamic per agent (`interested`, `objection`, `engagement_level`, etc.). GIN lets us filter on dynamic keys without schema changes. |
| Connection rate counts only `lifecycle_status='COMPLETED' AND answered_by='HUMAN'` | Machine pickups aren't real connections. This is the most defensible default. Tweak `services/metrics.py` if your definition differs. |
| `conversion_rate` is a v1 proxy (= interest rate) | Real conversion is downstream (lead → demo → paid). Wire your CRM/event source into `metrics.py` to make it real. |
| Webhooks > polling | Hunar's `call_summary` webhook is one-shot complete; polling is the backstop. |
| No auth in v1 | Internal tool. Put it behind Cloudflare Access or Vercel password protection. |

## Deployment notes

**Backend → Render / Railway / Fly**
- Set env vars from `.env.example`.
- Two services: web (`uvicorn app.main:app`) and worker (cron-style: `python -m scripts.run_sync` every 15 min via the platform's cron feature). Disable APScheduler in prod by removing `scheduler.start()` if you go this route — otherwise sync runs in two places.

**Frontend → Vercel**
- Set `NEXT_PUBLIC_API_BASE` to your backend's public URL.
- The `/api/*` rewrite in `next.config.mjs` proxies to that URL automatically.

**DB → Supabase / Neon**
- Run `db/schema.sql` once on a fresh database. Future migrations: use Alembic (already in requirements).

## Known gaps / v2 backlog

- Auth (Google SSO via Clerk or NextAuth).
- Materialized views for `vendor_summary` / `campaign_summary` daily rollups — only worth it if dashboard queries get slow.
- Real conversion tracking (CRM event ingestion) — `conversion_rate` is a v1 proxy.
- Webhook signature verification (Hunar says coming; we should verify when they ship it).
- Real-time via Server-Sent Events instead of 60s polling — only when the team grumbles.
- Cohort comparison view: same agent script across vendors, side-by-side.

## API reference (built-in)

- `GET /docs` — FastAPI's interactive Swagger UI.
- `GET /api/overview/metrics?start=&end=&vendor_ids=&campaign_ids=`
- `GET /api/overview/time-series?bucket=day`
- `GET /api/overview/funnel`
- `GET /api/overview/vendor-comparison`
- `GET /api/campaigns/breakdown`
- `GET /api/calls?page=&page_size=&search=&only_with_recording=&only_interested=`
- `GET /api/calls/{id}` — full detail incl. recording URL + result JSON.
- `GET /api/agents/performance` — per-agent metrics.
- `GET /api/export/calls.csv` (respects same filters)
- `POST /api/vendors/{slug}/sync` — manual sync trigger
- `POST /api/ingest/google-sheets` — pull leads from a sheet
- `POST /api/ingest/push-to-vendor` — Sheet → vendor bulk dial (end-to-end)
- `POST /api/webhooks/hunar/{event_kind}` — Hunar webhook receiver
