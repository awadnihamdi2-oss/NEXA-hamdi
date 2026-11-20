import { z } from 'zod';
import { routeInference, selectCandidateModels } from '../ai/router.ts';
import { listProviders } from '../ai/registry.ts';
import { getDb, nowIso, recordAuditEvent } from '../db/database.ts';
import { addEvidenceClaim, searchArxivLive } from '../research/researchEngine.ts';
import { getAgentById, SPECIALIST_AGENTS } from './agentRegistry.ts';
import type { AgentId, FailureClassification, ProviderId } from '../types/nexa.ts';

export const AgentOutputSchema = z.object({
  summary: z.string().min(5),
  facts: z.array(z.string()).default([]),
  hypotheses: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.65),
});

export type StructuredAgentOutput = z.infer<typeof AgentOutputSchema>;

export interface AgentExecutionRecord {
  agentId: AgentId;
  agentName: string;
  required: boolean;
  status: 'SUCCESS' | 'FAILED';
  providerId: ProviderId;
  modelId: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  isMock: boolean;
  structured: StructuredAgentOutput | null;
  rawText: string;
  schemaValidated?: boolean;
  error?: string;
  failureClassification?: FailureClassification;
  attempts?: number;
}

export function classifyExecutionError(rawMsg: string): FailureClassification {
  const msg = String(rawMsg || '');
  if (/\b429\b|rate.?limit|quota|too many requests/i.test(msg)) return 'rate_limit';
  if (/timed out|timeout|aborted|abort/i.test(msg)) return 'timeout';
  if (/\b401\b|\b403\b|unauthorized|authentication rejected|api key is not configured/i.test(msg)) return 'auth_error';
  if (/schema|zod|invalid|validation|at least \d+ characters/i.test(msg)) return 'validation_error';
  if (/fetch failed|econnrefused|enotfound|etimedout|eai_again|network/i.test(msg)) return 'network_error';
  return 'internal_error';
}

export function selectAgentsForMission(objective: string, domain: string, requestedAgents?: AgentId[]): AgentId[] {
  if (requestedAgents && requestedAgents.length > 0) {
    const valid = new Set(SPECIALIST_AGENTS.map((a) => a.id));
    const filtered = requestedAgents.filter((id) => valid.has(id));
    const required: AgentId[] = ['strategic_planner', 'research_agent', 'independent_critic', 'fact_verification_agent', 'final_synthesis_agent'];
    return Array.from(new Set([...filtered, ...required]));
  }

  const lower = `${domain} ${objective}`.toLowerCase();
  const pipeline: AgentId[] = ['strategic_planner', 'research_agent'];

  if (lower.includes('quant') || lower.includes('xauusd') || lower.includes('btcusd') || lower.includes('backtest') || lower.includes('trading')) {
    pipeline.push('quant_research_agent', 'mathematics_agent', 'data_analyst');
  } else if (lower.includes('commerce') || lower.includes('business') || lower.includes('website') || lower.includes('invoice') || lower.includes('lead') || lower.includes('market')) {
    pipeline.push('business_intelligence_agent', 'commerce_operations_agent');
  } else if (lower.includes('code') || lower.includes('software') || lower.includes('app') || lower.includes('api') || lower.includes('build') || lower.includes('debug')) {
    pipeline.push('programming_agent', 'security_auditor', 'quality_assurance_agent', 'documentation_agent');
  } else {
    pipeline.push('reasoning_agent', 'data_analyst', 'security_auditor');
  }

  pipeline.push('independent_critic', 'fact_verification_agent', 'final_synthesis_agent');
  return Array.from(new Set(pipeline));
}

export function planExecutionWaves(agentIds: AgentId[]): AgentId[][] {
  const remaining = new Set<AgentId>(agentIds);
  const completed = new Set<AgentId>();
  const waves: AgentId[][] = [];

  while (remaining.size > 0) {
    const ready: AgentId[] = [];
    for (const id of remaining) {
      const def = getAgentById(id);
      const depsMet = def.dependsOn.filter((dep) => remaining.has(dep) || agentIds.includes(dep)).every((dep) => completed.has(dep));
      if (depsMet) ready.push(id);
    }

    // Fallback safety break against unexpected cycles
    if (ready.length === 0) {
      waves.push(Array.from(remaining));
      break;
    }

    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      completed.add(id);
    }
  }

  return waves;
}

