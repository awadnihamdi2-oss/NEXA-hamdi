import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, nowIso, recordAuditEvent } from '../db/database.ts';
import {
  classifyExecutionError,
  detectAgentContradictions,
  gatherMissionResearchContext,
  planExecutionWaves,
  runSingleAgent,
  selectAgentsForMission,
  type AgentExecutionRecord,
} from '../agents/orchestrator.ts';
import { getAgentById } from '../agents/agentRegistry.ts';
import { saveMemoryEntry } from '../memory/memoryEngine.ts';
import type { AgentId, ApprovalStatus, FailureClassification, MissionStatus, ProviderId } from '../types/nexa.ts';

const ARTIFACT_ROOT = path.resolve(process.cwd(), 'data/artifacts');

const VALID_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  CREATED: ['PLANNED', 'RUNNING', 'PAUSED', 'CANCELLED', 'FAILED', 'BLOCKED'],
  PLANNED: ['RUNNING', 'PAUSED', 'AWAITING_APPROVAL', 'CANCELLED', 'FAILED', 'BLOCKED'],
  RUNNING: ['PAUSED', 'RETRYING', 'REVIEWING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  PAUSED: ['RUNNING', 'PLANNED', 'CANCELLED', 'FAILED'],
  RETRYING: ['RUNNING', 'PAUSED', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['RUNNING', 'REVIEWING', 'COMPLETED', 'BLOCKED', 'CANCELLED', 'FAILED'],
  REVIEWING: ['COMPLETED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL'],
  COMPLETED: [],
  FAILED: ['PLANNED', 'RETRYING', 'RUNNING', 'CANCELLED'],
  BLOCKED: ['PLANNED', 'RUNNING', 'CANCELLED'],
  CANCELLED: [],
};

export function createMission(params: {
  objective: string;
  domain?: string;
  priority?: string;
  createdBy?: string;
  requiresApproval?: boolean;
  paidFallbackAllowed?: boolean;
  maxRetries?: number;
  requestedAgents?: AgentId[];
}) {
  const objective = params.objective.trim();
  if (objective.length < 10) {
    throw new Error('Mission objective must contain at least 10 characters.');
  }

  const db = getDb();
  const id = `msn_${crypto.randomUUID().slice(0, 12)}`;
  const ts = nowIso();
  const domain = params.domain || 'general';
  const agents = selectAgentsForMission(objective, domain, params.requestedAgents);
  const maxRetries = Math.min(Math.max(Number(params.maxRetries ?? 2), 0), 5);

  db.prepare(
    `INSERT INTO missions
     (id, objective, domain, status, priority, created_by, requires_approval, paid_fallback_allowed, max_retries, plan_json, created_at, updated_at)
     VALUES (?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    objective,
    domain,
    params.priority || 'normal',
    params.createdBy || 'operator',
    params.requiresApproval === false ? 0 : 1,
    params.paidFallbackAllowed ? 1 : 0,
    maxRetries,
    JSON.stringify({ agents }),
    ts,
    ts
  );

  const insertStep = db.prepare(
    'INSERT INTO mission_steps (mission_id, step_order, agent_id, title, status, required) VALUES (?, ?, ?, ?, ?, ?)'
  );
  agents.forEach((agentId, idx) => {
    const def = getAgentById(agentId);
    insertStep.run(id, idx + 1, agentId, def.name, 'PENDING', def.requiredByDefault ? 1 : 0);
  });

  recordAuditEvent(params.createdBy || 'operator', 'KERNEL', 'MISSION_CREATED', { domain, agents, maxRetries }, id);
  return getMissionById(id)!;
}

export function transitionMissionStatus(
  missionId: string,
  nextStatus: MissionStatus,
  fields?: {
    finalSynthesis?: string;
    verificationSummary?: string;
    failureClassification?: FailureClassification | null;
    lastError?: string | null;
  }
): void {
  const db = getDb();
  const row = db.prepare('SELECT status FROM missions WHERE id = ?').get(missionId) as { status: MissionStatus } | undefined;
  if (!row) throw new Error(`Mission not found: ${missionId}`);

  const allowed = VALID_TRANSITIONS[row.status] || [];
  if (row.status !== nextStatus && !allowed.includes(nextStatus)) {
    throw new Error(`Invalid mission transition: ${row.status} -> ${nextStatus}`);
  }

  const ts = nowIso();
  const completedAt = nextStatus === 'COMPLETED' ? ts : null;
  const clearErrors = nextStatus === 'COMPLETED' || nextStatus === 'RUNNING' || nextStatus === 'RETRYING';
  db.prepare(
    `UPDATE missions
     SET status = ?,
         final_synthesis = COALESCE(?, final_synthesis),
         verification_summary = COALESCE(?, verification_summary),
         failure_classification = CASE WHEN ? THEN NULL ELSE COALESCE(?, failure_classification) END,
         last_error = CASE WHEN ? THEN NULL ELSE COALESCE(?, last_error) END,
         completed_at = COALESCE(?, completed_at),
         updated_at = ?
     WHERE id = ?`
  ).run(
    nextStatus,
    fields?.finalSynthesis ?? null,
    fields?.verificationSummary ?? null,
    clearErrors && fields?.failureClassification === undefined ? 1 : 0,
    fields?.failureClassification ?? null,
    clearErrors && fields?.lastError === undefined ? 1 : 0,
    fields?.lastError ?? null,
    completedAt,
    ts,
    missionId
  );

  recordAuditEvent('kernel', 'KERNEL', 'MISSION_STATE_CHANGED', { from: row.status, to: nextStatus }, missionId);
}

export function cancelMission(missionId: string, actor = 'operator') {
  transitionMissionStatus(missionId, 'CANCELLED');
  recordAuditEvent(actor, 'KERNEL', 'MISSION_CANCELLED', {}, missionId);
  return getMissionById(missionId)!;
}

export function pauseMission(missionId: string, actor = 'operator') {
  const mission = getMissionById(missionId);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);
  if (mission.status === 'COMPLETED' || mission.status === 'CANCELLED') {
    throw new Error(`Cannot pause mission in terminal status ${mission.status}`);
  }
  transitionMissionStatus(missionId, 'PAUSED');
  recordAuditEvent(actor, 'KERNEL', 'MISSION_PAUSED', { previousStatus: mission.status }, missionId);
  return getMissionById(missionId)!;
}

export function recoverInterruptedMissionsOnStartup(): { recoveredCount: number; missionIds: string[] } {
  const db = getDb();
  const stuck = db
    .prepare("SELECT id, status FROM missions WHERE status IN ('RUNNING', 'RETRYING')")
    .all() as Array<{ id: string; status: MissionStatus }>;
  const recoveredIds: string[] = [];
  const ts = nowIso();
  for (const row of stuck) {
    db.prepare(
      "UPDATE mission_steps SET status = 'FAILED', failure_classification = 'internal_error', last_error = 'Interrupted by server restart', completed_at = ? WHERE mission_id = ? AND status = 'RUNNING'"
    ).run(ts, row.id);
    transitionMissionStatus(row.id, 'FAILED', {
      failureClassification: 'internal_error',
      lastError: 'Interrupted by server restart; safe to retry idempotently.',
      verificationSummary: 'Recovered interrupted execution after process restart.',
    });
    recordAuditEvent('kernel', 'KERNEL', 'MISSION_INTERRUPTED_RECOVERED', { previousStatus: row.status }, row.id);
    recoveredIds.push(row.id);
  }
  return { recoveredCount: recoveredIds.length, missionIds: recoveredIds };
}

export function saveArtifact(params: {
  missionId?: string | null;
  subsystem: string;
  name: string;
  mimeType: string;
  content: string;
  metadata?: unknown;
}) {
  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
  const safeName = params.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const id = `art_${crypto.randomUUID().slice(0, 12)}`;
  const filePath = path.join(ARTIFACT_ROOT, `${id}_${safeName}`);
  fs.writeFileSync(filePath, params.content, 'utf-8');
  const buf = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  getDb()
    .prepare(
      `INSERT INTO artifacts (id, mission_id, subsystem, name, mime_type, file_path, size_bytes, sha256, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      params.missionId ?? null,
      params.subsystem,
      safeName,
      params.mimeType,
      filePath,
      buf.length,
      sha256,
      params.metadata ? JSON.stringify(params.metadata) : null,
      nowIso()
    );

  recordAuditEvent('kernel', 'ARTIFACT', 'ARTIFACT_SAVED', { id, name: safeName, sha256 }, params.missionId ?? null);
  return { id, name: safeName, sha256, sizeBytes: buf.length, filePath };
}

export function requestApproval(params: {
  missionId?: string | null;
  category: string;
  action: string;
  payload: unknown;
  requestedBy?: string;
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO approvals (mission_id, category, action, payload_json, status, requested_by, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      params.missionId ?? null,
      params.category,
      params.action,
      JSON.stringify(params.payload),
      params.requestedBy || 'operator',
      nowIso()
    );
  const approvalId = Number(res.lastInsertRowid);
  recordAuditEvent(params.requestedBy || 'operator', 'APPROVAL', 'APPROVAL_REQUESTED', { approvalId, action: params.action }, params.missionId ?? null);
  return approvalId;
}

export function decideApproval(approvalId: number, decision: Exclude<ApprovalStatus, 'pending'>, decidedBy = 'admin', note = '') {
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error('Decision must be approved or rejected');
  }
  const db = getDb();
  const ts = nowIso();
  let row: Record<string, unknown>;

  db.exec('BEGIN IMMEDIATE;');
  try {
    const res = db
      .prepare("UPDATE approvals SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(decision, decidedBy, note, ts, approvalId);
    if (Number(res.changes) !== 1) {
      throw new Error('Approval not found or already decided');
    }
    row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Record<string, unknown>;
    recordAuditEvent(decidedBy, 'APPROVAL', 'APPROVAL_DECIDED', { approvalId, decision, note }, row.mission_id ? String(row.mission_id) : null);

    // Execute category-aware downstream state transitions transactionally
    const category = String(row.category || '');
    const action = String(row.action || '');
    const payload = (() => {
      try {
        return row.payload_json ? (JSON.parse(String(row.payload_json)) as Record<string, unknown>) : {};
      } catch {
        return {} as Record<string, unknown>;
      }
    })();

    if (category === 'mission_completion' && decision === 'approved' && row.mission_id) {
      const mId = String(row.mission_id);
      const missionRow = db.prepare('SELECT objective, final_synthesis FROM missions WHERE id = ?').get(mId) as
        | { objective: string; final_synthesis: string | null }
        | undefined;
      if (missionRow?.final_synthesis) {
        saveMemoryEntry({
          scope: 'verified_facts',
          title: `Signed Deliverable (${mId}): ${missionRow.objective.slice(0, 60)}`,
          content: missionRow.final_synthesis.slice(0, 1800),
          provenance: `approval:${approvalId}:mission:${mId}`,
          tags: ['signed_off', 'mission_deliverable'],
        });
      }
      recordAuditEvent(decidedBy, 'KERNEL', 'MISSION_DELIVERABLES_SIGNED_OFF', { approvalId, missionId: mId }, mId);
    } else if (category === 'commerce_publish') {
      const siteId =
        typeof payload.siteId === 'string'
          ? payload.siteId
          : action.startsWith('PUBLISH_SITE_')
            ? action.slice('PUBLISH_SITE_'.length)
            : '';
      if (siteId) {
        const targetSiteStatus = decision === 'approved' ? 'PUBLISHED' : 'DRAFT';
        db.prepare('UPDATE commerce_sites SET status = ? WHERE id = ?').run(targetSiteStatus, siteId);
        recordAuditEvent(decidedBy, 'COMMERCE', decision === 'approved' ? 'COMMERCE_SITE_PUBLISHED' : 'COMMERCE_SITE_PUBLISH_REJECTED', {
          approvalId,
          siteId,
          status: targetSiteStatus,
        });
      }
    } else if (category === 'commerce_outreach' && decision === 'approved') {
      const proposalId = typeof payload.proposalId === 'string' ? payload.proposalId : '';
      if (proposalId) {
        const prop = db
          .prepare('SELECT id, status, proposal_note, opportunity_id FROM commerce_proposals WHERE id = ?')
          .get(proposalId) as { id: string; status: string; proposal_note: string | null; opportunity_id: string | null } | undefined;
        if (prop) {
          const isHistorical = Boolean(prop.proposal_note) && /DO NOT SEND|HISTORICAL_DRAFT/i.test(prop.proposal_note || '');
          const linkedOpp = prop.opportunity_id
            ? (db.prepare('SELECT is_chain_or_enterprise, qualification_decision FROM commerce_opportunities WHERE id = ?').get(prop.opportunity_id) as
                | { is_chain_or_enterprise: number; qualification_decision: string | null }
                | undefined)
            : undefined;
          const oppBlocked =
            Boolean(linkedOpp?.is_chain_or_enterprise) ||
            linkedOpp?.qualification_decision === 'EXCLUDED_CHAIN' ||
            linkedOpp?.qualification_decision === 'ARCHIVED_HISTORICAL';
          if (isHistorical || oppBlocked) {
            throw new Error(`Proposal ${proposalId} is locked as historical/excluded and cannot be approved for outreach.`);
          }
          if (prop.status === 'DRAFT') {
            db.prepare("UPDATE commerce_proposals SET status = 'APPROVED', updated_at = ? WHERE id = ?").run(ts, proposalId);
            recordAuditEvent(decidedBy, 'COMMERCE', 'PROPOSAL_GATE_APPROVED_UNSENT', { approvalId, proposalId });
          }
        }
      }
    } else if (category === 'commerce_invoice') {
      const invoiceId =
        typeof payload.invoiceId === 'string'
          ? payload.invoiceId
          : action.startsWith('ISSUE_DRAFT_INVOICE_')
            ? action.slice('ISSUE_DRAFT_INVOICE_'.length)
            : '';
      if (invoiceId) {
        const nextInvStatus = decision === 'approved' ? 'APPROVED' : 'REJECTED';
        db.prepare("UPDATE commerce_invoices SET status = ? WHERE id = ? AND status = 'DRAFT'").run(nextInvStatus, invoiceId);
        recordAuditEvent(decidedBy, 'COMMERCE', decision === 'approved' ? 'DRAFT_INVOICE_APPROVED' : 'DRAFT_INVOICE_REJECTED', {
          approvalId,
          invoiceId,
          status: nextInvStatus,
        });
      }
    } else if (category === 'commerce_content') {
      const contentId = typeof payload.id === 'string' ? payload.id : '';
      if (contentId) {
        const nextContentStatus = decision === 'approved' ? 'APPROVED' : 'REJECTED';
        db.prepare('UPDATE commerce_content_assets SET status = ? WHERE id = ?').run(nextContentStatus, contentId);
        recordAuditEvent(decidedBy, 'COMMERCE', 'CONTENT_ASSET_DECIDED', { approvalId, contentId, status: nextContentStatus });
      }
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return row;
}

export function getBridgeLinks(missionId?: string) {
  const db = getDb();
  if (missionId) {
    return db
      .prepare('SELECT * FROM bridge_links WHERE mission_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(missionId) as Array<Record<string, unknown>>;
  }
  return db.prepare('SELECT * FROM bridge_links ORDER BY created_at DESC LIMIT 100').all() as Array<Record<string, unknown>>;
}

export function linkMissionToBridgeTask(params: {
  missionId: string;
  commerceTaskId: string;
  objective: string;
  execute: boolean;
}) {
  const mission = getMissionById(params.missionId);
  if (!mission) {
    throw new Error(`Mission not found for bridge link: ${params.missionId}`);
  }

  if (!params.execute) {
    return {
      success: true,
      executed: false,
      preview: {
        missionId: params.missionId,
        commerceTaskId: params.commerceTaskId,
        objective: params.objective,
        mode: 'DRY_RUN',
      },
    };
  }

  const db = getDb();
  const ts = nowIso();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      'INSERT INTO bridge_links (mission_id, commerce_task_id, objective, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(params.missionId, params.commerceTaskId, params.objective, 'LINKED', ts, ts);
    recordAuditEvent('bridge', 'BRIDGE', 'LINKED_TASK_CREATED', { commerceTaskId: params.commerceTaskId }, params.missionId);
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return { success: true, executed: true, missionId: params.missionId, commerceTaskId: params.commerceTaskId };
}

export async function executeMission(params: {
  missionId: string;
  preferredProvider?: ProviderId;
  preferredModel?: string;
  allowMockFallback?: boolean;
  useLiveResearch?: boolean;
  timeoutMsOverride?: number;
}) {
  const db = getDb();
  const mission = getMissionById(params.missionId);
  if (!mission) throw new Error(`Mission not found: ${params.missionId}`);

  if (mission.status === 'CANCELLED') {
    throw new Error('Mission was cancelled and cannot execute.');
  }
  if (mission.status === 'COMPLETED') {
    return mission;
  }

  transitionMissionStatus(params.missionId, 'RUNNING');

  const steps = db
    .prepare('SELECT id, agent_id, status, required FROM mission_steps WHERE mission_id = ? ORDER BY step_order ASC')
    .all(params.missionId) as Array<{ id: number; agent_id: AgentId; status: string; required: number }>;

  let context = await gatherMissionResearchContext(params.missionId, mission.objective, Boolean(params.useLiveResearch));
  const executions: AgentExecutionRecord[] = [];

  let totalTokens = Number(mission.totalTokens || 0);
  let totalCost = Number(mission.totalCostUsd || 0);
  let requiredFailure: string | null = null;
  let requiredFailureClass: FailureClassification | null = null;

  const waves = planExecutionWaves(steps.map((s) => s.agent_id));
  const stepByAgent = new Map(steps.map((s) => [s.agent_id, s]));

  for (const wave of waves) {
    const currentStatus = (db.prepare('SELECT status FROM missions WHERE id = ?').get(params.missionId) as { status: MissionStatus }).status;
    if (currentStatus === 'CANCELLED' || currentStatus === 'PAUSED') {
      break;
    }

    const waveSteps = wave.map((agentId) => stepByAgent.get(agentId)).filter((s): s is NonNullable<typeof s> => Boolean(s));
    const pendingSteps = waveSteps.filter((s) => s.status !== 'COMPLETED');
    const alreadyCompletedSteps = waveSteps.filter((s) => s.status === 'COMPLETED');

    // Idempotent resume/retry: rehydrate context from already-completed steps without duplicate agent runs
    for (const doneStep of alreadyCompletedSteps) {
      const prevRun = db
        .prepare("SELECT * FROM agent_runs WHERE mission_id = ? AND agent_id = ? AND status = 'SUCCESS' ORDER BY id DESC LIMIT 1")
        .get(params.missionId, doneStep.agent_id) as Record<string, unknown> | undefined;
      if (prevRun) {
        const def = getAgentById(doneStep.agent_id);
        const parsed = prevRun.output_json ? JSON.parse(String(prevRun.output_json)) : null;
        executions.push({
          agentId: doneStep.agent_id,
          agentName: def.name,
          required: doneStep.required === 1,
          status: 'SUCCESS',
          providerId: prevRun.provider_id as ProviderId,
          modelId: String(prevRun.model_id),
          latencyMs: Number(prevRun.latency_ms || 0),
          tokensIn: Number(prevRun.tokens_in || 0),
          tokensOut: Number(prevRun.tokens_out || 0),
          costUsd: Number(prevRun.cost_usd || 0),
          isMock: Number(prevRun.is_mock) === 1,
          structured: parsed,
          rawText: String(prevRun.output_text || ''),
        });
        context += `\n\n### ${def.name} (${String(prevRun.provider_id)}/${String(prevRun.model_id)}):\n${parsed?.summary || String(prevRun.output_text || '').slice(0, 700)}`;
      }
    }

    if (pendingSteps.length === 0) {
      continue;
    }

    const waveStart = nowIso();
    for (const s of pendingSteps) {
      db.prepare("UPDATE mission_steps SET status = 'RUNNING', started_at = COALESCE(started_at, ?) WHERE id = ?").run(waveStart, s.id);
    }

    // Run independent specialists in this dependency wave concurrently with per-agent isolation
    const settled = await Promise.allSettled(
      pendingSteps.map(async (step) => {
        const exec = await runSingleAgent({
          missionId: params.missionId,
          agentId: step.agent_id,
          objective: mission.objective,
          context,
          preferredProvider: params.preferredProvider,
          preferredModel: params.preferredModel,
          paidFallbackAllowed: mission.paidFallbackAllowed,
          allowMockFallback: params.allowMockFallback,
          timeoutMsOverride: params.timeoutMsOverride,
        });
        return { step, exec };
      })
    );

    const waveResults = settled.map((res, idx) => {
      if (res.status === 'fulfilled') return res.value;
      const step = pendingSteps[idx];
      const def = getAgentById(step.agent_id);
      const errMsg = res.reason instanceof Error ? res.reason.message : 'Unexpected worker rejection';
      return {
        step,
        exec: {
          agentId: step.agent_id,
          agentName: def.name,
          required: step.required === 1,
          status: 'FAILED' as const,
          providerId: params.preferredProvider || ('GEMINI' as ProviderId),
          modelId: params.preferredModel || 'none',
          latencyMs: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          isMock: false,
          structured: null,
          rawText: '',
          error: errMsg,
          failureClassification: classifyExecutionError(errMsg),
        } as AgentExecutionRecord,
      };
    });

    for (const { step, exec } of waveResults) {
      executions.push(exec);
      totalTokens += exec.tokensIn + exec.tokensOut;
      totalCost += exec.costUsd;

      if (exec.status === 'SUCCESS') {
        db.prepare("UPDATE mission_steps SET status = 'COMPLETED', failure_classification = NULL, last_error = NULL, completed_at = ? WHERE id = ?").run(
          nowIso(),
          step.id
        );
        context += `\n\n### ${exec.agentName} (${exec.providerId}/${exec.modelId}):\n${exec.structured?.summary || exec.rawText.slice(0, 700)}`;
      } else {
        const fClass = exec.failureClassification || classifyExecutionError(exec.error || '');
        db.prepare(
          "UPDATE mission_steps SET status = 'FAILED', retry_count = retry_count + 1, failure_classification = ?, last_error = ?, completed_at = ? WHERE id = ?"
        ).run(fClass, (exec.error || 'Agent failed').slice(0, 300), nowIso(), step.id);
        if (step.required === 1 && !requiredFailure) {
          requiredFailure = `${exec.agentName}: ${exec.error || 'Required stage failed'}`;
          requiredFailureClass = fClass;
        }
      }
    }

    if (requiredFailure) {
      break;
    }

    const costCapRow = db.prepare("SELECT value_json FROM system_settings WHERE key = 'max_cost_per_mission_usd'").get() as
      | { value_json: string }
      | undefined;
    const costCap = costCapRow ? Number(JSON.parse(costCapRow.value_json)) : 0;
    if (Number.isFinite(costCap) && costCap > 0 && totalCost > costCap) {
      requiredFailure = `Mission cost ceiling exceeded ($${totalCost.toFixed(4)} > $${costCap.toFixed(4)} max_cost_per_mission_usd).`;
      requiredFailureClass = 'quota_exhausted';
      recordAuditEvent('kernel', 'SECURITY', 'MISSION_COST_CEILING_EXCEEDED', { totalCost, costCap }, params.missionId);
      break;
    }
  }

  const latestStatus = (db.prepare('SELECT status FROM missions WHERE id = ?').get(params.missionId) as { status: MissionStatus }).status;
  if (latestStatus === 'CANCELLED' || latestStatus === 'PAUSED') {
    db.prepare('UPDATE missions SET total_tokens = ?, total_cost_usd = ?, updated_at = ? WHERE id = ?').run(
      totalTokens,
      totalCost,
      nowIso(),
      params.missionId
    );
    return getMissionById(params.missionId)!;
  }

  if (requiredFailure) {
    db.prepare('UPDATE missions SET total_tokens = ?, total_cost_usd = ? WHERE id = ?').run(totalTokens, totalCost, params.missionId);
    transitionMissionStatus(params.missionId, 'FAILED', {
      failureClassification: requiredFailureClass || 'internal_error',
      lastError: requiredFailure.slice(0, 400),
      verificationSummary: `Mission failed at required stage (${requiredFailureClass || 'internal_error'}): ${requiredFailure}`,
    });
    return getMissionById(params.missionId)!;
  }

  transitionMissionStatus(params.missionId, 'REVIEWING');

  const contradictionsDetected = detectAgentContradictions(executions);
  if (contradictionsDetected.length > 0) {
    recordAuditEvent('kernel', 'VERIFICATION', 'CONTRADICTION_DETECTED', { contradictionsDetected }, params.missionId);
  }

  const succeededExecs = executions.filter((e) => e.status === 'SUCCESS');
  const schemaValidatedCount = succeededExecs.filter((e) => e.schemaValidated !== false).length;
  const totalClaims = succeededExecs.reduce(
    (acc, e) => acc + (e.structured?.facts.length || 0) + (e.structured?.recommendations.length || 0),
    0
  );
  if (succeededExecs.length === 0 || (schemaValidatedCount === 0 && totalClaims === 0)) {
    const reason = 'Epistemic verification failed: no schema-validated outputs or actionable facts/recommendations were produced.';
    db.prepare('UPDATE missions SET total_tokens = ?, total_cost_usd = ? WHERE id = ?').run(totalTokens, totalCost, params.missionId);
    transitionMissionStatus(params.missionId, 'FAILED', {
      failureClassification: 'validation_error',
      lastError: reason,
      verificationSummary: reason,
    });
    return getMissionById(params.missionId)!;
  }

  const synth = executions.find((e) => e.agentId === 'final_synthesis_agent') || executions[executions.length - 1];
  const anyMock = executions.some((e) => e.isMock);
  const finalSynthesis =
    synth?.structured?.summary ||
    executions
      .filter((e) => e.status === 'SUCCESS')
      .map((e) => `## ${e.agentName}\n${e.structured?.summary || ''}`)
      .join('\n\n');

  const verificationSummary = JSON.stringify({
    totalStages: steps.length,
    succeeded: succeededExecs.length,
    failed: executions.filter((e) => e.status === 'FAILED').length,
    schemaValidatedCount,
    totalClaims,
    usedOfflineMock: anyMock,
    executionWaves: waves,
    contradictionsDetected,
    providersUsed: Array.from(new Set(executions.map((e) => `${e.providerId}:${e.modelId}`))),
  });

  db.prepare('UPDATE missions SET total_tokens = ?, total_cost_usd = ? WHERE id = ?').run(totalTokens, totalCost, params.missionId);

  // Save report artifact with SHA-256 checksum
  const reportMd = [
    `# NEXA MISSION REPORT: ${params.missionId}`,
    `Objective: ${mission.objective}`,
    `Mode: ${anyMock ? 'OFFLINE_MOCK_VERIFIED_PIPELINE' : 'LIVE_PROVIDER_EXECUTION'}`,
    '',
    '## Executive Synthesis',
    finalSynthesis,
    '',
    '## Specialist Agent Audit',
    ...executions.map(
      (e) =>
        `### ${e.agentName} [${e.status}] — ${e.providerId}/${e.modelId} (${e.latencyMs}ms)\n${e.structured ? e.structured.summary : e.error || ''}`
    ),
  ].join('\n');

  saveArtifact({
    missionId: params.missionId,
    subsystem: 'mission_kernel',
    name: `mission_report_${params.missionId}.md`,
    mimeType: 'text/markdown',
    content: reportMd,
    metadata: { usedOfflineMock: anyMock },
  });

  saveMemoryEntry({
    scope: 'mission_history',
    title: `Mission ${params.missionId}: ${mission.objective.slice(0, 60)}`,
    content: finalSynthesis.slice(0, 1800),
    provenance: `mission:${params.missionId}`,
    tags: [mission.domain, anyMock ? 'mock' : 'live'],
  });

  if (mission.requiresApproval) {
    requestApproval({
      missionId: params.missionId,
      category: 'mission_completion',
      action: 'SIGN_OFF_MISSION_DELIVERABLES',
      payload: { objective: mission.objective, verificationSummary },
    });
  }

  transitionMissionStatus(params.missionId, 'COMPLETED', {
    finalSynthesis,
    verificationSummary,
  });

  return getMissionById(params.missionId)!;
}

export async function resumeMission(params: {
  missionId: string;
  actor?: string;
  preferredProvider?: ProviderId;
  preferredModel?: string;
  allowMockFallback?: boolean;
  useLiveResearch?: boolean;
}) {
  const mission = getMissionById(params.missionId);
  if (!mission) throw new Error(`Mission not found: ${params.missionId}`);
  if (mission.status !== 'PAUSED' && mission.status !== 'PLANNED' && mission.status !== 'AWAITING_APPROVAL') {
    throw new Error(`Mission cannot resume from status ${mission.status}`);
  }
  recordAuditEvent(params.actor || 'operator', 'KERNEL', 'MISSION_RESUMED', { fromStatus: mission.status }, params.missionId);
  return executeMission(params);
}

export async function retryMission(params: {
  missionId: string;
  actor?: string;
  preferredProvider?: ProviderId;
  preferredModel?: string;
  allowMockFallback?: boolean;
  useLiveResearch?: boolean;
}) {
  const db = getDb();
  const mission = getMissionById(params.missionId);
  if (!mission) throw new Error(`Mission not found: ${params.missionId}`);
  if (mission.status !== 'FAILED' && mission.status !== 'RETRYING' && mission.status !== 'BLOCKED') {
    throw new Error(`Only FAILED, BLOCKED, or RETRYING missions can be retried (current: ${mission.status})`);
  }
  if (mission.retryCount >= mission.maxRetries) {
    recordAuditEvent(
      params.actor || 'operator',
      'KERNEL',
      'MISSION_RETRY_LIMIT_REACHED',
      { retryCount: mission.retryCount, maxRetries: mission.maxRetries },
      params.missionId
    );
    throw new Error(`Maximum bounded retry limit (${mission.maxRetries}) reached for mission ${params.missionId}.`);
  }

  db.prepare('UPDATE missions SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?').run(nowIso(), params.missionId);
  // Keep already-COMPLETED steps intact for strict idempotency; reset only non-completed steps
  db.prepare("UPDATE mission_steps SET status = 'PENDING', completed_at = NULL WHERE mission_id = ? AND status != 'COMPLETED'").run(
    params.missionId
  );

  if (mission.status !== 'RETRYING') {
    transitionMissionStatus(params.missionId, 'RETRYING');
  }
  recordAuditEvent(
    params.actor || 'operator',
    'KERNEL',
    'MISSION_RETRYING',
    { retryAttempt: mission.retryCount + 1, maxRetries: mission.maxRetries },
    params.missionId
  );

  return executeMission(params);
}

export function listMissions() {
  const rows = getDb().prepare('SELECT * FROM missions ORDER BY created_at DESC LIMIT 100').all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    objective: String(r.objective),
    domain: String(r.domain),
    status: r.status as MissionStatus,
    priority: String(r.priority),
    createdBy: r.created_by ? String(r.created_by) : null,
    requiresApproval: Number(r.requires_approval) === 1,
    paidFallbackAllowed: Number(r.paid_fallback_allowed) === 1,
    finalSynthesis: r.final_synthesis ? String(r.final_synthesis) : null,
    verificationSummary: r.verification_summary ? String(r.verification_summary) : null,
    totalTokens: Number(r.total_tokens || 0),
    totalCostUsd: Number(r.total_cost_usd || 0),
    retryCount: Number(r.retry_count || 0),
    maxRetries: Number(r.max_retries ?? 2),
    failureClassification: r.failure_classification ? (String(r.failure_classification) as FailureClassification) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
  }));
}

export function getMissionById(missionId: string) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as Record<string, unknown> | undefined;
  if (!r) return null;

  const steps = db.prepare('SELECT * FROM mission_steps WHERE mission_id = ? ORDER BY step_order ASC').all(missionId) as Array<
    Record<string, unknown>
  >;
  const runs = db.prepare('SELECT * FROM agent_runs WHERE mission_id = ? ORDER BY id ASC').all(missionId) as Array<
    Record<string, unknown>
  >;
  const artifacts = db.prepare('SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at DESC').all(missionId) as Array<
    Record<string, unknown>
  >;
  const approvals = db.prepare('SELECT * FROM approvals WHERE mission_id = ? ORDER BY id DESC').all(missionId) as Array<
    Record<string, unknown>
  >;

  return {
    id: String(r.id),
    objective: String(r.objective),
    domain: String(r.domain),
    status: r.status as MissionStatus,
    priority: String(r.priority),
    createdBy: r.created_by ? String(r.created_by) : null,
    requiresApproval: Number(r.requires_approval) === 1,
    paidFallbackAllowed: Number(r.paid_fallback_allowed) === 1,
    finalSynthesis: r.final_synthesis ? String(r.final_synthesis) : null,
    verificationSummary: r.verification_summary ? String(r.verification_summary) : null,
    totalTokens: Number(r.total_tokens || 0),
    totalCostUsd: Number(r.total_cost_usd || 0),
    retryCount: Number(r.retry_count || 0),
    maxRetries: Number(r.max_retries ?? 2),
    failureClassification: r.failure_classification ? (String(r.failure_classification) as FailureClassification) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
    steps: steps.map((s) => ({
      id: Number(s.id),
      stepOrder: Number(s.step_order),
      agentId: s.agent_id as AgentId,
      title: String(s.title),
      status: String(s.status),
      required: Number(s.required) === 1,
      retryCount: Number(s.retry_count || 0),
      failureClassification: s.failure_classification ? (String(s.failure_classification) as FailureClassification) : null,
      lastError: s.last_error ? String(s.last_error) : null,
      startedAt: s.started_at ? String(s.started_at) : null,
      completedAt: s.completed_at ? String(s.completed_at) : null,
    })),
    agentRuns: runs.map((ar) => ({
      id: Number(ar.id),
      agentId: ar.agent_id as AgentId,
      providerId: ar.provider_id as ProviderId,
      modelId: String(ar.model_id),
      status: String(ar.status),
      output: ar.output_json ? JSON.parse(String(ar.output_json)) : null,
      outputText: ar.output_text ? String(ar.output_text) : null,
      errorMessage: ar.error_message ? String(ar.error_message) : null,
      latencyMs: Number(ar.latency_ms || 0),
      tokensIn: Number(ar.tokens_in || 0),
      tokensOut: Number(ar.tokens_out || 0),
      costUsd: Number(ar.cost_usd || 0),
      isMock: Number(ar.is_mock) === 1,
      createdAt: String(ar.created_at),
    })),
    artifacts: artifacts.map((a) => ({
      id: String(a.id),
      name: String(a.name),
      subsystem: String(a.subsystem),
      mimeType: String(a.mime_type),
      sizeBytes: Number(a.size_bytes),
      sha256: String(a.sha256),
      createdAt: String(a.created_at),
    })),
    approvals: approvals.map((ap) => ({
      id: Number(ap.id),
      category: String(ap.category),
      action: String(ap.action),
      status: ap.status as ApprovalStatus,
      createdAt: String(ap.created_at),
      decidedAt: ap.decided_at ? String(ap.decided_at) : null,
    })),
  };
}
