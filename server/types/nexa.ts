export type Role = 'admin' | 'operator' | 'researcher' | 'viewer';

export type MissionStatus =
  | 'CREATED'
  | 'PLANNED'
  | 'RUNNING'
  | 'PAUSED'
  | 'RETRYING'
  | 'AWAITING_APPROVAL'
  | 'REVIEWING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

export type FailureClassification =
  | 'rate_limit'
  | 'quota_exhausted'
  | 'timeout'
  | 'auth_error'
  | 'validation_error'
  | 'network_error'
  | 'internal_error';

export type ProviderAvailabilityStatus =
  | 'UNCONFIGURED'
  | 'CONFIGURED'
  | 'AUTHENTICATED'
  | 'OPERATIONAL'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE';

export type EvidenceType = 'verified' | 'hypothesis' | 'assumption' | 'unknown';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type ProviderId =
  | 'GEMINI'
  | 'OPENROUTER'
  | 'GROQ'
  | 'NVIDIA'
  | 'OPENAI'
  | 'ANTHROPIC'
  | 'DEEPSEEK'
  | 'QWEN'
  | 'MOCK';

export type TaskClass =
  | 'strategic_planning'
  | 'research_synthesis'
  | 'deep_reasoning'
  | 'software_engineering'
  | 'quantitative_math'
  | 'data_analysis'
  | 'security_audit'
  | 'adversarial_critic'
  | 'fact_verification'
  | 'commerce_operations'
  | 'conversational_chat';

export type AgentId =
  | 'strategic_planner'
  | 'research_agent'
  | 'reasoning_agent'
  | 'programming_agent'
  | 'mathematics_agent'
  | 'data_analyst'
  | 'quant_research_agent'
  | 'security_auditor'
  | 'independent_critic'
  | 'fact_verification_agent'
  | 'quality_assurance_agent'
  | 'final_synthesis_agent'
  | 'documentation_agent'
  | 'business_intelligence_agent'
  | 'commerce_operations_agent';

export type MemoryScope =
  | 'user_preferences'
  | 'project_knowledge'
  | 'mission_history'
  | 'technical_docs'
  | 'verified_facts'
  | 'temporary_context'
  | 'agent_working';

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  baseUrl: string;
  envVar: string;
  protocol: 'gemini_sdk' | 'openai_compat' | 'anthropic' | 'mock';
  isPaidByDefault: boolean;
  enabled: boolean;
  configured: boolean;
  keyValueExposed: false;
  cooldownUntil: number;
  failureCount: number;
  lastError: string | null;
  lastVerifiedAt: string | null;
  availabilityStatus?: ProviderAvailabilityStatus;
}

export interface ModelCatalogEntry {
  id: string;
  providerId: ProviderId;
  displayName: string;
  contextWindow: number;
  inputModalities: string[];
  outputModalities: string[];
  supportsTools: boolean;
  supportsJson: boolean;
  promptPricePerMillion: number;
  completionPricePerMillion: number;
  freeVerified: boolean;
  enabled: boolean;
  recommendedTasks: TaskClass[];
  latencyAvgMs: number | null;
}

export interface AgentDefinition {
  id: AgentId;
  name: string;
  role: string;
  domainGroup: 'core' | 'reasoning' | 'quant' | 'engineering' | 'commerce' | 'verification';
  requiredByDefault: boolean;
  taskClass: TaskClass;
  allowedTools: string[];
  memoryPolicy: 'read_write' | 'read_only' | 'ephemeral';
  executionLimit: {
    maxTokens: number;
    timeoutMs: number;
    maxRetries: number;
  };
  dependsOn: AgentId[];
  inputSchemaSummary: string;
  outputSchemaSummary: string;
  systemInstructions: string;
}

export interface SafeUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  preferredLanguage: 'en' | 'ar' | 'it' | 'fr';
}

