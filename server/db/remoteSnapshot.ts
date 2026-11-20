import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');
const GIST_SNAPSHOT_FILE = 'nexa_snapshot.sqlite3.gz.b64';
const GIST_SHA_FILE = 'nexa_snapshot.sha256';
const GIST_META_FILE = 'nexa_snapshot_meta.json';

let lastRemoteSyncAt: string | null = null;
let lastRemoteSyncError: string | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncInFlight: Promise<{ synced: boolean; sha256?: string; sizeBytes?: number; error?: string }> | null = null;

export interface PersistenceModeStatus {
  mode: 'REMOTE_GIST_SYNC' | 'LOCAL_SEEDED_EPHEMERAL';
  gistConfigured: boolean;
  seedBaselinePresent: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

export function isRemoteGistSyncConfigured(): boolean {
  const token = (process.env.NEXA_BACKUP_GIST_TOKEN || '').trim();
  const gistId = (process.env.NEXA_BACKUP_GIST_ID || '').trim();
  return Boolean(token && gistId);
}

export function resolveSeedBaselinePath(): string {
  return path.resolve(process.cwd(), 'deploy/seed/nexa_seed_baseline.sqlite3');
}

export function resolveSeedExportsDir(): string {
  return path.resolve(process.cwd(), 'deploy/seed/exports');
}

export function getPersistenceModeStatus(): PersistenceModeStatus {
  const gistConfigured = isRemoteGistSyncConfigured();
  return {
    mode: gistConfigured ? 'REMOTE_GIST_SYNC' : 'LOCAL_SEEDED_EPHEMERAL',
    gistConfigured,
    seedBaselinePresent: fs.existsSync(resolveSeedBaselinePath()),
    lastSyncAt: lastRemoteSyncAt,
    lastSyncError: lastRemoteSyncError,
  };
}

export function validateSqliteBufferOnDisk(buffer: Buffer): { tableCount: number; sha256: string } {
  if (buffer.length < 16384 || buffer.length > 20 * 1024 * 1024) {
    throw new Error('Invalid SQLite backup file size (must be between 16 KB and 20 MB).');
  }
  if (!buffer.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    throw new Error('Invalid file signature: not a SQLite 3 database.');
  }

  const tmpPath = path.join(os.tmpdir(), `nexa_validate_${crypto.randomUUID()}.sqlite3`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    const db = new DatabaseSync(tmpPath, { readOnly: true });
    try {
      const checkRow = db.prepare('PRAGMA integrity_check;').get() as { integrity_check?: string } | undefined;
      if (String(checkRow?.integrity_check || '').toLowerCase() !== 'ok') {
        throw new Error(`SQLite integrity_check failed: ${checkRow?.integrity_check || 'unknown'}`);
      }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((t) => t.name));
      for (const reqTable of ['users', 'missions', 'phase7_validation_missions', 'phase7_deliverable_packages']) {
        if (!tableNames.has(reqTable)) {
          throw new Error(`Invalid NEXA snapshot: missing core table '${reqTable}'.`);
        }
      }
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      return { tableCount: tableNames.size, sha256 };
    } finally {
      db.close();
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failures
    }
  }
}

