# NEXA QUANT INTELLIGENCE — Production Deployment & Operations Runbook

## 1. Prerequisites & Hosting Reality Check
- **Node.js**: `v22+` (`v22.23+` runs native `node:sqlite` + TypeScript type-stripping directly).
- **Bun** (`v1.4+`) or `npm` for dependency management (`bun.lock` is authoritative).
- **SQLite WAL Persistence Requirement**:
  - Container-local disk on serverless platforms (AI Studio dev sandbox, Render Free, Cloud Run without NFS) is **ephemeral**—container resets and cold starts wipe local files.
  - Free-tier PaaS services generally **sleep after ~15 minutes of inactivity** and **do not include persistent disks** for SQLite.
  - **Supported 24/7 Persistent Topologies**:
    1. **Linux VPS / GCE VM + Docker Compose + Caddy (`deploy/compose.yaml`, `deploy/deploy-vps.sh`)**: Single-instance POSIX disk volume (`nexa_data:/app/data`), automatic Let's Encrypt HTTPS for iPhone Safari & desktop, 24/7 uptime, lowest cost (~EUR 3.5–5/mo).
    2. **Render Single-Instance Web Service + Disk (`deploy/render.yaml`)**: Managed HTTPS URL out of the box with 1 GB persistent disk at `/app/data` (requires Starter paid web service + disk plan; free tier does not support disks).
    3. **Google Cloud Run (`maxScale: "1"`) + Cloud Filestore NFS (`deploy/cloudrun.service.yaml`)**: Strict single-writer POSIX NFS mount (`autoscaling.knative.dev/maxScale: "1"`). Never use Cloud Storage FUSE for SQLite WAL.

---

## 2. Environment Configuration & Preflight (`npm run preflight`)
Secrets live exclusively on the server (`process.env` / `.env.production` chmod `600` / Secret Manager). Never prefix server secrets with `VITE_`.

### Required Production Variables
1. `NODE_ENV="production"` — Serves compiled static SPA from `dist/` and disables dev-mode fallback operator auth.
2. `NEXA_SESSION_SECRET` — HMAC-SHA256 signing key (`>= 32` cryptographically random chars, `>= 10` distinct chars).
3. `NEXA_SCHEDULER_TOKEN` — Shared secret (`>= 24` random chars) protecting `POST /api/commerce/schedules/run-due`.
4. `NEXA_ADMIN_PASSWORD` — Admin RBAC password (`>= 12` chars non-default).
5. `NEXA_DATA_DIR="/app/data"` and `NEXA_DB_PATH="/app/data/nexa_genesis.sqlite3"` — Persistent POSIX directory storing SQLite WAL DB, automatic pre-migration backups (`backups/`), and Phase 7 client export bundles (`exports/`).
6. **Hard Safety Locks (Must Remain `false`)**:
   - `NEXA_PAID_FALLBACK_ALLOWED="false"`
   - `NEXA_LIVE_TRADING_ENABLED="false"`
   - `NEXA_EXTERNAL_COMMERCE_ENABLED="false"`
7. `APP_URL="https://YOUR_PUBLIC_HOST"` — Public HTTPS base URL.

Validate before starting production:
```bash
npm run build
NODE_ENV=production npm run preflight
```

---

## 3. Fast Production Deployment (Recommended: Linux VPS + Docker + Caddy)
On any Ubuntu/Debian VPS or GCE VM with Docker installed and ports `80`/`443` pointed to your domain:
```bash
git clone <YOUR_REPO_URL> nexa && cd nexa
NEXA_DOMAIN=nexa.yourdomain.com bash deploy/deploy-vps.sh
```
This script generates `.env.production` with `0600` permissions (preserving existing secrets on updates), builds the hardened `Dockerfile`, mounts persistent volume `nexa_data:/app/data`, configures automatic Let's Encrypt TLS via Caddy, and verifies `/api/health` and `npm run preflight`.

### Importing an Existing Local SQLite Snapshot (`Hamdi`)
If you are migrating existing missions (e.g. `p7_msn_872263ab-3` / `p7_pkg_a08d5e05-d`) into a fresh Docker volume:
```bash
docker compose -f deploy/compose.yaml stop nexa
docker cp ./Hamdi nexa-quant-prod:/app/data/nexa_genesis.sqlite3
docker compose -f deploy/compose.yaml start nexa
```

---

## 4. Three-Layer Scheduling & External Cloud Scheduler
- **Layer A**: In-process 60s `setInterval` scheduler while Node is running.
- **Layer B**: Persistent SQLite lease queue (`commerce_schedules` + `commerce_schedule_runs`) recovering stale locks cleanly on startup.
- **Layer C**: External authenticated HTTP trigger (`POST /api/commerce/schedules/run-due`, header `x-nexa-scheduler-token`); see `deploy/cloudscheduler.sh`.

---

## 5. Post-Deploy External Public Verification Checklist (iPhone Safari & Desktop)
1. Public health without proxy login redirect:
   ```bash
   curl -fsS https://YOUR_DOMAIN/api/health
   ```
   Confirm `"status": "OPERATIONAL"` and `database.persistentFile: true`.
2. Unauthenticated routes lock down (`NODE_ENV=production`):
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://YOUR_DOMAIN/api/commerce
   ```
   Expected: `401`.
3. Sign in on iPhone Safari or desktop at `https://YOUR_DOMAIN` using `admin` + `NEXA_ADMIN_PASSWORD` (sets `HttpOnly` cookie + `x-nexa-session`).
4. Verify public client preview loads over HTTPS (`200 OK`, `X-Robots-Tag: noindex, nofollow`, sandbox CSP):
   ```bash
   curl -fsSI https://YOUR_DOMAIN/preview/p7/p7_pkg_a08d5e05-d
   ```
5. Verify restart persistence: `docker compose -f deploy/compose.yaml restart nexa` -> re-check `/api/health` and confirm all missions/deliverables remain intact.
