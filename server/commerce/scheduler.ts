import crypto from 'node:crypto';
import os from 'node:os';
import { getDb, nowIso, recordAuditEvent } from '../db/database.ts';
import { saveArtifact } from '../kernel/masterKernel.ts';
import { searchPublicWebSignals } from '../research/researchEngine.ts';
import { getCommerceTruthMetrics } from './commerceEngine.ts';

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerActive = false;
const activeInProcessSchedules = new Set<string>();
const INSTANCE_ID = `${os.hostname()}-${process.pid}`;
const LEASE_DURATION_MS = 5 * 60 * 1000;

export function getSchedulerArchitectureEvaluation() {
  const tokenConfigured = (process.env.NEXA_SCHEDULER_TOKEN || '').trim().length >= 24;
  return {
    recommendedPattern: 'CLOUD_SCHEDULER_HTTP_TRIGGER_WITH_DB_LEASE',
    executionArchitecture: {
      inProcessScheduler: {
        mechanism: 'setInterval (60000ms) inside server.ts',
        limitation: 'Runs only while container instance stays warm; stops when Cloud Run scales to zero.',
      },
      persistentSqliteJobQueue: {
        tables: ['commerce_schedules', 'commerce_schedule_runs'],
        leaseDurationMs: LEASE_DURATION_MS,
        startupRecovery: 'recoverStaleScheduleLocks() recovers expired leases + missed due schedules on boot',
        duplicatePrevention: 'Atomic SQLite lease lock UPDATE ... WHERE locked_until IS NULL OR locked_until <= now',
      },
      externalCloudSchedulerHttp: {
        endpoint: '/api/commerce/schedules/run-due',
        method: 'POST',
        recommendedSchedule: '0 */6 * * * (Europe/Rome)',
        retryPolicy: {
          maxRetryAttempts: 3,
          minBackoffSeconds: 30,
          maxBackoffSeconds: 300,
          attemptDeadlineSeconds: 180,
          concurrencyLimit: 1,
        },
      },
    },
    cloudSchedulerHttpTrigger: {
      endpoint: '/api/commerce/schedules/run-due',
      method: 'POST',
      authMode: 'NEXA_SCHEDULER_TOKEN (Bearer / x-nexa-scheduler-token) or RBAC Operator/Admin',
      tokenConfigured,
      pros: [
        'Works reliably with Cloud Run scale-to-zero (min-instances=0) — wakes container only on schedule',
        'Zero idle compute cost between 24h discovery/reporting runs',
        'Atomic SQLite lease lock prevents duplicate runs across retries or multiple instances',
      ],
      cons: ['Cold start latency (~1–2s) on first tick when scaled to zero'],
    },
    cloudRunMinInstances: {
      inProcessIntervalMs: 60000,
      pros: ['Sub-second tick latency via in-process setInterval', 'Zero cold-start delay'],
      cons: [
        'Requires min-instances>=1 billing continuously 24/7',
        'Must still pair with DB lease locks during rolling deployments to prevent double runs',
      ],
    },
  };
}

export function listSchedulesWithRuns() {
  const db = getDb();
  const schedules = db.prepare('SELECT * FROM commerce_schedules ORDER BY id ASC').all();
  const recentRuns = db.prepare('SELECT * FROM commerce_schedule_runs ORDER BY started_at DESC LIMIT 30').all();
  return {
    schedulerRunningInProcess: schedulerActive,
    instanceId: INSTANCE_ID,
    architectureEvaluation: getSchedulerArchitectureEvaluation(),
    schedules,
    recentRuns,
  };
}

export function setScheduleEnabled(scheduleId: string, enabled: boolean) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM commerce_schedules WHERE id = ?').get(scheduleId);
  if (!row) throw new Error('Schedule not found.');
  db.prepare('UPDATE commerce_schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, scheduleId);
  recordAuditEvent('operator', 'SCHEDULER', enabled ? 'SCHEDULE_ENABLED' : 'SCHEDULE_PAUSED', { scheduleId });
  return db.prepare('SELECT * FROM commerce_schedules WHERE id = ?').get(scheduleId);
}

export function recoverStaleScheduleLocks(): { recoveredLocks: number } {
  const db = getDb();
  const now = nowIso();
  const staleSchedules = db
    .prepare('SELECT id, lock_owner, locked_until FROM commerce_schedules WHERE locked_until IS NOT NULL AND locked_until <= ?')
    .all(now) as Array<{ id: string; lock_owner: string | null; locked_until: string }>;

  if (staleSchedules.length === 0) return { recoveredLocks: 0 };

  for (const s of staleSchedules) {
    db.prepare(
      `UPDATE commerce_schedule_runs
       SET status = 'FAILED', error_message = ?, summary = ?, completed_at = ?
       WHERE schedule_id = ? AND status = 'RUNNING'`
    ).run(
      `Recovered stale execution lease from ${s.lock_owner || 'previous worker'}`,
      'Stale RUNNING execution recovered cleanly after lease expiry.',
      now,
      s.id
    );
    db.prepare('UPDATE commerce_schedules SET lock_owner = NULL, locked_until = NULL WHERE id = ?').run(s.id);
    recordAuditEvent('commerce_scheduler', 'SCHEDULER', 'STALE_LOCK_RECOVERED', {
      scheduleId: s.id,
      previousOwner: s.lock_owner,
    });
  }

  return { recoveredLocks: staleSchedules.length };
}

