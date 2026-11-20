import { getDb, nowIso, recordAuditEvent } from '../db/database.ts';
import type { ModelCatalogEntry, ProviderAvailabilityStatus, ProviderConfig, ProviderId, TaskClass } from '../types/nexa.ts';

const DEFAULT_PROVIDERS: Array<Omit<ProviderConfig, 'configured' | 'keyValueExposed' | 'cooldownUntil' | 'failureCount' | 'lastError' | 'lastVerifiedAt'>> = [
  {
    id: 'GEMINI',
    displayName: 'Google Gemini (Server SDK)',
    baseUrl: 'https://generativelanguage.googleapis.com',
    envVar: 'GEMINI_API_KEY',
    protocol: 'gemini_sdk',
    isPaidByDefault: false,
    enabled: true,
  },
  {
    id: 'OPENROUTER',
    displayName: 'OpenRouter Free & Unified',
    baseUrl: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    protocol: 'openai_compat',
    isPaidByDefault: false,
    enabled: true,
  },
  {
    id: 'GROQ',
    displayName: 'Groq LPU Inference',
    baseUrl: 'https://api.groq.com/openai/v1',
    envVar: 'GROQ_API_KEY',
    protocol: 'openai_compat',
    isPaidByDefault: false,
    enabled: true,
  },
  {
    id: 'NVIDIA',
    displayName: 'NVIDIA NIM Free Endpoints',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envVar: 'NVIDIA_API_KEY',
    protocol: 'openai_compat',
    isPaidByDefault: false,
    enabled: true,
  },
  {
    id: 'DEEPSEEK',
    displayName: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com/v1',
    envVar: 'DEEPSEEK_API_KEY',
    protocol: 'openai_compat',
    isPaidByDefault: true,
    enabled: false,
  },
  {
    id: 'QWEN',
    displayName: 'Qwen DashScope Compatible',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envVar: 'QWEN_API_KEY',
    protocol: 'openai_compat',
    isPaidByDefault: true,
    enabled: false,
  },
  {
    id: 'OPENAI',
    displayName: 'OpenAI API (Paid)',
    baseUrl: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    protocol: 'openai_compat',
    isPaidByDefault: true,
    enabled: false,
  },
  {
    id: 'ANTHROPIC',
    displayName: 'Anthropic Claude API (Paid)',
    baseUrl: 'https://api.anthropic.com/v1',
    envVar: 'ANTHROPIC_API_KEY',
    protocol: 'anthropic',
    isPaidByDefault: true,
    enabled: false,
  },
];

