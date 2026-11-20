import { getDb } from '../db/database.ts';
import { callProvider, GatewayHttpError, isModelInCooldown, type GatewayCallInput, type GatewayCallResult } from './gateway.ts';
import { isModelEligibleFreeChat, listModels, listProviders } from './registry.ts';
import type { ModelCatalogEntry, ProviderId, TaskClass } from '../types/nexa.ts';

export interface RouteRequest {
  taskClass: TaskClass;
  systemPrompt: string;
  userPrompt: string;
  preferredProvider?: ProviderId;
  preferredModel?: string;
  maxTokens?: number;
  temperature?: number;
  missionId?: string | null;
  paidFallbackAllowed?: boolean;
  allowMockFallback?: boolean;
  mockHandler?: (input: GatewayCallInput) => string;
}

export interface RouteResult extends GatewayCallResult {
  routePolicy: 'FREE_ONLY' | 'PAID_APPROVED' | 'OFFLINE_MOCK';
  attempts: number;
  failures: Array<{ providerId: ProviderId; modelId: string; status: number | null; error: string }>;
}

export function isPaidFallbackEnabledGlobally(): boolean {
  const row = getDb().prepare("SELECT value_json FROM system_settings WHERE key = 'automatic_paid_fallback'").get() as
    | { value_json: string }
    | undefined;
  if (!row) return false;
  try {
    return JSON.parse(row.value_json) === true;
  } catch {
    return false;
  }
}

export function selectCandidateModels(opts: {
  taskClass: TaskClass;
  preferredProvider?: ProviderId;
  preferredModel?: string;
  paidFallbackAllowed?: boolean;
}): ModelCatalogEntry[] {
  const providers = new Map(listProviders().map((p) => [p.id, p]));
  const allModels = listModels();
  const allowPaid = Boolean(opts.paidFallbackAllowed) && isPaidFallbackEnabledGlobally();

  const eligible = allModels.filter((m) => {
    const prov = providers.get(m.providerId);
    if (!prov || !prov.enabled || !prov.configured) return false;
    if (!m.enabled) return false;
    if (isModelInCooldown(m.providerId, m.id)) return false;

    if (!allowPaid) {
      if (prov.isPaidByDefault) return false;
      if (!isModelEligibleFreeChat(m)) return false;
    }
    return true;
  });

  const statusRank = (status?: string) => {
    if (status === 'OPERATIONAL') return 3;
    if (status === 'AUTHENTICATED') return 2;
    if (status === 'CONFIGURED') return 1;
    return 0;
  };

  // Sort by preference, live operational status, task match, proven latency, free priority, context window
  eligible.sort((a, b) => {
    if (opts.preferredModel) {
      if (a.id === opts.preferredModel && b.id !== opts.preferredModel) return -1;
      if (b.id === opts.preferredModel && a.id !== opts.preferredModel) return 1;
    }
    if (opts.preferredProvider) {
      if (a.providerId === opts.preferredProvider && b.providerId !== opts.preferredProvider) return -1;
      if (b.providerId === opts.preferredProvider && a.providerId !== opts.preferredProvider) return 1;
    }
    const aStatus = statusRank(providers.get(a.providerId)?.availabilityStatus);
    const bStatus = statusRank(providers.get(b.providerId)?.availabilityStatus);
    if (aStatus !== bStatus) return bStatus - aStatus;

    const aProven = a.latencyAvgMs !== null ? 1 : 0;
    const bProven = b.latencyAvgMs !== null ? 1 : 0;
    if (aProven !== bProven) return bProven - aProven;

    const aTask = a.recommendedTasks.includes(opts.taskClass) ? 1 : 0;
    const bTask = b.recommendedTasks.includes(opts.taskClass) ? 1 : 0;
    if (aTask !== bTask) return bTask - aTask;

    if (a.freeVerified !== b.freeVerified) return a.freeVerified ? -1 : 1;
    return b.contextWindow - a.contextWindow;
  });

  return eligible;
}

export async function routeInference(req: RouteRequest): Promise<RouteResult> {
  const allowPaid = Boolean(req.paidFallbackAllowed) && isPaidFallbackEnabledGlobally();
  const candidates = selectCandidateModels({
    taskClass: req.taskClass,
    preferredProvider: req.preferredProvider,
    preferredModel: req.preferredModel,
    paidFallbackAllowed: allowPaid,
  });

  const failures: Array<{ providerId: ProviderId; modelId: string; status: number | null; error: string }> = [];
  let attempts = 0;

  // Diversify across providers: max 2 consecutive model failures per provider unless user explicitly pinned a provider
  const selectedPool: ModelCatalogEntry[] = [];
  const perProviderCount = new Map<ProviderId, number>();
  for (const cand of candidates) {
    const cnt = perProviderCount.get(cand.providerId) || 0;
    const cap = req.preferredProvider === cand.providerId ? 4 : 2;
    if (cnt >= cap) continue;
    perProviderCount.set(cand.providerId, cnt + 1);
    selectedPool.push(cand);
    if (selectedPool.length >= 6) break;
  }

  for (const candidate of selectedPool) {
    attempts += 1;
    try {
      const res = await callProvider({
        providerId: candidate.providerId,
        modelId: candidate.id,
        systemPrompt: req.systemPrompt,
        userPrompt: req.userPrompt,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        taskClass: req.taskClass,
        missionId: req.missionId,
      });

      return {
        ...res,
        routePolicy: allowPaid && !candidate.freeVerified ? 'PAID_APPROVED' : 'FREE_ONLY',
        attempts,
        failures,
      };
    } catch (err) {
      const status = err instanceof GatewayHttpError ? err.status : null;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      failures.push({
        providerId: candidate.providerId,
        modelId: candidate.id,
        status,
        error: msg.slice(0, 200),
      });

      // Ported NEXA 1.1 invariant: 401/403 stops automatic fallback immediately for that credential
      if (status === 401 || status === 403) {
        throw new GatewayHttpError(
          `Authentication rejected by ${candidate.providerId}; automatic fallback stopped cleanly`,
          candidate.providerId,
          candidate.id,
          status
        );
      }
    }
  }

  // Only use deterministic offline mock if caller explicitly opted in (e.g., offline tests or explicit offline simulation mode)
  if (req.allowMockFallback) {
    const mockRes = await callProvider({
      providerId: 'MOCK',
      modelId: 'nexa-offline-mock-v1',
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      taskClass: req.taskClass,
      missionId: req.missionId,
      mockHandler: req.mockHandler,
    });
    return {
      ...mockRes,
      routePolicy: 'OFFLINE_MOCK',
      attempts: attempts + 1,
      failures,
    };
  }

  throw new GatewayHttpError(
    candidates.length === 0
      ? 'No eligible free AI provider is currently configured. Set GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, or NVIDIA_API_KEY in server environment, or enable explicit Offline Mock Mode for dry-run simulation.'
      : `All ${attempts} eligible free candidates failed without paid fallback.`,
    req.preferredProvider || 'GEMINI',
    req.preferredModel || 'gemini-4-hydrogen',
    null
  );
}
