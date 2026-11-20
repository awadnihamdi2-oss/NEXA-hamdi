import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createIsolatedSandboxDatabase, nowIso } from '../db/database.ts';
import { getAgentById } from '../agents/agentRegistry.ts';
import { AgentOutputSchema, classifyExecutionError, type StructuredAgentOutput } from '../agents/orchestrator.ts';
import { buildCommercialTermsBreakdown, scoreBusinessOpportunity } from './commerceEngine.ts';
import type { AgentId, FailureClassification, MissionStatus } from '../types/nexa.ts';

export const SANDBOX_POLICY_LOCKS = {
  environmentMode: 'SANDBOX' as const,
  storageIsolation: 'ISOLATED_IN_MEMORY_SQLITE_FIXTURE' as const,
  writesToProductionDb: false,
  writesToFilesystemArtifacts: false,
  externalPayments: 'DENIED' as const,
  customerOutreach: 'DENIED' as const,
  messaging: 'DENIED' as const,
  publishing: 'DENIED' as const,
  liveTrading: 'DENIED' as const,
  approvalBypass: 'DENIED' as const,
};

export type SandboxStageId =
  | 'opportunity_discovery'
  | 'opportunity_scoring'
  | 'market_research'
  | 'feasibility_analysis'
  | 'strategic_planning'
  | 'proposal_generation'
  | 'website_draft_generation'
  | 'marketing_strategy'
  | 'risk_compliance_review'
  | 'human_approval_gate'
  | 'sandbox_execution'
  | 'result_collection'
  | 'execution_audit'
  | 'final_mission_report';

export type SandboxStageStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'AWAITING_APPROVAL' | 'FAILED' | 'BLOCKED' | 'CANCELLED';

export interface SandboxStageSpec {
  order: number;
  id: SandboxStageId;
  title: string;
  agentId: AgentId;
  dependsOn: SandboxStageId[];
}

export const SANDBOX_STAGE_SPECS: SandboxStageSpec[] = [
  { order: 1, id: 'opportunity_discovery', title: '1. Opportunity Discovery (Simulated)', agentId: 'business_intelligence_agent', dependsOn: [] },
  { order: 2, id: 'opportunity_scoring', title: '2. Opportunity Scoring & Ranking', agentId: 'business_intelligence_agent', dependsOn: ['opportunity_discovery'] },
  { order: 3, id: 'market_research', title: '3. Market Research & Evidence', agentId: 'research_agent', dependsOn: ['opportunity_scoring'] },
  { order: 4, id: 'feasibility_analysis', title: '4. Business Feasibility Analysis', agentId: 'business_intelligence_agent', dependsOn: ['market_research'] },
  { order: 5, id: 'strategic_planning', title: '5. Strategic Planning', agentId: 'strategic_planner', dependsOn: ['feasibility_analysis'] },
  { order: 6, id: 'proposal_generation', title: '6. Business Proposal Generation', agentId: 'commerce_operations_agent', dependsOn: ['strategic_planning'] },
  { order: 7, id: 'website_draft_generation', title: '7. Storefront HTML Draft (Unpublished)', agentId: 'commerce_operations_agent', dependsOn: ['proposal_generation'] },
  { order: 8, id: 'marketing_strategy', title: '8. Marketing Strategy & Draft Assets', agentId: 'commerce_operations_agent', dependsOn: ['website_draft_generation'] },
  { order: 9, id: 'risk_compliance_review', title: '9. Risk & Compliance Review', agentId: 'security_auditor', dependsOn: ['marketing_strategy'] },
  { order: 10, id: 'human_approval_gate', title: '10. Human Approval Gate', agentId: 'independent_critic', dependsOn: ['risk_compliance_review'] },
  { order: 11, id: 'sandbox_execution', title: '11. Sandbox Execution (Side-Effect Free)', agentId: 'commerce_operations_agent', dependsOn: ['human_approval_gate'] },
  { order: 12, id: 'result_collection', title: '12. Result Collection (Simulated Metrics)', agentId: 'data_analyst', dependsOn: ['sandbox_execution'] },
  { order: 13, id: 'execution_audit', title: '13. Execution Audit & Policy Verify', agentId: 'fact_verification_agent', dependsOn: ['result_collection'] },
  { order: 14, id: 'final_mission_report', title: '14. Final Sandbox Mission Report', agentId: 'final_synthesis_agent', dependsOn: ['execution_audit'] },
];

