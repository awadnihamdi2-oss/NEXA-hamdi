import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express, { Router, type Response } from 'express';
import { z } from 'zod';
import {
  getDb,
  getDatabaseDiagnostics,
  listDatabaseBackups,
  nowIso,
  exportDatabaseBackup,
  recordAuditEvent,
  resolvePersistentDataDir,
  restoreDatabaseFromBuffer,
  verifyDatabaseBackup,
} from '../db/database.ts';
import { isRemoteGistSyncConfigured, pushRemoteSnapshotFromFile } from '../db/remoteSnapshot.ts';
import {
  assertPathInsideRoot,
  attachSessionMiddleware,
  authenticateCredentials,
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  createSessionForUser,
  extractSessionTokenFromRequest,
  getProductionSecurityReadiness,
  rateLimitMiddleware,
  redactPii,
  requireRole,
  revokeSessionToken,
  runProductionPreflight,
  validateAdminPassword,
  validateSchedulerSecret,
  validateSchedulerTriggerToken,
  validateSessionSecret,
  type AuthedRequest,
} from '../security/auth.ts';
import { isEnvKeyConfigured, listModels, listProviders, setModelEnabled, setProviderEnabled } from '../ai/registry.ts';
import { clearProviderCooldown, testProviderConnectivity } from '../ai/gateway.ts';
import { routeInference } from '../ai/router.ts';
import { SPECIALIST_AGENTS } from '../agents/agentRegistry.ts';
import { interpretGenesisObjective } from '../agents/orchestrator.ts';
import {
  cancelMission,
  createMission,
  decideApproval,
  executeMission,
  getBridgeLinks,
  getMissionById,
  linkMissionToBridgeTask,
  listMissions,
  pauseMission,
  resumeMission,
  retryMission,
} from '../kernel/masterKernel.ts';
import { addEvidenceClaim, queryKnowledgeBase, searchArxivLive, searchPublicWebSignals } from '../research/researchEngine.ts';
import { deleteMemoryEntry, purgeExpiredMemory, queryMemory, saveMemoryEntry } from '../memory/memoryEngine.ts';
import {
  createPaperOrder,
  importOrCreateDataset,
  isLiveTradingEnabled,
  listBacktests,
  listDatasets,
  listPaperOrders,
  runQuantBacktest,
} from '../quant/quantEngine.ts';
import {
  advanceCustomerStage,
  auditBusinessWebsiteLive,
  authorizeProposalOutreach,
  createCommercialProposal,
  createDraftInvoice,
  createLeadCustomer,
  createOpportunity,
  discoverMarketOpportunitiesLive,
  discoverRealLocalBusinessesLive,
  generateDigitalProductSite,
  generateMarketingContentAsset,
  getCommerceSiteHtml,
  isExternalCommerceEnabled,
  listCommerceOverview,
  prepareCommercialPackageForOpportunity,
  recordCustomerReply,
  recordFinancialEntry,
  recordVerifiedConversionPayment,
  reverifyAndUpdateOpportunity,
  submitPublicClientInquiry,
  updateProposalStatus,
} from '../commerce/commerceEngine.ts';
import { executeScheduleById, listSchedulesWithRuns, runDueSchedules, setScheduleEnabled } from '../commerce/scheduler.ts';
import {
  cancelSandboxMission,
  decideSandboxApproval,
  deleteSandboxMission,
  getSandboxMissionDetails,
  listSandboxMissions,
  startSandboxMission,
} from '../commerce/sandboxEngine.ts';
import {
  PHASE7_SAFETY_LOCKS,
  deletePhase7Mission,
  exportPhase7MissionPackageToDisk,
  generatePhase7DeliverableWithLiveAi,
  getPhase7CapabilityMatrix,
  getPhase7MissionDetails,
  listPhase7Missions,
  probeProviderAuthSafe,
  revisePhase7Deliverable,
  runPhase7ResearchMission,
  selectPhase7Opportunity,
} from '../commerce/phase7Engine.ts';
import {
  createEngineeringProject,
  createProjectSnapshot,
  getEngineeringProject,
  listEngineeringProjects,
  rollbackProjectSnapshot,
  runProjectValidationAndTests,
  updateProjectFile,
} from '../engineering/studioEngine.ts';
import type { AgentId, EvidenceType, MemoryScope, ProviderId, TaskClass } from '../types/nexa.ts';

