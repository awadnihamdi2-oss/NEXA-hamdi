import { GoogleGenAI } from '@google/genai';
import { getDb, nowIso, recordAuditEvent } from '../db/database.ts';
import { redactPii } from '../security/auth.ts';
import {
  isEnvKeyConfigured,
  listModels,
  listProviders,
  upsertDiscoveredGeminiModels,
  upsertDiscoveredGroqModels,
  upsertDiscoveredOpenRouterModels,
} from './registry.ts';
import type { ProviderAvailabilityStatus, ProviderId, TaskClass } from '../types/nexa.ts';

export function sanitizeGatewayError(rawMsg: string): string {
  return redactPii(rawMsg).maskedText.slice(0, 240);
}

async function extractSanitizedUpstreamError(resp: globalThis.Response): Promise<string> {
  try {
    const text = (await resp.text()).slice(0, 1000);
    if (!text) return '';
    try {
      const parsed = JSON.parse(text) as { error?: { type?: string; message?: string } | string; message?: string };
      if (parsed.error && typeof parsed.error === 'object') {
        const parts = [parsed.error.type, parsed.error.message].filter(Boolean).join(': ');
        if (parts) return sanitizeGatewayError(parts);
      }
      if (typeof parsed.error === 'string' && parsed.error) return sanitizeGatewayError(parsed.error);
      if (parsed.message) return sanitizeGatewayError(parsed.message);
    } catch {
      // plain-text fallback
    }
    return sanitizeGatewayError(text.replace(/\s+/g, ' ').trim());
  } catch {
    return '';
  }
}

export interface GatewayCallInput {
  providerId: ProviderId;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  taskClass?: TaskClass;
  missionId?: string | null;
  mockHandler?: (input: GatewayCallInput) => string;
}

export interface GatewayCallResult {
  providerId: ProviderId;
  modelId: string;
  content: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  isMock: boolean;
  verifiedGeneration: boolean;
  timestamp: string;
}

export class GatewayHttpError extends Error {
  status: number | null;
  providerId: ProviderId;
  modelId: string;

  constructor(message: string, providerId: ProviderId, modelId: string, status: number | null = null) {
    super(message);
    this.name = 'GatewayHttpError';
    this.status = status;
    this.providerId = providerId;
    this.modelId = modelId;
  }
}

const modelCooldowns = new Map<string, number>();

export function isModelInCooldown(providerId: ProviderId, modelId: string): boolean {
  const key = `${providerId}:${modelId}`;
  const until = modelCooldowns.get(key) || 0;
  return until > Date.now();
}

export function setModelCooldown(providerId: ProviderId, modelId: string, seconds = 90): void {
  const key = `${providerId}:${modelId}`;
  const until = Date.now() + seconds * 1000;
  modelCooldowns.set(key, until);
  try {
    getDb().prepare('UPDATE provider_settings SET cooldown_until = ? WHERE id = ?').run(until, providerId);
  } catch {
    // ignore if DB not yet initialized
  }
}

export function clearCooldownsForTests(): void {
  modelCooldowns.clear();
  try {
    getDb().prepare('UPDATE provider_settings SET cooldown_until = 0').run();
  } catch {
    // ignore if DB is closed
  }
}

export function clearProviderCooldown(providerId: ProviderId, actor = 'operator'): void {
  const prefix = `${providerId}:`;
  for (const key of Array.from(modelCooldowns.keys())) {
    if (key.startsWith(prefix)) {
      modelCooldowns.delete(key);
    }
  }
  getDb()
    .prepare('UPDATE provider_settings SET cooldown_until = 0, failure_count = 0, last_error = NULL WHERE id = ?')
    .run(providerId);
  recordAuditEvent(actor, 'AI_GATEWAY', 'COOLDOWN_CLEARED', { providerId });
}