export function detectAgentContradictions(executions: AgentExecutionRecord[]): string[] {
  const contradictions: string[] = [];
  const polarityPairs: Array<[RegExp, RegExp, string]> = [
    [/\bprofitable\b|\bpositive\b|\bsafe\b|\bpassed\b/i, /\bunprofitable\b|\bnegative\b|\bunsafe\b|\bfailed\b/i, 'Outcome polarity divergence'],
    [/\bfeasible\b|\bready\b|\bapproved\b/i, /\binfeasible\b|\bblocked\b|\brejected\b/i, 'Feasibility / readiness conflict'],
  ];

  const successful = executions.filter((e) => e.status === 'SUCCESS' && e.structured);
  for (let i = 0; i < successful.length; i++) {
    for (let j = i + 1; j < successful.length; j++) {
      const a = successful[i];
      const b = successful[j];
      const textA = `${a.structured!.summary} ${a.structured!.facts.join(' ')}`;
      const textB = `${b.structured!.summary} ${b.structured!.facts.join(' ')}`;
      for (const [pos, neg, label] of polarityPairs) {
        if ((pos.test(textA) && neg.test(textB)) || (neg.test(textA) && pos.test(textB))) {
          contradictions.push(`${label} between ${a.agentName} and ${b.agentName}`);
        }
      }
    }
  }
  return Array.from(new Set(contradictions));
}

export function interpretGenesisObjective(objective: string) {
  const clean = objective.trim();
  const lower = clean.toLowerCase();
  let domain: 'quant' | 'software' | 'commerce' | 'research' | 'general' = 'research';
  let targetEnvironment: 'command' | 'quant' | 'commerce' | 'engineering' | 'research' | 'models' = 'command';

  if (/\b(quant|backtest|xauusd|btcusd|sharpe|drawdown|ohlcv|rsi|sma|ema|strategy|dataset)\b/i.test(lower)) {
    domain = 'quant';
    targetEnvironment = 'quant';
  } else if (/\b(code|bug|debug|typescript|python|api|architect|refactor|test|repo|build|engineer|software)\b/i.test(lower)) {
    domain = 'software';
    targetEnvironment = 'engineering';
  } else if (/\b(commerce|business|product|storefront|invoice|lead|crm|market|pricing|revenue)\b/i.test(lower)) {
    domain = 'commerce';
    targetEnvironment = 'commerce';
  } else if (/\b(model|provider|gemini|openrouter|groq|openai|anthropic|deepseek|compare|latency)\b/i.test(lower)) {
    domain = 'general';
    targetEnvironment = 'models';
  } else if (/\b(arxiv|paper|citation|evidence|research|study)\b/i.test(lower)) {
    domain = 'research';
    targetEnvironment = 'research';
  }

  const agents = selectAgentsForMission(clean, domain);
  const waves = planExecutionWaves(agents);
  const freeProvidersConfigured = listProviders()
    .filter((p) => !p.isPaidByDefault && p.configured)
    .map((p) => p.id);

  // Ambiguity detection across length, specificity, and cross-domain overlap
  const ambiguityFlags: string[] = [];
  if (clean.length < 20) {
    ambiguityFlags.push('Brief objective (< 20 chars) — execution scope inferred from domain heuristics.');
  }
  const matchedDomains = [
    /\b(quant|backtest|xauusd|btcusd|sharpe|ohlcv|rsi|sma|ema)\b/i.test(lower) ? 'quant' : null,
    /\b(code|bug|typescript|python|api|architect|refactor|test|engineer)\b/i.test(lower) ? 'engineering' : null,
    /\b(commerce|business|product|storefront|invoice|lead|crm|pricing)\b/i.test(lower) ? 'commerce' : null,
    /\b(arxiv|paper|citation|evidence|research|study)\b/i.test(lower) ? 'research' : null,
  ].filter(Boolean) as string[];

  if (matchedDomains.length > 1) {
    ambiguityFlags.push(`Cross-domain signals detected (${matchedDomains.join(' + ')}) — routed primary stage to ${domain}.`);
  }
  if (domain === 'quant' && !/\b(xauusd|btcusd|eth|csv|dataset|sma|rsi|ema|atr)\b/i.test(lower)) {
    ambiguityFlags.push('No specific ticker or indicator strategy named — default XAUUSD/SMA dataset controls will be staged.');
  }

  const selectedModelPreviews = agents.map((agentId) => {
    const def = getAgentById(agentId);
    const candidates = selectCandidateModels({ taskClass: def.taskClass, paidFallbackAllowed: false });
    const top = candidates[0] || null;
    return {
      agentId,
      agentName: def.name,
      taskClass: def.taskClass,
      providerId: top ? top.providerId : null,
      modelId: top ? top.id : null,
      mode: top ? 'FREE_ELIGIBLE' : 'OFFLINE_MOCK_FALLBACK',
    };
  });

  const clarificationPrompt =
    ambiguityFlags.length > 0
      ? 'You can run this wave schedule immediately or refine target asset, codebase stack, or verification metric above.'
      : null;

  return {
    objective: clean,
    domain,
    targetEnvironment,
    agents,
    waves,
    freeProvidersConfigured,
    requiresHumanApproval: true,
    estimatedStages: agents.length,
    ambiguityFlags,
    clarificationPrompt,
    selectedModelPreviews,
  };
}

