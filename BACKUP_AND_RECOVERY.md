# NEXA QUANT INTELLIGENCE — Backup & Disaster Recovery

## 1. Database Architecture
NEXA QUANT INTELLIGENCE consolidates all 35 domain tables (`schema_migrations` version 6: missions, steps, agent provenance, bridge links, conversations/messages, research sources/evidence, 7-scope memory, artifacts, RBAC users/sessions, approvals, audit logs, provider settings, model registry/calls, quant datasets/backtests/paper orders, commerce opportunities/audits/customers/proposals/content assets/invoices/payments/ledger/schedules/schedule runs/sites, engineering projects/files/snapshots, test runs, system settings) into a single SQLite database (`NEXA_DB_PATH`, defaulting to `data/nexa_genesis.sqlite3`, or `./Hamdi` when configured in active workspace `.env`) configured with:
- `PRAGMA journal_mode = WAL;`
- `PRAGMA foreign_keys = ON;`
- `PRAGMA busy_timeout = 5000;`
- Versioned schema tracking via `schema_migrations`.

## 2. Creating Verified Backups

### Via Web UI or REST API (Admin / Operator Session)
- **UI**: Navigate to **Settings** -> **Export Verified Backup**.
- **API**: `POST /api/backup`

### What Happens Under the Hood
`exportDatabaseBackup()` in `server/db/database.ts`:
1. Generates a consistent, atomic online snapshot via SQLite `VACUUM INTO 'data/backups/nexa_backup_<timestamp>.sqlite3'`.
2. Computes and returns the full **SHA-256** digest and exact byte size of the snapshot file.
3. Also copy `data/artifacts/` and `workspace_projects/` alongside database backups to preserve generated reports, HTML sites, and sandboxed engineering files.

## 3. Disaster Recovery / Restore Procedure
1. Stop the running Node server cleanly (`SIGTERM`).
2. Verify snapshot integrity before restoring:
   ```bash
   sha256sum data/backups/nexa_backup_<timestamp>.sqlite3
   ```
   Confirm the checksum matches the recorded SHA-256 hash.
3. Move any corrupted active WAL files aside and restore the snapshot:
   ```bash
   rm -f data/nexa_genesis.sqlite3-wal data/nexa_genesis.sqlite3-shm
   cp data/backups/nexa_backup_<timestamp>.sqlite3 data/nexa_genesis.sqlite3
   ```
4. Restart the platform with `NODE_ENV=production npm start` and verify `GET /api/health` returns `status: "OPERATIONAL"` and expected table counts.

## 4. Sandboxed Engineering Project Rollback
Individual projects inside the Software Engineering Studio (`workspace_projects/`) store immutable SHA-256 file snapshots in `engineering_snapshots`:
- From **Engineering Studio**, select any recorded checkpoint in **Snapshots & Rollback** and click **Rollback** (`POST /api/engineering/projects/:id/rollback`) to restore source files atomically both on disk and in SQLite.