export interface SandboxStageState {
  order: number;
  id: SandboxStageId;
  title: string;
  agentId: AgentId;
  dependsOn: SandboxStageId[];
  status: SandboxStageStatus;
  attempts: number;
  costUsd: number;
  tokensUsed: number;
  latencyMs: number;
  summary: string | null;
  error: string | null;
  failureClassification: FailureClassification | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BlockedExternalActionRecord {
  id: string;
  stageId: SandboxStageId;
  actionType: 'PAYMENT_INITIATION' | 'CUSTOMER_OUTREACH' | 'SEND_EMAIL' | 'SEND_SMS' | 'PUBLISH_WEBSITE' | 'PUBLISH_ADS' | 'LIVE_TRADING';
  target: string;
  policyResult: 'DENIED_BY_SANDBOX_POLICY';
  reason: string;
  timestamp: string;
}

export type SandboxFaultSimulationMode =
  | 'NONE'
  | 'AGENT_FAILURE'
  | 'RETRY_EXHAUSTION'
  | 'TIMEOUT'
  | 'INVALID_AI_OUTPUT'
  | 'COST_CEILING_EXCEEDED';

export interface StartSandboxMissionInput {
  niche: string;
  cityOrMarket: string;
  language?: 'en' | 'it' | 'ar' | 'fr';
  maxCostUsd?: number;
  maxRetries?: number;
  stageTimeoutMs?: number;
  idempotencyKey?: string;
  createdBy?: string;
  simulationMode?: SandboxFaultSimulationMode;
  stageWorkerHook?: (ctx: {
    stage: SandboxStageSpec;
    attempt: number;
    runId: string;
    missionId: string;
  }) => Promise<{ rawOutput: string; costUsd?: number; tokensIn?: number; tokensOut?: number } | null>;
}

interface InternalSandboxRunContext {
  runId: string;
  missionId: string;
  dedupeKey: string;
  db: DatabaseSync;
  niche: string;
  cityOrMarket: string;
  language: 'en' | 'it' | 'ar' | 'fr';
  maxCostUsd: number;
  maxRetries: number;
  stageTimeoutMs: number;
  simulationMode: SandboxFaultSimulationMode;
  stageWorkerHook?: StartSandboxMissionInput['stageWorkerHook'];
  stages: SandboxStageState[];
  blockedExternalActions: BlockedExternalActionRecord[];
  cancelled: boolean;
  running: boolean;
  totalCostUsd: number;
  totalTokens: number;
  primaryOpportunityId: string | null;
  primarySiteId: string | null;
  primaryProposalId: string | null;
  approvalId: number | null;
  finalReportMarkdown: string | null;
  simulatedMetrics: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
  lastError: string | null;
  failureClassification: FailureClassification | null;
  status: MissionStatus;
  createdBy: string;
}

const sandboxRuns = new Map<string, InternalSandboxRunContext>();
const activeDedupeLocks = new Set<string>();

function escapeSandboxHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function recordSandboxAudit(
  db: DatabaseSync,
  actor: string,
  category: string,
  event: string,
  details: unknown,
  missionId: string
): void {
  db.prepare('INSERT INTO audit_events (mission_id, actor, category, event, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    missionId,
    actor,
    category,
    event,
    details ? JSON.stringify(details) : null,
    nowIso()
  );
}

function blockExternalSideEffect(
  ctx: InternalSandboxRunContext,
  stageId: SandboxStageId,
  actionType: BlockedExternalActionRecord['actionType'],
  target: string,
  reason: string
): BlockedExternalActionRecord {
  const entry: BlockedExternalActionRecord = {
    id: `blk_${crypto.randomUUID().slice(0, 8)}`,
    stageId,
    actionType,
    target,
    policyResult: 'DENIED_BY_SANDBOX_POLICY',
    reason,
    timestamp: nowIso(),
  };
  ctx.blockedExternalActions.push(entry);
  recordSandboxAudit(ctx.db, 'sandbox_guard', 'SANDBOX_SECURITY', 'EXTERNAL_SIDE_EFFECT_BLOCKED', entry, ctx.missionId);
  return entry;
}

function syncSandboxResultRow(ctx: InternalSandboxRunContext): void {
  const currentStage =
    ctx.stages.find((s) => s.status === 'RUNNING' || s.status === 'AWAITING_APPROVAL' || s.status === 'FAILED')?.id ||
    ctx.stages[ctx.stages.length - 1].id;

  ctx.db
    .prepare(
      `INSERT OR REPLACE INTO commerce_sandbox_results
       (id, mission_id, environment_mode, status, current_stage, stages_json, blocked_external_actions_json, simulated_metrics_json, final_report_markdown, error_message, started_at, completed_at)
       VALUES (?, ?, 'SANDBOX', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ctx.runId,
      ctx.missionId,
      ctx.status,
      currentStage,
      JSON.stringify(ctx.stages),
      JSON.stringify(ctx.blockedExternalActions),
      JSON.stringify(ctx.simulatedMetrics),
      ctx.finalReportMarkdown,
      ctx.lastError,
      ctx.createdAt,
      ctx.completedAt
    );

  ctx.db
    .prepare(
      `UPDATE missions
       SET status = ?, total_tokens = ?, total_cost_usd = ?, failure_classification = ?, last_error = ?, final_synthesis = COALESCE(?, final_synthesis), updated_at = ?, completed_at = ?
       WHERE id = ?`
    )
    .run(
      ctx.status,
      ctx.totalTokens,
      ctx.totalCostUsd,
      ctx.failureClassification,
      ctx.lastError,
      ctx.finalReportMarkdown,
      nowIso(),
      ctx.completedAt,
      ctx.missionId
    );
}

function blockRemainingStages(ctx: InternalSandboxRunContext, failedIndex: number, reason: string): void {
  for (let i = failedIndex + 1; i < ctx.stages.length; i++) {
    const st = ctx.stages[i];
    if (st.status === 'PENDING' || st.status === 'AWAITING_APPROVAL') {
      st.status = 'BLOCKED';
      st.error = reason;
      ctx.db
        .prepare("UPDATE mission_steps SET status = 'BLOCKED', last_error = ?, completed_at = ? WHERE mission_id = ? AND step_order = ?")
        .run(reason.slice(0, 280), nowIso(), ctx.missionId, st.order);
    }
  }
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function produceDeterministicStagePayload(ctx: InternalSandboxRunContext, stage: SandboxStageSpec): {
  rawJson: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  domainExec: (structured: StructuredAgentOutput) => string;
} {
  const safeNiche = ctx.niche.trim();
  const safeCity = ctx.cityOrMarket.trim();

  switch (stage.id) {
    case 'opportunity_discovery': {
      const output: StructuredAgentOutput = {
        summary: `[SANDBOX SIMULATED] Discovered 3 synthetic ${safeNiche} prospects in ${safeCity} requiring mobile lead-capture upgrades.`,
        facts: [`Generated 3 synthetic sandbox candidate businesses in ${safeNiche} (${safeCity}); zero live web/customer records queried.`],
        hypotheses: ['Independent local service operators without responsive booking forms lose mobile prospects.'],
        assumptions: ['All discovered entities are synthetic SANDBOX fixtures strictly for end-to-end validation.'],
        unknowns: ['Live market conversion elasticity remains unverified inside offline sandbox simulation.'],
        risks: ['Synthetic discovery must remain strictly isolated from production CRM tables.'],
        recommendations: ['Score and rank all 3 sandbox opportunities before research & feasibility stages.'],
        confidence: 0.84,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.0002,
        tokensIn: 310,
        tokensOut: 190,
        domainExec: () => {
          const candidates = [
            {
              name: `[SANDBOX] ${safeNiche} Soluzione Uno (${safeCity})`,
              websiteStatus: 'NO_WEBSITE',
              readinessScore: 0,
              gapsCount: 4,
              hasPhone: true,
              hasEmail: true,
              hasAddress: true,
              effort: 16,
              model: 'EUR 450 Setup + EUR 99/mo Sandbox Tier',
            },
            {
              name: `[SANDBOX] ${safeNiche} Centro Beta (${safeCity})`,
              websiteStatus: 'WEAK_WEBSITE',
              readinessScore: 45,
              gapsCount: 3,
              hasPhone: true,
              hasEmail: false,
              hasAddress: true,
              effort: 20,
              model: 'EUR 650 Setup + EUR 149/mo Sandbox Tier',
            },
            {
              name: `[SANDBOX] ${safeNiche} Rete Franchising Gamma`,
              websiteStatus: 'HEALTHY_WEBSITE',
              readinessScore: 95,
              gapsCount: 0,
              hasPhone: true,
              hasEmail: false,
              hasAddress: false,
              effort: 35,
              model: 'Enterprise Chain (Excluded Candidate)',
              isChain: true,
            },
          ];
          const ts = nowIso();
          for (const c of candidates) {
            const oppId = `sbx_opp_${crypto.randomUUID().slice(0, 8)}`;
            const problem =
              c.websiteStatus === 'NO_WEBSITE'
                ? 'Simulated SMB without official website or online booking funnel.'
                : c.isChain
                  ? 'Multi-location simulated franchise chain — unsuitable for SMB direct package.'
                  : 'Simulated SMB lacking mobile viewport meta tags and direct inquiry form.';
            ctx.db
              .prepare(
                `INSERT INTO commerce_opportunities
                 (id, title, target_market, problem_statement, estimated_effort_hours, revenue_model, validation_score, status, evidence_notes, business_name, city, website_status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 0, 'DISCOVERED_SANDBOX', ?, ?, ?, ?, ?)`
              )
              .run(
                oppId,
                c.name,
                `[SANDBOX] ${safeNiche} — ${safeCity}`,
                problem,
                c.effort,
                c.model,
                `[SANDBOX FIXTURE] ${JSON.stringify(c)}`,
                c.name,
                safeCity,
                c.websiteStatus,
                ts
              );
          }
          return output.summary;
        },
      };
    }

    case 'opportunity_scoring': {
      const output: StructuredAgentOutput = {
        summary: '[SANDBOX] Ranked 3 discovered opportunities using deterministic verification confidence, solvability, and chain exclusion rules.',
        facts: ['Top ranked SMB candidate qualified for commercial packaging; franchise fixture automatically excluded.'],
        hypotheses: ['Missing official website + verified phone/email yields highest turnkey setup margin in SMB segment.'],
        assumptions: ['Scoring uses scoreBusinessOpportunity() deterministic ruleset inside isolated sandbox DB.'],
        unknowns: [],
        risks: ['Avoid targeting corporate chains or low-evidence entries without contact verification.'],
        recommendations: ['Advance highest-priority P1/P2 candidate to Stage 3 research.'],
        confidence: 0.88,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00015,
        tokensIn: 260,
        tokensOut: 165,
        domainExec: () => {
          const rows = ctx.db.prepare('SELECT * FROM commerce_opportunities ORDER BY created_at ASC').all() as Array<Record<string, unknown>>;
          let topId: string | null = null;
          let topScore = -1;
          for (const row of rows) {
            const noteRaw = String(row.evidence_notes || '').replace('[SANDBOX FIXTURE] ', '');
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(noteRaw);
            } catch {
              parsed = {};
            }
            const isChain = Boolean(parsed.isChain);
            const scored = scoreBusinessOpportunity({
              websiteStatus: String(row.website_status || 'NO_WEBSITE') as 'NO_WEBSITE' | 'WEAK_WEBSITE' | 'HEALTHY_WEBSITE',
              digitalReadinessScore: Number(parsed.readinessScore || 0),
              gapsCount: Number(parsed.gapsCount || 2),
              hasPhone: Boolean(parsed.hasPhone),
              hasEmail: Boolean(parsed.hasEmail),
              hasAddress: Boolean(parsed.hasAddress),
              isChainOrEnterprise: isChain,
              liveAuditCompleted: true,
              hasCrossCheckCorroboration: true,
              httpStatus: isChain ? 200 : 404,
            });
            ctx.db
              .prepare(
                `UPDATE commerce_opportunities
                 SET priority_score = ?, validation_score = ?, priority_tier = ?, confidence_score = ?,
                     verification_status = ?, is_chain_or_enterprise = ?, qualification_decision = ?, status = ?
                 WHERE id = ?`
              )
              .run(
                scored.priorityScore,
                scored.priorityScore,
                scored.priorityTier,
                scored.confidenceScore,
                scored.verificationStatus,
                isChain ? 1 : 0,
                scored.qualificationDecision,
                isChain ? 'EXCLUDED' : 'QUALIFIED_SANDBOX',
                String(row.id)
              );
            if (!isChain && scored.priorityScore > topScore) {
              topScore = scored.priorityScore;
              topId = String(row.id);
            }
          }
          ctx.primaryOpportunityId = topId;
          if (!topId) throw new Error('No qualified sandbox opportunity remained after scoring.');
          return `Top ranked candidate: ${topId} (score ${topScore}).`;
        },
      };
    }

    case 'market_research': {
      const output: StructuredAgentOutput = {
        summary: `[SANDBOX] Compiled market research dossier for ${safeNiche} (${safeCity}) with tagged verified, hypothesis, assumption, and unknown claims.`,
        facts: [`${safeCity} local service buyers predominantly browse and inquire on mobile devices (< 390px viewports).`],
        hypotheses: ['Clear fixed-price setup + transparent SLA exclusions reduces SMB buying friction.'],
        assumptions: ['Baseline market response rates are modeled as sandbox hypotheses pending real outreach.'],
        unknowns: ['Exact local seasonal demand peaks for selected SMB niche.'],
        risks: ['Research claims must distinguish sandbox fixture assumptions from live empirical telemetry.'],
        recommendations: ['Bind collected evidence claims to downstream feasibility & proposal stages.'],
        confidence: 0.81,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00022,
        tokensIn: 340,
        tokensOut: 210,
        domainExec: (structured) => {
          const ts = nowIso();
          const srcId = `sbx_src_${crypto.randomUUID().slice(0, 8)}`;
          ctx.db
            .prepare(
              `INSERT INTO sources (id, source_type, title, url, authors, published_at, abstract, retrieval_status, raw_metadata_json, retrieved_at)
               VALUES (?, 'SANDBOX_FIXTURE', ?, 'sandbox://fixture/local-smb-benchmark', 'NEXA Sandbox Research', ?, ?, 'SIMULATED_LOCAL', ?, ?)`
            )
            .run(
              srcId,
              `[SANDBOX] Local ${safeNiche} Digital Maturity Benchmark (${safeCity})`,
              ts.slice(0, 10),
              `Deterministic sandbox benchmark fixture evaluating responsive booking UX and fixed-price turnaround in ${safeCity}.`,
              JSON.stringify({ environmentMode: 'SANDBOX', isSimulated: true }),
              ts
            );
          const claims: Array<{ claim: string; type: 'verified' | 'hypothesis' | 'assumption' | 'unknown'; conf: number }> = [
            ...structured.facts.map((c) => ({ claim: `[SANDBOX] ${c}`, type: 'verified' as const, conf: 0.85 })),
            ...structured.hypotheses.map((c) => ({ claim: `[SANDBOX] ${c}`, type: 'hypothesis' as const, conf: 0.68 })),
            ...structured.assumptions.map((c) => ({ claim: `[SANDBOX] ${c}`, type: 'assumption' as const, conf: 0.55 })),
            ...structured.unknowns.map((c) => ({ claim: `[SANDBOX] ${c}`, type: 'unknown' as const, conf: 0.35 })),
          ];
          const insEv = ctx.db.prepare(
            `INSERT INTO evidence (mission_id, source_id, source_label, claim, evidence_type, confidence, contradiction_flag, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, 'sandbox_isolated_evidence', ?)`
          );
          for (const item of claims) {
            insEv.run(ctx.missionId, srcId, `Sandbox Research (${safeCity})`, item.claim, item.type, item.conf, ts);
          }
          return `${claims.length} structured evidence claims stored cleanly in sandbox DB.`;
        },
      };
    }

    case 'feasibility_analysis': {
      const output: StructuredAgentOutput = {
        summary: '[SANDBOX] Business feasibility confirmed at EUR 450 fixed setup + optional EUR 99/mo SLA (~EUR 252 delivery cost base).',
        facts: ['Unit economics produce ~EUR 198 estimated first-month setup margin in sandbox model before tax/payment fees.'],
        hypotheses: ['Mobile-first HTML5 storefront + CRM webhook capture can be delivered within 7 business days.'],
        assumptions: ['Operator internal engineering labor modeled at 16h @ EUR 15/h + EUR 12 sandbox/hosting allowance.'],
        unknowns: ['Client copy approval turnaround time remains an external schedule dependency.'],
        risks: ['Scope creep must be prevented by explicit exclusions for paid ad spend and third-party ERP integrations.'],
        recommendations: ['Proceed to Strategic Planning with fixed-scope MVP architecture.'],
        confidence: 0.86,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00018,
        tokensIn: 290,
        tokensOut: 180,
        domainExec: () => 'Feasibility verified: positive contribution margin with bounded delivery scope.',
      };
    }

    case 'strategic_planning': {
      const output: StructuredAgentOutput = {
        summary: `[SANDBOX] Formulated 4-milestone execution plan for ${safeNiche} (${safeCity}) under zero-external-action sandbox governance.`,
        facts: ['Milestones cover Prototype Draft, Proposal Package, Human Approval Gate, and Simulated Launch Verification.'],
        hypotheses: ['Interactive mobile preview increases prospect engagement over cold text emails.'],
        assumptions: ['Human operator reviews all commercial terms and legal placeholders prior to external launch.'],
        unknowns: ['Actual prospect channel preference (email vs phone).'],
        risks: ['Never bypass human approval gate before marking proposals SENT or publishing HTML storefronts.'],
        recommendations: ['Generate Proposal Package & Terms in Stage 6, followed by Sandbox HTML Demo in Stage 7.'],
        confidence: 0.89,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.0002,
        tokensIn: 320,
        tokensOut: 195,
        domainExec: (structured) => {
          const planId = `sbx_plan_${crypto.randomUUID().slice(0, 8)}`;
          const unitEconomics = {
            setupPriceEur: 450,
            monthlyRetainerEur: 99,
            estimatedHours: 16,
            hourlyCostEur: 15,
            infraCostEur: 12,
            estimatedDeliveryCostEur: 252,
            estimatedFirstMonthMarginEur: 198,
            currency: 'EUR',
            isSimulated: true,
          };
          const milestones = [
            { phase: 'M1', title: 'Technical Storefront Prototype Draft (Unpublished)', targetDays: 2 },
            { phase: 'M2', title: 'Proposal, Scope & Fiscal Terms Review', targetDays: 3 },
            { phase: 'M3', title: 'Mandatory Human Operator Gate Sign-off', targetDays: 5 },
            { phase: 'M4', title: 'Sandbox Validation & Telemetry Audit', targetDays: 7 },
          ];
          ctx.db
            .prepare(
              `INSERT INTO commerce_business_plans
               (id, mission_id, opportunity_id, executive_summary, feasibility_score, unit_economics_json, strategic_milestones_json, assumptions_json, environment_mode, created_at)
               VALUES (?, ?, ?, ?, 86, ?, ?, ?, 'SANDBOX', ?)`
            )
            .run(
              planId,
              ctx.missionId,
              ctx.primaryOpportunityId,
              structured.summary,
              JSON.stringify(unitEconomics),
              JSON.stringify(milestones),
              JSON.stringify(structured.assumptions),
              nowIso()
            );
          return `Business plan ${planId} persisted in isolated sandbox DB.`;
        },
      };
    }

    case 'proposal_generation': {
      const output: StructuredAgentOutput = {
        summary: '[SANDBOX] Generated structured DRAFT commercial proposal with transparent pricing, SLA exclusions, and fiscal disclosures.',
        facts: ['Proposal status locked at DRAFT with non-fiscal disclaimer and missing legal/tax placeholder checklist.'],
        hypotheses: ['Clear exclusions prevent post-sale support disputes.'],
        assumptions: ['VAT/fiscal regime details must be completed by operator before any real commercial issuance.'],
        unknowns: [],
        risks: ['Unsent draft must never transmit to third parties automatically.'],
        recommendations: ['Generate responsive HTML storefront draft cleanly in Stage 7.'],
        confidence: 0.9,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00021,
        tokensIn: 350,
        tokensOut: 210,
        domainExec: () => {
          const propId = `sbx_prop_${crypto.randomUUID().slice(0, 8)}`;
          const opp = ctx.db.prepare('SELECT * FROM commerce_opportunities WHERE id = ?').get(ctx.primaryOpportunityId) as Record<string, unknown>;
          const clientName = String(opp?.business_name || `[SANDBOX] ${safeNiche} Client`);
          const terms = buildCommercialTermsBreakdown(450, 99, ctx.language);
          const ts = nowIso();
          const outreachSubject = `[SANDBOX DRAFT — NOT SENT] Digital Storefront Prototype for ${clientName}`;
          const outreachBody = `[SANDBOX SIMULATION — NEVER TRANSMITTED]\n\nPrototype proposal prepared for ${clientName} in ${safeCity}.\nSetup: EUR 450 one-time · Optional SLA: EUR 99/mo.`;
          ctx.db
            .prepare(
              `INSERT INTO commerce_proposals
               (id, opportunity_id, title, client_name, pricing_tier, setup_price_eur, monthly_retainer_eur, estimated_delivery_cost_eur, estimated_margin_eur, deliverables_json, outreach_subject, outreach_body, whatsapp_message, commercial_terms_json, follow_up_plan_json, status, proposal_note, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'STARTER', 450, 99, 252, 198, ?, ?, ?, ?, ?, ?, 'DRAFT', 'SANDBOX_SIMULATED_DO_NOT_SEND', ?, ?)`
            )
            .run(
              propId,
              ctx.primaryOpportunityId,
              `[SANDBOX] ${clientName} — Mobile Storefront & Lead Capture Package`,
              clientName,
              JSON.stringify(terms.setupScope),
              outreachSubject,
              outreachBody,
              `[SANDBOX DRAFT] Preview available inside isolated NEXA workspace only.`,
              JSON.stringify(terms),
              JSON.stringify([{ dayOffset: 3, channel: 'sandbox_dry_run', action: 'Follow-up reminder simulated' }]),
              ts,
              ts
            );
          ctx.primaryProposalId = propId;
          return `Sandbox proposal ${propId} saved in DRAFT state.`;
        },
      };
    }

    case 'website_draft_generation': {
      const output: StructuredAgentOutput = {
        summary: '[SANDBOX] Generated isolated responsive HTML5 landing page prototype with noindex headers and disabled live form network submission.',
        facts: ['Website artifact held strictly inside sandbox SQLite memory (`DRAFT`); public hosting/publishing DENIED.'],
        hypotheses: ['390px mobile-first layout improves prospect clarity during walkthrough review.'],
        assumptions: ['Live domain DNS and SSL provisioning occur only after explicit human approval outside sandbox.'],
        unknowns: [],
        risks: ['Ensure prototype HTML cannot submit forms to external origins or index in search engines.'],
        recommendations: ['Inspect HTML prototype safely inside sandbox iframe srcDoc.'],
        confidence: 0.91,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00019,
        tokensIn: 300,
        tokensOut: 190,
        domainExec: () => {
          const siteId = `sbx_site_${crypto.randomUUID().slice(0, 8)}`;
          const opp = ctx.db.prepare('SELECT * FROM commerce_opportunities WHERE id = ?').get(ctx.primaryOpportunityId) as Record<string, unknown>;
          const brandName = String(opp?.business_name || `[SANDBOX] ${safeNiche}`);
          const html = `<!doctype html>
<html lang="${ctx.language}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeSandboxHtml(brandName)} — SANDBOX PREVIEW</title>
<style>
  body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:#0b111e; color:#f1f5f9; }
  .banner { background:#78350f; color:#fef3c7; padding:10px 16px; font-family:monospace; font-size:12px; font-weight:700; text-align:center; border-bottom:1px solid #f59e0b; }
  .hero { max-width:720px; margin:28px auto; padding:24px; background:#111726; border:1px solid #1e2534; border-radius:10px; }
  h1 { margin:0 0 8px; font-size:24px; color:#38bdf8; }
  p { color:#cbd5e1; line-height:1.5; }
  .cta { display:inline-block; margin-top:12px; padding:10px 16px; background:#06b6d4; color:#020617; font-weight:700; border-radius:6px; border:0; }
</style>
</head>
<body>
  <div class="banner">SANDBOX SIMULATION PREVIEW · NOT PUBLISHED · ZERO LIVE PAYMENTS OR OUTREACH</div>
  <main class="hero">
    <h1>${escapeSandboxHtml(brandName)}</h1>
    <p>Mobile-first digital presence prototype generated inside isolated NEXA Sandbox for ${escapeSandboxHtml(safeCity)}.</p>
    <p>Offer Scope: Fast Appointment Intake · Local SEO Hygiene · Fixed EUR 450 Setup Prototype</p>
    <form onsubmit="event.preventDefault(); document.getElementById('sbx-note').textContent='Blocked: Sandbox forms do not transmit external inquiries.';">
      <button class="cta" type="submit">Test Sandbox CTA (Local Only)</button>
      <div id="sbx-note" style="margin-top:10px;font-family:monospace;font-size:12px;color:#fbbf24;"></div>
    </form>
  </main>
</body>
</html>`;
          ctx.db
            .prepare(
              `INSERT INTO commerce_sites
               (id, brand_name, tagline, language, template, html_content, status, created_at)
               VALUES (?, ?, ?, ?, 'SANDBOX_OMEGA_V5', ?, 'DRAFT', ?)`
            )
            .run(siteId, brandName, `[SANDBOX] ${safeNiche} Preview (${safeCity})`, ctx.language, html, nowIso());
          ctx.primarySiteId = siteId;
          if (ctx.primaryProposalId) {
            ctx.db.prepare('UPDATE commerce_proposals SET site_id = ? WHERE id = ?').run(siteId, ctx.primaryProposalId);
          }
          return `Sandbox storefront draft ${siteId} generated (${html.length} bytes HTML).`;
        },
      };
    }

    case 'marketing_strategy': {
      const output: StructuredAgentOutput = {
        summary: '[SANDBOX] Drafted multi-channel GTM strategy and copy assets (`LANDING_COPY`, `EMAIL_OUTREACH`, `FOLLOW_UP_SEQ`) strictly in DRAFT status.',
        facts: ['Generated 3 sandbox marketing assets with explicit sandbox watermarks and manual-review-only flags.'],
        hypotheses: ['Value-led local audit messaging outperforms generic web design outreach.'],
        assumptions: ['All outbound emails, SMS, and paid ads remain permanently disabled in sandbox mode.'],
        unknowns: [],
        risks: ['Outbound spam or unconsented messaging must remain technically impossible from sandbox storage.'],
        recommendations: ['Submit complete deliverable bundle to Stage 9 Risk & Compliance Review.'],
        confidence: 0.87,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00018,
        tokensIn: 280,
        tokensOut: 175,
        domainExec: () => {
          const ts = nowIso();
          const channels: Array<'LANDING_COPY' | 'EMAIL_OUTREACH' | 'FOLLOW_UP_SEQ'> = ['LANDING_COPY', 'EMAIL_OUTREACH', 'FOLLOW_UP_SEQ'];
          const ins = ctx.db.prepare(
            `INSERT INTO commerce_content_assets
             (id, opportunity_id, channel, title, body, language, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?)`
          );
          for (const ch of channels) {
            ins.run(
              `sbx_cnt_${crypto.randomUUID().slice(0, 8)}`,
              ctx.primaryOpportunityId,
              ch,
              `[SANDBOX DRAFT] ${ch} — ${safeNiche} (${safeCity})`,
              `[SANDBOX SIMULATION — OUTBOUND SENDING DENIED]\nChannel: ${ch}\nMarket: ${safeCity}\nKey Offer: Mobile-first prototype ready for internal operator inspection.`,
              ctx.language,
              ts
            );
          }
          return '3 sandbox marketing draft assets persisted cleanly.';
        },
      };
    }

    case 'risk_compliance_review': {
      const output: StructuredAgentOutput = {
        summary: '[SANDBOX] Risk & Compliance review passed: RBAC verified, production DB untouched, external payments/messaging/publishing DENIED.',
        facts: [
          'Zero writes performed against production SQLite database or filesystem artifacts.',
          'All external side-effect channels (payments, email, SMS, ads, live publishing, live trading) locked DENIED.',
        ],
        hypotheses: ['Human operator approval gate prevents accidental advancement from DRAFT into execution stage.'],
        assumptions: ['Production deployment would require separate legal/VAT verification fields completed by operator.'],
        unknowns: [],
        risks: ['Low residual sandbox risk (score 14/100) — isolated in-memory fixture only.'],
        recommendations: ['Require mandatory human operator decision at Stage 10 before Stage 11 Sandbox Execution.'],
        confidence: 0.94,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00017,
        tokensIn: 270,
        tokensOut: 170,
        domainExec: () => {
          const riskId = `sbx_risk_${crypto.randomUUID().slice(0, 8)}`;
          const findings = [
            { control: 'PRODUCTION_DB_ISOLATION', status: 'PASS', detail: 'Active workload bound strictly to isolated :memory: SQLite fixture.' },
            { control: 'EXTERNAL_SIDE_EFFECT_LOCK', status: 'ENFORCED', detail: 'Payments, email, SMS, WhatsApp, publishing, ads, and live trading explicitly DENIED.' },
            { control: 'PII_AND_FISCAL_HYGIENE', status: 'PASS', detail: 'Zero real customer PII stored; non-fiscal disclaimer attached to proposal.' },
            { control: 'HUMAN_APPROVAL_GATE', status: 'REQUIRED', detail: 'Stage 11 execution blocked pending explicit operator approval.' },
          ];
          const mitigations = [
            'Gate Stage 11 behind explicit operator sign-off in approvals table.',
            'Intercept and log any external dispatch attempt via blockExternalSideEffect().',
          ];
          ctx.db
            .prepare(
              `INSERT INTO commerce_risk_evaluations
               (id, mission_id, opportunity_id, compliance_status, risk_score, external_actions_denied, findings_json, mitigations_json, environment_mode, created_at)
               VALUES (?, ?, ?, 'SANDBOX_COMPLIANT', 14, 1, ?, ?, 'SANDBOX', ?)`
            )
            .run(riskId, ctx.missionId, ctx.primaryOpportunityId, JSON.stringify(findings), JSON.stringify(mitigations), nowIso());
          return `Risk evaluation ${riskId} logged (riskScore 14/100, compliant for gated sandbox execution).`;
        },
      };
    }

    case 'human_approval_gate': {
      const output: StructuredAgentOutput = {
        summary: '[SANDBOX] Critical review complete; Stage 11+ held behind mandatory Human Approval Gate.',
        facts: ['Pending approval record queued for operator sign-off or rejection before simulated execution runs.'],
        hypotheses: [],
        assumptions: ['Stage 11 cannot execute without explicit human decision = approved.'],
        unknowns: ['Operator decision (approve vs reject).'],
        risks: ['Rejected gate permanently blocks downstream execution stages 11-14.'],
        recommendations: ['Await explicit human approval decision in UI or API.'],
        confidence: 0.92,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00014,
        tokensIn: 220,
        tokensOut: 145,
        domainExec: () => 'Pending approval gate opened; execution suspended cleanly in AWAITING_APPROVAL.',
      };
    }

    case 'sandbox_execution': {
      const output: StructuredAgentOutput = {
        summary: '[SANDBOX] Executed Stage 11 simulated commercial dry-run; all attempted real-world external side effects were intercepted & DENIED.',
        facts: [
          'Blocked real external actions: PUBLISH_WEBSITE, SEND_EMAIL, SEND_SMS, PAYMENT_INITIATION, PUBLISH_ADS, LIVE_TRADING.',
          'Verified zero mutations to production SQLite database or filesystem.',
        ],
        hypotheses: ['Sandbox dry-run validates full packaging & delivery coordination prior to human-authorized live ops.'],
        assumptions: ['Simulated funnel counters do NOT represent real revenue or external customer interactions.'],
        unknowns: [],
        risks: [],
        recommendations: ['Collect simulated telemetry in Stage 12 while keeping verifiedRealRevenueEur = 0.'],
        confidence: 0.93,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.0002,
        tokensIn: 310,
        tokensOut: 190,
        domainExec: () => {
          blockExternalSideEffect(ctx, 'sandbox_execution', 'PUBLISH_WEBSITE', `sandbox://${ctx.primarySiteId || 'site'}`, 'Site publishing permanently denied in SANDBOX mode.');
          blockExternalSideEffect(ctx, 'sandbox_execution', 'SEND_EMAIL', '[SANDBOX_REDACTED_RECIPIENT]', 'SMTP/outbound email transmission denied in SANDBOX mode.');
          blockExternalSideEffect(ctx, 'sandbox_execution', 'SEND_SMS', '[SANDBOX_REDACTED_PHONE]', 'SMS/WhatsApp transmission denied in SANDBOX mode.');
          blockExternalSideEffect(ctx, 'sandbox_execution', 'PAYMENT_INITIATION', `proposal://${ctx.primaryProposalId || 'prop'}`, 'Real payment links/charges denied in SANDBOX mode.');
          blockExternalSideEffect(ctx, 'sandbox_execution', 'PUBLISH_ADS', `${safeNiche}/${safeCity}`, 'External ad spend denied in SANDBOX mode.');
          blockExternalSideEffect(ctx, 'sandbox_execution', 'LIVE_TRADING', 'PAPER_ONLY', 'Live capital execution disabled globally & in SANDBOX.');
          return `Sandbox execution completed with ${ctx.blockedExternalActions.length} external side effects safely intercepted & denied.`;
        },
      };
    }

    case 'result_collection': {
      const output: StructuredAgentOutput = {
        summary: '[SANDBOX] Collected simulated sandbox execution outcomes while preserving strict separation from verified real revenue (€0.00).',
        facts: ['Simulated funnel projection logged with isSimulated: true; real verified payments remain €0.00.'],
        hypotheses: [],
        assumptions: ['Simulated metrics are non-financial projections from sandbox fixture execution.'],
        unknowns: [],
        risks: ['UI & API must explicitly label simulated metrics so operators never confuse them with real-world income.'],
        recommendations: ['Proceed to Stage 13 Execution Audit.'],
        confidence: 0.91,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00014,
        tokensIn: 210,
        tokensOut: 140,
        domainExec: () => {
          ctx.simulatedMetrics = {
            environmentMode: 'SANDBOX',
            isSimulated: true,
            verifiedRealRevenueEur: 0,
            verifiedRealPaymentsCount: 0,
            simulatedOpportunitiesDiscovered: 3,
            simulatedQualifiedLeads: 2,
            simulatedExcludedChains: 1,
            simulatedProjectedSetupValueEur: 450,
            simulatedEstimatedDeliveryCostEur: 252,
            simulatedEstimatedMarginEur: 198,
            blockedExternalActionsCount: ctx.blockedExternalActions.length,
            collectedAt: nowIso(),
          };
          return 'Simulated metrics gathered cleanly; verifiedRealRevenueEur = €0.00.';
        },
      };
    }

    case 'execution_audit': {
      const output: StructuredAgentOutput = {
        summary: '[SANDBOX] Execution Audit verified all 13 upstream stages, approval compliance, schema validity, budget adherence, and external blocks.',
        facts: [
          'Every stage executed within dependency order after upstream completion.',
          'All blocked external side effects recorded immutably in sandbox audit_events.',
        ],
        hypotheses: [],
        assumptions: [],
        unknowns: [],
        risks: [],
        recommendations: ['Generate Final Mission Report in Stage 14.'],
        confidence: 0.95,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00015,
        tokensIn: 230,
        tokensOut: 150,
        domainExec: () => {
          const runs = (ctx.db.prepare('SELECT COUNT(*) AS c FROM agent_runs WHERE mission_id = ?').get(ctx.missionId) as { c: number }).c;
          return `Audited ${runs} agent runs and ${ctx.blockedExternalActions.length} blocked external actions; zero policy violations.`;
        },
      };
    }

    case 'final_mission_report': {
      const output: StructuredAgentOutput = {
        summary: `[SANDBOX] End-to-End 14-Stage Autonomous Commerce Sandbox completed cleanly for ${safeNiche} (${safeCity}) with zero real-world side effects.`,
        facts: [
          'All 14 stages executed in strict dependency sequence inside an isolated :memory: SQLite fixture.',
          'Production database untouched; verified real revenue: EUR 0.00.',
        ],
        hypotheses: [],
        assumptions: [],
        unknowns: [],
        risks: [],
        recommendations: ['Use verified proposal terms & human approval workflow outside sandbox for real-world operations.'],
        confidence: 0.96,
      };
      return {
        rawJson: JSON.stringify(output),
        costUsd: 0.00018,
        tokensIn: 260,
        tokensOut: 170,
        domainExec: () => {
          ctx.finalReportMarkdown = [
            `# NEXA SANDBOX E2E COMMERCE MISSION REPORT`,
            `- **Run ID:** ${ctx.runId}`,
            `- **Mission ID:** ${ctx.missionId}`,
            `- **Environment Mode:** SANDBOX (Isolated In-Memory SQLite Fixture — Zero Production Writes)`,
            `- **Market Scope:** ${safeNiche} · ${safeCity} (${ctx.language.toUpperCase()})`,
            `- **Total Cost (Simulated Telemetry):** $${ctx.totalCostUsd.toFixed(6)} · Tokens: ${ctx.totalTokens}`,
            `- **Verified Real-World Revenue:** EUR 0.00 (Explicitly separated from simulated EUR 450 proposal draft)`,
            '',
            `## Pipeline Summary (Stages 1–14)`,
            ...ctx.stages.map((s) => `- Stage ${s.order} (${s.title}): **${s.status}** — ${s.summary || 'Pending finalization'}`),
            '',
            `## Security & External Side Effects Blocked (${ctx.blockedExternalActions.length})`,
            ...ctx.blockedExternalActions.map((b) => `- [${b.actionType}] ${b.target} -> **${b.policyResult}** (${b.reason})`),
          ].join('\n');
          return ctx.finalReportMarkdown;
        },
      };
    }
  }
}

async function executeStageRange(ctx: InternalSandboxRunContext, startIndex: number, endIndexInclusive: number): Promise<void> {
  ctx.running = true;
  try {
    for (let idx = startIndex; idx <= endIndexInclusive; idx++) {
      const stage = ctx.stages[idx];
      const spec = SANDBOX_STAGE_SPECS[idx];

      if (ctx.cancelled) {
        stage.status = 'CANCELLED';
        stage.error = 'Mission cancelled by operator before stage execution.';
        blockRemainingStages(ctx, idx, 'Cancelled by operator');
        ctx.status = 'CANCELLED';
        ctx.completedAt = nowIso();
        syncSandboxResultRow(ctx);
        return;
      }

      // Enforce upstream dependency gate: do not execute downstream stages unless all dependencies COMPLETED
      const unmetDep = spec.dependsOn.find((depId) => ctx.stages.find((s) => s.id === depId)?.status !== 'COMPLETED');
      if (unmetDep) {
        const msg = `Blocked downstream stage '${stage.id}': prerequisite '${unmetDep}' not COMPLETED.`;
        stage.status = 'BLOCKED';
        stage.error = msg;
        blockRemainingStages(ctx, idx, msg);
        ctx.status = 'FAILED';
        ctx.lastError = msg;
        ctx.failureClassification = 'internal_error';
        ctx.completedAt = nowIso();
        syncSandboxResultRow(ctx);
        return;
      }

      stage.status = 'RUNNING';
      stage.startedAt = nowIso();
      ctx.db
        .prepare("UPDATE mission_steps SET status = 'RUNNING', started_at = ? WHERE mission_id = ? AND step_order = ?")
        .run(stage.startedAt, ctx.missionId, stage.order);
      syncSandboxResultRow(ctx);

      const maxAttempts = Math.max(1, ctx.maxRetries + 1);
      let succeeded = false;
      let lastErrMsg = '';
      let lastFailureClass: FailureClassification = 'internal_error';

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (ctx.cancelled) {
          stage.status = 'CANCELLED';
          stage.error = 'Cancelled during retry loop.';
          blockRemainingStages(ctx, idx, 'Cancelled by operator');
          ctx.status = 'CANCELLED';
          ctx.completedAt = nowIso();
          syncSandboxResultRow(ctx);
          return;
        }

        stage.attempts = attempt;
        const t0 = Date.now();
        try {
          const defaultPayload = produceDeterministicStagePayload(ctx, spec);

          const workerPromise = (async () => {
            if (ctx.simulationMode === 'AGENT_FAILURE' && stage.id === 'feasibility_analysis' && attempt === 1) {
              throw new Error('Simulated transient upstream agent provider failure');
            }
            if (ctx.simulationMode === 'RETRY_EXHAUSTION' && stage.id === 'feasibility_analysis') {
              throw new Error('Simulated persistent worker failure exhausting all retries');
            }
            if (ctx.simulationMode === 'TIMEOUT' && stage.id === 'market_research') {
              await new Promise((r) => setTimeout(r, ctx.stageTimeoutMs + 80));
            }
            if (ctx.simulationMode === 'INVALID_AI_OUTPUT' && stage.id === 'strategic_planning') {
              return { rawOutput: 'bad-unstructured-tiny', costUsd: 0.0001, tokensIn: 12, tokensOut: 4 };
            }
            if (ctx.simulationMode === 'COST_CEILING_EXCEEDED' && stage.id === 'proposal_generation') {
              return { rawOutput: defaultPayload.rawJson, costUsd: ctx.maxCostUsd + 0.05, tokensIn: 10000, tokensOut: 4000 };
            }

            if (ctx.stageWorkerHook) {
              const hookRes = await ctx.stageWorkerHook({
                stage: spec,
                attempt,
                runId: ctx.runId,
                missionId: ctx.missionId,
              });
              if (hookRes) return hookRes;
            }

            return {
              rawOutput: defaultPayload.rawJson,
              costUsd: defaultPayload.costUsd,
              tokensIn: defaultPayload.tokensIn,
              tokensOut: defaultPayload.tokensOut,
            };
          })();

          const res = await runWithTimeout(workerPromise, ctx.stageTimeoutMs, spec.title);
          const latencyMs = Math.max(1, Date.now() - t0);
          const trimmed = (res.rawOutput || '').trim();
          if (trimmed.length < 15) {
            throw new Error(`Invalid AI output: stage ${stage.id} returned empty/non-substantive text (<15 chars)`);
          }
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(trimmed);
          } catch {
            throw new Error(`Invalid AI output schema: non-JSON response at stage ${stage.id}`);
          }
          const validated = AgentOutputSchema.safeParse(parsedJson);
          if (!validated.success) {
            throw new Error(`Invalid AI output schema: ${validated.error.issues[0]?.message || 'zod schema mismatch'}`);
          }

          const stepCost = Number(res.costUsd ?? defaultPayload.costUsd);
          const tIn = Number(res.tokensIn ?? defaultPayload.tokensIn);
          const tOut = Number(res.tokensOut ?? defaultPayload.tokensOut);

          ctx.totalCostUsd = Number((ctx.totalCostUsd + stepCost).toFixed(6));
          ctx.totalTokens += tIn + tOut;
          stage.costUsd = Number((stage.costUsd + stepCost).toFixed(6));
          stage.tokensUsed += tIn + tOut;
          stage.latencyMs += latencyMs;

          // Record agent_runs inside isolated sandbox DB
          ctx.db
            .prepare(
              `INSERT INTO agent_runs
               (mission_id, agent_id, provider_id, model_id, status, input_json, output_json, output_text, latency_ms, tokens_in, tokens_out, cost_usd, is_mock, created_at)
               VALUES (?, ?, 'MOCK', 'nexa-sandbox-deterministic-v1', 'SUCCESS', ?, ?, ?, ?, ?, ?, ?, 1, ?)`
            )
            .run(
              ctx.missionId,
              spec.agentId,
              JSON.stringify({ stageId: spec.id, environmentMode: 'SANDBOX', schemaValidated: true }),
              JSON.stringify(validated.data),
              trimmed,
              latencyMs,
              tIn,
              tOut,
              stepCost,
              nowIso()
            );

          // Check cost ceiling BEFORE applying domain mutations or proceeding to downstream stage
          if (ctx.maxCostUsd > 0 && ctx.totalCostUsd > ctx.maxCostUsd) {
            lastErrMsg = `Sandbox cost ceiling exceeded ($${ctx.totalCostUsd.toFixed(6)} > $${ctx.maxCostUsd.toFixed(6)} maxCostUsd)`;
            lastFailureClass = 'quota_exhausted';
            recordSandboxAudit(ctx.db, 'sandbox_kernel', 'SANDBOX_SECURITY', 'SANDBOX_COST_CEILING_EXCEEDED', {
              stageId: spec.id,
              totalCostUsd: ctx.totalCostUsd,
              maxCostUsd: ctx.maxCostUsd,
            }, ctx.missionId);
            succeeded = false;
            break;
          }

          const summaryNote = defaultPayload.domainExec(validated.data);
          stage.summary = summaryNote;
          succeeded = true;
          break;
        } catch (err) {
          const latencyMs = Math.max(1, Date.now() - t0);
          lastErrMsg = err instanceof Error ? err.message : 'Unknown sandbox worker failure';
          lastFailureClass = classifyExecutionError(lastErrMsg);
          stage.latencyMs += latencyMs;
          ctx.db
            .prepare(
              `INSERT INTO agent_runs
               (mission_id, agent_id, provider_id, model_id, status, input_json, error_message, latency_ms, tokens_in, tokens_out, cost_usd, is_mock, created_at)
               VALUES (?, ?, 'MOCK', 'nexa-sandbox-deterministic-v1', 'FAILED', ?, ?, ?, 0, 0, 0, 1, ?)`
            )
            .run(ctx.missionId, spec.agentId, JSON.stringify({ stageId: spec.id, attempt, environmentMode: 'SANDBOX' }), lastErrMsg, latencyMs, nowIso());
        }
      }

      if (!succeeded) {
        stage.status = 'FAILED';
        stage.error = lastErrMsg;
        stage.failureClassification = lastFailureClass;
        stage.completedAt = nowIso();
        ctx.db
          .prepare(
            "UPDATE mission_steps SET status = 'FAILED', retry_count = ?, failure_classification = ?, last_error = ?, completed_at = ? WHERE mission_id = ? AND step_order = ?"
          )
          .run(Math.max(0, stage.attempts - 1), lastFailureClass, lastErrMsg.slice(0, 280), stage.completedAt, ctx.missionId, stage.order);
        blockRemainingStages(ctx, idx, `Upstream stage ${stage.order} (${stage.id}) failed: ${lastErrMsg}`);
        ctx.status = 'FAILED';
        ctx.lastError = lastErrMsg;
        ctx.failureClassification = lastFailureClass;
        ctx.completedAt = nowIso();
        recordSandboxAudit(ctx.db, 'sandbox_kernel', 'SANDBOX_KERNEL', 'SANDBOX_STAGE_FAILED', {
          stageId: spec.id,
          attempts: stage.attempts,
          failureClassification: lastFailureClass,
          error: lastErrMsg,
        }, ctx.missionId);
        syncSandboxResultRow(ctx);
        return;
      }

      if (ctx.cancelled) {
        stage.status = 'CANCELLED';
        stage.error = 'Mission cancelled after stage completion.';
        blockRemainingStages(ctx, idx, 'Cancelled by operator');
        ctx.status = 'CANCELLED';
        ctx.completedAt = nowIso();
        syncSandboxResultRow(ctx);
        return;
      }

      // Stage 10 opens pending Human Approval Gate and pauses execution cleanly
      if (stage.id === 'human_approval_gate') {
        const res = ctx.db
          .prepare(
            `INSERT INTO approvals (mission_id, category, action, payload_json, status, requested_by, created_at)
             VALUES (?, 'sandbox_commerce_execution', ?, ?, 'pending', ?, ?)`
          )
          .run(
            ctx.missionId,
            `APPROVE_SANDBOX_EXECUTION_${ctx.runId.toUpperCase()}`,
            JSON.stringify({
              runId: ctx.runId,
              environmentMode: 'SANDBOX',
              opportunityId: ctx.primaryOpportunityId,
              proposalId: ctx.primaryProposalId,
              siteId: ctx.primarySiteId,
              externalPermissionsDenied: true,
            }),
            ctx.createdBy,
            nowIso()
          );
        ctx.approvalId = Number(res.lastInsertRowid);
        stage.status = 'AWAITING_APPROVAL';
        ctx.db
          .prepare("UPDATE mission_steps SET status = 'AWAITING_APPROVAL' WHERE mission_id = ? AND step_order = ?")
          .run(ctx.missionId, stage.order);
        ctx.status = 'AWAITING_APPROVAL';
        recordSandboxAudit(ctx.db, 'sandbox_kernel', 'SANDBOX_APPROVAL', 'SANDBOX_APPROVAL_REQUESTED', {
          approvalId: ctx.approvalId,
        }, ctx.missionId);
        syncSandboxResultRow(ctx);
        return;
      }

      stage.status = 'COMPLETED';
      stage.completedAt = nowIso();
      ctx.db
        .prepare("UPDATE mission_steps SET status = 'COMPLETED', retry_count = ?, completed_at = ? WHERE mission_id = ? AND step_order = ?")
        .run(Math.max(0, stage.attempts - 1), stage.completedAt, ctx.missionId, stage.order);
      syncSandboxResultRow(ctx);
    }

    if (endIndexInclusive === SANDBOX_STAGE_SPECS.length - 1) {
      ctx.status = 'COMPLETED';
      ctx.completedAt = nowIso();
      syncSandboxResultRow(ctx);
      recordSandboxAudit(ctx.db, 'sandbox_kernel', 'SANDBOX_KERNEL', 'SANDBOX_MISSION_COMPLETED', {
        totalCostUsd: ctx.totalCostUsd,
        totalTokens: ctx.totalTokens,
        blockedExternalActions: ctx.blockedExternalActions.length,
      }, ctx.missionId);
    }
  } finally {
    ctx.running = false;
    if (ctx.status === 'COMPLETED' || ctx.status === 'FAILED' || ctx.status === 'CANCELLED' || ctx.status === 'BLOCKED') {
      activeDedupeLocks.delete(ctx.dedupeKey);
    }
  }
}

export async function startSandboxMission(input: StartSandboxMissionInput) {
  const niche = (input.niche || '').trim();
  const cityOrMarket = (input.cityOrMarket || '').trim();
  if (niche.length < 3) throw new Error('Sandbox business niche must contain at least 3 characters.');
  if (cityOrMarket.length < 2) throw new Error('Sandbox target market/city must contain at least 2 characters.');

  const maxCostUsd = Number(input.maxCostUsd ?? 0.25);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0 || maxCostUsd > 50) {
    throw new Error('maxCostUsd must be between 0 and 50 USD.');
  }
  const maxRetries = Math.min(Math.max(Number(input.maxRetries ?? 1), 0), 5);
  const stageTimeoutMs = Math.min(Math.max(Number(input.stageTimeoutMs ?? 5000), 20), 60000);
  const language = input.language || 'en';
  const dedupeKey = (input.idempotencyKey || `${niche.toLowerCase()}::${cityOrMarket.toLowerCase()}::${language}`).trim();

