import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  getPersistenceModeStatus,
  scheduleRemoteSnapshotSync,
  stageAndRestoreVerifiedSqlite,
  type PersistenceModeStatus,
} from './remoteSnapshot.ts';

export function resolveConfiguredDbPath(): string {
  const configured = (process.env.NEXA_DB_PATH || '').trim();
  if (!configured) return path.resolve(process.cwd(), 'data/nexa_genesis.sqlite3');
  if (configured === ':memory:') return ':memory:';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

export function resolvePersistentDataDir(): string {
  const explicitDataDir = (process.env.NEXA_DATA_DIR || '').trim();
  if (explicitDataDir) {
    return path.isAbsolute(explicitDataDir) ? explicitDataDir : path.resolve(process.cwd(), explicitDataDir);
  }
  const configuredDb = (process.env.NEXA_DB_PATH || '').trim();
  if (configuredDb && configuredDb !== ':memory:') {
    return path.dirname(resolveConfiguredDbPath());
  }
  return path.resolve(process.cwd(), 'data');
}

let dbInstance: DatabaseSync | null = null;
let activeDbPath: string | null = null;

export function nowIso(): string {
  return new Date().toISOString();
}

export function hashPassword(password: string, salt?: string): string {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(password, actualSalt, 120000, 32, 'sha256').toString('hex');
  return `${actualSalt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  const candidate = hashPassword(password, salt);
  const candidateHex = candidate.split(':')[1] || '';
  if (candidateHex.length !== expectedHex.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidateHex, 'hex'), Buffer.from(expectedHex, 'hex'));
}

export function getDb(customPath?: string): DatabaseSync {
  const targetPath = customPath || activeDbPath || resolveConfiguredDbPath();
  if (dbInstance && targetPath === activeDbPath) {
    return dbInstance;
  }

  let preExistingFileSize = 0;
  if (targetPath !== ':memory:') {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (fs.existsSync(targetPath)) {
      preExistingFileSize = fs.statSync(targetPath).size;
    }
  }

  const db = new DatabaseSync(targetPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  if (targetPath !== ':memory:' && preExistingFileSize > 0) {
    const qc = db.prepare('PRAGMA quick_check;').get() as { quick_check?: string } | undefined;
    if (String(qc?.quick_check || '').toLowerCase() !== 'ok') {
      throw new Error(`SQLite quick_check failed for ${path.basename(targetPath)}: ${qc?.quick_check || 'unknown'}`);
    }
  }

  applyMigrations(db, targetPath);
  seedBaselineRecords(db);

  dbInstance = db;
  activeDbPath = targetPath;
  return db;
}

export function resetDbForTests(testDbPath = ':memory:'): DatabaseSync {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore close errors during test teardown
    }
    dbInstance = null;
  }
  activeDbPath = testDbPath;
  return getDb(testDbPath);
}

/**
 * Opens an isolated in-memory SQLite database fixture with identical unified NEXA migrations
 * without touching the singleton activeDbPath / real workspace database.
 */
export function createIsolatedSandboxDatabase(): DatabaseSync {
  const sandboxDb = new DatabaseSync(':memory:');
  sandboxDb.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(sandboxDb);
  seedBaselineRecords(sandboxDb);
  return sandboxDb;
}

export function closeDb(): void {
  if (!dbInstance) return;
  try {
    if (activeDbPath && activeDbPath !== ':memory:') {
      dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    }
    dbInstance.close();
  } catch {
    // ignore errors when closing during process teardown
  } finally {
    dbInstance = null;
  }
}

export function getDatabaseDiagnostics(): {
  persistentFile: boolean;
  exists: boolean;
  sizeBytes: number;
  walMode: boolean;
  configuredViaEnv: boolean;
  directoryCreated: boolean;
  dataDir: string;
  persistence: PersistenceModeStatus;
} {
  const db = getDb();
  const targetPath = activeDbPath || resolveConfiguredDbPath();
  const persistentFile = targetPath !== ':memory:';
  const dirOk = persistentFile ? fs.existsSync(path.dirname(targetPath)) : false;
  const exists = persistentFile ? fs.existsSync(targetPath) : false;
  const sizeBytes = exists ? fs.statSync(targetPath).size : 0;
  const journalRow = db.prepare('PRAGMA journal_mode;').get() as { journal_mode?: string } | undefined;
  return {
    persistentFile,
    exists,
    sizeBytes,
    walMode: String(journalRow?.journal_mode || '').toLowerCase() === 'wal',
    configuredViaEnv: Boolean((process.env.NEXA_DB_PATH || '').trim()),
    directoryCreated: dirOk,
    dataDir: resolvePersistentDataDir(),
    persistence: getPersistenceModeStatus(),
  };
}

function applyMigrations(db: DatabaseSync, dbFilePath = ':memory:'): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => Number(r.version)));

  const latestExpectedVersion = 9;
  const hasPendingUpgrades = applied.size > 0 && Array.from({ length: latestExpectedVersion }, (_, i) => i + 1).some((v) => !applied.has(v));
  if (hasPendingUpgrades && dbFilePath !== ':memory:' && fs.existsSync(dbFilePath)) {
    const backupDir = path.join(resolvePersistentDataDir(), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preMigrationBackup = path.join(backupDir, `nexa_pre_migration_${stamp}.sqlite3`);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec(`VACUUM INTO '${preMigrationBackup.replace(/'/g, "''")}'`);
  }

  const migrations: Array<{ version: number; name: string; sql: string }> = [
    {
      version: 1,
      name: 'initial_unified_nexa_genesis_schema',
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','operator','researcher','viewer')),
          password_hash TEXT NOT NULL,
          preferred_language TEXT NOT NULL DEFAULT 'en',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          token_hash TEXT UNIQUE NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS missions (
          id TEXT PRIMARY KEY,
          objective TEXT NOT NULL,
          domain TEXT NOT NULL DEFAULT 'general',
          status TEXT NOT NULL CHECK(status IN ('CREATED','PLANNED','RUNNING','AWAITING_APPROVAL','REVIEWING','COMPLETED','FAILED','BLOCKED','CANCELLED')),
          priority TEXT NOT NULL DEFAULT 'normal',
          created_by TEXT,
          requires_approval INTEGER NOT NULL DEFAULT 1,
          paid_fallback_allowed INTEGER NOT NULL DEFAULT 0,
          plan_json TEXT,
          final_synthesis TEXT,
          verification_summary TEXT,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS mission_steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT NOT NULL,
          step_order INTEGER NOT NULL,
          agent_id TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          required INTEGER NOT NULL DEFAULT 1,
          started_at TEXT,
          completed_at TEXT,
          FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          status TEXT NOT NULL,
          input_json TEXT,
          output_json TEXT,
          output_text TEXT,
          error_message TEXT,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          tokens_in INTEGER NOT NULL DEFAULT 0,
          tokens_out INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          is_mock INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY,
          source_type TEXT NOT NULL,
          title TEXT NOT NULL,
          url TEXT,
          authors TEXT,
          published_at TEXT,
          abstract TEXT,
          retrieval_status TEXT NOT NULL,
          raw_metadata_json TEXT,
          retrieved_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT,
          source_id TEXT,
          source_label TEXT,
          claim TEXT NOT NULL,
          evidence_type TEXT NOT NULL CHECK(evidence_type IN ('verified','hypothesis','assumption','unknown')),
          confidence REAL,
          contradiction_flag INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE,
          FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS approvals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT,
          category TEXT NOT NULL,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
          requested_by TEXT,
          decided_by TEXT,
          decision_note TEXT,
          created_at TEXT NOT NULL,
          decided_at TEXT,
          FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          mission_id TEXT,
          subsystem TEXT NOT NULL,
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          file_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS memory_entries (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK(scope IN ('user_preferences','project_knowledge','mission_history','technical_docs','verified_facts','temporary_context','agent_working')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          provenance TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          tags_json TEXT NOT NULL DEFAULT '[]',
          retention_days INTEGER,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS provider_settings (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          env_var TEXT NOT NULL,
          protocol TEXT NOT NULL,
          is_paid_by_default INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          cooldown_until INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          last_verified_at TEXT
        );

        CREATE TABLE IF NOT EXISTS model_registry (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          context_window INTEGER NOT NULL,
          input_modalities_json TEXT NOT NULL,
          output_modalities_json TEXT NOT NULL,
          supports_tools INTEGER NOT NULL DEFAULT 0,
          supports_json INTEGER NOT NULL DEFAULT 1,
          prompt_price_per_million REAL NOT NULL DEFAULT 0,
          completion_price_per_million REAL NOT NULL DEFAULT 0,
          free_verified INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          recommended_tasks_json TEXT NOT NULL,
          latency_avg_ms REAL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS model_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          task_class TEXT NOT NULL,
          status TEXT NOT NULL,
          latency_ms INTEGER NOT NULL,
          tokens_in INTEGER NOT NULL DEFAULT 0,
          tokens_out INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          is_mock INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'en',
          user_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
          content TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'en',
          provider_id TEXT,
          model_id TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT,
          actor TEXT NOT NULL,
          category TEXT NOT NULL,
          event TEXT NOT NULL,
          details_json TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bridge_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT NOT NULL,
          commerce_task_id TEXT NOT NULL,
          objective TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS quant_datasets (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          timeframe TEXT NOT NULL,
          source_type TEXT NOT NULL,
          bar_count INTEGER NOT NULL,
          quality_report_json TEXT NOT NULL,
          bars_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS quant_backtests (
          id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          strategy_name TEXT NOT NULL,
          params_json TEXT NOT NULL,
          metrics_json TEXT NOT NULL,
          walk_forward_json TEXT NOT NULL,
          monte_carlo_json TEXT NOT NULL,
          sensitivity_json TEXT NOT NULL,
          equity_curve_json TEXT NOT NULL,
          trades_json TEXT NOT NULL,
          report_markdown TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(dataset_id) REFERENCES quant_datasets(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS quant_paper_orders (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
          quantity REAL NOT NULL,
          entry_price REAL NOT NULL,
          stop_loss REAL NOT NULL,
          take_profit REAL,
          risk_usd REAL NOT NULL,
          status TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'PAPER_ONLY',
          notes TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS commerce_opportunities (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          target_market TEXT NOT NULL,
          problem_statement TEXT NOT NULL,
          estimated_effort_hours REAL NOT NULL,
          revenue_model TEXT NOT NULL,
          validation_score REAL NOT NULL,
          status TEXT NOT NULL,
          evidence_notes TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS commerce_customers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          company TEXT,
          email TEXT,
          channel TEXT NOT NULL,
          stage TEXT NOT NULL,
          notes TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS commerce_invoices (
          id TEXT PRIMARY KEY,
          customer_id TEXT,
          title TEXT NOT NULL,
          currency TEXT NOT NULL DEFAULT 'EUR',
          amount REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'DRAFT',
          fiscal_disclaimer TEXT NOT NULL DEFAULT 'DRAFT — NOT A FISCAL INVOICE',
          approval_id INTEGER,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS commerce_sites (
          id TEXT PRIMARY KEY,
          brand_name TEXT NOT NULL,
          tagline TEXT NOT NULL,
          language TEXT NOT NULL,
          template TEXT NOT NULL,
          artifact_id TEXT,
          html_content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'DRAFT',
          approval_id INTEGER,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS engineering_projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          stack TEXT NOT NULL,
          objective TEXT NOT NULL,
          workspace_rel_path TEXT NOT NULL,
          status TEXT NOT NULL,
          files_json TEXT NOT NULL,
          last_build_log TEXT,
          last_test_status TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS engineering_snapshots (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          label TEXT NOT NULL,
          files_json TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES engineering_projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS test_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          suite TEXT NOT NULL,
          passed INTEGER NOT NULL,
          failed INTEGER NOT NULL,
          total INTEGER NOT NULL,
          output TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS system_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `,
    },
    {
      version: 2,
      name: '002_autonomous_commerce_mvp',
      sql: `
        CREATE TABLE IF NOT EXISTS commerce_presence_audits (
          id TEXT PRIMARY KEY,
          customer_id TEXT,
          target_url TEXT NOT NULL,
          http_status INTEGER,
          load_time_ms INTEGER,
          has_ssl INTEGER NOT NULL DEFAULT 0,
          has_title INTEGER NOT NULL DEFAULT 0,
          has_meta_desc INTEGER NOT NULL DEFAULT 0,
          has_viewport INTEGER NOT NULL DEFAULT 0,
          has_contact_cta INTEGER NOT NULL DEFAULT 0,
          detected_gaps_json TEXT NOT NULL DEFAULT '[]',
          digital_readiness_score INTEGER NOT NULL DEFAULT 0,
          source_mode TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS commerce_proposals (
          id TEXT PRIMARY KEY,
          opportunity_id TEXT,
          customer_id TEXT,
          site_id TEXT,
          artifact_id TEXT,
          title TEXT NOT NULL,
          client_name TEXT NOT NULL,
          pricing_tier TEXT NOT NULL,
          setup_price_eur REAL NOT NULL,
          monthly_retainer_eur REAL NOT NULL DEFAULT 0,
          estimated_delivery_cost_eur REAL NOT NULL,
          estimated_margin_eur REAL NOT NULL,
          deliverables_json TEXT NOT NULL DEFAULT '[]',
          outreach_subject TEXT NOT NULL,
          outreach_body TEXT NOT NULL,
          follow_up_plan_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','SENT','WON','LOST')),
          approval_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS commerce_financial_ledger (
          id TEXT PRIMARY KEY,
          entry_type TEXT NOT NULL CHECK(entry_type IN ('REVENUE','OPERATING_COST')),
          category TEXT NOT NULL,
          amount_eur REAL NOT NULL,
          currency TEXT NOT NULL DEFAULT 'EUR',
          proposal_id TEXT,
          invoice_id TEXT,
          verified_payment INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          recorded_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS commerce_content_assets (
          id TEXT PRIMARY KEY,
          opportunity_id TEXT,
          customer_id TEXT,
          channel TEXT NOT NULL CHECK(channel IN ('LANDING_COPY','EMAIL_OUTREACH','FOLLOW_UP_SEQ','LINKEDIN_POST')),
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'en',
          status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED')),
          approval_id INTEGER,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS commerce_schedules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          workflow_type TEXT NOT NULL CHECK(workflow_type IN ('DAILY_OPPORTUNITY_DISCOVERY','DAILY_BUSINESS_REPORT')),
          cron_description TEXT NOT NULL,
          interval_minutes INTEGER NOT NULL DEFAULT 1440,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at TEXT,
          next_run_at TEXT NOT NULL,
          last_status TEXT,
          last_summary TEXT,
          failure_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS commerce_schedule_runs (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED','SKIPPED')),
          items_processed INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          report_artifact_id TEXT,
          summary TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY(schedule_id) REFERENCES commerce_schedules(id) ON DELETE CASCADE
        );
      `,
    },
  ];

  for (const m of migrations) {
    if (!applied.has(m.version)) {
      db.exec('BEGIN;');
      try {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          nowIso()
        );
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    }
  }

  if (!applied.has(3)) {
    db.exec('BEGIN;');
    try {
      addColumnIfMissing(db, 'commerce_schedules', 'lock_owner', 'TEXT');
      addColumnIfMissing(db, 'commerce_schedules', 'locked_until', 'TEXT');
      addColumnIfMissing(db, 'commerce_schedules', 'missed_runs_recovered', 'INTEGER NOT NULL DEFAULT 0');

      addColumnIfMissing(db, 'commerce_opportunities', 'business_name', 'TEXT');
      addColumnIfMissing(db, 'commerce_opportunities', 'city', 'TEXT');
      addColumnIfMissing(db, 'commerce_opportunities', 'address', 'TEXT');
      addColumnIfMissing(db, 'commerce_opportunities', 'website_url', 'TEXT');
      addColumnIfMissing(db, 'commerce_opportunities', 'public_source_url', 'TEXT');
      addColumnIfMissing(db, 'commerce_opportunities', 'website_status', "TEXT NOT NULL DEFAULT 'UNKNOWN'");
      addColumnIfMissing(db, 'commerce_opportunities', 'audit_id', 'TEXT');
      addColumnIfMissing(db, 'commerce_opportunities', 'priority_score', 'REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'commerce_opportunities', 'priority_tier', "TEXT NOT NULL DEFAULT 'P3_NURTURE'");
      addColumnIfMissing(db, 'commerce_opportunities', 'customer_id', 'TEXT');
      addColumnIfMissing(db, 'commerce_opportunities', 'site_id', 'TEXT');
      addColumnIfMissing(db, 'commerce_opportunities', 'proposal_id', 'TEXT');

      addColumnIfMissing(db, 'commerce_customers', 'opportunity_id', 'TEXT');
      addColumnIfMissing(db, 'commerce_customers', 'website_url', 'TEXT');
      addColumnIfMissing(db, 'commerce_customers', 'public_source_url', 'TEXT');
      addColumnIfMissing(db, 'commerce_customers', 'phone', 'TEXT');
      addColumnIfMissing(db, 'commerce_customers', 'address', 'TEXT');
      addColumnIfMissing(db, 'commerce_customers', 'priority_score', 'REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'commerce_customers', 'reply_status', "TEXT NOT NULL DEFAULT 'NONE'");
      addColumnIfMissing(db, 'commerce_customers', 'reply_notes', 'TEXT');
      addColumnIfMissing(db, 'commerce_customers', 'replied_at', 'TEXT');
      addColumnIfMissing(db, 'commerce_customers', 'last_contacted_at', 'TEXT');

      addColumnIfMissing(db, 'commerce_financial_ledger', 'customer_id', 'TEXT');

      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        3,
        '003_production_scheduler_and_first_revenue',
        nowIso()
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  if (!applied.has(4)) {
    db.exec('BEGIN;');
    try {
      addColumnIfMissing(db, 'commerce_opportunities', 'confidence_score', 'REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'commerce_opportunities', 'verification_status', "TEXT NOT NULL DEFAULT 'UNVERIFIED'");
      addColumnIfMissing(db, 'commerce_opportunities', 'is_chain_or_enterprise', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'commerce_opportunities', 'verification_evidence_json', "TEXT NOT NULL DEFAULT '{}'");
      addColumnIfMissing(db, 'commerce_opportunities', 'qualification_decision', "TEXT NOT NULL DEFAULT 'REVIEW'");

      addColumnIfMissing(db, 'commerce_customers', 'verification_status', "TEXT NOT NULL DEFAULT 'UNVERIFIED'");
      addColumnIfMissing(db, 'commerce_customers', 'confidence_score', 'REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'commerce_customers', 'is_chain_or_enterprise', 'INTEGER NOT NULL DEFAULT 0');

      addColumnIfMissing(db, 'commerce_proposals', 'proposal_note', 'TEXT');

      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        4,
        '004_evidence_confidence_and_verification',
        nowIso()
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  if (!applied.has(5)) {
    db.exec('BEGIN;');
    try {
      addColumnIfMissing(db, 'commerce_proposals', 'whatsapp_message', 'TEXT');
      addColumnIfMissing(db, 'commerce_proposals', 'commercial_terms_json', 'TEXT');

      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        5,
        '005_outreach_whatsapp_and_commercial_terms',
        nowIso()
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  if (!applied.has(6)) {
    // SQLite requires foreign_keys = OFF outside transaction when swapping table schema safely
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN;');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS missions_v6 (
          id TEXT PRIMARY KEY,
          objective TEXT NOT NULL,
          domain TEXT NOT NULL DEFAULT 'general',
          status TEXT NOT NULL CHECK(status IN ('CREATED','PLANNED','RUNNING','PAUSED','RETRYING','AWAITING_APPROVAL','REVIEWING','COMPLETED','FAILED','BLOCKED','CANCELLED')),
          priority TEXT NOT NULL DEFAULT 'normal',
          created_by TEXT,
          requires_approval INTEGER NOT NULL DEFAULT 1,
          paid_fallback_allowed INTEGER NOT NULL DEFAULT 0,
          plan_json TEXT,
          final_synthesis TEXT,
          verification_summary TEXT,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 2,
          failure_classification TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );

        INSERT INTO missions_v6 (
          id, objective, domain, status, priority, created_by, requires_approval,
          paid_fallback_allowed, plan_json, final_synthesis, verification_summary,
          total_tokens, total_cost_usd, created_at, updated_at, completed_at
        )
        SELECT
          id, objective, domain, status, priority, created_by, requires_approval,
          paid_fallback_allowed, plan_json, final_synthesis, verification_summary,
          total_tokens, total_cost_usd, created_at, updated_at, completed_at
        FROM missions;

        DROP TABLE missions;
        ALTER TABLE missions_v6 RENAME TO missions;
      `);

      addColumnIfMissing(db, 'mission_steps', 'retry_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'mission_steps', 'failure_classification', 'TEXT');
      addColumnIfMissing(db, 'mission_steps', 'last_error', 'TEXT');

      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        6,
        '006_kernel_pause_retry_resilience',
        nowIso()
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  if (!applied.has(7)) {
    db.exec('BEGIN;');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_business_plans (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          opportunity_id TEXT,
          executive_summary TEXT NOT NULL,
          feasibility_score REAL NOT NULL,
          unit_economics_json TEXT NOT NULL,
          strategic_milestones_json TEXT NOT NULL,
          assumptions_json TEXT NOT NULL,
          environment_mode TEXT NOT NULL DEFAULT 'SANDBOX',
          created_at TEXT NOT NULL,
          FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS commerce_risk_evaluations (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          opportunity_id TEXT,
          compliance_status TEXT NOT NULL,
          risk_score REAL NOT NULL,
          external_actions_denied INTEGER NOT NULL DEFAULT 1,
          findings_json TEXT NOT NULL,
          mitigations_json TEXT NOT NULL,
          environment_mode TEXT NOT NULL DEFAULT 'SANDBOX',
          created_at TEXT NOT NULL,
          FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS commerce_sandbox_results (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          environment_mode TEXT NOT NULL DEFAULT 'SANDBOX',
          status TEXT NOT NULL,
          current_stage TEXT NOT NULL,
          stages_json TEXT NOT NULL,
          blocked_external_actions_json TEXT NOT NULL,
          simulated_metrics_json TEXT NOT NULL,
          final_report_markdown TEXT,
          error_message TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE
        );
      `);

      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        7,
        '007_commerce_plans_risk_and_sandbox_tables',
        nowIso()
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  if (!applied.has(8)) {
    db.exec('BEGIN TRANSACTION;');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS phase7_validation_missions (
          id TEXT PRIMARY KEY,
          niche TEXT NOT NULL,
          market TEXT NOT NULL,
          target_url TEXT,
          mode TEXT NOT NULL CHECK(mode IN ('LIVE_RESEARCH','FIXTURE_SIMULATION')),
          research_status TEXT NOT NULL CHECK(research_status IN ('VERIFIED_LIVE','PARTIAL_LIVE','BLOCKED','UNVERIFIED','SIMULATED_FIXTURE')),
          selected_opportunity_id TEXT,
          selected_deliverable_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('CREATED','RESEARCHED','SCORED','VALIDATED','QA_REJECTED','READY_FOR_REVIEW','BLOCKED','FAILED')),
          max_cost_usd REAL NOT NULL,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          total_requests INTEGER NOT NULL DEFAULT 0,
          retries_used INTEGER NOT NULL DEFAULT 0,
          provider_used TEXT,
          limitations_json TEXT NOT NULL DEFAULT '[]',
          error_message TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS phase7_research_sources (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          source_url TEXT,
          source_title TEXT NOT NULL,
          source_provider TEXT NOT NULL,
          retrieved_at TEXT NOT NULL,
          relevant_evidence TEXT NOT NULL,
          evidence_classification TEXT NOT NULL CHECK(evidence_classification IN ('VERIFIED_SOURCE_DATA','AI_INFERENCE','UNVERIFIED_CLAIM','SIMULATED_DATA')),
          confidence REAL NOT NULL,
          limitations TEXT NOT NULL,
          is_valid INTEGER NOT NULL DEFAULT 1,
          FOREIGN KEY(mission_id) REFERENCES phase7_validation_missions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS phase7_opportunity_scores (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          title TEXT NOT NULL,
          customer_segment TEXT NOT NULL,
          service_category TEXT NOT NULL,
          problem_statement TEXT NOT NULL,
          proposed_solution TEXT NOT NULL,
          value_thesis TEXT NOT NULL,
          criteria_json TEXT NOT NULL,
          total_score REAL NOT NULL,
          evidence_confidence REAL NOT NULL,
          supporting_source_ids_json TEXT NOT NULL DEFAULT '[]',
          assumptions_json TEXT NOT NULL DEFAULT '[]',
          risks_json TEXT NOT NULL DEFAULT '[]',
          estimated_effort_hours REAL NOT NULL,
          estimated_operating_cost_eur REAL NOT NULL,
          is_selected INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY(mission_id) REFERENCES phase7_validation_missions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS phase7_deliverable_packages (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          opportunity_id TEXT NOT NULL,
          revision_number INTEGER NOT NULL DEFAULT 1,
          generator_agent_id TEXT NOT NULL,
          qa_reviewer_agent_id TEXT,
          qa_status TEXT NOT NULL CHECK(qa_status IN ('PENDING','READY','NEEDS_REVISION','BLOCKED')),
          qa_score REAL NOT NULL DEFAULT 0,
          qa_report_json TEXT,
          package_json TEXT NOT NULL,
          deliverable_html TEXT NOT NULL,
          presentation_markdown TEXT NOT NULL,
          revision_notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(mission_id) REFERENCES phase7_validation_missions(id) ON DELETE CASCADE,
          FOREIGN KEY(opportunity_id) REFERENCES phase7_opportunity_scores(id) ON DELETE CASCADE
        );
      `);

      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        8,
        '008_phase7_real_world_validation',
        nowIso()
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  if (!applied.has(9)) {
    db.exec('BEGIN;');
    try {
      addColumnIfMissing(db, 'phase7_validation_missions', 'checkpoint_json', 'TEXT');
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        9,
        '009_phase7_resumable_checkpoints',
        nowIso()
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function seedBaselineRecords(db: DatabaseSync): void {
  const ts = nowIso();

  // Seed default RBAC role accounts (non-production defaults; password configurable via env)
  const existingUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;
  const envAdminPass = (process.env.NEXA_ADMIN_PASSWORD || process.env.NEXA_DEFAULT_ADMIN_PASSWORD || '').trim();
  if (existingUsers === 0) {
    const insertUser = db.prepare(
      'INSERT INTO users (id, username, display_name, role, password_hash, preferred_language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const defaultPass = envAdminPass || 'nexa-operator-local';
    insertUser.run('usr_admin', 'admin', 'NEXA Lead Architect', 'admin', hashPassword(defaultPass), 'en', ts, ts);
    insertUser.run('usr_operator', 'operator', 'NEXA Mission Operator', 'operator', hashPassword(defaultPass), 'en', ts, ts);
    insertUser.run('usr_researcher', 'researcher', 'NEXA Quant Researcher', 'researcher', hashPassword(defaultPass), 'en', ts, ts);
    insertUser.run('usr_viewer', 'viewer', 'NEXA Audit Observer', 'viewer', hashPassword(defaultPass), 'en', ts, ts);
  } else if (envAdminPass.length >= 6) {
    const adminRow = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get('usr_admin') as
      | { id: string; password_hash: string }
      | undefined;
    if (adminRow && !verifyPassword(envAdminPass, adminRow.password_hash)) {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(envAdminPass), ts, 'usr_admin');
    }
    if (process.env.NODE_ENV === 'production' && envAdminPass.length >= 12) {
      for (const secondaryId of ['usr_operator', 'usr_researcher', 'usr_viewer']) {
        const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(secondaryId) as
          | { password_hash: string }
          | undefined;
        if (row && verifyPassword('nexa-operator-local', row.password_hash)) {
          const rotated = hashPassword(crypto.randomBytes(24).toString('hex'));
          db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(rotated, ts, secondaryId);
        }
      }
    }
  }

  // Seed core system safety settings
  const insertSetting = db.prepare('INSERT OR IGNORE INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)');
  insertSetting.run('automatic_paid_fallback', JSON.stringify(process.env.NEXA_PAID_FALLBACK_ALLOWED === 'true'), ts);
  insertSetting.run('live_trading_enabled', JSON.stringify(false), ts);
  insertSetting.run('external_commerce_enabled', JSON.stringify(false), ts);
  insertSetting.run('human_approval_required', JSON.stringify(true), ts);
  insertSetting.run('default_language', JSON.stringify('en'), ts);
  insertSetting.run('max_cost_per_mission_usd', JSON.stringify(0.0), ts);

  // Seed continuous commercial scheduler workflows (idle until run; zero fake leads/revenues)
  const insertSched = db.prepare(
    `INSERT OR IGNORE INTO commerce_schedules
     (id, name, workflow_type, cron_description, interval_minutes, enabled, next_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  );
  const nextDaily = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  insertSched.run(
    'sched_daily_discovery',
    'Daily SMB Opportunity Signal Scan',
    'DAILY_OPPORTUNITY_DISCOVERY',
    'Every 24 hours (08:00 UTC)',
    1440,
    nextDaily,
    ts
  );
  insertSched.run(
    'sched_daily_report',
    'Daily Commerce Performance & Financial Truth Report',
    'DAILY_BUSINESS_REPORT',
    'Every 24 hours (20:00 UTC)',
    1440,
    nextDaily,
    ts
  );
}

export function exportDatabaseBackup(): { backupPath: string; sha256: string; sizeBytes: number } {
  const db = getDb();
  const backupDir = path.join(resolvePersistentDataDir(), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `nexa_backup_${stamp}.sqlite3`);

  if (activeDbPath === ':memory:') {
    // Export JSON snapshot if running in-memory tests
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (r) => r.name
    );
    const snapshot: Record<string, unknown> = {};
    for (const t of tables) {
      snapshot[t] = db.prepare(`SELECT * FROM ${t}`).all();
    }
    const jsonPath = path.join(backupDir, `nexa_backup_${stamp}.json`);
    const payload = JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(jsonPath, payload, 'utf-8');
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
    return { backupPath: jsonPath, sha256, sizeBytes: Buffer.byteLength(payload) };
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  const bytes = fs.readFileSync(backupPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { backupPath, sha256, sizeBytes: bytes.length };
}

export interface BackupEntrySummary {
  filename: string;
  sizeBytes: number;
  sha256: string;
  modifiedAt: string;
}

export function listDatabaseBackups(): BackupEntrySummary[] {
  const backupDir = path.join(resolvePersistentDataDir(), 'backups');
  if (!fs.existsSync(backupDir)) return [];
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.sqlite3') || f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 30);

  return files.map((filename) => {
    const full = path.join(backupDir, filename);
    const stat = fs.statSync(full);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    return {
      filename,
      sizeBytes: stat.size,
      sha256,
      modifiedAt: stat.mtime.toISOString(),
    };
  });
}

export function verifyDatabaseBackup(filename: string): {
  filename: string;
  valid: boolean;
  integrityCheck: string;
  tableCount: number;
  sha256: string;
  sizeBytes: number;
} {
  const backupDir = path.join(resolvePersistentDataDir(), 'backups');
  const safeName = path.basename(filename);
  if (!safeName || safeName !== filename) {
    throw new Error('Invalid backup filename');
  }
  const fullPath = path.resolve(backupDir, safeName);
  if (!fullPath.startsWith(backupDir + path.sep) || !fs.existsSync(fullPath)) {
    throw new Error(`Backup file not found: ${safeName}`);
  }
  const bytes = fs.readFileSync(fullPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  if (safeName.endsWith('.json')) {
    const parsed = JSON.parse(bytes.toString('utf-8')) as Record<string, unknown>;
    const tableCount = Object.keys(parsed).length;
    return { filename: safeName, valid: tableCount > 0, integrityCheck: 'ok (json snapshot)', tableCount, sha256, sizeBytes: bytes.length };
  }

  const roDb = new DatabaseSync(fullPath, { readOnly: true });
  try {
    const checkRow = roDb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string } | undefined;
    const integrityCheck = checkRow?.integrity_check || 'unknown';
    const tablesRow = roDb.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table'").get() as { cnt: number };
    return {
      filename: safeName,
      valid: integrityCheck === 'ok' && Number(tablesRow.cnt) >= 25,
      integrityCheck,
      tableCount: Number(tablesRow.cnt),
      sha256,
      sizeBytes: bytes.length,
    };
  } finally {
    roDb.close();
  }
}

export function restoreDatabaseFromBuffer(sqliteBytes: Buffer): {
  tableCount: number;
  sha256: string;
  sizeBytes: number;
  safetyBackupPath: string;
} {
  const targetPath = activeDbPath || resolveConfiguredDbPath();
  return stageAndRestoreVerifiedSqlite(
    sqliteBytes,
    targetPath,
    () => exportDatabaseBackup(),
    () => closeDb(),
    () => {
      getDb(targetPath);
    }
  );
}

export function recordAuditEvent(actor: string, category: string, event: string, details: unknown = null, missionId: string | null = null): void {
  const db = getDb();
  db.prepare('INSERT INTO audit_events (mission_id, actor, category, event, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    missionId,
    actor,
    category,
    event,
    details ? JSON.stringify(details) : null,
    nowIso()
  );
  if (activeDbPath && activeDbPath !== ':memory:' && category !== 'AUTH') {
    scheduleRemoteSnapshotSync(exportDatabaseBackup);
  }
}