function tryAcquireScheduleLease(scheduleId: string): boolean {
  if (activeInProcessSchedules.has(scheduleId)) {
    return false;
  }
  const db = getDb();
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  const result = db
    .prepare(
      `UPDATE commerce_schedules
       SET lock_owner = ?, locked_until = ?
       WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?)`
    )
    .run(INSTANCE_ID, leaseUntil, scheduleId, now);

  if (Number(result.changes || 0) === 0) {
    return false;
  }
  activeInProcessSchedules.add(scheduleId);
  return true;
}

function releaseScheduleLease(scheduleId: string): void {
  activeInProcessSchedules.delete(scheduleId);
  try {
    getDb()
      .prepare('UPDATE commerce_schedules SET lock_owner = NULL, locked_until = NULL WHERE id = ? AND lock_owner = ?')
      .run(scheduleId, INSTANCE_ID);
  } catch {
    // ignore shutdown release errors
  }
}

export async function executeScheduleById(scheduleId: string, options?: { missedRecovery?: boolean; triggerSource?: string }) {
  const db = getDb();
  const sched = db.prepare('SELECT * FROM commerce_schedules WHERE id = ?').get(scheduleId) as
    | {
        id: string;
        name: string;
        workflow_type: 'DAILY_OPPORTUNITY_DISCOVERY' | 'DAILY_BUSINESS_REPORT';
        interval_minutes: number;
        enabled: number;
        failure_count: number;
        next_run_at: string;
      }
    | undefined;

  if (!sched) throw new Error('Schedule not found.');

  recoverStaleScheduleLocks();

  if (!tryAcquireScheduleLease(scheduleId)) {
    const runId = `skip_${crypto.randomUUID().slice(0, 8)}`;
    const ts = nowIso();
    const msg = `Skipped duplicate concurrent execution for ${scheduleId} (active lock held).`;
    db.prepare(
      `INSERT INTO commerce_schedule_runs (id, schedule_id, status, items_processed, summary, started_at, completed_at)
       VALUES (?, ?, 'SKIPPED', 0, ?, ?, ?)`
    ).run(runId, sched.id, msg, ts, ts);
    recordAuditEvent('commerce_scheduler', 'SCHEDULER', 'CONCURRENT_RUN_SKIPPED', { scheduleId, runId });
    return db.prepare('SELECT * FROM commerce_schedule_runs WHERE id = ?').get(runId);
  }

  const runId = `run_${crypto.randomUUID().slice(0, 10)}`;
  const startedAt = nowIso();
  db.prepare(
    `INSERT INTO commerce_schedule_runs (id, schedule_id, status, items_processed, started_at)
     VALUES (?, ?, 'RUNNING', 0, ?)`
  ).run(runId, sched.id, startedAt);

  try {
    let itemsProcessed = 0;
    let reportArtifactId: string | null = null;
    let summary = '';

    if (sched.workflow_type === 'DAILY_OPPORTUNITY_DISCOVERY') {
      const scan = await searchPublicWebSignals('small business digital automation lead conversion website', 5);
      itemsProcessed = scan.signals.length;
      if (scan.status === 'UNAVAILABLE_OFFLINE') {
        throw new Error(scan.errorMessage || 'Public web signal sources unreachable.');
      }
      summary = `Verified live scan completed (${scan.status}): indexed ${scan.signals.length} public market/web signals.`;
    } else {
      const metrics = getCommerceTruthMetrics();
      const reportMd = [
        '# NEXA Autonomous Commerce — Daily Business Truth Report',
        `- **Generated At (UTC):** ${startedAt}`,
        `- **Trigger Source:** ${options?.triggerSource || 'scheduler'}`,
        '',
        '## Pipeline Discovery & Preparation',
        `- **Opportunities Discovered:** ${metrics.opportunitiesDiscovered}`,
        `- **Live Website Presence Audits Verified:** ${metrics.auditsCompletedLive}`,
        `- **CRM Contacts / Qualified Leads:** ${metrics.totalLeads} total / ${metrics.qualifiedLeads} qualified`,
        `- **Commercial Proposals Prepared / Sent:** ${metrics.proposalsPrepared} / ${metrics.proposalsApprovedOrSent}`,
        `- **Storefront MVP Sites Generated:** ${metrics.websitesGenerated}`,
        '',
        '## Realized Commercial Results (Strictly Verified)',
        `- **Customers Acquired (CUSTOMER_WON):** ${metrics.customersAcquired}`,
        `- **Verified Payments Count:** ${metrics.verifiedPaymentsCount}`,
        `- **Realized Revenue (EUR):** ${metrics.realizedRevenueEur.toFixed(2)}`,
        `- **Expenses / Operating Costs (EUR):** ${metrics.actualOperatingCostsEur.toFixed(2)}`,
        `- **Net Profit (EUR):** ${metrics.netProfitEur.toFixed(2)}`,
      ].join('\n');

      const artifact = saveArtifact({
        subsystem: 'commerce_scheduler',
        name: `daily_business_report_${runId}.md`,
        mimeType: 'text/markdown',
        content: reportMd,
        metadata: metrics,
      });
      reportArtifactId = artifact.id;
      itemsProcessed = 1;
      summary = `Generated verified Daily Business Truth Report (${artifact.id}) — Revenue EUR ${metrics.realizedRevenueEur.toFixed(2)}, Expenses EUR ${metrics.actualOperatingCostsEur.toFixed(2)}, Net Profit EUR ${metrics.netProfitEur.toFixed(2)}.`;
    }

    const completedAt = nowIso();
    const nextRun = new Date(Date.now() + sched.interval_minutes * 60 * 1000).toISOString();

    db.prepare(
      `UPDATE commerce_schedule_runs
       SET status = 'COMPLETED', items_processed = ?, report_artifact_id = ?, summary = ?, completed_at = ?
       WHERE id = ?`
    ).run(itemsProcessed, reportArtifactId, summary, completedAt, runId);

    db.prepare(
      `UPDATE commerce_schedules
       SET last_run_at = ?, next_run_at = ?, last_status = 'COMPLETED', last_summary = ?, failure_count = 0,
           missed_runs_recovered = missed_runs_recovered + ?
       WHERE id = ?`
    ).run(completedAt, nextRun, summary, options?.missedRecovery ? 1 : 0, sched.id);

    recordAuditEvent('commerce_scheduler', 'SCHEDULER', 'SCHEDULE_RUN_COMPLETED', {
      scheduleId: sched.id,
      runId,
      itemsProcessed,
      reportArtifactId,
      missedRecovery: Boolean(options?.missedRecovery),
      triggerSource: options?.triggerSource || 'scheduler',
    });

    return db.prepare('SELECT * FROM commerce_schedule_runs WHERE id = ?').get(runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Scheduled execution failed';
    const completedAt = nowIso();
    const nextRetry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    db.prepare(
      `UPDATE commerce_schedule_runs
       SET status = 'FAILED', error_message = ?, summary = ?, completed_at = ?
       WHERE id = ?`
    ).run(msg, `Execution failed cleanly: ${msg}`, completedAt, runId);

    db.prepare(
      `UPDATE commerce_schedules
       SET last_run_at = ?, next_run_at = ?, last_status = 'FAILED', last_summary = ?, failure_count = failure_count + 1
       WHERE id = ?`
    ).run(completedAt, nextRetry, msg, sched.id);

    recordAuditEvent('commerce_scheduler', 'SCHEDULER', 'SCHEDULE_RUN_FAILED', {
      scheduleId: sched.id,
      runId,
      error: msg,
    });

    return db.prepare('SELECT * FROM commerce_schedule_runs WHERE id = ?').get(runId);
  } finally {
    releaseScheduleLease(scheduleId);
  }
}

export async function runDueSchedules(triggerSource = 'interval'): Promise<{
  recoveredLocks: number;
  dueChecked: number;
  executed: Array<Record<string, unknown>>;
}> {
  const { recoveredLocks } = recoverStaleScheduleLocks();
  const now = nowIso();
  const nowMs = Date.now();
  const due = getDb()
    .prepare('SELECT id, next_run_at FROM commerce_schedules WHERE enabled = 1 AND next_run_at <= ?')
    .all(now) as Array<{ id: string; next_run_at: string }>;

  const executed: Array<Record<string, unknown>> = [];
  for (const row of due) {
    const overdueMs = nowMs - new Date(row.next_run_at).getTime();
    const missedRecovery = overdueMs > 5 * 60 * 1000;
    const run = (await executeScheduleById(row.id, { missedRecovery, triggerSource })) as Record<string, unknown>;
    executed.push(run);
  }

  return { recoveredLocks, dueChecked: due.length, executed };
}

export function startCommerceScheduler(intervalMs = 60000): void {
  if (schedulerTimer) return;
  schedulerActive = true;
  // Immediate startup check to recover stale locks or missed scheduled runs
  runDueSchedules('startup_recovery').catch(() => {
    // Errors recorded cleanly inside commerce_schedule_runs
  });
  schedulerTimer = setInterval(() => {
    runDueSchedules('interval').catch(() => {
      // Errors recorded cleanly inside commerce_schedule_runs
    });
  }, intervalMs);
  schedulerTimer.unref?.();
}

export function stopCommerceScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerActive = false;
}