  if (activeDedupeLocks.has(dedupeKey)) {
    throw new Error(`Duplicate active sandbox mission already running or awaiting approval for '${niche} (${cityOrMarket})'.`);
  }

  activeDedupeLocks.add(dedupeKey);

  const db = createIsolatedSandboxDatabase();
  const runId = `sbx_${crypto.randomUUID().slice(0, 10)}`;
  const missionId = `sbx_msn_${crypto.randomUUID().slice(0, 10)}`;
  const ts = nowIso();

  try {
    db.prepare(
      `INSERT INTO missions
       (id, objective, domain, status, priority, created_by, requires_approval, paid_fallback_allowed, max_retries, plan_json, created_at, updated_at)
       VALUES (?, ?, 'commerce_sandbox', 'RUNNING', 'normal', ?, 1, 0, ?, ?, ?, ?)`
    ).run(
      missionId,
      `[SANDBOX] End-to-End 14-Stage Autonomous Commerce Pipeline: ${niche} (${cityOrMarket})`,
      input.createdBy || 'operator',
      maxRetries,
      JSON.stringify({ environmentMode: 'SANDBOX', stages: SANDBOX_STAGE_SPECS.map((s) => s.id) }),
      ts,
      ts
    );

    const insStep = db.prepare(
      'INSERT INTO mission_steps (mission_id, step_order, agent_id, title, status, required) VALUES (?, ?, ?, ?, ?, 1)'
    );
    const stages: SandboxStageState[] = SANDBOX_STAGE_SPECS.map((s) => {
      const agentDef = getAgentById(s.agentId);
      insStep.run(missionId, s.order, agentDef.id, s.title, 'PENDING');
      return {
        ...s,
        status: 'PENDING',
        attempts: 0,
        costUsd: 0,
        tokensUsed: 0,
        latencyMs: 0,
        summary: null,
        error: null,
        failureClassification: null,
        startedAt: null,
        completedAt: null,
      };
    });

    const ctx: InternalSandboxRunContext = {
      runId,
      missionId,
      dedupeKey,
      db,
      niche,
      cityOrMarket,
      language,
      maxCostUsd,
      maxRetries,
      stageTimeoutMs,
      simulationMode: input.simulationMode || 'NONE',
      stageWorkerHook: input.stageWorkerHook,
      stages,
      blockedExternalActions: [],
      cancelled: false,
      running: true,
      totalCostUsd: 0,
      totalTokens: 0,
      primaryOpportunityId: null,
      primarySiteId: null,
      primaryProposalId: null,
      approvalId: null,
      finalReportMarkdown: null,
      simulatedMetrics: {
        environmentMode: 'SANDBOX',
        isSimulated: true,
        verifiedRealRevenueEur: 0,
        verifiedRealPaymentsCount: 0,
      },
      createdAt: ts,
      completedAt: null,
      lastError: null,
      failureClassification: null,
      status: 'RUNNING',
      createdBy: input.createdBy || 'operator',
    };

    sandboxRuns.set(runId, ctx);
    recordSandboxAudit(db, ctx.createdBy, 'SANDBOX_KERNEL', 'SANDBOX_MISSION_STARTED', {
      runId,
      niche,
      cityOrMarket,
      policy: SANDBOX_POLICY_LOCKS,
    }, missionId);
    syncSandboxResultRow(ctx);

    // Run Stages 1..10 (stops cleanly at Stage 10 Human Approval Gate with AWAITING_APPROVAL unless fault/cancel occurs)
    await executeStageRange(ctx, 0, 9);
    return getSandboxMissionDetails(runId)!;
  } catch (err) {
    activeDedupeLocks.delete(dedupeKey);
    throw err;
  }
}