export function estimateCallCostUsd(modelId: string, tokensIn: number, tokensOut: number): number {
  try {
    const row = getDb()
      .prepare('SELECT prompt_price_per_million, completion_price_per_million, free_verified FROM model_registry WHERE id = ?')
      .get(modelId) as
      | { prompt_price_per_million: number; completion_price_per_million: number; free_verified: number }
      | undefined;
    if (!row || Number(row.free_verified) === 1) return 0;
    const promptCost = (Math.max(0, tokensIn) / 1_000_000) * Number(row.prompt_price_per_million || 0);
    const completionCost = (Math.max(0, tokensOut) / 1_000_000) * Number(row.completion_price_per_million || 0);
    return Number((promptCost + completionCost).toFixed(6));
  } catch {
    return 0;
  }
}

function getProviderSecret(providerId: ProviderId): string {
  const providers = listProviders();
  const cfg = providers.find((p) => p.id === providerId);
  if (!cfg) {
    throw new GatewayHttpError(`Unknown provider: ${providerId}`, providerId, 'none', 400);
  }
  const key = (process.env[cfg.envVar] || '').trim();
  if (!key || !isEnvKeyConfigured(cfg.envVar)) {
    throw new GatewayHttpError(`${cfg.displayName} API key is not configured in server environment (${cfg.envVar})`, providerId, 'none', null);
  }
  return key;
}