export function createApiRouter(): Router {
  const api = Router();
  const loginRateLimit = rateLimitMiddleware(15, 10 * 60 * 1000);
  api.use(rateLimitMiddleware(180));
  api.use(attachSessionMiddleware);

  const handleErr = (res: Response, err: unknown, status = 400) => {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    res.status(status).json({ error: message });
  };

  // ---------------- HEALTH & SYSTEM ----------------
  api.get('/health', (_req, res) => {
    try {
      const db = getDb();
      const providers = listProviders();
      const models = listModels();
      const counts = {
        missions: Number((db.prepare('SELECT COUNT(*) as c FROM missions').get() as { c: number }).c),
        agentRuns: Number((db.prepare('SELECT COUNT(*) as c FROM agent_runs').get() as { c: number }).c),
        sources: Number((db.prepare('SELECT COUNT(*) as c FROM sources').get() as { c: number }).c),
        evidence: Number((db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }).c),
        memory: Number((db.prepare('SELECT COUNT(*) as c FROM memory_entries').get() as { c: number }).c),
        artifacts: Number((db.prepare('SELECT COUNT(*) as c FROM artifacts').get() as { c: number }).c),
        pendingApprovals: Number((db.prepare("SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'").get() as { c: number }).c),
        backtests: Number((db.prepare('SELECT COUNT(*) as c FROM quant_backtests').get() as { c: number }).c),
        engineeringProjects: Number((db.prepare('SELECT COUNT(*) as c FROM engineering_projects').get() as { c: number }).c),
      };

      const settingsRows = db.prepare('SELECT key, value_json FROM system_settings').all() as Array<{ key: string; value_json: string }>;
      const settings: Record<string, unknown> = {};
      for (const s of settingsRows) {
        try {
          settings[s.key] = JSON.parse(s.value_json);
        } catch {
          settings[s.key] = s.value_json;
        }
      }

      res.json({
        status: 'OPERATIONAL',
        platform: 'NEXA QUANT INTELLIGENCE',
        version: '7.0-GENESIS',
        timestamp: nowIso(),
        configuredProviders: providers.filter((p) => p.configured).map((p) => p.id),
        liveVerifiedProviders: providers.filter((p) => p.configured && Boolean(p.lastVerifiedAt)).map((p) => p.id),
        totalProviders: providers.length,
        verifiedFreeModels: models.filter((m) => m.freeVerified).length,
        counts,
        readiness: {
          sessionSecret: validateSessionSecret(),
          productionSecurity: getProductionSecurityReadiness(),
          database: getDatabaseDiagnostics(),
          geminiRequiredForBoot: false,
          geminiRequiredForGeminiProvider: true,
          appUrlConfigured: Boolean((process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim()),
          adminPasswordConfigured: validateAdminPassword().valid,
        },
        safety: {
          automaticPaidFallback: Boolean(settings.automatic_paid_fallback),
          liveTradingEnabled: isLiveTradingEnabled(),
          externalCommerceEnabled: isExternalCommerceEnabled(),
          humanApprovalRequired: true,
        },
      });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/preflight', requireRole('viewer'), (_req, res) => {
    try {
      res.json(runProductionPreflight({ requireProductionNodeEnv: true }));
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  // ---------------- AUTH & RBAC ----------------
  api.get('/auth/session', (req: AuthedRequest, res) => {
    res.json({ user: req.nexaUser || null });
  });

  api.post('/auth/login', loginRateLimit, (req, res) => {
    try {
      const schema = z.object({ username: z.string().min(1), password: z.string().min(1) });
      const body = schema.parse(req.body);
      const auth = authenticateCredentials(body.username, body.password);
      if (!auth) {
        recordAuditEvent(body.username.trim().slice(0, 60) || 'anonymous', 'AUTH', 'USER_LOGIN_FAILED', {
          ip: req.ip || 'unknown',
        });
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      res.setHeader('Set-Cookie', buildSessionCookieHeader(auth.token, req));
      res.json(auth);
    } catch (err) {
      handleErr(res, err, 400);
    }
  });

  api.post('/auth/logout', (req: AuthedRequest, res) => {
    const token = extractSessionTokenFromRequest(req);
    const revoked = revokeSessionToken(token);
    if (req.nexaUser?.username) {
      recordAuditEvent(req.nexaUser.username, 'AUTH', 'USER_LOGOUT', { revoked });
    }
    res.setHeader('Set-Cookie', buildClearSessionCookieHeader(req));
    res.json({ revoked });
  });

  api.post('/auth/switch-role', (req: AuthedRequest, res) => {
    try {
      if (process.env.NODE_ENV === 'production' && req.nexaUser?.role !== 'admin') {
        recordAuditEvent(req.nexaUser?.username || 'anonymous', 'SECURITY', 'ROLE_SWITCH_BLOCKED', {
          reason: 'Production role switching requires an authenticated admin session',
        });
        res.status(403).json({ error: 'Direct role switching is disabled in production. Sign in via /api/auth/login.' });
        return;
      }
      const schema = z.object({ role: z.enum(['admin', 'operator', 'researcher', 'viewer']) });
      const { role } = schema.parse(req.body);
      const db = getDb();
      const user = db.prepare('SELECT id, username, display_name, role, preferred_language FROM users WHERE role = ?').get(role) as
        | { id: string; username: string; display_name: string; role: 'admin' | 'operator' | 'researcher' | 'viewer'; preferred_language: 'en' | 'ar' | 'it' | 'fr' }
        | undefined;
      if (!user) {
        res.status(404).json({ error: 'Role profile not found' });
        return;
      }
      const session = createSessionForUser(user.id);
      recordAuditEvent(user.username, 'AUTH', 'WORKSPACE_ROLE_SWITCH', { role });
      res.json({
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role,
          preferredLanguage: user.preferred_language,
        },
        token: session.token,
        expiresAt: session.expiresAt,
      });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- CONVERSATIONAL & VOICE CHAT ----------------
  api.get('/conversations', requireRole('viewer'), (_req, res) => {
    try {
      const db = getDb();
      const convs = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 30').all();
      res.json({ conversations: convs });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/conversations/:id/messages', requireRole('viewer'), (req, res) => {
    try {
      const rows = getDb()
        .prepare('SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 200')
        .all(req.params.id);
      res.json({ messages: rows });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/chat', async (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        conversationId: z.string().optional(),
        message: z.string().min(1).max(8000),
        language: z.enum(['en', 'ar', 'it', 'fr']).default('en'),
        preferredProvider: z.string().optional(),
        preferredModel: z.string().optional(),
        allowMockFallback: z.boolean().default(true),
      });
      const body = schema.parse(req.body);
      const db = getDb();
      const ts = nowIso();

      let convId = body.conversationId;
      if (!convId) {
        convId = `cnv_${crypto.randomUUID().slice(0, 10)}`;
        db.prepare('INSERT INTO conversations (id, title, language, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          convId,
          body.message.slice(0, 60),
          body.language,
          req.nexaUser?.id || 'usr_operator',
          ts,
          ts
        );
      }

      const { maskedText } = redactPii(body.message);
      db.prepare('INSERT INTO conversation_messages (conversation_id, role, content, language, created_at) VALUES (?, ?, ?, ?, ?)').run(
        convId,
        'user',
        maskedText,
        body.language,
        ts
      );

      const historyRows = db
        .prepare('SELECT role, content FROM conversation_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 8')
        .all(convId) as Array<{ role: string; content: string }>;
      const historyContext = historyRows
        .reverse()
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n');

      const langNames = { en: 'English', ar: 'Arabic (العربية)', it: 'Italian', fr: 'French' } as const;
      const systemPrompt = `You are NEXA QUANT INTELLIGENCE, an epistemic multi-agent core.
Respond cleanly in ${langNames[body.language]}.
Rules: Separate verified facts from hypotheses/assumptions, never claim unexecuted actions, and keep answers concise, structured, and technical.`;

      const result = await routeInference({
        taskClass: 'conversational_chat',
        systemPrompt,
        userPrompt: `CONVERSATION HISTORY:\n${historyContext}\n\nUSER MESSAGE:\n${maskedText}`,
        preferredProvider: body.preferredProvider as ProviderId | undefined,
        preferredModel: body.preferredModel,
        allowMockFallback: body.allowMockFallback,
        mockHandler: () => {
          const prefix =
            body.language === 'ar'
              ? '[وضع المحاكاة المحلي — لا يوجد مفتاح API متصل حالياً]'
              : body.language === 'it'
                ? '[MODALITÀ SIMULAZIONE OFFLINE — Nessuna chiave API live attiva]'
                : body.language === 'fr'
                  ? '[MODE SIMULATION HORS LIGNE — Aucune clé API active]'
                  : '[OFFLINE SIMULATION MODE — No live provider API key configured]';
          return `${prefix}\n\nNEXA received your objective: "${maskedText.slice(0, 200)}".\n\n- Verified State: Local SQLite persistence, 15-agent orchestrator, Quant Lab, Commerce Studio, and Engineering Sandbox are operational.\n- Next Step: Launch a formal Mission or configure a live free-tier server key (GEMINI_API_KEY / OPENROUTER_API_KEY) in environment secrets for live LLM synthesis.`;
        },
      });

      db.prepare(
        'INSERT INTO conversation_messages (conversation_id, role, content, language, provider_id, model_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        convId,
        'assistant',
        result.content,
        body.language,
        result.providerId,
        result.modelId,
        JSON.stringify({ routePolicy: result.routePolicy, latencyMs: result.latencyMs, isMock: result.isMock }),
        nowIso()
      );
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(nowIso(), convId);

      res.json({
        conversationId: convId,
        reply: result.content,
        language: body.language,
        providerId: result.providerId,
        modelId: result.modelId,
        latencyMs: result.latencyMs,
        isMock: result.isMock,
        routePolicy: result.routePolicy,
      });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- AI PROVIDERS & MODELS ----------------
  api.get('/providers', requireRole('viewer'), (_req, res) => {
    try {
      const providers = listProviders();
      const recentCalls = getDb()
        .prepare('SELECT * FROM model_calls ORDER BY id DESC LIMIT 40')
        .all();
      res.json({
        providers,
        recentCalls,
        readiness: {
          configuredCount: providers.filter((p) => p.configured).length,
          unconfiguredCount: providers.filter((p) => !p.configured).length,
          liveVerifiedCount: providers.filter((p) => p.configured && Boolean(p.lastVerifiedAt)).length,
          sessionSecret: validateSessionSecret(),
          database: getDatabaseDiagnostics(),
          safety: {
            paidFallbackAllowed: process.env.NEXA_PAID_FALLBACK_ALLOWED === 'true',
            liveTradingEnabled: isLiveTradingEnabled(),
            externalCommerceEnabled: isExternalCommerceEnabled(),
          },
          envStatus: [
            { name: 'GEMINI_API_KEY', set: isEnvKeyConfigured('GEMINI_API_KEY'), scope: 'AI_FREE_TIER', required: 'Optional for boot; required for live GEMINI' },
            { name: 'OPENROUTER_API_KEY', set: isEnvKeyConfigured('OPENROUTER_API_KEY'), scope: 'AI_FREE_TIER', required: 'Optional' },
            { name: 'GROQ_API_KEY', set: isEnvKeyConfigured('GROQ_API_KEY'), scope: 'AI_FREE_TIER', required: 'Optional' },
            { name: 'NVIDIA_API_KEY', set: isEnvKeyConfigured('NVIDIA_API_KEY'), scope: 'AI_FREE_TIER', required: 'Optional' },
            { name: 'DEEPSEEK_API_KEY', set: isEnvKeyConfigured('DEEPSEEK_API_KEY'), scope: 'AI_PAID_TIER', required: 'Optional (disabled by default)' },
            { name: 'QWEN_API_KEY', set: isEnvKeyConfigured('QWEN_API_KEY'), scope: 'AI_PAID_TIER', required: 'Optional (disabled by default)' },
            { name: 'OPENAI_API_KEY', set: isEnvKeyConfigured('OPENAI_API_KEY'), scope: 'AI_PAID_TIER', required: 'Optional (disabled by default)' },
            { name: 'ANTHROPIC_API_KEY', set: isEnvKeyConfigured('ANTHROPIC_API_KEY'), scope: 'AI_PAID_TIER', required: 'Optional (disabled by default)' },
            { name: 'NEXA_DB_PATH', set: Boolean((process.env.NEXA_DB_PATH || '').trim()), scope: 'DATABASE', required: 'Required non-:memory: persistent path in production' },
            { name: 'NEXA_SESSION_SECRET', set: validateSessionSecret().configured && validateSessionSecret().valid, scope: 'SECURITY', required: 'Required >= 32 random chars in production' },
            { name: 'NEXA_SCHEDULER_TOKEN', set: validateSchedulerSecret().valid, scope: 'SECURITY', required: 'Required >= 24 random chars for external Cloud Scheduler' },
            { name: 'NEXA_ADMIN_PASSWORD', set: validateAdminPassword().valid, scope: 'SECURITY', required: 'Required >= 12 non-default chars in production (legacy alias NEXA_DEFAULT_ADMIN_PASSWORD)' },
            { name: 'NEXA_PAID_FALLBACK_ALLOWED', set: Boolean(process.env.NEXA_PAID_FALLBACK_ALLOWED), scope: 'SAFETY', required: 'Keep false' },
            { name: 'NEXA_LIVE_TRADING_ENABLED', set: Boolean(process.env.NEXA_LIVE_TRADING_ENABLED), scope: 'SAFETY', required: 'Keep false' },
            { name: 'NEXA_EXTERNAL_COMMERCE_ENABLED', set: Boolean(process.env.NEXA_EXTERNAL_COMMERCE_ENABLED), scope: 'SAFETY', required: 'Keep false' },
            { name: 'APP_URL', set: Boolean((process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim()), scope: 'RUNTIME', required: 'Injected HTTPS base URL in production (APP_URL or RENDER_EXTERNAL_URL)' },
            { name: 'NEXA_BACKUP_GIST_ID', set: Boolean((process.env.NEXA_BACKUP_GIST_ID || '').trim()), scope: 'PERSISTENCE', required: 'Optional private GitHub Gist ID for $0 remote snapshot sync' },
          ],
        },
      });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/providers/:id/toggle', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      const updated = setProviderEnabled(req.params.id as ProviderId, enabled, req.nexaUser?.username);
      res.json({ provider: updated });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/providers/:id/test', requireRole('researcher'), async (req, res) => {
    try {
      const body = z
        .object({
          runInferenceProbe: z.boolean().optional(),
          paidInferenceApproved: z.boolean().optional(),
        })
        .parse(req.body || {});
      const result = await testProviderConnectivity(req.params.id as ProviderId, body);
      res.json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/providers/:id/reset-cooldown', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      clearProviderCooldown(req.params.id as ProviderId, req.nexaUser?.username || 'operator');
      res.json({ cleared: true, providerId: req.params.id });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.get('/models', requireRole('viewer'), (req, res) => {
    try {
      const providerId = req.query.provider as ProviderId | undefined;
      const freeOnly = req.query.freeOnly === 'true';
      const taskClass = req.query.task as TaskClass | undefined;
      res.json({ models: listModels({ providerId, freeOnly, taskClass }) });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/models/:id/toggle', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      const updated = setModelEnabled(decodeURIComponent(req.params.id), enabled, req.nexaUser?.username);
      res.json({ model: updated });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- GENESIS INTERPRETER & AGENTS & MISSIONS ----------------
  api.post('/genesis/interpret', requireRole('viewer'), (req, res) => {
    try {
      const { objective } = z.object({ objective: z.string().min(3).max(6000) }).parse(req.body);
      res.json(interpretGenesisObjective(objective));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.get('/agents', requireRole('viewer'), (_req, res) => {
    try {
      const recentRuns = getDb().prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT 50').all();
      res.json({ agents: SPECIALIST_AGENTS, recentRuns });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/missions', requireRole('viewer'), (_req, res) => {
    try {
      res.json({ missions: listMissions() });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/missions/:id', requireRole('viewer'), (req, res) => {
    try {
      const mission = getMissionById(req.params.id);
      if (!mission) {
        res.status(404).json({ error: 'Mission not found' });
        return;
      }
      res.json({ mission });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/missions', requireRole('operator'), async (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        objective: z.string().min(10).max(6000),
        domain: z.string().default('general'),
        priority: z.string().default('normal'),
        requiresApproval: z.boolean().default(true),
        paidFallbackAllowed: z.boolean().default(false),
        requestedAgents: z.array(z.string()).optional(),
        autoExecute: z.boolean().default(true),
        preferredProvider: z.string().optional(),
        preferredModel: z.string().optional(),
        allowMockFallback: z.boolean().default(true),
        useLiveResearch: z.boolean().default(false),
      });
      const body = schema.parse(req.body);
      const created = createMission({
        objective: body.objective,
        domain: body.domain,
        priority: body.priority,
        createdBy: req.nexaUser?.username || 'operator',
        requiresApproval: body.requiresApproval,
        paidFallbackAllowed: body.paidFallbackAllowed,
        requestedAgents: body.requestedAgents as AgentId[] | undefined,
      });

      if (body.autoExecute) {
        const executed = await executeMission({
          missionId: created.id,
          preferredProvider: body.preferredProvider as ProviderId | undefined,
          preferredModel: body.preferredModel,
          allowMockFallback: body.allowMockFallback,
          useLiveResearch: body.useLiveResearch,
        });
        res.status(201).json({ mission: executed });
        return;
      }

      res.status(201).json({ mission: created });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/missions/:id/execute', requireRole('operator'), async (req, res) => {
    try {
      const schema = z.object({
        preferredProvider: z.string().optional(),
        preferredModel: z.string().optional(),
        allowMockFallback: z.boolean().default(true),
        useLiveResearch: z.boolean().default(false),
      });
      const body = schema.parse(req.body || {});
      const mission = await executeMission({
        missionId: req.params.id,
        preferredProvider: body.preferredProvider as ProviderId | undefined,
        preferredModel: body.preferredModel,
        allowMockFallback: body.allowMockFallback,
        useLiveResearch: body.useLiveResearch,
      });
      res.json({ mission });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/missions/:id/cancel', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const mission = cancelMission(req.params.id, req.nexaUser?.username);
      res.json({ mission });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/missions/:id/pause', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const mission = pauseMission(req.params.id, req.nexaUser?.username || 'operator');
      res.json({ mission });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/missions/:id/resume', requireRole('operator'), async (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        preferredProvider: z.string().optional(),
        preferredModel: z.string().optional(),
        allowMockFallback: z.boolean().default(true),
        useLiveResearch: z.boolean().default(false),
      });
      const body = schema.parse(req.body || {});
      const mission = await resumeMission({
        missionId: req.params.id,
        actor: req.nexaUser?.username || 'operator',
        preferredProvider: body.preferredProvider as ProviderId | undefined,
        preferredModel: body.preferredModel,
        allowMockFallback: body.allowMockFallback,
        useLiveResearch: body.useLiveResearch,
      });
      res.json({ mission });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/missions/:id/retry', requireRole('operator'), async (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        preferredProvider: z.string().optional(),
        preferredModel: z.string().optional(),
        allowMockFallback: z.boolean().default(true),
        useLiveResearch: z.boolean().default(false),
      });
      const body = schema.parse(req.body || {});
      const mission = await retryMission({
        missionId: req.params.id,
        actor: req.nexaUser?.username || 'operator',
        preferredProvider: body.preferredProvider as ProviderId | undefined,
        preferredModel: body.preferredModel,
        allowMockFallback: body.allowMockFallback,
        useLiveResearch: body.useLiveResearch,
      });
      res.json({ mission });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.get('/bridge/links', requireRole('viewer'), (req, res) => {
    try {
      const missionId = req.query.missionId ? String(req.query.missionId) : undefined;
      res.json({ links: getBridgeLinks(missionId) });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/bridge/link', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        missionId: z.string().min(4),
        commerceTaskId: z.string().min(4),
        objective: z.string().min(10),
        execute: z.boolean().default(false),
      });
      const body = schema.parse(req.body);
      res.json(linkMissionToBridgeTask(body));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- APPROVALS & SECURITY ----------------
  api.get('/approvals', requireRole('viewer'), (_req, res) => {
    try {
      const rows = getDb().prepare('SELECT * FROM approvals ORDER BY id DESC LIMIT 100').all();
      res.json({ approvals: rows });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/approvals/:id/decide', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        decision: z.enum(['approved', 'rejected']),
        note: z.string().max(500).default(''),
      });
      const body = schema.parse(req.body);
      const updated = decideApproval(Number(req.params.id), body.decision, req.nexaUser?.username || 'operator', body.note);
      res.json({ approval: updated });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- RESEARCH & KNOWLEDGE ----------------
  api.post('/research/arxiv', requireRole('researcher'), async (req, res) => {
    try {
      const schema = z.object({
        query: z.string().min(3).max(400),
        maxResults: z.number().int().min(1).max(15).default(5),
        missionId: z.string().optional(),
      });
      const body = schema.parse(req.body);
      const result = await searchArxivLive(body.query, body.maxResults, body.missionId ?? null);
      res.json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/research/web', requireRole('researcher'), async (req, res) => {
    try {
      const schema = z.object({
        query: z.string().min(3).max(400),
        maxResults: z.number().int().min(1).max(10).default(5),
        missionId: z.string().optional(),
      });
      const body = schema.parse(req.body);
      res.json(await searchPublicWebSignals(body.query, body.maxResults, body.missionId ?? null));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.get('/research/knowledge', requireRole('viewer'), (req, res) => {
    try {
      const q = String(req.query.q || '');
      const type = req.query.type ? (String(req.query.type) as EvidenceType) : undefined;
      res.json(queryKnowledgeBase(q, type));
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/research/evidence', requireRole('researcher'), (req, res) => {
    try {
      const schema = z.object({
        missionId: z.string().optional(),
        sourceId: z.string().optional(),
        sourceLabel: z.string().optional(),
        claim: z.string().min(5),
        evidenceType: z.enum(['verified', 'hypothesis', 'assumption', 'unknown']),
        confidence: z.number().min(0).max(1).optional(),
        notes: z.string().optional(),
      });
      const body = schema.parse(req.body);
      res.status(201).json(addEvidenceClaim(body));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- PERSISTENT MEMORY ----------------
  api.get('/memory', requireRole('viewer'), (req, res) => {
    try {
      const scope = req.query.scope ? (String(req.query.scope) as MemoryScope) : undefined;
      const search = req.query.q ? String(req.query.q) : undefined;
      res.json({ entries: queryMemory({ scope, search }) });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/memory', requireRole('researcher'), (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        scope: z.enum([
          'user_preferences',
          'project_knowledge',
          'mission_history',
          'technical_docs',
          'verified_facts',
          'temporary_context',
          'agent_working',
        ]),
        title: z.string().min(2),
        content: z.string().min(3),
        provenance: z.string().default('user_entry'),
        tags: z.array(z.string()).default([]),
        retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
      });
      const body = schema.parse(req.body);
      const saved = saveMemoryEntry({ ...body, createdBy: req.nexaUser?.username || 'operator' });
      res.status(201).json(saved);
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.delete('/memory/:id', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const ok = deleteMemoryEntry(req.params.id, req.nexaUser?.username);
      if (!ok) {
        res.status(404).json({ error: 'Memory entry not found' });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/memory/purge-expired', requireRole('operator'), (_req, res) => {
    try {
      const purged = purgeExpiredMemory();
      res.json({ purged });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- QUANT RESEARCH LAB ----------------
  api.get('/quant/datasets', requireRole('viewer'), (_req, res) => {
    try {
      res.json({ datasets: listDatasets(), liveTradingEnabled: false });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/quant/datasets', requireRole('researcher'), (req, res) => {
    try {
      const schema = z.object({
        symbol: z.string().min(2).max(16),
        timeframe: z.string().default('1H'),
        sourceType: z.enum(['SYNTHETIC_SAMPLE', 'CSV_IMPORT', 'JSON_IMPORT']).default('SYNTHETIC_SAMPLE'),
        csvText: z.string().optional(),
      });
      const body = schema.parse(req.body);
      res.status(201).json(importOrCreateDataset(body));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.get('/quant/backtests', requireRole('viewer'), (_req, res) => {
    try {
      res.json({ backtests: listBacktests(), paperOrders: listPaperOrders(), liveTradingEnabled: false });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/quant/backtest', requireRole('researcher'), (req, res) => {
    try {
      const schema = z.object({
        datasetId: z.string().min(4),
        strategyName: z.enum(['SMA_CROSSOVER', 'RSI_MEAN_REVERSION', 'EMA_ATR_TREND']),
        fastPeriod: z.number().int().min(3).max(100).optional(),
        slowPeriod: z.number().int().min(5).max(200).optional(),
        rsiPeriod: z.number().int().min(5).max(50).optional(),
        rsiBuy: z.number().min(5).max(49).optional(),
        rsiSell: z.number().min(51).max(95).optional(),
        initialCapital: z.number().min(100).max(10000000).optional(),
        commissionBps: z.number().min(0).max(100).optional(),
        slippageBps: z.number().min(0).max(100).optional(),
        riskPerTradePct: z.number().min(5).max(100).optional(),
      });
      const body = schema.parse(req.body);
      res.status(201).json(runQuantBacktest(body));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/quant/paper-orders', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        symbol: z.string().min(2),
        side: z.enum(['BUY', 'SELL']),
        accountEquityUsd: z.number().positive(),
        riskPct: z.number().positive(),
        entryPrice: z.number().positive(),
        stopLoss: z.number().positive(),
        takeProfit: z.number().positive().nullable().optional(),
        maxDrawdownLimitPct: z.number().positive().optional(),
        currentDrawdownPct: z.number().min(0).optional(),
        notes: z.string().optional(),
      });
      const body = schema.parse(req.body);
      res.status(201).json(createPaperOrder(body));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- AUTONOMOUS COMMERCE ----------------
  api.get('/commerce', requireRole('viewer'), (_req, res) => {
    try {
      res.json(listCommerceOverview());
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/commerce/opportunities', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        title: z.string().min(4),
        targetMarket: z.string().min(2),
        problemStatement: z.string().min(10),
        estimatedEffortHours: z.number().positive(),
        revenueModel: z.string().min(2),
        evidenceNotes: z.string().optional(),
      });
      res.status(201).json(createOpportunity(schema.parse(req.body)));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/commerce/customers', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        name: z.string().min(2),
        company: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        channel: z.string().optional(),
        stage: z.enum(['LEAD', 'QUALIFIED', 'CONTACTED', 'RESPONDED', 'NEGOTIATION', 'PROPOSAL_SENT', 'ACCEPTED', 'CUSTOMER_WON', 'CHURNED']).optional(),
        notes: z.string().optional(),
      });
      res.status(201).json(createLeadCustomer(schema.parse(req.body)));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/commerce/invoices', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        customerId: z.string().nullable().optional(),
        title: z.string().min(2),
        currency: z.string().default('EUR'),
        amount: z.number().positive(),
      });
      res.status(201).json(createDraftInvoice(schema.parse(req.body)));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/commerce/sites', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        brandName: z.string().min(2),
        tagline: z.string().min(3),
        language: z.enum(['en', 'it', 'ar', 'fr']).default('en'),
        template: z.enum(['IMCASO_V4', 'OMEGA_V5']).default('OMEGA_V5'),
        services: z.array(z.string()).optional(),
      });
      res.status(201).json(generateDigitalProductSite(schema.parse(req.body)));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.get('/commerce/sites/:id/html', requireRole('viewer'), (req, res) => {
    const html = getCommerceSiteHtml(req.params.id);
    if (!html) {
      res.status(404).send('Site not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.send(html);
  });

  // Live SMB Website Presence Audit & Discovery
  api.post('/commerce/audit-site', requireRole('operator'), async (req, res) => {
    try {
      const schema = z.object({
        url: z.string().min(8).max(500),
        customerId: z.string().nullable().optional(),
      });
      res.status(201).json(await auditBusinessWebsiteLive(schema.parse(req.body)));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/commerce/discover', requireRole('operator'), async (req, res) => {
    try {
      const schema = z.object({
        niche: z.string().min(3).max(120),
        cityOrMarket: z.string().min(2).max(120).default('Local Regional Market'),
      });
      res.status(201).json(await discoverMarketOpportunitiesLive(schema.parse(req.body)));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.patch('/commerce/customers/:id/stage', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        stage: z.enum(['LEAD', 'QUALIFIED', 'CONTACTED', 'RESPONDED', 'NEGOTIATION', 'PROPOSAL_SENT', 'ACCEPTED', 'CUSTOMER_WON', 'CHURNED']),
      });
      res.json(advanceCustomerStage(req.params.id, schema.parse(req.body).stage));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // Public Web MVP Client Lead Capture Form (no auth required for inbound prospects; strictly validated & rate-limited)
  api.post('/commerce/public/inquiry', rateLimitMiddleware(6, 10 * 60 * 1000), (req, res) => {
    try {
      const schema = z.object({
        name: z.string().min(2).max(80),
        email: z.string().email().max(120),
        phone: z.string().max(40).optional(),
        company: z.string().max(80).optional(),
        notes: z.string().max(400).optional(),
        siteId: z.string().max(60).optional(),
        honeypot: z.string().max(80).optional(),
        consent: z.literal(true),
      });
      const result = submitPublicClientInquiry(schema.parse(req.body));
      res.status(201).json({ received: result.received, message: result.message });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // Sales Proposal, Costing & Approval-Gated Outreach Engine
  api.post('/commerce/proposals', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        opportunityId: z.string().nullable().optional(),
        customerId: z.string().nullable().optional(),
        siteId: z.string().nullable().optional(),
        clientName: z.string().min(2).max(120),
        title: z.string().min(4).max(200),
        problemSummary: z.string().min(10).max(1000),
        pricingTier: z.enum(['STARTER', 'GROWTH', 'MANAGED_SLA']).optional(),
        estimatedEffortHours: z.number().positive().optional(),
        hourlyCostEur: z.number().min(0).optional(),
        infraCostEur: z.number().min(0).optional(),
        setupPriceEur: z.number().positive(),
        monthlyRetainerEur: z.number().min(0).optional(),
        language: z.enum(['en', 'it', 'ar', 'fr']).optional(),
        address: z.string().max(240).nullable().optional(),
        city: z.string().max(120).nullable().optional(),
        publicSourceUrl: z.string().max(400).nullable().optional(),
        websiteUrl: z.string().max(400).nullable().optional(),
        demoUrl: z.string().max(400).nullable().optional(),
      });
      res.status(201).json(createCommercialProposal(schema.parse(req.body)));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.patch('/commerce/proposals/:id/status', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({ status: z.enum(['DRAFT', 'APPROVED', 'SENT', 'WON', 'LOST']) });
      res.json(updateProposalStatus(req.params.id, schema.parse(req.body).status));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // Content Factory (Approval-Gated)
  api.post('/commerce/content', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        opportunityId: z.string().nullable().optional(),
        customerId: z.string().nullable().optional(),
        channel: z.enum(['LANDING_COPY', 'EMAIL_OUTREACH', 'FOLLOW_UP_SEQ', 'LINKEDIN_POST']),
        brandName: z.string().min(2).max(120),
        targetAudience: z.string().min(2).max(140),
        offerSummary: z.string().min(5).max(400),
        language: z.enum(['en', 'it', 'ar', 'fr']).optional(),
      });
      res.status(201).json(generateMarketingContentAsset(schema.parse(req.body)));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // Financial Ledger (Strict Separation of Verified Payments vs Operating Costs)
  api.post('/commerce/ledger', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        entryType: z.enum(['REVENUE', 'OPERATING_COST']),
        category: z.string().min(2).max(80),
        amountEur: z.number().positive(),
        proposalId: z.string().nullable().optional(),
        invoiceId: z.string().nullable().optional(),
        verifiedPayment: z.boolean().default(false),
        notes: z.string().max(400).optional(),
      });
      const body = schema.parse(req.body);
      res.status(201).json(recordFinancialEntry({ ...body, recordedBy: req.nexaUser?.username || 'operator' }));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // Continuous Automation Schedules & Persistent Run Logs
  api.get('/commerce/schedules', requireRole('viewer'), (_req, res) => {
    try {
      res.json(listSchedulesWithRuns());
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  // Authenticated Cloud Scheduler HTTP Trigger (supports NEXA_SCHEDULER_TOKEN or Operator/Admin RBAC)
  api.post('/commerce/schedules/run-due', async (req: AuthedRequest, res) => {
    try {
      const authHeader = req.headers.authorization;
      const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      const schedHeader = (req.headers['x-nexa-scheduler-token'] as string | undefined) || null;
      const tokenCheck = validateSchedulerTriggerToken(schedHeader || bearer);
      const hasOperatorRole = Boolean(req.nexaUser && (req.nexaUser.role === 'operator' || req.nexaUser.role === 'admin'));

      if (!tokenCheck.authorized && !hasOperatorRole) {
        res.status(401).json({
          error: tokenCheck.reason || 'Valid NEXA_SCHEDULER_TOKEN or operator session required.',
        });
        return;
      }

      const source = tokenCheck.authorized ? 'cloud_scheduler_http' : `operator_${req.nexaUser?.username || 'local'}`;
      const result = await runDueSchedules(source);
      res.json({ ok: true, triggerSource: source, ...result });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.patch('/commerce/schedules/:id', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({ enabled: z.boolean() });
      res.json(setScheduleEnabled(req.params.id, schema.parse(req.body).enabled));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/commerce/schedules/:id/run', requireRole('operator'), async (req, res) => {
    try {
      res.status(201).json(await executeScheduleById(req.params.id, { triggerSource: 'manual_api' }));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // Priority 4: End-to-End Real SMB Discovery & First Revenue Execution Workflow
  api.post('/commerce/discover-businesses', requireRole('operator'), async (req, res) => {
    try {
      const schema = z.object({
        niche: z.string().min(2).max(120),
        cityOrMarket: z.string().min(2).max(120),
        limit: z.number().int().min(1).max(12).optional(),
        auditWebsites: z.boolean().optional(),
      });
      res.status(201).json(await discoverRealLocalBusinessesLive(schema.parse(req.body)));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/commerce/opportunities/:id/reverify', requireRole('operator'), async (req, res) => {
    try {
      const schema = z.object({
        businessName: z.string().min(2).max(160).optional(),
        websiteUrl: z.string().max(500).nullable().optional(),
        phone: z.string().max(60).nullable().optional(),
        email: z.string().max(160).nullable().optional(),
        isChainOrEnterprise: z.boolean().optional(),
        historicalProposalNote: z.string().max(400).nullable().optional(),
        archiveExistingProposal: z.boolean().optional(),
        runLiveAudit: z.boolean().optional(),
      });
      res.json(
        await reverifyAndUpdateOpportunity({
          opportunityId: req.params.id,
          ...schema.parse(req.body || {}),
        })
      );
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/commerce/opportunities/:id/package', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        setupPriceEur: z.number().positive().optional(),
        monthlyRetainerEur: z.number().min(0).optional(),
        hourlyCostEur: z.number().min(0).optional(),
        estimatedEffortHours: z.number().positive().optional(),
        pricingTier: z.enum(['STARTER', 'GROWTH', 'MANAGED_SLA']).optional(),
        language: z.enum(['en', 'it', 'ar', 'fr']).optional(),
      });
      res.status(201).json(
        prepareCommercialPackageForOpportunity({
          opportunityId: req.params.id,
          ...schema.parse(req.body || {}),
        })
      );
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/commerce/proposals/:id/authorize-outreach', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const schema = z.object({ markSent: z.boolean().default(true) });
      const body = schema.parse(req.body || {});
      res.json(
        authorizeProposalOutreach({
          proposalId: req.params.id,
          decidedBy: req.nexaUser?.username || 'operator',
          markSent: body.markSent,
        })
      );
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.patch('/commerce/customers/:id/reply', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        replyStatus: z.enum(['NONE', 'REPLIED_INTERESTED', 'REPLIED_QUESTIONS', 'DECLINED']),
        replyNotes: z.string().max(600).optional(),
        nextStage: z.enum(['LEAD', 'QUALIFIED', 'CONTACTED', 'RESPONDED', 'NEGOTIATION', 'PROPOSAL_SENT', 'ACCEPTED', 'CUSTOMER_WON', 'CHURNED']).optional(),
      });
      res.json(recordCustomerReply({ customerId: req.params.id, ...schema.parse(req.body) }));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/commerce/payments/verify', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        customerId: z.string().min(4),
        proposalId: z.string().nullable().optional(),
        amountEur: z.number().positive(),
        paymentReference: z.string().min(3).max(160),
        paymentMethod: z.string().max(80).optional(),
        invoiceTitle: z.string().max(180).optional(),
      });
      res.status(201).json(
        recordVerifiedConversionPayment({
          ...schema.parse(req.body),
          recordedBy: req.nexaUser?.username || 'operator',
        })
      );
    } catch (err) {
      handleErr(res, err);
    }
  });

  // Autonomous Commerce Isolated E2E Sandbox (Zero production DB writes, zero external side effects)
  api.get('/commerce/sandbox', requireRole('viewer'), (_req, res) => {
    try {
      res.json(listSandboxMissions());
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/commerce/sandbox/:runId', requireRole('viewer'), (req, res) => {
    try {
      const details = getSandboxMissionDetails(req.params.runId);
      if (!details) {
        res.status(404).json({ error: 'Sandbox run not found' });
        return;
      }
      res.json(details);
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/commerce/sandbox/start', requireRole('operator'), async (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        niche: z.string().trim().min(3).max(120),
        cityOrMarket: z.string().trim().min(2).max(120).default('Milan'),
        language: z.enum(['en', 'it', 'ar', 'fr']).optional(),
        maxCostUsd: z.number().min(0).max(50).optional(),
        maxRetries: z.number().int().min(0).max(5).optional(),
        stageTimeoutMs: z.number().int().min(20).max(60000).optional(),
        idempotencyKey: z.string().max(120).optional(),
        simulationMode: z
          .enum(['NONE', 'AGENT_FAILURE', 'RETRY_EXHAUSTION', 'TIMEOUT', 'INVALID_AI_OUTPUT', 'COST_CEILING_EXCEEDED'])
          .optional(),
      });
      const parsed = schema.parse(req.body || {});
      const result = await startSandboxMission({
        ...parsed,
        createdBy: req.nexaUser?.username || 'operator',
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof Error && /Duplicate active sandbox mission/i.test(err.message)) {
        res.status(409).json({ error: err.message });
        return;
      }
      handleErr(res, err);
    }
  });

  api.post('/commerce/sandbox/:runId/approve', requireRole('operator'), async (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        decision: z.enum(['approved', 'rejected']),
        note: z.string().max(400).optional(),
      });
      const body = schema.parse(req.body || {});
      const result = await decideSandboxApproval({
        runId: req.params.runId,
        decision: body.decision,
        decidedBy: req.nexaUser?.username || 'operator',
        note: body.note,
      });
      res.json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/commerce/sandbox/:runId/cancel', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      res.json(cancelSandboxMission(req.params.runId, req.nexaUser?.username || 'operator'));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.delete('/commerce/sandbox/:runId', requireRole('operator'), (req, res) => {
    try {
      res.json(deleteSandboxMission(req.params.runId));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- PHASE 7: REAL-WORLD INTELLIGENCE & FIRST REVENUE VALIDATION ----------------
  api.get('/phase7/capabilities', requireRole('viewer'), async (_req, res) => {
    try {
      res.json(await getPhase7CapabilityMatrix());
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/phase7/providers/:id/probe', requireRole('operator'), async (req, res) => {
    try {
      const schema = z.enum(['GEMINI', 'OPENROUTER', 'GROQ', 'NVIDIA', 'OPENAI', 'ANTHROPIC', 'DEEPSEEK', 'QWEN']);
      const providerId = schema.parse(String(req.params.id || '').toUpperCase());
      res.json(await probeProviderAuthSafe(providerId));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.get('/phase7/missions', requireRole('viewer'), (_req, res) => {
    try {
      res.json({ safetyLocks: PHASE7_SAFETY_LOCKS, missions: listPhase7Missions() });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/phase7/missions/:id', requireRole('viewer'), (req, res) => {
    try {
      const details = getPhase7MissionDetails(req.params.id);
      if (!details) {
        res.status(404).json({ error: 'Phase 7 validation mission not found' });
        return;
      }
      res.json(details);
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/phase7/missions/start', requireRole('researcher'), async (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        niche: z.string().trim().min(3).max(120),
        market: z.string().trim().min(2).max(120),
        targetUrl: z.string().trim().max(400).nullable().optional(),
        mode: z.enum(['LIVE_RESEARCH', 'FIXTURE_SIMULATION']).default('LIVE_RESEARCH'),
        language: z.enum(['en', 'it', 'ar', 'fr']).default('en'),
        maxCostUsd: z.number().min(0).max(20).default(0.25),
        maxRequests: z.number().int().min(1).max(15).default(8),
        maxRetries: z.number().int().min(0).max(3).default(1),
        timeoutMs: z.number().int().min(50).max(30000).default(6000),
        allowFixtureFallback: z.boolean().default(false),
      });
      const parsed = schema.parse(req.body || {});
      const result = await runPhase7ResearchMission({
        ...parsed,
        createdBy: req.nexaUser?.username || 'researcher',
      });
      res.status(201).json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/phase7/missions/:id/opportunities/:oppId/select', requireRole('operator'), (req, res) => {
    try {
      res.json(selectPhase7Opportunity(req.params.id, req.params.oppId));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/phase7/missions/:id/deliverable', requireRole('operator'), async (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        opportunityId: z.string().optional(),
        language: z.enum(['en', 'it', 'ar', 'fr']).optional(),
        defectInjection: z.enum(['MISSING_VIEWPORT', 'UNSUPPORTED_CLAIM', 'UNSAFE_SCRIPT']).nullable().optional(),
        useLiveAi: z.boolean().optional(),
      });
      const parsed = schema.parse(req.body || {});
      const result = await generatePhase7DeliverableWithLiveAi({
        missionId: req.params.id,
        ...parsed,
        actor: req.nexaUser?.username || 'operator',
      });
      res.status(201).json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/phase7/missions/:id/export', requireRole('operator'), (req, res) => {
    try {
      res.json(exportPhase7MissionPackageToDisk(req.params.id));
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/phase7/deliverables/:id/revise', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        revisionNotes: z.string().max(600).optional(),
        language: z.enum(['en', 'it', 'ar', 'fr']).optional(),
        verifiedContact: z
          .object({
            clinicName: z.string().max(120).nullable().optional(),
            phone: z.string().max(40).nullable().optional(),
            address: z.string().max(160).nullable().optional(),
            hours: z.string().max(80).nullable().optional(),
          })
          .optional(),
      });
      const parsed = schema.parse(req.body || {});
      const result = revisePhase7Deliverable({
        deliverableId: req.params.id,
        ...parsed,
        actor: req.nexaUser?.username || 'operator',
      });
      res.json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.delete('/phase7/missions/:id', requireRole('operator'), (req, res) => {
    try {
      res.json(deletePhase7Mission(req.params.id));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- SOFTWARE ENGINEERING STUDIO ----------------
  api.get('/engineering/projects', requireRole('viewer'), (_req, res) => {
    try {
      res.json({ projects: listEngineeringProjects() });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/engineering/projects/:id', requireRole('viewer'), (req, res) => {
    try {
      const project = getEngineeringProject(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json({ project });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.post('/engineering/projects', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({
        name: z.string().min(2),
        objective: z.string().min(5),
        stack: z.enum(['node_ts_service', 'python_quant_script', 'static_web_app']).default('node_ts_service'),
      });
      res.status(201).json({ project: createEngineeringProject(schema.parse(req.body)) });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.put('/engineering/projects/:id/files', requireRole('operator'), (req, res) => {
    try {
      const schema = z.object({ path: z.string().min(1), content: z.string() });
      const body = schema.parse(req.body);
      res.json({ project: updateProjectFile(req.params.id, body.path, body.content) });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/engineering/projects/:id/snapshot', requireRole('operator'), (req, res) => {
    try {
      const { label } = z.object({ label: z.string().min(1).default('manual_checkpoint') }).parse(req.body || {});
      res.status(201).json({ snapshot: createProjectSnapshot(req.params.id, label) });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/engineering/projects/:id/rollback', requireRole('operator'), (req, res) => {
    try {
      const { snapshotId } = z.object({ snapshotId: z.string().min(4) }).parse(req.body);
      res.json({ project: rollbackProjectSnapshot(req.params.id, snapshotId) });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/engineering/projects/:id/test', requireRole('operator'), async (req, res) => {
    try {
      const result = await runProjectValidationAndTests(req.params.id);
      res.json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ---------------- ARTIFACTS, REPORTS, AUDIT & SETTINGS ----------------
  api.get('/artifacts', requireRole('viewer'), (_req, res) => {
    try {
      const artifacts = getDb().prepare('SELECT * FROM artifacts ORDER BY created_at DESC LIMIT 100').all();
      res.json({ artifacts });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/artifacts/:id/content', requireRole('viewer'), (req, res) => {
    try {
      const art = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
      if (!art) {
        res.status(404).json({ error: 'Artifact not found' });
        return;
      }
      const artifactsRoot = path.resolve(process.cwd(), 'data/artifacts');
      const fp = assertPathInsideRoot(artifactsRoot, String(art.file_path));
      if (!fs.existsSync(fp)) {
        res.status(404).json({ error: 'Artifact file missing on disk' });
        return;
      }
      const bytes = fs.readFileSync(fp);
      const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
      res.json({
        artifact: art,
        integrityVerified: actualSha === String(art.sha256),
        content: bytes.toString('utf-8'),
      });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/reports/analytics', requireRole('viewer'), (_req, res) => {
    try {
      const db = getDb();
      const missionsByStatus = db.prepare('SELECT status, COUNT(*) as count FROM missions GROUP BY status').all();
      const callsByProvider = db
        .prepare(
          'SELECT provider_id, status, COUNT(*) as calls, AVG(latency_ms) as avg_latency_ms, SUM(tokens_in + tokens_out) as total_tokens, SUM(cost_usd) as total_cost_usd FROM model_calls GROUP BY provider_id, status'
        )
        .all();
      const evidenceByType = db.prepare('SELECT evidence_type, COUNT(*) as count FROM evidence GROUP BY evidence_type').all();
      const recentTests = db.prepare('SELECT * FROM test_runs ORDER BY created_at DESC LIMIT 20').all();
      res.json({ missionsByStatus, callsByProvider, evidenceByType, recentTests });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/audit/mission-executions', requireRole('viewer'), (req, res) => {
    try {
      const db = getDb();
      const q = String(req.query.q || '').trim().toLowerCase();
      const statusFilter = String(req.query.status || 'ALL').trim().toUpperCase();
      const limit = Math.min(Math.max(Number(req.query.limit || 200) || 200, 1), 500);

      const rows = db
        .prepare(
          `SELECT ar.id, ar.mission_id, ar.agent_id, ar.provider_id, ar.model_id, ar.status,
                  ar.error_message, ar.latency_ms, ar.tokens_in, ar.tokens_out, ar.cost_usd, ar.is_mock, ar.created_at,
                  m.objective AS mission_objective, m.domain AS mission_domain, m.status AS mission_status, m.total_cost_usd AS mission_total_cost_usd
           FROM agent_runs ar
           LEFT JOIN missions m ON m.id = ar.mission_id
           ORDER BY ar.id DESC
           LIMIT ?`
        )
        .all(limit) as Array<Record<string, unknown>>;

      const mapped = rows
        .map((r) => ({
          id: Number(r.id),
          timestamp: String(r.created_at),
          mission_id: String(r.mission_id),
          agent_id: String(r.agent_id),
          status: String(r.status),
          cost_metadata: {
            costUsd: Number(r.cost_usd || 0),
            tokensIn: Number(r.tokens_in || 0),
            tokensOut: Number(r.tokens_out || 0),
            totalTokens: Number(r.tokens_in || 0) + Number(r.tokens_out || 0),
            latencyMs: Number(r.latency_ms || 0),
            providerId: String(r.provider_id || ''),
            modelId: String(r.model_id || ''),
            isMock: Number(r.is_mock) === 1,
            missionTotalCostUsd: Number(r.mission_total_cost_usd || 0),
          },
          error_message: r.error_message ? String(r.error_message) : null,
          mission_domain: r.mission_domain ? String(r.mission_domain) : null,
          mission_objective: r.mission_objective ? String(r.mission_objective) : null,
        }))
        .filter((row) => {
          if (statusFilter !== 'ALL' && row.status.toUpperCase() !== statusFilter) return false;
          if (!q) return true;
          const haystack = [
            row.timestamp,
            row.mission_id,
            row.agent_id,
            row.status,
            row.cost_metadata.providerId,
            row.cost_metadata.modelId,
            row.mission_domain || '',
            row.mission_objective || '',
            row.error_message || '',
          ]
            .join(' ')
            .toLowerCase();
          return haystack.includes(q);
        });

      const summary = {
        totalRows: rows.length,
        filteredRows: mapped.length,
        failedRuns: mapped.filter((r) => r.status === 'FAILED').length,
        totalCostUsd: Number(mapped.reduce((acc, r) => acc + r.cost_metadata.costUsd, 0).toFixed(6)),
        totalTokens: mapped.reduce((acc, r) => acc + r.cost_metadata.totalTokens, 0),
      };

      res.json({ logs: mapped, summary });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/audit', requireRole('viewer'), (_req, res) => {
    try {
      const db = getDb();
      const events = db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 120').all();
      const securityAlerts = db
        .prepare("SELECT * FROM audit_events WHERE category = 'SECURITY' ORDER BY id DESC LIMIT 40")
        .all();
      const failedMissions = db
        .prepare("SELECT id, objective, status, failure_classification, last_error, retry_count, updated_at FROM missions WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 25")
        .all();
      const failedAgentRuns = db
        .prepare("SELECT id, mission_id, agent_id, provider_id, model_id, error_message, created_at FROM agent_runs WHERE status = 'FAILED' ORDER BY id DESC LIMIT 25")
        .all();
      const failedSchedules = db
        .prepare("SELECT id, schedule_id, error_message, started_at FROM commerce_schedule_runs WHERE status = 'FAILED' ORDER BY started_at DESC LIMIT 20")
        .all();
      res.json({ events, securityAlerts, failedMissions, failedAgentRuns, failedSchedules });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/settings', requireRole('viewer'), (_req, res) => {
    try {
      const rows = getDb().prepare('SELECT key, value_json, updated_at FROM system_settings').all() as Array<{
        key: string;
        value_json: string;
        updated_at: string;
      }>;
      const settings: Record<string, unknown> = {};
      for (const r of rows) {
        try {
          settings[r.key] = JSON.parse(r.value_json);
        } catch {
          settings[r.key] = r.value_json;
        }
      }
      res.json({ settings });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.put('/settings', requireRole('admin'), (req: AuthedRequest, res) => {
    try {
      const schema = z.object({
        default_language: z.enum(['en', 'ar', 'it', 'fr']).optional(),
        human_approval_required: z.boolean().optional(),
        automatic_paid_fallback: z.boolean().optional(),
        max_cost_per_mission_usd: z.number().min(0).max(100).optional(),
      });
      const body = schema.parse(req.body);
      const db = getDb();
      const ts = nowIso();

      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        db.prepare('INSERT OR REPLACE INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
          key,
          JSON.stringify(value),
          ts
        );
      }

      recordAuditEvent(req.nexaUser?.username || 'admin', 'SETTINGS', 'SETTINGS_UPDATED', body);
      res.json({ updated: true, body });
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.get('/backups', requireRole('viewer'), (_req, res) => {
    try {
      res.json({ backups: listDatabaseBackups() });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.get('/backups/:filename/download', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const safeName = path.basename(req.params.filename || '');
      if (!safeName || safeName !== req.params.filename || (!safeName.endsWith('.sqlite3') && !safeName.endsWith('.json'))) {
        res.status(400).json({ error: 'Invalid backup filename' });
        return;
      }
      const backupDir = path.join(resolvePersistentDataDir(), 'backups');
      const fullPath = assertPathInsideRoot(backupDir, safeName);
      if (!fs.existsSync(fullPath)) {
        res.status(404).json({ error: 'Backup file not found' });
        return;
      }
      recordAuditEvent(req.nexaUser?.username || 'operator', 'DATABASE', 'BACKUP_DOWNLOADED', { filename: safeName });
      res.setHeader('Content-Type', safeName.endsWith('.json') ? 'application/json' : 'application/x-sqlite3');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.sendFile(fullPath);
    } catch (err) {
      handleErr(res, err, 400);
    }
  });

  api.post('/backups/verify', requireRole('operator'), (req: AuthedRequest, res) => {
    try {
      const { filename } = z.object({ filename: z.string().min(4) }).parse(req.body);
      const report = verifyDatabaseBackup(filename);
      recordAuditEvent(req.nexaUser?.username || 'operator', 'DATABASE', 'BACKUP_VERIFIED', report);
      res.json(report);
    } catch (err) {
      handleErr(res, err);
    }
  });

  api.post('/backups/restore', requireRole('admin'), express.json({ limit: '16mb' }), async (req: AuthedRequest, res) => {
    try {
      const { base64Sqlite } = z.object({ base64Sqlite: z.string().min(100) }).parse(req.body);
      const rawBuf = Buffer.from(base64Sqlite.trim(), 'base64');
      const report = restoreDatabaseFromBuffer(rawBuf);
      recordAuditEvent(req.nexaUser?.username || 'admin', 'DATABASE', 'BACKUP_RESTORED', {
        tableCount: report.tableCount,
        sha256: report.sha256,
        sizeBytes: report.sizeBytes,
      });
      let remoteSync: { synced: boolean; error?: string } | undefined;
      if (isRemoteGistSyncConfigured()) {
        const freshSnap = exportDatabaseBackup();
        remoteSync = await pushRemoteSnapshotFromFile(freshSnap.backupPath);
      }
      res.json({ restored: true, ...report, remoteSync });
    } catch (err) {
      handleErr(res, err, 400);
    }
  });

  api.post('/backup', requireRole('operator'), async (req: AuthedRequest, res) => {
    try {
      const backup = exportDatabaseBackup();
      let remoteSync: { synced: boolean; sha256?: string; sizeBytes?: number; error?: string } | undefined;
      if (isRemoteGistSyncConfigured()) {
        remoteSync = await pushRemoteSnapshotFromFile(backup.backupPath);
      }
      recordAuditEvent(req.nexaUser?.username || 'operator', 'DATABASE', 'BACKUP_EXPORTED', {
        ...backup,
        remoteSynced: Boolean(remoteSync?.synced),
      });
      res.json({ ...backup, remoteSync });
    } catch (err) {
      handleErr(res, err, 500);
    }
  });

  api.use((_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  return api;
}