function parseStructuredOutput(rawText: string, agentName: string): { structured: StructuredAgentOutput; schemaValidated: boolean } {
  const trimmed = rawText.trim();
  if (trimmed.length < 15) {
    throw new Error(`${agentName} returned empty or non-substantive output (<15 characters); validation failed.`);
  }
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const validated = AgentOutputSchema.safeParse(parsed);
      if (validated.success) {
        return { structured: validated.data, schemaValidated: true };
      }
    } catch {
      // fall through to structured text wrapping
    }
  }

  return {
    schemaValidated: false,
    structured: {
      summary: trimmed.slice(0, 600),
      facts: [],
      hypotheses: [`${agentName} provided narrative analysis requiring further formal verification.`],
      assumptions: [],
      unknowns: ['Model response did not conform to strict JSON AgentOutputSchema; requires independent verification.'],
      risks: [],
      recommendations: [trimmed.slice(0, 240)],
      confidence: 0.35,
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runSingleAgent(params: {
  missionId: string;
  agentId: AgentId;
  objective: string;
  context: string;
  preferredProvider?: ProviderId;
  preferredModel?: string;
  paidFallbackAllowed?: boolean;
  allowMockFallback?: boolean;
  timeoutMsOverride?: number;
}): Promise<AgentExecutionRecord> {
  const def = getAgentById(params.agentId);
  const timeoutMs = Math.max(25, params.timeoutMsOverride || def.executionLimit.timeoutMs);
  const systemPrompt = `${def.systemInstructions}
Return ONLY valid JSON matching this schema:
{
  "summary": "concise executive paragraph",
  "facts": ["strictly observed facts"],
  "hypotheses": ["testable hypotheses"],
  "assumptions": ["explicit working assumptions"],
  "unknowns": ["information gaps"],
  "risks": ["operational, technical, or security risks"],
  "recommendations": ["concrete ordered actions"],
  "confidence": 0.72
}`;

  const userPrompt = `MISSION OBJECTIVE:\n${params.objective}\n\nPRIOR CONTEXT & EVIDENCE:\n${params.context || 'None yet.'}`;

  let lastErr: unknown = null;
  let attemptsRun = 0;
  const maxAttempts = Math.max(1, (def.executionLimit.maxRetries || 0) + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsRun = attempt;
    try {
      const res = await withTimeout(
        routeInference({
          taskClass: def.taskClass,
          systemPrompt,
          userPrompt,
          maxTokens: def.executionLimit.maxTokens,
          preferredProvider: params.preferredProvider,
          preferredModel: params.preferredModel,
          missionId: params.missionId,
          paidFallbackAllowed: params.paidFallbackAllowed,
          allowMockFallback: params.allowMockFallback,
          mockHandler: () =>
            JSON.stringify({
              summary: `${def.name} offline simulation analysis for objective: ${params.objective.slice(0, 140)}`,
              facts: ['Executed in deterministic offline mock mode without live external API calls.'],
              hypotheses: [`${def.name} structured workflow validates schema compliance for ${def.taskClass}.`],
              assumptions: ['Live LLM inference requires configured provider keys.'],
              unknowns: ['Live external benchmark latency and real-world market conditions.'],
              risks: ['Mock synthesis does not substitute for live verification or human review.'],
              recommendations: [`Proceed with human-approved verification step for ${def.name}.`],
              confidence: 0.7,
            }),
        }),
        timeoutMs,
        def.name
      );

      const { structured, schemaValidated } = parseStructuredOutput(res.content, def.name);

      getDb()
        .prepare(
          `INSERT INTO agent_runs
           (mission_id, agent_id, provider_id, model_id, status, input_json, output_json, output_text, latency_ms, tokens_in, tokens_out, cost_usd, is_mock, created_at)
           VALUES (?, ?, ?, ?, 'SUCCESS', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.missionId,
          def.id,
          res.providerId,
          res.modelId,
          JSON.stringify({ objective: params.objective.slice(0, 300), attempt, schemaValidated }),
          JSON.stringify(structured),
          res.content,
          res.latencyMs,
          res.tokensIn,
          res.tokensOut,
          res.costUsd,
          res.isMock ? 1 : 0,
          nowIso()
        );

      // Persist claims into epistemic evidence table respecting memoryPolicy
      if (def.memoryPolicy !== 'ephemeral') {
        for (const f of structured.facts.slice(0, 2)) {
          if (f.trim().length >= 5) {
            addEvidenceClaim({
              missionId: params.missionId,
              sourceLabel: `${def.name} (${res.providerId}/${res.modelId})`,
              claim: f,
              evidenceType: res.isMock ? 'assumption' : 'verified',
              confidence: structured.confidence,
            });
          }
        }
        for (const h of structured.hypotheses.slice(0, 2)) {
          if (h.trim().length >= 5) {
            addEvidenceClaim({
              missionId: params.missionId,
              sourceLabel: def.name,
              claim: h,
              evidenceType: 'hypothesis',
              confidence: structured.confidence,
            });
          }
        }
      }

      return {
        agentId: def.id,
        agentName: def.name,
        required: def.requiredByDefault,
        status: 'SUCCESS',
        providerId: res.providerId,
        modelId: res.modelId,
        latencyMs: res.latencyMs,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        costUsd: res.costUsd,
        isMock: res.isMock,
        schemaValidated,
        structured,
        rawText: res.content,
        attempts: attemptsRun,
      };
    } catch (err) {
      lastErr = err;
      const cls = classifyExecutionError(err instanceof Error ? err.message : '');
      if (cls === 'auth_error' || cls === 'validation_error') {
        break;
      }
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : 'Agent execution error';
  const failureClassification = classifyExecutionError(msg);
  getDb()
    .prepare(
      `INSERT INTO agent_runs
       (mission_id, agent_id, provider_id, model_id, status, input_json, error_message, latency_ms, tokens_in, tokens_out, cost_usd, is_mock, created_at)
       VALUES (?, ?, ?, ?, 'FAILED', ?, ?, 0, 0, 0, 0, 0, ?)`
    )
    .run(
      params.missionId,
      def.id,
      params.preferredProvider || 'GEMINI',
      params.preferredModel || 'none',
      JSON.stringify({ objective: params.objective.slice(0, 300), attempts: attemptsRun, failureClassification }),
      msg.slice(0, 300),
      nowIso()
    );

  recordAuditEvent('orchestrator', 'AGENT', 'AGENT_FAILED', { agentId: def.id, error: msg, failureClassification, attempts: attemptsRun }, params.missionId);

  return {
    agentId: def.id,
    agentName: def.name,
    required: def.requiredByDefault,
    status: 'FAILED',
    providerId: params.preferredProvider || 'GEMINI',
    modelId: params.preferredModel || 'none',
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    isMock: false,
    structured: null,
    rawText: '',
    error: msg,
    failureClassification,
    attempts: attemptsRun,
  };
}

export async function gatherMissionResearchContext(missionId: string, objective: string, useLiveSearch: boolean): Promise<string> {
  if (!useLiveSearch) {
    return 'Live external arXiv search was skipped for this run; relying strictly on user prompt and verified internal records.';
  }
  const arxiv = await searchArxivLive(objective, 3, missionId);
  if (arxiv.status === 'VERIFIED_LIVE' && arxiv.papers.length > 0) {
    return (
      `LIVE ARXIV PAPERS (keywords: ${arxiv.extractedKeywords}):\n` +
      arxiv.papers.map((p) => `- ${p.title} (${p.url}): ${p.summary.slice(0, 260)}`).join('\n')
    );
  }
  return `arXiv search status: ${arxiv.status}${arxiv.errorMessage ? ` (${arxiv.errorMessage})` : ''}.`;
}
