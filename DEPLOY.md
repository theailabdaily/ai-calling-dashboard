# Free deployment — Supabase + Render + Vercel + GitHub Actions

End-to-end ₹0/month. ~30 minutes from zero.

## 0. Prep

- [ ] Rotate the Hunar API key you pasted in chat earlier. Treat that one as compromised.
- [ ] Push this repo to GitHub.

## 1. Database — Supabase

1. supabase.com → New project. Region: `ap-south-1` (Mumbai).
2. Wait for it to provision (~2 min).
3. Project Settings → Database → Connection string → **Use connection pooling** (Transaction mode).
4. Copy the URL. It looks like:
   ```
   postgresql://postgres.xxx:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```
5. Convert for asyncpg by changing the prefix:
   ```
   postgresql+asyncpg://postgres.xxx:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```
6. Load the schema. SQL Editor → paste contents of `db/schema.sql` → Run.

**Gotcha:** Supabase free pauses the project after 7 days of zero queries. The cron we set up below pings every 15 min, so this won't happen in practice.

## 2. Backend — Render

1. render.com → New → Blueprint → connect your GitHub repo.
2. Render picks up `render.yaml` and proposes the service. Confirm.
3. After it boots (first build ~5 min), open the service → Environment → fill the values marked `sync: false`:
   - `DATABASE_URL` — the Supabase URL with `+asyncpg`
   - `HUNAR_API_KEY` — the new one
   - `PUBLIC_WEBHOOK_BASE_URL` — your own Render URL (e.g. `https://ai-calling-dashboard-api.onrender.com`)
   - `DASHBOARD_PASSWORD` — generate a long random string. `openssl rand -base64 32`
   - `CORS_ORIGINS` — `["https://your-frontend.vercel.app"]` — fill after step 3
4. Manual deploy → wait for green.
5. Test: `curl https://your-render-url.onrender.com/health` → `{"status":"ok"}`

## 3. Frontend — Vercel

1. vercel.com → New Project → import the same GitHub repo.
2. Root directory: `frontend`.
3. Environment variables:
   - `NEXT_PUBLIC_API_BASE` = your Render URL
   - `DASHBOARD_USERNAME` = `admin` (or whatever)
   - `DASHBOARD_PASSWORD` = same string you used on Render
4. Deploy. Note the URL (e.g. `https://ai-calling-dashboard.vercel.app`).
5. Go back to Render and update `CORS_ORIGINS` to include this URL.
6. Open the Vercel URL — browser prompts for username + password. Enter them. Done.

## 4. Cron — GitHub Actions

1. In your GitHub repo → Settings → Secrets and variables → Actions → New secret. Add three:
   - `API_BASE` = your Render URL (no trailing slash)
   - `DASHBOARD_USERNAME` = same as above
   - `DASHBOARD_PASSWORD` = same as above
2. Push the repo (the workflow file `.github/workflows/sync-cron.yml` is already in there).
3. Actions tab → "Sync vendors + keep Render awake" → Run workflow (manual test).
4. After it goes green once, it'll run every 15 min automatically.

GitHub Actions cron timing isn't precise (can drift 5-10 min), which is fine for sync.

## 5. Hunar webhooks

Two paths:

**Path A — campaigns launched from this dashboard (auto):**
The backend supplies callback URLs automatically when you launch via `/campaigns/new`. Nothing to do.

**Path B — campaigns launched from Hunar's UI (manual):**
In Hunar's dashboard, set the campaign callback URLs to:
- `https://your-render-url.onrender.com/api/webhooks/hunar/summary`
- `https://your-render-url.onrender.com/api/webhooks/hunar/status`

These bypass the dashboard auth (they have to — Hunar isn't authenticated). The webhook endpoint accepts any POST. If you want to harden this, add a shared-secret query param check inside the route handler.

## 6. First sync

```bash
# from your laptop
curl -X POST -u admin:YOUR_PASSWORD \
  https://your-render-url.onrender.com/api/vendors/hunar/sync
```

Open the dashboard, wait 60 seconds, refresh. Calls should appear.

## What this costs

| Service | Plan | Cost |
|---|---|---|
| Supabase | Free | ₹0 |
| Render | Free | ₹0 |
| Vercel | Hobby | ₹0 |
| GitHub Actions | Free (~30 min/mo used) | ₹0 |
| **Total** | | **₹0/mo** |

## Honest tradeoffs

- **Render free has a 750 hr/mo cap.** A single always-on service is 720 hrs (24×30). You're cutting it close. If Render decides your service has been idle (it shouldn't, with the cron pings), it spins down. Cold start back up is ~30 sec.
- **Supabase free DB has 500 MB.** At Testbook scale, ~250 bytes per call_log row + JSONB, you've got room for ~1.5M call records. Comfortable for 6+ months.
- **HTTP Basic Auth is browser-stored.** No "logout" button. To log out, close the browser or open incognito. Fine for internal tools, not fine for shared computers.
- **Dual-layer auth means TWO env vars must match.** If frontend and backend `DASHBOARD_PASSWORD` drift apart, the API calls 401 silently and the dashboard looks broken. Set them in a password manager and copy from there.
- **Webhooks during Render sleep are lost.** The 15-min cron sync recovers them, so worst case you see calls 15 min late. Not real-time, but not catastrophic either.

## When to upgrade

- **>1 user / proper logout flow:** swap basic auth for Clerk (free up to 10k MAU, ~30 min integration).
- **DB > 400 MB:** Supabase Pro is ₹2k/mo and gets you 8 GB + PITR backups.
- **Sleeping is annoying:** Render Starter is ~₹600/mo, no sleep, 512 MB.
- **More than ~10 vendors/synthesized analytics:** time to talk about materialized views and a proper warehouse.