async function fetchSnapshotFromGitHubGist(): Promise<Buffer | null> {
  const token = (process.env.NEXA_BACKUP_GIST_TOKEN || '').trim();
  const gistId = (process.env.NEXA_BACKUP_GIST_ID || '').trim();
  if (!token || !gistId) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'NEXA-Quant-Intelligence/7.0',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GitHub Gist fetch failed (${res.status})`);
    }
    const payload = (await res.json()) as {
      files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }>;
    };
    const snapEntry = payload.files?.[GIST_SNAPSHOT_FILE];
    const shaEntry = payload.files?.[GIST_SHA_FILE];
    if (!snapEntry) return null;

    let b64Content = snapEntry.content || '';
    if (snapEntry.truncated && snapEntry.raw_url) {
      const rawRes = await fetch(snapEntry.raw_url, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'NEXA-Quant-Intelligence/7.0' },
        signal: controller.signal,
      });
      if (!rawRes.ok) throw new Error(`GitHub Gist raw fetch failed (${rawRes.status})`);
      b64Content = await rawRes.text();
    }

    if (!b64Content.trim()) return null;
    const gzBytes = Buffer.from(b64Content.trim(), 'base64');
    const sqliteBytes = zlib.gunzipSync(gzBytes);
    const { sha256 } = validateSqliteBufferOnDisk(sqliteBytes);
    const expectedSha = (shaEntry?.content || '').trim().toLowerCase();
    if (expectedSha && expectedSha !== sha256.toLowerCase()) {
      throw new Error('Remote Gist snapshot SHA-256 mismatch.');
    }
    return sqliteBytes;
  } finally {
    clearTimeout(timer);
  }
}

export async function hydrateDbOnStartupIfMissing(targetPath: string, dataDir: string): Promise<void> {
  if (!targetPath || targetPath === ':memory:') return;

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'exports'), { recursive: true });

  // Copy bundled verified exports if not yet present in persistent/runtime data dir
  const seedExportsDir = resolveSeedExportsDir();
  const runtimeExportsDir = path.join(dataDir, 'exports');
  if (fs.existsSync(seedExportsDir)) {
    for (const entry of fs.readdirSync(seedExportsDir)) {
      const srcSub = path.join(seedExportsDir, entry);
      const dstSub = path.join(runtimeExportsDir, entry);
      if (fs.statSync(srcSub).isDirectory() && !fs.existsSync(dstSub)) {
        fs.cpSync(srcSub, dstSub, { recursive: true });
      }
    }
  }

  // Never overwrite an already-present runtime database
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  // 1. Try verified remote GitHub Gist snapshot first (survives container restarts for $0)
  if (isRemoteGistSyncConfigured()) {
    try {
      const remoteBuf = await fetchSnapshotFromGitHubGist();
      if (remoteBuf) {
        const tmpDest = `${targetPath}.hydrating`;
        fs.writeFileSync(tmpDest, remoteBuf);
        fs.renameSync(tmpDest, targetPath);
        lastRemoteSyncAt = new Date().toISOString();
        lastRemoteSyncError = null;
        console.log(`NEXA hydrated SQLite database from remote GitHub Gist snapshot (${remoteBuf.length} bytes).`);
        return;
      }
    } catch (err) {
      lastRemoteSyncError = err instanceof Error ? err.message : 'Remote Gist hydration error';
      console.warn('Remote Gist snapshot hydration skipped/failed; falling back to seed baseline:', lastRemoteSyncError);
    }
  }

  // 2. Fall back to bundled verified baseline snapshot preserving Phase 7 mission + deliverable
  const seedPath = resolveSeedBaselinePath();
  if (fs.existsSync(seedPath)) {
    const seedBytes = fs.readFileSync(seedPath);
    validateSqliteBufferOnDisk(seedBytes);
    const tmpDest = `${targetPath}.seedtmp`;
    fs.writeFileSync(tmpDest, seedBytes);
    fs.renameSync(tmpDest, targetPath);
    console.log(`NEXA hydrated baseline SQLite database from verified seed (${seedBytes.length} bytes).`);
  }
}

export async function pushRemoteSnapshotFromFile(snapshotFilePath: string): Promise<{
  synced: boolean;
  sha256?: string;
  sizeBytes?: number;
  error?: string;
}> {
  if (!isRemoteGistSyncConfigured()) {
    return { synced: false };
  }
  if (syncInFlight) return syncInFlight;

  const token = (process.env.NEXA_BACKUP_GIST_TOKEN || '').trim();
  const gistId = (process.env.NEXA_BACKUP_GIST_ID || '').trim();

  syncInFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const rawBytes = fs.readFileSync(snapshotFilePath);
      const { tableCount, sha256 } = validateSqliteBufferOnDisk(rawBytes);
      const gzB64 = zlib.gzipSync(rawBytes, { level: 9 }).toString('base64');
      const meta = JSON.stringify(
        {
          platform: 'NEXA QUANT INTELLIGENCE',
          syncedAt: new Date().toISOString(),
          sizeBytes: rawBytes.length,
          compressedBase64Bytes: gzB64.length,
          sha256,
          tableCount,
        },
        null,
        2
      );

      const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'NEXA-Quant-Intelligence/7.0',
        },
        body: JSON.stringify({
          files: {
            [GIST_SNAPSHOT_FILE]: { content: gzB64 },
            [GIST_SHA_FILE]: { content: sha256 },
            [GIST_META_FILE]: { content: meta },
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`GitHub Gist PATCH failed (${res.status}): ${bodyText.slice(0, 140)}`);
      }
      lastRemoteSyncAt = new Date().toISOString();
      lastRemoteSyncError = null;
      return { synced: true, sha256, sizeBytes: rawBytes.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Remote Gist sync failed';
      lastRemoteSyncError = message;
      return { synced: false, error: message };
    } finally {
      clearTimeout(timer);
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}

export function scheduleRemoteSnapshotSync(exportFn: () => { backupPath: string }): void {
  if (!isRemoteGistSyncConfigured()) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    try {
      const snap = exportFn();
      void pushRemoteSnapshotFromFile(snap.backupPath);
    } catch (err) {
      lastRemoteSyncError = err instanceof Error ? err.message : 'Scheduled snapshot export failed';
    }
  }, 20000);
  syncTimer.unref();
}

export function stageAndRestoreVerifiedSqlite(
  sqliteBytes: Buffer,
  activeDbFilePath: string,
  safetyBackupFn: () => { backupPath: string },
  closeDbFn: () => void,
  reopenDbFn: () => void
): { tableCount: number; sha256: string; sizeBytes: number; safetyBackupPath: string } {
  if (!activeDbFilePath || activeDbFilePath === ':memory:') {
    throw new Error('Cannot restore binary file into :memory: test database.');
  }

  // 1. Validate candidate buffer in isolation BEFORE stopping or modifying live DB
  const { tableCount, sha256 } = validateSqliteBufferOnDisk(sqliteBytes);

  // 2. Create mandatory pre-restore safety backup of current DB
  const safety = safetyBackupFn();

  const stagedPath = `${activeDbFilePath}.restore_tmp`;
  fs.writeFileSync(stagedPath, sqliteBytes);

  try {
    closeDbFn();
    for (const sidecar of [`${activeDbFilePath}-wal`, `${activeDbFilePath}-shm`]) {
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
    fs.renameSync(stagedPath, activeDbFilePath);
    reopenDbFn();
    return {
      tableCount,
      sha256,
      sizeBytes: sqliteBytes.length,
      safetyBackupPath: safety.backupPath,
    };
  } catch (err) {
    try {
      if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
    } catch {
      // ignore cleanup error
    }
    reopenDbFn();
    throw err;
  }
}