export async function decideSandboxApproval(params: {
  runId: string;
  decision: 'approved' | 'rejected';
  decidedBy?: string;
  note?: string;
}) {
  const ctx = sandboxRuns.get(params.runId);
  if (!ctx) throw new Error(`Sandbox run not found: ${params.runId}`);
  if (ctx.status !== 'AWAITING_APPROVAL') {
    throw new Error(`Sandbox run ${params.runId} is not awaiting approval (status: ${ctx.status}).`);
  }
  if (!ctx.approvalId) throw new Error('Missing pending sandbox approval gate record.');

  const actor = params.decidedBy || 'operator';
  const note = (params.note || '').trim();
  const ts = nowIso();
  const stage10Idx = 9;
  const stage10 = ctx.stages[stage10Idx];

  const upd = ctx.db
    .prepare("UPDATE approvals SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(params.decision, actor, note || `Operator decision: ${params.decision}`, ts, ctx.approvalId);
  if (Number(upd.changes) !== 1) {
    throw new Error(`Sandbox approval #${ctx.approvalId} already decided or missing.`);
  }

  if (params.decision === 'rejected') {
    const reason = `Approval gate #${ctx.approvalId} rejected by ${actor}${note ? `: ${note}` : ''}`;
    stage10.status = 'FAILED';
    stage10.error = reason;
    stage10.completedAt = ts;
    ctx.db
      .prepare("UPDATE mission_steps SET status = 'FAILED', last_error = ?, completed_at = ? WHERE mission_id = ? AND step_order = ?")
      .run(reason.slice(0, 280), ts, ctx.missionId, stage10.order);
    blockRemainingStages(ctx, stage10Idx, reason);
    ctx.status = 'BLOCKED';
    ctx.lastError = reason;
    ctx.completedAt = ts;
    recordSandboxAudit(ctx.db, actor, 'SANDBOX_APPROVAL', 'SANDBOX_APPROVAL_REJECTED', { approvalId: ctx.approvalId, note }, ctx.missionId);
    syncSandboxResultRow(ctx);
    activeDedupeLocks.delete(ctx.dedupeKey);
    return getSandboxMissionDetails(params.runId)!;
  }

  stage10.status = 'COMPLETED';
  stage10.summary = `Approved by ${actor}${note ? ` (${note})` : ''}. Advancing to Stages 11–14 inside SANDBOX.`;
  stage10.completedAt = ts;
  ctx.db
    .prepare("UPDATE mission_steps SET status = 'COMPLETED', completed_at = ? WHERE mission_id = ? AND step_order = ?")
    .run(ts, ctx.missionId, stage10.order);
  ctx.status = 'RUNNING';
  recordSandboxAudit(ctx.db, actor, 'SANDBOX_APPROVAL', 'SANDBOX_APPROVAL_APPROVED', { approvalId: ctx.approvalId, note }, ctx.missionId);
  syncSandboxResultRow(ctx);

  await executeStageRange(ctx, 10, SANDBOX_STAGE_SPECS.length - 1);
  return getSandboxMissionDetails(params.runId)!;
}

export function cancelSandboxMission(runId: string, actor = 'operator') {
  const ctx = sandboxRuns.get(runId);
  if (!ctx) throw new Error(`Sandbox run not found: ${runId}`);
  if (ctx.status === 'COMPLETED' || ctx.status === 'CANCELLED') {
    throw new Error(`Sandbox mission ${runId} is already in terminal state ${ctx.status}.`);
  }

  ctx.cancelled = true;
  const ts = nowIso();
  for (const st of ctx.stages) {
    if (st.status === 'PENDING' || st.status === 'RUNNING' || st.status === 'AWAITING_APPROVAL') {
      st.status = 'CANCELLED';
      st.error = `Cancelled by ${actor}`;
      st.completedAt = ts;
      ctx.db
        .prepare("UPDATE mission_steps SET status = 'CANCELLED', last_error = ?, completed_at = ? WHERE mission_id = ? AND step_order = ?")
        .run(`Cancelled by ${actor}`, ts, ctx.missionId, st.order);
    }
  }
  ctx.status = 'CANCELLED';
  ctx.lastError = `Cancelled by ${actor}`;
  ctx.completedAt = ts;
  recordSandboxAudit(ctx.db, actor, 'SANDBOX_KERNEL', 'SANDBOX_MISSION_CANCELLED', { runId }, ctx.missionId);
  syncSandboxResultRow(ctx);
  activeDedupeLocks.delete(ctx.dedupeKey);
  return getSandboxMissionDetails(runId)!;
}

export function deleteSandboxMission(runId: string): { deleted: boolean } {
  const ctx = sandboxRuns.get(runId);
  if (!ctx) throw new Error(`Sandbox run not found: ${runId}`);
  if (ctx.running) throw new Error('Cannot remove an actively running sandbox mission; cancel it first.');
  activeDedupeLocks.delete(ctx.dedupeKey);
  try {
    ctx.db.close();
  } catch {
    // ignore
  }
  sandboxRuns.delete(runId);
  return { deleted: true };
}

export function listSandboxMissions() {
  const runs = Array.from(sandboxRuns.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((ctx) => ({
      runId: ctx.runId,
      missionId: ctx.missionId,
      environmentMode: 'SANDBOX' as const,
      niche: ctx.niche,
      cityOrMarket: ctx.cityOrMarket,
      language: ctx.language,
      status: ctx.status,
      completedStages: ctx.stages.filter((s) => s.status === 'COMPLETED').length,
      totalStages: ctx.stages.length,
      totalCostUsd: ctx.totalCostUsd,
      totalTokens: ctx.totalTokens,
      blockedExternalActionsCount: ctx.blockedExternalActions.length,
      approvalId: ctx.approvalId,
      createdAt: ctx.createdAt,
      completedAt: ctx.completedAt,
      lastError: ctx.lastError,
      failureClassification: ctx.failureClassification,
    }));

  return {
    policy: SANDBOX_POLICY_LOCKS,
    runs,
  };
}

export function getSandboxMissionDetails(runId: string) {
  const ctx = sandboxRuns.get(runId);
  if (!ctx) return null;

  const opportunities = ctx.db
    .prepare('SELECT * FROM commerce_opportunities ORDER BY priority_score DESC, created_at ASC')
    .all() as Array<Record<string, unknown>>;
  const sources = ctx.db.prepare('SELECT * FROM sources ORDER BY retrieved_at DESC').all() as Array<Record<string, unknown>>;
  const evidence = ctx.db.prepare('SELECT * FROM evidence ORDER BY id ASC').all() as Array<Record<string, unknown>>;
  const businessPlans = ctx.db.prepare('SELECT * FROM commerce_business_plans ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  const proposals = ctx.db.prepare('SELECT * FROM commerce_proposals ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  const sites = ctx.db.prepare('SELECT * FROM commerce_sites ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  const contentAssets = ctx.db.prepare('SELECT * FROM commerce_content_assets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  const riskEvaluations = ctx.db.prepare('SELECT * FROM commerce_risk_evaluations ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  const approvals = ctx.db.prepare('SELECT * FROM approvals ORDER BY id DESC').all() as Array<Record<string, unknown>>;
  const agentExecutions = ctx.db.prepare('SELECT * FROM agent_runs ORDER BY id ASC').all() as Array<Record<string, unknown>>;
  const auditEvents = ctx.db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 120').all() as Array<Record<string, unknown>>;
  const sandboxResult = ctx.db.prepare('SELECT * FROM commerce_sandbox_results WHERE id = ?').get(ctx.runId) as Record<string, unknown> | undefined;

  return {
    policy: SANDBOX_POLICY_LOCKS,
    run: {
      runId: ctx.runId,
      missionId: ctx.missionId,
      environmentMode: 'SANDBOX' as const,
      niche: ctx.niche,
      cityOrMarket: ctx.cityOrMarket,
      language: ctx.language,
      status: ctx.status,
      maxCostUsd: ctx.maxCostUsd,
      maxRetries: ctx.maxRetries,
      stageTimeoutMs: ctx.stageTimeoutMs,
      totalCostUsd: ctx.totalCostUsd,
      totalTokens: ctx.totalTokens,
      approvalId: ctx.approvalId,
      createdBy: ctx.createdBy,
      createdAt: ctx.createdAt,
      completedAt: ctx.completedAt,
      lastError: ctx.lastError,
      failureClassification: ctx.failureClassification,
    },
    stages: ctx.stages,
    opportunities,
    sources,
    evidence,
    businessPlans,
    proposals,
    sites,
    contentAssets,
    riskEvaluations,
    approvals,
    agentExecutions,
    auditEvents,
    blockedExternalActions: ctx.blockedExternalActions,
    simulatedMetrics: ctx.simulatedMetrics,
    sandboxResult: sandboxResult || null,
    finalReportMarkdown: ctx.finalReportMarkdown,
  };
}