const DEFAULT_MODELS: Array<Omit<ModelCatalogEntry, 'latencyAvgMs'>> = [
  {
    id: 'gemini-4-hydrogen',
    providerId: 'GEMINI',
    displayName: 'Gemini 4 Hydrogen (Fast General Intelligence)',
    contextWindow: 1000000,
    inputModalities: ['text', 'image', 'audio'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsJson: true,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    freeVerified: true,
    enabled: true,
    recommendedTasks: [
      'strategic_planning',
      'research_synthesis',
      'deep_reasoning',
      'software_engineering',
      'quantitative_math',
      'data_analysis',
      'security_audit',
      'adversarial_critic',
      'fact_verification',
      'commerce_operations',
      'conversational_chat',
    ],
  },
  {
    id: 'gemini-2.5-flash',
    providerId: 'GEMINI',
    displayName: 'Gemini 2.5 Flash (Fallback)',
    contextWindow: 1000000,
    inputModalities: ['text', 'image', 'audio'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsJson: true,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    freeVerified: true,
    enabled: true,
    recommendedTasks: [
      'strategic_planning',
      'research_synthesis',
      'deep_reasoning',
      'software_engineering',
      'data_analysis',
      'fact_verification',
      'commerce_operations',
      'conversational_chat',
    ],
  },
  {
    id: 'gemini-2.5-flash-lite',
    providerId: 'GEMINI',
    displayName: 'Gemini 2.5 Flash-Lite (Fast Free Tier)',
    contextWindow: 1000000,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsJson: true,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    freeVerified: true,
    enabled: true,
    recommendedTasks: ['conversational_chat', 'research_synthesis', 'commerce_operations', 'fact_verification'],
  },
  {
    id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    providerId: 'OPENROUTER',
    displayName: 'NVIDIA Nemotron 3 Nano Reasoning (:free)',
    contextWindow: 128000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsJson: true,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    freeVerified: true,
    enabled: true,
    recommendedTasks: ['deep_reasoning', 'quantitative_math', 'adversarial_critic', 'fact_verification'],
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    providerId: 'OPENROUTER',
    displayName: 'Llama 3.3 70B Instruct (:free)',
    contextWindow: 131072,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsJson: true,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    freeVerified: true,
    enabled: true,
    recommendedTasks: ['strategic_planning', 'research_synthesis', 'software_engineering', 'commerce_operations'],
  },
  {
    id: 'qwen/qwen-2.5-coder-32b-instruct:free',
    providerId: 'OPENROUTER',
    displayName: 'Qwen 2.5 Coder 32B (:free)',
    contextWindow: 32768,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: false,
    supportsJson: true,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    freeVerified: true,
    enabled: true,
    recommendedTasks: ['software_engineering', 'security_audit'],
  },
  {
    id: 'llama-3.3-70b-versatile',
    providerId: 'GROQ',
    displayName: 'Groq Llama 3.3 70B Versatile',
    contextWindow: 128000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsJson: true,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    freeVerified: true,
    enabled: true,
    recommendedTasks: ['conversational_chat', 'strategic_planning', 'data_analysis', 'commerce_operations'],
  },
  {
    id: 'meta/llama-3.1-70b-instruct',
    providerId: 'NVIDIA',
    displayName: 'NVIDIA NIM Llama 3.1 70B Instruct',
    contextWindow: 128000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsJson: true,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    freeVerified: true,
    enabled: true,
    recommendedTasks: ['deep_reasoning', 'quantitative_math', 'research_synthesis'],
  },
  {
    id: 'deepseek-reasoner',
    providerId: 'DEEPSEEK',
    displayName: 'DeepSeek Reasoner (Metered)',
    contextWindow: 64000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: false,
    supportsJson: true,
    promptPricePerMillion: 0.55,
    completionPricePerMillion: 2.19,
    freeVerified: false,
    enabled: false,
    recommendedTasks: ['deep_reasoning', 'quantitative_math'],
  },
  {
    id: 'qwen-plus',
    providerId: 'QWEN',
    displayName: 'Qwen Plus (Metered)',
    contextWindow: 131072,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsJson: true,
    promptPricePerMillion: 0.4,
    completionPricePerMillion: 1.2,
    freeVerified: false,
    enabled: false,
    recommendedTasks: ['software_engineering', 'data_analysis'],
  },
  {
    id: 'gpt-4o-mini',
    providerId: 'OPENAI',
    displayName: 'OpenAI GPT-4o Mini (Paid)',
    contextWindow: 128000,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsJson: true,
    promptPricePerMillion: 0.15,
    completionPricePerMillion: 0.6,
    freeVerified: false,
    enabled: false,
    recommendedTasks: ['strategic_planning', 'software_engineering'],
  },
  {
    id: 'claude-sonnet-4-5',
    providerId: 'ANTHROPIC',
    displayName: 'Anthropic Claude Sonnet (Paid)',
    contextWindow: 200000,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsJson: true,
    promptPricePerMillion: 3.0,
    completionPricePerMillion: 15.0,
    freeVerified: false,
    enabled: false,
    recommendedTasks: ['software_engineering', 'adversarial_critic', 'security_audit'],
  },
];

export function ensureRegistrySeeded(): void {
  const db = getDb();
  const ts = nowIso();

  const insertProvider = db.prepare(
    `INSERT OR IGNORE INTO provider_settings
     (id, display_name, base_url, env_var, protocol, is_paid_by_default, enabled, cooldown_until, failure_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`
  );

  for (const p of DEFAULT_PROVIDERS) {
    insertProvider.run(p.id, p.displayName, p.baseUrl, p.envVar, p.protocol, p.isPaidByDefault ? 1 : 0, p.enabled ? 1 : 0);
  }

  const insertModel = db.prepare(
    `INSERT OR IGNORE INTO model_registry
     (id, provider_id, display_name, context_window, input_modalities_json, output_modalities_json,
      supports_tools, supports_json, prompt_price_per_million, completion_price_per_million,
      free_verified, enabled, recommended_tasks_json, latency_avg_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  );

  for (const m of DEFAULT_MODELS) {
    insertModel.run(
      m.id,
      m.providerId,
      m.displayName,
      m.contextWindow,
      JSON.stringify(m.inputModalities),
      JSON.stringify(m.outputModalities),
      m.supportsTools ? 1 : 0,
      m.supportsJson ? 1 : 0,
      m.promptPricePerMillion,
      m.completionPricePerMillion,
      m.freeVerified ? 1 : 0,
      m.enabled ? 1 : 0,
      JSON.stringify(m.recommendedTasks),
      ts
    );
  }
}

export function isEnvKeyConfigured(envVar: string): boolean {
  const val = (process.env[envVar] || '').trim();
  if (!val) return false;
  if (val === 'MY_GEMINI_API_KEY' || val === 'MY_APP_URL') return false;
  return val.length >= 8;
}

export function listProviders(): ProviderConfig[] {
  ensureRegistrySeeded();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM provider_settings ORDER BY is_paid_by_default ASC, id ASC').all() as Array<
    Record<string, unknown>
  >;
  const liveSuccessRows = db
    .prepare("SELECT DISTINCT provider_id FROM model_calls WHERE status = 'SUCCESS' AND is_mock = 0")
    .all() as Array<{ provider_id: string }>;
  const operationalProviders = new Set(liveSuccessRows.map((r) => r.provider_id));
  const nowMs = Date.now();

  return rows.map((r) => {
    const id = r.id as ProviderId;
    const configured = isEnvKeyConfigured(String(r.env_var));
    const enabled = Number(r.enabled) === 1;
    const cooldownUntil = Number(r.cooldown_until || 0);
    const lastError = r.last_error ? String(r.last_error) : null;
    const lastVerifiedAt = r.last_verified_at ? String(r.last_verified_at) : null;

    let availabilityStatus: ProviderAvailabilityStatus = 'CONFIGURED';
    if (!configured) {
      availabilityStatus = 'UNCONFIGURED';
    } else if (cooldownUntil > nowMs) {
      availabilityStatus = /429|rate.?limit/i.test(lastError || '') ? 'RATE_LIMITED' : 'UNAVAILABLE';
    } else if (/HTTP 401|HTTP 403|authentication rejected/i.test(lastError || '')) {
      availabilityStatus = 'UNAVAILABLE';
    } else if (!enabled) {
      availabilityStatus = 'CONFIGURED';
    } else if (operationalProviders.has(id)) {
      availabilityStatus = 'OPERATIONAL';
    } else if (lastVerifiedAt) {
      availabilityStatus = 'AUTHENTICATED';
    }

    return {
      id,
      displayName: String(r.display_name),
      baseUrl: String(r.base_url),
      envVar: String(r.env_var),
      protocol: r.protocol as ProviderConfig['protocol'],
      isPaidByDefault: Number(r.is_paid_by_default) === 1,
      enabled,
      configured,
      keyValueExposed: false,
      cooldownUntil,
      failureCount: Number(r.failure_count || 0),
      lastError,
      lastVerifiedAt,
      availabilityStatus,
    };
  });
}

export function setProviderEnabled(providerId: ProviderId, enabled: boolean, actor = 'operator'): ProviderConfig {
  ensureRegistrySeeded();
  const db = getDb();
  const res = db.prepare('UPDATE provider_settings SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, providerId);
  if (Number(res.changes) === 0) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  recordAuditEvent(actor, 'AI_PROVIDER', 'PROVIDER_TOGGLED', { providerId, enabled });
  const found = listProviders().find((p) => p.id === providerId);
  if (!found) throw new Error(`Provider not found: ${providerId}`);
  return found;
}

export function listModels(filters?: { providerId?: ProviderId; freeOnly?: boolean; taskClass?: TaskClass }): ModelCatalogEntry[] {
  ensureRegistrySeeded();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM model_registry ORDER BY free_verified DESC, context_window DESC, id ASC').all() as Array<
    Record<string, unknown>
  >;

  let models: ModelCatalogEntry[] = rows.map((r) => ({
    id: String(r.id),
    providerId: r.provider_id as ProviderId,
    displayName: String(r.display_name),
    contextWindow: Number(r.context_window),
    inputModalities: JSON.parse(String(r.input_modalities_json)) as string[],
    outputModalities: JSON.parse(String(r.output_modalities_json)) as string[],
    supportsTools: Number(r.supports_tools) === 1,
    supportsJson: Number(r.supports_json) === 1,
    promptPricePerMillion: Number(r.prompt_price_per_million),
    completionPricePerMillion: Number(r.completion_price_per_million),
    freeVerified: Number(r.free_verified) === 1,
    enabled: Number(r.enabled) === 1,
    recommendedTasks: JSON.parse(String(r.recommended_tasks_json)) as TaskClass[],
    latencyAvgMs: r.latency_avg_ms !== null && r.latency_avg_ms !== undefined ? Number(r.latency_avg_ms) : null,
  }));

  if (filters?.providerId) {
    models = models.filter((m) => m.providerId === filters.providerId);
  }
  if (filters?.freeOnly) {
    models = models.filter(
      (m) => m.freeVerified && m.promptPricePerMillion === 0 && m.completionPricePerMillion === 0
    );
  }
  if (filters?.taskClass) {
    const task = filters.taskClass;
    models = models.filter((m) => m.recommendedTasks.includes(task));
  }

  return models;
}

export function setModelEnabled(modelId: string, enabled: boolean, actor = 'operator'): ModelCatalogEntry {
  ensureRegistrySeeded();
  const db = getDb();
  const res = db.prepare('UPDATE model_registry SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowIso(), modelId);
  if (Number(res.changes) === 0) {
    throw new Error(`Unknown model: ${modelId}`);
  }
  recordAuditEvent(actor, 'AI_MODEL', 'MODEL_TOGGLED', { modelId, enabled });
  const found = listModels().find((m) => m.id === modelId);
  if (!found) throw new Error(`Model not found: ${modelId}`);
  return found;
}

export function isModelEligibleFreeChat(item: {
  id: string;
  providerId: ProviderId;
  promptPricePerMillion: number;
  completionPricePerMillion: number;
  inputModalities: string[];
  outputModalities: string[];
  freeVerified: boolean;
}): boolean {
  if (!item.freeVerified) return false;
  if (item.promptPricePerMillion !== 0 || item.completionPricePerMillion !== 0) return false;
  if (!item.inputModalities.includes('text') || !item.outputModalities.includes('text')) return false;
  if (item.providerId === 'OPENROUTER' && !item.id.endsWith(':free')) return false;
  return true;
}

export function upsertDiscoveredOpenRouterModels(rawItems: Array<Record<string, unknown>>): number {
  ensureRegistrySeeded();
  const db = getDb();
  const ts = nowIso();
  const upsert = db.prepare(
    `INSERT INTO model_registry
     (id, provider_id, display_name, context_window, input_modalities_json, output_modalities_json,
      supports_tools, supports_json, prompt_price_per_million, completion_price_per_million,
      free_verified, enabled, recommended_tasks_json, latency_avg_ms, updated_at)
     VALUES (?, 'OPENROUTER', ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name=excluded.display_name,
       context_window=excluded.context_window,
       input_modalities_json=excluded.input_modalities_json,
       output_modalities_json=excluded.output_modalities_json,
       prompt_price_per_million=excluded.prompt_price_per_million,
       completion_price_per_million=excluded.completion_price_per_million,
       free_verified=excluded.free_verified,
       updated_at=excluded.updated_at`
  );

  let inserted = 0;
  for (const item of rawItems) {
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id.endsWith(':free')) continue;

    const pricing = (item.pricing as Record<string, unknown> | undefined) || {};
    const pPrompt = Number(pricing.prompt);
    const pComp = Number(pricing.completion);
    if (pPrompt !== 0 || pComp !== 0) continue;

    const arch = (item.architecture as Record<string, unknown> | undefined) || {};
    let inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities.map(String) : [];
    let outputs = Array.isArray(arch.output_modalities) ? arch.output_modalities.map(String) : [];
    if (inputs.length === 0 && typeof arch.modality === 'string' && arch.modality.includes('->')) {
      const [left, right] = arch.modality.split('->');
      if (left.includes('text')) inputs = ['text'];
      if (right.includes('text')) outputs = ['text'];
    }
    if (!inputs.includes('text') || !outputs.includes('text')) continue;

    const ctx = Number(item.context_length || 32768);
    const name = typeof item.name === 'string' ? item.name : id;
    const tasks: TaskClass[] = ['research_synthesis', 'deep_reasoning', 'conversational_chat', 'strategic_planning'];

    upsert.run(id, name, ctx, JSON.stringify(inputs), JSON.stringify(outputs), 0, 0, 0, 1, JSON.stringify(tasks), ts);
    inserted++;
    if (inserted >= 25) break;
  }

  return inserted;
}

export function upsertDiscoveredGeminiModels(rawItems: Array<Record<string, unknown>>): number {
  ensureRegistrySeeded();
  const db = getDb();
  const ts = nowIso();
  const upsert = db.prepare(
    `INSERT INTO model_registry
     (id, provider_id, display_name, context_window, input_modalities_json, output_modalities_json,
      supports_tools, supports_json, prompt_price_per_million, completion_price_per_million,
      free_verified, enabled, recommended_tasks_json, latency_avg_ms, updated_at)
     VALUES (?, 'GEMINI', ?, ?, '["text"]', '["text"]', 1, 1, 0, 0, 1, 1, ?, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name=excluded.display_name,
       context_window=excluded.context_window,
       updated_at=excluded.updated_at`
  );

  let count = 0;
  for (const item of rawItems) {
    const rawName = typeof item.name === 'string' ? item.name : '';
    const id = rawName.replace(/^models\//, '').trim();
    if (!id) continue;
    const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods.map(String) : [];
    if (!methods.includes('generateContent')) continue;
    if (/embedding|aqa|imagen|image|veo|tts|audio|live|computer-use|robotics/i.test(id)) continue;

    const displayName = typeof item.displayName === 'string' && item.displayName ? item.displayName : id;
    const ctx = Number(item.inputTokenLimit || 1000000);
    const tasks: TaskClass[] = ['strategic_planning', 'research_synthesis', 'commerce_operations', 'conversational_chat', 'fact_verification'];
    upsert.run(id, displayName, ctx, JSON.stringify(tasks), ts);
    count++;
    if (count >= 12) break;
  }
  return count;
}

export function upsertDiscoveredGroqModels(rawItems: Array<Record<string, unknown>>): number {
  ensureRegistrySeeded();
  const db = getDb();
  const ts = nowIso();
  const upsert = db.prepare(
    `INSERT INTO model_registry
     (id, provider_id, display_name, context_window, input_modalities_json, output_modalities_json,
      supports_tools, supports_json, prompt_price_per_million, completion_price_per_million,
      free_verified, enabled, recommended_tasks_json, latency_avg_ms, updated_at)
     VALUES (?, 'GROQ', ?, ?, '["text"]', '["text"]', 1, 1, 0, 0, 1, 1, ?, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name=excluded.display_name,
       context_window=excluded.context_window,
       enabled=1,
       updated_at=excluded.updated_at`
  );

  const activeIds = new Set<string>();
  let count = 0;
  for (const item of rawItems) {
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    if (/whisper|guard|tts|playai|orpheus|safeguard|prompt-guard/i.test(id)) continue;
    activeIds.add(id);
    const ctx = Number(item.context_window || 32768);
    const tasks: TaskClass[] = ['conversational_chat', 'research_synthesis', 'strategic_planning', 'commerce_operations'];
    upsert.run(id, `Groq ${id}`, ctx, JSON.stringify(tasks), ts);
    count++;
    if (count >= 15) break;
  }

  // Disable stale hardcoded Groq models that the current API key cannot access (prevents recurring 404s)
  if (activeIds.size > 0) {
    const existing = db.prepare("SELECT id FROM model_registry WHERE provider_id = 'GROQ'").all() as Array<{ id: string }>;
    for (const row of existing) {
      if (!activeIds.has(row.id)) {
        db.prepare('UPDATE model_registry SET enabled = 0, updated_at = ? WHERE id = ?').run(ts, row.id);
      }
    }
  }
  return count;
}