function recordModelCall(params: {
  missionId?: string | null;
  providerId: ProviderId;
  modelId: string;
  taskClass: TaskClass;
  status: 'SUCCESS' | 'FAILED';
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  isMock: boolean;
  errorMessage?: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO model_calls
     (mission_id, provider_id, model_id, task_class, status, latency_ms, tokens_in, tokens_out, cost_usd, is_mock, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.missionId ?? null,
    params.providerId,
    params.modelId,
    params.taskClass,
    params.status,
    params.latencyMs,
    params.tokensIn,
    params.tokensOut,
    params.costUsd,
    params.isMock ? 1 : 0,
    params.errorMessage ?? null,
    nowIso()
  );

  if (params.status === 'SUCCESS') {
    db.prepare(
      `UPDATE model_registry
       SET latency_avg_ms = CASE
         WHEN latency_avg_ms IS NULL THEN ?
         ELSE ROUND((latency_avg_ms * 0.7) + (? * 0.3), 1)
       END,
       updated_at = ?
       WHERE id = ?`
    ).run(params.latencyMs, params.latencyMs, nowIso(), params.modelId);
  }
}

export async function callProvider(input: GatewayCallInput): Promise<GatewayCallResult> {
  const started = Date.now();
  const taskClass = input.taskClass || 'conversational_chat';
  const maxTokens = Math.min(Math.max(input.maxTokens || 1400, 64), 8192);
  const temperature = input.temperature ?? 0.2;

  if (input.providerId === 'MOCK') {
    const text = input.mockHandler
      ? input.mockHandler(input)
      : JSON.stringify({
          mode: 'OFFLINE_MOCK_SYNTHESIS',
          summary: `Deterministic offline mock response for task ${taskClass}.`,
          facts: ['Executed via local offline mock provider without external API charges.'],
          assumptions: ['Live LLM inference was not executed in mock mode.'],
          unknowns: ['Live external API behavior requires live credentials.'],
        });
    const latencyMs = Math.max(1, Date.now() - started);
    const tokensIn = Math.ceil((input.systemPrompt.length + input.userPrompt.length) / 4);
    const tokensOut = Math.ceil(text.length / 4);
    recordModelCall({
      missionId: input.missionId,
      providerId: 'MOCK',
      modelId: input.modelId || 'nexa-offline-mock-v1',
      taskClass,
      status: 'SUCCESS',
      latencyMs,
      tokensIn,
      tokensOut,
      costUsd: 0,
      isMock: true,
    });
    return {
      providerId: 'MOCK',
      modelId: input.modelId || 'nexa-offline-mock-v1',
      content: text,
      latencyMs,
      tokensIn,
      tokensOut,
      costUsd: 0,
      isMock: true,
      verifiedGeneration: false,
      timestamp: nowIso(),
    };
  }

  try {
    if (input.providerId === 'GEMINI') {
      const apiKey = getProviderSecret('GEMINI');
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });
      const response = await Promise.race([
        ai.models.generateContent({
          model: input.modelId || 'gemini-2.5-flash',
          contents: input.userPrompt,
          config: {
            systemInstruction: input.systemPrompt,
            temperature,
            maxOutputTokens: maxTokens,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new GatewayHttpError('Gemini inference timed out after 45000ms', 'GEMINI', input.modelId || 'gemini-2.5-flash', 408)), 45000)
        ),
      ]);
      const text = (response.text || '').trim();
      if (!text) {
        throw new GatewayHttpError('Gemini returned an empty response', 'GEMINI', input.modelId, 502);
      }
      const latencyMs = Date.now() - started;
      const usage = response.usageMetadata;
      const modelId = input.modelId || 'gemini-4-hydrogen';
      const tokensIn = Number(usage?.promptTokenCount || Math.ceil((input.systemPrompt.length + input.userPrompt.length) / 4));
      const tokensOut = Number(usage?.candidatesTokenCount || Math.ceil(text.length / 4));
      const costUsd = estimateCallCostUsd(modelId, tokensIn, tokensOut);

      getDb()
        .prepare('UPDATE provider_settings SET last_verified_at = ?, last_error = NULL, cooldown_until = 0 WHERE id = ?')
        .run(nowIso(), 'GEMINI');

      recordModelCall({
        missionId: input.missionId,
        providerId: 'GEMINI',
        modelId,
        taskClass,
        status: 'SUCCESS',
        latencyMs,
        tokensIn,
        tokensOut,
        costUsd,
        isMock: false,
      });

      return {
        providerId: 'GEMINI',
        modelId,
        content: text,
        latencyMs,
        tokensIn,
        tokensOut,
        costUsd,
        isMock: false,
        verifiedGeneration: true,
        timestamp: nowIso(),
      };
    }

    // OpenAI-compatible & Anthropic HTTP adapters
    const apiKey = getProviderSecret(input.providerId);
    const providerCfg = listProviders().find((p) => p.id === input.providerId)!;

    if (input.providerId === 'ANTHROPIC') {
      const resp = await fetch(`${providerCfg.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: input.modelId,
          max_tokens: maxTokens,
          system: input.systemPrompt,
          messages: [{ role: 'user', content: input.userPrompt }],
          temperature,
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!resp.ok) {
        const detail = await extractSanitizedUpstreamError(resp);
        throw new GatewayHttpError(
          detail ? `Anthropic HTTP ${resp.status} — ${detail}` : `Anthropic HTTP ${resp.status}`,
          'ANTHROPIC',
          input.modelId,
          resp.status
        );
      }
      const data = (await resp.json()) as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      const text = (data.content || []).map((c) => c.text || '').join('').trim();
      if (!text) throw new GatewayHttpError('Empty Anthropic content', 'ANTHROPIC', input.modelId, 502);
      const latencyMs = Date.now() - started;
      const tokensIn = Number(data.usage?.input_tokens || 0);
      const tokensOut = Number(data.usage?.output_tokens || 0);
      const costUsd = estimateCallCostUsd(input.modelId, tokensIn, tokensOut);

      getDb()
        .prepare('UPDATE provider_settings SET last_verified_at = ?, last_error = NULL, cooldown_until = 0 WHERE id = ?')
        .run(nowIso(), 'ANTHROPIC');

      recordModelCall({
        missionId: input.missionId,
        providerId: 'ANTHROPIC',
        modelId: input.modelId,
        taskClass,
        status: 'SUCCESS',
        latencyMs,
        tokensIn,
        tokensOut,
        costUsd,
        isMock: false,
      });
      return {
        providerId: 'ANTHROPIC',
        modelId: input.modelId,
        content: text,
        latencyMs,
        tokensIn,
        tokensOut,
        costUsd,
        isMock: false,
        verifiedGeneration: true,
        timestamp: nowIso(),
      };
    }

    // OpenAI-compatible (OpenRouter, Groq, NVIDIA, DeepSeek, Qwen, OpenAI)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (input.providerId === 'OPENROUTER') {
      headers['HTTP-Referer'] = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'https://nexa.local';
      headers['X-Title'] = 'NEXA QUANT INTELLIGENCE';
    }

    const resp = await fetch(`${providerCfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: input.modelId,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!resp.ok) {
      const detail = await extractSanitizedUpstreamError(resp);
      throw new GatewayHttpError(
        detail ? `Provider HTTP ${resp.status} — ${detail}` : `Provider HTTP ${resp.status}`,
        input.providerId,
        input.modelId,
        resp.status
      );
    }

    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const rawContent = json.choices?.[0]?.message?.content;
    const text =
      typeof rawContent === 'string'
        ? rawContent.trim()
        : Array.isArray(rawContent)
          ? rawContent
              .filter((p) => p.type === 'text')
              .map((p) => p.text || '')
              .join('')
              .trim()
          : '';

    if (!text) {
      throw new GatewayHttpError('Provider returned empty content', input.providerId, input.modelId, 502);
    }

    const latencyMs = Date.now() - started;
    const tokensIn = Number(json.usage?.prompt_tokens || Math.ceil((input.systemPrompt.length + input.userPrompt.length) / 4));
    const tokensOut = Number(json.usage?.completion_tokens || Math.ceil(text.length / 4));
    const costUsd = estimateCallCostUsd(input.modelId, tokensIn, tokensOut);

    getDb()
      .prepare('UPDATE provider_settings SET last_verified_at = ?, last_error = NULL, cooldown_until = 0 WHERE id = ?')
      .run(nowIso(), input.providerId);

    recordModelCall({
      missionId: input.missionId,
      providerId: input.providerId,
      modelId: input.modelId,
      taskClass,
      status: 'SUCCESS',
      latencyMs,
      tokensIn,
      tokensOut,
      costUsd,
      isMock: false,
    });

    return {
      providerId: input.providerId,
      modelId: input.modelId,
      content: text,
      latencyMs,
      tokensIn,
      tokensOut,
      costUsd,
      isMock: false,
      verifiedGeneration: true,
      timestamp: nowIso(),
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const status = err instanceof GatewayHttpError ? err.status : null;
    const rawMsg = err instanceof Error ? err.message : 'Unknown gateway failure';
    const msg = sanitizeGatewayError(rawMsg);

    if (status === 408 || status === 429 || (status !== null && status >= 500) || status === 404) {
      setModelCooldown(input.providerId, input.modelId, 90);
      if (status === 404) {
        try {
          getDb().prepare('UPDATE model_registry SET enabled = 0, updated_at = ? WHERE id = ?').run(nowIso(), input.modelId);
        } catch {
          // ignore if DB not ready
        }
      }
    }

    getDb()
      .prepare('UPDATE provider_settings SET failure_count = failure_count + 1, last_error = ? WHERE id = ?')
      .run(msg, input.providerId);

    recordModelCall({
      missionId: input.missionId,
      providerId: input.providerId,
      modelId: input.modelId,
      taskClass,
      status: 'FAILED',
      latencyMs,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      isMock: false,
      errorMessage: msg,
    });

    if (err instanceof GatewayHttpError) {
      throw new GatewayHttpError(msg, err.providerId, err.modelId, err.status);
    }
    throw new GatewayHttpError(msg, input.providerId, input.modelId, status);
  }
}

export async function testProviderConnectivity(
  providerId: ProviderId,
  options?: { runInferenceProbe?: boolean; paidInferenceApproved?: boolean }
): Promise<{
  providerId: ProviderId;
  connected: boolean;
  configured: boolean;
  liveVerified: boolean;
  availabilityStatus: ProviderAvailabilityStatus;
  testMode: 'SAFE_AUTH_METADATA' | 'LIVE_INFERENCE_PROBE' | 'BLOCKED_PAID_APPROVAL' | 'UNCONFIGURED';
  message: string;
  discoveredFreeModels?: number;
}> {
  const provider = listProviders().find((p) => p.id === providerId);
  if (!provider) {
    return {
      providerId,
      connected: false,
      configured: false,
      liveVerified: false,
      availabilityStatus: 'UNCONFIGURED',
      testMode: 'UNCONFIGURED',
      message: 'Unknown provider',
    };
  }
  if (!provider.configured) {
    getDb().prepare('UPDATE provider_settings SET last_verified_at = NULL WHERE id = ?').run(providerId);
    return {
      providerId,
      connected: false,
      configured: false,
      liveVerified: false,
      availabilityStatus: 'UNCONFIGURED',
      testMode: 'UNCONFIGURED',
      message: `API key missing in server environment (${provider.envVar})`,
    };
  }

  // Never execute paid inference probe unless explicit approval is provided
  if (options?.runInferenceProbe && provider.isPaidByDefault && !options?.paidInferenceApproved) {
    return {
      providerId,
      connected: false,
      configured: true,
      liveVerified: false,
      availabilityStatus: provider.availabilityStatus || 'CONFIGURED',
      testMode: 'BLOCKED_PAID_APPROVAL',
      message: `Paid inference probe blocked for ${provider.displayName}. Explicit paid approval required, or use safe zero-cost auth/metadata test.`,
    };
  }

  const db = getDb();
  const markSuccess = (msg: string, extra?: { discoveredFreeModels?: number }, mode: 'SAFE_AUTH_METADATA' | 'LIVE_INFERENCE_PROBE' = 'SAFE_AUTH_METADATA') => {
    db.prepare('UPDATE provider_settings SET last_verified_at = ?, last_error = NULL, cooldown_until = 0 WHERE id = ?').run(nowIso(), providerId);
    recordAuditEvent('operator', 'AI_PROVIDER', 'CONNECTIVITY_VERIFIED', { providerId, mode, ...extra });
    return {
      providerId,
      connected: true,
      configured: true,
      liveVerified: true,
      availabilityStatus: (mode === 'LIVE_INFERENCE_PROBE' ? 'OPERATIONAL' : 'AUTHENTICATED') as ProviderAvailabilityStatus,
      testMode: mode,
      message: msg,
      ...extra,
    };
  };

  const markFailure = (
    rawReason: string,
    httpStatus?: number,
    mode: 'SAFE_AUTH_METADATA' | 'LIVE_INFERENCE_PROBE' = options?.runInferenceProbe ? 'LIVE_INFERENCE_PROBE' : 'SAFE_AUTH_METADATA'
  ) => {
    const reason = sanitizeGatewayError(rawReason);
    if (httpStatus === 429) {
      setModelCooldown(providerId, '*', 90);
    }
    db.prepare('UPDATE provider_settings SET last_verified_at = NULL, failure_count = failure_count + 1, last_error = ? WHERE id = ?').run(
      reason,
      providerId
    );
    const availabilityStatus: ProviderAvailabilityStatus = httpStatus === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE';
    return {
      providerId,
      connected: false,
      configured: true,
      liveVerified: false,
      availabilityStatus,
      testMode: mode,
      message: reason,
    };
  };

  try {
    const key = getProviderSecret(providerId);
    const started = Date.now();

    // Sync accessible models cleanly first for free providers so dead defaults are replaced cleanly
    if (providerId === 'GEMINI') {
      const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=30', {
        headers: {
          'x-goog-api-key': key,
          'User-Agent': 'aistudio-build',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const detail = await extractSanitizedUpstreamError(resp);
        return markFailure(
          detail ? `Gemini auth check failed with HTTP ${resp.status}: ${detail}` : `Gemini auth check failed with HTTP ${resp.status}`,
          resp.status
        );
      }
      const data = (await resp.json()) as { models?: Array<Record<string, unknown>> };
      const count = upsertDiscoveredGeminiModels(data.models || []);
      if (!options?.runInferenceProbe) {
        return markSuccess(
          `Authenticated Gemini API key verified (${count} compatible text models discovered, ${Date.now() - started}ms)`
        );
      }
    } else if (providerId === 'OPENROUTER') {
      const authResp = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!authResp.ok) {
        const detail = await extractSanitizedUpstreamError(authResp);
        return markFailure(
          detail ? `OpenRouter key authentication failed with HTTP ${authResp.status}: ${detail}` : `OpenRouter key authentication failed with HTTP ${authResp.status}`,
          authResp.status
        );
      }
      const modelsResp = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      let added = 0;
      if (modelsResp.ok) {
        const data = (await modelsResp.json()) as { data?: Array<Record<string, unknown>> };
        added = upsertDiscoveredOpenRouterModels(data.data || []);
      }
      if (!options?.runInferenceProbe) {
        return markSuccess(
          `Authenticated OpenRouter key verified (${added} free text-chat models indexed, ${Date.now() - started}ms)`,
          { discoveredFreeModels: added }
        );
      }
    } else if (providerId === 'ANTHROPIC') {
      const resp = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const detail = await extractSanitizedUpstreamError(resp);
        return markFailure(
          detail ? `Anthropic auth check failed with HTTP ${resp.status}: ${detail}` : `Anthropic auth check failed with HTTP ${resp.status}`,
          resp.status
        );
      }
      if (!options?.runInferenceProbe) {
        return markSuccess(`Authenticated Anthropic key verified via zero-cost /models endpoint (${Date.now() - started}ms)`);
      }
    } else {
      // OpenAI-compatible providers: GROQ, NVIDIA, DEEPSEEK, QWEN, OPENAI
      const resp = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const detail = await extractSanitizedUpstreamError(resp);
        return markFailure(
          detail ? `${provider.displayName} auth check failed with HTTP ${resp.status}: ${detail}` : `${provider.displayName} auth check failed with HTTP ${resp.status}`,
          resp.status
        );
      }
      const body = (await resp.json()) as { data?: Array<Record<string, unknown>> };
      const rawModels = Array.isArray(body.data) ? body.data : [];
      if (providerId === 'GROQ') {
        upsertDiscoveredGroqModels(rawModels);
      }
      if (!options?.runInferenceProbe) {
        return markSuccess(
          `Authenticated ${provider.displayName} key verified via zero-cost /models (${rawModels.length} models visible, ${Date.now() - started}ms)`
        );
      }
    }

    // Explicit inference probe: try primary and up to 2 fallback enabled models for the provider (stopping on 401/403 auth rejection)
    const fallbackProbeMap: Record<string, string[]> = {
      GEMINI: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-4-hydrogen'],
      OPENROUTER: ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'meta-llama/llama-3.3-70b-instruct:free'],
      GROQ: ['llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct'],
      NVIDIA: ['meta/llama-3.1-70b-instruct'],
      DEEPSEEK: ['deepseek-chat', 'deepseek-reasoner'],
      QWEN: ['qwen-plus'],
      OPENAI: ['gpt-4o-mini'],
      ANTHROPIC: ['claude-sonnet-4-5'],
    };

    const dbModels = listModels({ providerId, freeOnly: !provider.isPaidByDefault })
      .filter((m) => m.enabled)
      .map((m) => m.id);
    const orderedCandidates = Array.from(
      new Set([
        ...dbModels.filter((id) => /gemini-2\.5-flash|llama-3\.1-8b|llama-4|nemotron/i.test(id)),
        ...(fallbackProbeMap[providerId] || []),
        ...dbModels,
      ])
    ).slice(0, 3);

    let lastErr: unknown = null;
    for (const candidateModel of orderedCandidates) {
      try {
        const res = await callProvider({
          providerId,
          modelId: candidateModel,
          systemPrompt: 'Reply concisely with OK.',
          userPrompt: 'Connectivity probe.',
          maxTokens: 64,
          taskClass: 'conversational_chat',
        });
        return markSuccess(
          `Authenticated live inference probe passed via ${res.modelId} (${res.latencyMs}ms)`,
          undefined,
          'LIVE_INFERENCE_PROBE'
        );
      } catch (err) {
        lastErr = err;
        const st = err instanceof GatewayHttpError ? err.status : null;
        if (st === 401 || st === 403) break;
      }
    }
    const lastMsg = lastErr instanceof Error ? lastErr.message : 'Live inference probe failed across candidate models';
    const lastStatus = lastErr instanceof GatewayHttpError && lastErr.status !== null ? lastErr.status : undefined;
    return markFailure(lastMsg, lastStatus, 'LIVE_INFERENCE_PROBE');
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Connectivity test failed';
    return markFailure(rawMsg);
  }
}
