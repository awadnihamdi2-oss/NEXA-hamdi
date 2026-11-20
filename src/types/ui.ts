export type EnvironmentId =
  | 'genesis'
  | 'command'
  | 'network'
  | 'models'
  | 'research'
  | 'memory'
  | 'quant'
  | 'commerce'
  | 'engineering'
  | 'analytics'
  | 'security'
  | 'control';

export type CoreState =
  | 'dormant'
  | 'aware'
  | 'listening'
  | 'reasoning'
  | 'collaborating'
  | 'executing'
  | 'speaking'
  | 'completed'
  | 'failed';

export type UiLang = 'en' | 'ar' | 'fr';
export type LangCode = 'en' | 'ar' | 'it' | 'fr';

export interface EnvironmentMeta {
  id: EnvironmentId;
  index: string;
  cluster: 'PORTAL' | 'INTELLIGENCE' | 'DOMAINS' | 'GOVERNANCE';
}

export const ENVIRONMENTS: EnvironmentMeta[] = [
  { id: 'genesis', index: '01', cluster: 'PORTAL' },
  { id: 'command', index: '02', cluster: 'PORTAL' },
  { id: 'network', index: '03', cluster: 'INTELLIGENCE' },
  { id: 'models', index: '04', cluster: 'INTELLIGENCE' },
  { id: 'research', index: '05', cluster: 'DOMAINS' },
  { id: 'memory', index: '06', cluster: 'DOMAINS' },
  { id: 'quant', index: '07', cluster: 'DOMAINS' },
  { id: 'commerce', index: '08', cluster: 'DOMAINS' },
  { id: 'engineering', index: '09', cluster: 'DOMAINS' },
  { id: 'analytics', index: '10', cluster: 'GOVERNANCE' },
  { id: 'security', index: '11', cluster: 'GOVERNANCE' },
  { id: 'control', index: '12', cluster: 'GOVERNANCE' },
];

export interface HealthSnapshot {
  status: string;
  platform: string;
  version: string;
  timestamp: string;
  configuredProviders: string[];
  liveVerifiedProviders?: string[];
  totalProviders: number;
  verifiedFreeModels: number;
  counts: {
    missions: number;
    agentRuns: number;
    sources: number;
    evidence: number;
    memory: number;
    artifacts: number;
    pendingApprovals: number;
    backtests: number;
    engineeringProjects: number;
  };
  readiness?: {
    sessionSecret: { configured: boolean; valid: boolean; mode: string; message: string };
    database: { persistentFile: boolean; exists: boolean; sizeBytes: number; walMode: boolean };
    geminiRequiredForBoot: boolean;
    geminiRequiredForGeminiProvider: boolean;
    appUrlConfigured: boolean;
    adminPasswordConfigured: boolean;
  };
  safety: {
    automaticPaidFallback: boolean;
    liveTradingEnabled: boolean;
    externalCommerceEnabled: boolean;
    humanApprovalRequired: boolean;
  };
}
