import crypto from 'node:crypto';
import { getDb, nowIso, recordAuditEvent } from '../db/database.ts';
import type { MemoryScope } from '../types/nexa.ts';

export const VALID_MEMORY_SCOPES: MemoryScope[] = [
  'user_preferences',
  'project_knowledge',
  'mission_history',
  'technical_docs',
  'verified_facts',
  'temporary_context',
  'agent_working',
];

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  title: string;
  content: string;
  provenance: string;
  version: number;
  tags: string[];
  retentionDays: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function saveMemoryEntry(params: {
  scope: MemoryScope;
  title: string;
  content: string;
  provenance: string;
  tags?: string[];
  retentionDays?: number | null;
  createdBy?: string | null;
}): { record: MemoryRecord; deduplicated: boolean } {
  if (!VALID_MEMORY_SCOPES.includes(params.scope)) {
    throw new Error(`Invalid memory scope: ${params.scope}`);
  }
  const title = params.title.trim();
  const content = params.content.trim();
  if (!title || content.length < 3) {
    throw new Error('Memory title and content are required.');
  }

  const db = getDb();
  const ts = nowIso();
  const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
  const contentHash = crypto.createHash('sha256').update(`${params.scope}:${normalized}`).digest('hex');

  const existing = db
    .prepare('SELECT * FROM memory_entries WHERE scope = ? AND content_hash = ?')
    .get(params.scope, contentHash) as Record<string, unknown> | undefined;

  if (existing) {
    const newVersion = Number(existing.version || 1) + 1;
    db.prepare('UPDATE memory_entries SET version = ?, title = ?, updated_at = ? WHERE id = ?').run(
      newVersion,
      title,
      ts,
      String(existing.id)
    );
    const updated = getMemoryById(String(existing.id))!;
    return { record: updated, deduplicated: true };
  }

  const id = `mem_${crypto.randomUUID().slice(0, 12)}`;
  db.prepare(
    `INSERT INTO memory_entries
     (id, scope, title, content, content_hash, provenance, version, tags_json, retention_days, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.scope,
    title,
    content,
    contentHash,
    params.provenance.trim() || 'manual',
    JSON.stringify(params.tags || []),
    params.retentionDays ?? null,
    params.createdBy ?? 'operator',
    ts,
    ts
  );

  recordAuditEvent(params.createdBy || 'operator', 'MEMORY', 'MEMORY_SAVED', { id, scope: params.scope, title });
  return { record: getMemoryById(id)!, deduplicated: false };
}

export function getMemoryById(id: string): MemoryRecord | null {
  const row = getDb().prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapMemoryRow(row);
}

export function queryMemory(params?: { scope?: MemoryScope; search?: string; limit?: number }): MemoryRecord[] {
  const db = getDb();
  let rows = db.prepare('SELECT * FROM memory_entries ORDER BY updated_at DESC LIMIT 300').all() as Array<
    Record<string, unknown>
  >;

  if (params?.scope) {
    rows = rows.filter((r) => r.scope === params.scope);
  }
  if (params?.search && params.search.trim()) {
    const q = params.search.trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        String(r.title).toLowerCase().includes(q) ||
        String(r.content).toLowerCase().includes(q) ||
        String(r.tags_json).toLowerCase().includes(q)
    );
  }
  const limit = Math.min(Math.max(params?.limit || 100, 1), 300);
  return rows.slice(0, limit).map(mapMemoryRow);
}

export function deleteMemoryEntry(id: string, actor = 'operator'): boolean {
  const res = getDb().prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
  const deleted = Number(res.changes) > 0;
  if (deleted) {
    recordAuditEvent(actor, 'MEMORY', 'MEMORY_DELETED', { id });
  }
  return deleted;
}

export function purgeExpiredMemory(): number {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, retention_days, created_at FROM memory_entries WHERE retention_days IS NOT NULL')
    .all() as Array<{ id: string; retention_days: number; created_at: string }>;
  const now = Date.now();
  let purged = 0;
  for (const r of rows) {
    const expiresAt = new Date(r.created_at).getTime() + r.retention_days * 86400000;
    if (now > expiresAt) {
      db.prepare('DELETE FROM memory_entries WHERE id = ?').run(r.id);
      purged++;
    }
  }
  return purged;
}

function mapMemoryRow(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    scope: row.scope as MemoryScope,
    title: String(row.title),
    content: String(row.content),
    provenance: String(row.provenance),
    version: Number(row.version),
    tags: JSON.parse(String(row.tags_json || '[]')) as string[],
    retentionDays: row.retention_days !== null && row.retention_days !== undefined ? Number(row.retention_days) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
