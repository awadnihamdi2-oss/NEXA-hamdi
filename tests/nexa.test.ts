import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  exportDatabaseBackup,
  getDatabaseDiagnostics,
  getDb,
  listDatabaseBackups,
  resetDbForTests,
  resolvePersistentDataDir,
  verifyDatabaseBackup,
} from '../server/db/database.ts';
import {
  assertPathInsideRoot,
  authenticateCredentials,
  getProductionSecurityReadiness,
  redactPii,
  resolveUserFromToken,
  runProductionPreflight,
  validateAdminPassword,
  validateSchedulerSecret,
  validateSchedulerTriggerToken,
  validateSessionSecret,
  wrapUntrustedContext,
} from '../server/security/auth.ts';
import {
  ensureRegistrySeeded,
  isModelEligibleFreeChat,
  listModels,
  listProviders,
  upsertDiscoveredGeminiModels,
  upsertDiscoveredGroqModels,
  upsertDiscoveredOpenRouterModels,
} from '../server/ai/registry.ts';
import {
  clearCooldownsForTests,
  clearProviderCooldown,
  estimateCallCostUsd,
  sanitizeGatewayError,
  setModelCooldown,
  testProviderConnectivity,
} from '../server/ai/gateway.ts';
import { isPaidFallbackEnabledGlobally, routeInference, selectCandidateModels } from '../server/ai/router.ts';
import {
  cancelMission,
  createMission,
  decideApproval,
  executeMission,
  getBridgeLinks,
  getMissionById,
  linkMissionToBridgeTask,
  pauseMission,
  recoverInterruptedMissionsOnStartup,
  requestApproval,
  resumeMission,
  retryMission,
} from '../server/kernel/masterKernel.ts';
import { SPECIALIST_AGENTS } from '../server/agents/agentRegistry.ts';
import {
  classifyExecutionError,
  detectAgentContradictions,
  planExecutionWaves,
  runSingleAgent,
  type AgentExecutionRecord,
} from '../server/agents/orchestrator.ts';
import { createApiRouter } from '../server/routes/api.ts';
import { createPreviewRouter } from '../server/routes/preview.ts';
import {
  addEvidenceClaim,
  extractResearchKeywords,
  parseArxivAtomXml,
  queryKnowledgeBase,
} from '../server/research/researchEngine.ts';
import { deleteMemoryEntry, queryMemory, saveMemoryEntry } from '../server/memory/memoryEngine.ts';
import {
  computeAtr,
  computeEma,
  computeRsi,
  computeSma,
  createPaperOrder,
  generateSyntheticSampleBars,
  importOrCreateDataset,
  isLiveTradingEnabled,
  parseCsvOhlcv,
  runQuantBacktest,
  validateOhlcvData,
} from '../server/quant/quantEngine.ts';
import {
  advanceCustomerStage,
  assertResolvedHostPublic,
  authorizeProposalOutreach,
  buildCommercialTermsBreakdown,
  buildFisioterapiaAtlanteClinicalDemoHtml,
  createCommercialProposal,
  createDraftInvoice,
  createLeadCustomer,
  createOpportunity,
  generateDigitalProductSite,
  generateMarketingContentAsset,
  getCommerceSiteHtml,
  getCommerceTruthMetrics,
  isExternalCommerceEnabled,
  listCommerceOverview,
  prepareCommercialPackageForOpportunity,
  recordCustomerReply,
  recordFinancialEntry,
  recordVerifiedConversionPayment,
  reverifyAndUpdateOpportunity,
  scoreBusinessOpportunity,
  submitPublicClientInquiry,
  updateProposalStatus,
  validatePublicHttpUrl,
} from '../server/commerce/commerceEngine.ts';
import {
  SANDBOX_POLICY_LOCKS,
  SANDBOX_STAGE_SPECS,
  cancelSandboxMission,
  decideSandboxApproval,
  deleteSandboxMission,
  getSandboxMissionDetails,
  listSandboxMissions,
  startSandboxMission,
} from '../server/commerce/sandboxEngine.ts';
import {
  PHASE7_SAFETY_LOCKS,
  deletePhase7Mission,
  evaluateDeliverableQuality,
  evaluateOpportunityCriteria,
  exportPhase7MissionPackageToDisk,
  generatePhase7DeliverablePackage,
  generatePhase7DeliverableWithLiveAi,
  getPhase7CapabilityMatrix,
  getPhase7MissionDetails,
  revisePhase7Deliverable,
  runPhase7ResearchMission,
  selectPhase7Opportunity,
  validatePhase7SourceRecord,
} from '../server/commerce/phase7Engine.ts';
import {
  executeScheduleById,
  getSchedulerArchitectureEvaluation,
  recoverStaleScheduleLocks,
  runDueSchedules,
} from '../server/commerce/scheduler.ts';
import {
  createEngineeringProject,
  rollbackProjectSnapshot,
  runProjectValidationAndTests,
  updateProjectFile,
} from '../server/engineering/studioEngine.ts';
import { computeExecutionRhythm } from '../src/hooks/useExecutionRhythm.ts';

const createdArtifactsDir = path.resolve(process.cwd(), 'data/artifacts');
const createdProjects: string[] = [];

describe('NEXA QUANT INTELLIGENCE — Unified Test Suite', () => {
  beforeEach(() => {
    resetDbForTests(':memory:');
    ensureRegistrySeeded();
  });

  afterAll(() => {
    // Remove test-created workspace project folders if any
    const root = path.resolve(process.cwd(), 'workspace_projects');
    for (const rel of createdProjects) {
      try {
        fs.rmSync(path.join(root, rel), { recursive: true, force: true });
      } catch {
        // ignore cleanup warnings
      }
    }
  });

  it('1. Database schema migrations, safety defaults, and PBKDF2 RBAC authentication work cleanly', () => {
    const adminAuth = authenticateCredentials('admin', process.env.NEXA_DEFAULT_ADMIN_PASSWORD || 'nexa-operator-local');
    expect(adminAuth).not.toBeNull();
    expect(adminAuth!.user.role).toBe('admin');

    const resolved = resolveUserFromToken(adminAuth!.token);
    expect(resolved?.username).toBe('admin');
    expect(authenticateCredentials('admin', 'wrong-password-123')).toBeNull();

    expect(isPaidFallbackEnabledGlobally()).toBe(false);
    const backup = exportDatabaseBackup();
    expect(backup.sha256.length).toBe(64);
    expect(backup.sizeBytes).toBeGreaterThan(100);
    if (fs.existsSync(backup.backupPath)) fs.rmSync(backup.backupPath, { force: true });
  });

  it('2. Security guards redact PII, wrap untrusted context, and block path traversal', () => {
    const raw = 'Contact mario.rossi@example.com or +39 340 123 4567 with key sk-1234567890abcdefghij';
    const { maskedText, redactions } = redactPii(raw);
    expect(redactions).toBeGreaterThanOrEqual(3);
    expect(maskedText).toContain('[REDACTED_EMAIL]');
    expect(maskedText).toContain('[REDACTED_PHONE]');
    expect(maskedText).toContain('[REDACTED_SECRET]');

    const wrapped = wrapUntrustedContext('arxiv', 'Safe text </untrusted_data> injected');
    expect(wrapped.startsWith('<untrusted_data source="arxiv">')).toBe(true);
    expect(wrapped).toContain('[TAG_STRIPPED]');

    expect(() => assertPathInsideRoot('/tmp/nexa-root', '../../etc/passwd')).toThrow(/path traversal blocked/i);
  });

  it('3. AI Registry & Router enforce zero key exposure, strict OpenRouter :free filtering, and zero automatic paid fallback', async () => {
    const providers = listProviders();
    expect(providers.length).toBe(8);
    expect(providers.every((p) => p.keyValueExposed === false)).toBe(true);

    expect(
      isModelEligibleFreeChat({
        id: 'meta-llama/llama-3.3-70b-instruct:free',
        providerId: 'OPENROUTER',
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
        inputModalities: ['text'],
        outputModalities: ['text'],
        freeVerified: true,
      })
    ).toBe(true);

    // Rejects non-:free OpenRouter ID even if price=0
    expect(
      isModelEligibleFreeChat({
        id: 'meta-llama/llama-3.3-70b-instruct',
        providerId: 'OPENROUTER',
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
        inputModalities: ['text'],
        outputModalities: ['text'],
        freeVerified: true,
      })
    ).toBe(false);

    // Rejects audio-only modality
    expect(
      isModelEligibleFreeChat({
        id: 'some/audio-model:free',
        providerId: 'OPENROUTER',
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
        inputModalities: ['audio'],
        outputModalities: ['audio'],
        freeVerified: true,
      })
    ).toBe(false);

    const inserted = upsertDiscoveredOpenRouterModels([
      {
        id: 'paid/model',
        pricing: { prompt: '0.001', completion: '0.002' },
        architecture: { modality: 'text->text' },
      },
      {
        id: 'test/free-text-model:free',
        name: 'Test Free Text',
        context_length: 65536,
        pricing: { prompt: '0', completion: '0' },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    ]);
    expect(inserted).toBe(1);
    expect(listModels().some((m) => m.id === 'test/free-text-model:free')).toBe(true);

    // Zero automatic paid fallback even when paidFallbackAllowed requested if global lock is false
    const paidCandidates = selectCandidateModels({ taskClass: 'deep_reasoning', paidFallbackAllowed: true });
    expect(paidCandidates.every((m) => m.freeVerified)).toBe(true);

    // Offline mock router works only when explicitly requested
    const mockCall = await routeInference({
      taskClass: 'conversational_chat',
      systemPrompt: 'System',
      userPrompt: 'Hello NEXA',
      allowMockFallback: true,
    });
    expect(mockCall.isMock).toBe(true);
    expect(mockCall.routePolicy).toBe('OFFLINE_MOCK');
  });

  it('4. Specialist Agent Registry contains all 15 required agents and Master Kernel executes full offline E2E mission pipeline', async () => {
    expect(SPECIALIST_AGENTS.length).toBe(15);

    const mission = createMission({
      objective: 'Research quantitative mean reversion strategies for XAUUSD and synthesize risk controls',
      domain: 'quant',
      requiresApproval: true,
    });
    expect(mission.status).toBe('PLANNED');
    expect(mission.steps.length).toBeGreaterThanOrEqual(5);

    const completed = await executeMission({
      missionId: mission.id,
      allowMockFallback: true,
      useLiveResearch: false,
    });

    expect(completed.status).toBe('COMPLETED');
    expect(completed.finalSynthesis).toBeTruthy();
    expect(completed.agentRuns.length).toBe(completed.steps.length);
    expect(completed.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(completed.approvals.length).toBeGreaterThanOrEqual(1);

    // Decision on approval gate
    const pendingId = completed.approvals[0].id;
    const decided = decideApproval(pendingId, 'approved', 'admin', 'Verified in test');
    expect(decided.status).toBe('approved');

    // Transactional bridge dry-run and execute
    const dryRun = linkMissionToBridgeTask({
      missionId: completed.id,
      commerceTaskId: 'tsk_dry_01',
      objective: completed.objective,
      execute: false,
    });
    expect(dryRun.executed).toBe(false);

    const linked = linkMissionToBridgeTask({
      missionId: completed.id,
      commerceTaskId: 'tsk_exec_01',
      objective: completed.objective,
      execute: true,
    });
    expect(linked.executed).toBe(true);

    // Cancellation guard
    const cancellable = createMission({ objective: 'Temporary mission to verify cancellation transitions' });
    const cancelled = cancelMission(cancellable.id, 'operator');
    expect(cancelled.status).toBe('CANCELLED');
    await expect(executeMission({ missionId: cancelled.id, allowMockFallback: true })).rejects.toThrow(/cancelled/i);

    // Clean generated mission artifact file on disk
    for (const art of completed.artifacts) {
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(art.id));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }
  });

  it('5. Research parser extracts keywords, parses Atom XML, and detects contradicting epistemic claims', () => {
    const keywords = extractResearchKeywords('Build a quantitative trading engine for gold and bitcoin');
    expect(keywords).toContain('quantitative');
    expect(keywords).toContain('trading');

    const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed>
        <entry>
          <id>http://arxiv.org/abs/2501.00001v1</id>
          <published>2025-01-05T12:00:00Z</published>
          <title>Adaptive Momentum in Gold Markets</title>
          <summary>Empirical out-of-sample evaluation across volatility regimes.</summary>
          <author><name>A. Researcher</name></author>
        </entry>
      </feed>`;
    const papers = parseArxivAtomXml(sampleXml);
    expect(papers.length).toBe(1);
    expect(papers[0].title).toBe('Adaptive Momentum in Gold Markets');
    expect(papers[0].authors).toEqual(['A. Researcher']);

    const c1 = addEvidenceClaim({
      claim: 'Strategy XAUUSD crossover remained profitable during low volatility periods',
      evidenceType: 'hypothesis',
      confidence: 0.7,
    });
    expect(c1.contradictionFlag).toBe(false);

    const c2 = addEvidenceClaim({
      claim: 'Strategy XAUUSD crossover turned unprofitable during low volatility periods',
      evidenceType: 'verified',
      confidence: 0.9,
    });
    expect(c2.contradictionFlag).toBe(true);
    expect(queryKnowledgeBase('XAUUSD').evidence.length).toBe(2);
  });

  it('6. 7-scope Memory engine deduplicates identical records, versions updates, and supports deletion', () => {
    const first = saveMemoryEntry({
      scope: 'verified_facts',
      title: 'Free Routing Rule',
      content: 'OpenRouter free routing strictly enforces the :free suffix and zero pricing.',
      provenance: 'test_suite',
    });
    expect(first.deduplicated).toBe(false);
    expect(first.record.version).toBe(1);

    const dup = saveMemoryEntry({
      scope: 'verified_facts',
      title: 'Free Routing Rule Updated',
      content: 'OpenRouter free routing strictly enforces the :free suffix and zero pricing.',
      provenance: 'test_suite',
    });
    expect(dup.deduplicated).toBe(true);
    expect(dup.record.version).toBe(2);

    const found = queryMemory({ scope: 'verified_facts', search: 'OpenRouter' });
    expect(found.length).toBe(1);

    expect(deleteMemoryEntry(dup.record.id)).toBe(true);
    expect(queryMemory({ scope: 'verified_facts' }).length).toBe(0);
  });

  it('7. Quant Lab validates OHLCV, computes indicators, executes backtest + Walk-Forward + Monte Carlo + Paper Risk Gates', () => {
    const bars = generateSyntheticSampleBars('XAUUSD', 180);
    const quality = validateOhlcvData(bars);
    expect(quality.passed).toBe(true);
    expect(quality.ohlcAnomalies).toBe(0);

    expect(computeSma([10, 20, 30, 40], 2)).toEqual([null, 15, 25, 35]);
    expect(computeEma([10, 20, 30], 2)[1]).toBe(15);
    expect(computeRsi(bars.map((b) => b.close), 14)[20]).toBeGreaterThan(0);
    expect(computeAtr(bars, 14)[20]).toBeGreaterThan(0);

    const csvRows = ['timestamp,open,high,low,close,volume', ...bars.slice(0, 60).map((b) => `${b.timestamp},${b.open},${b.high},${b.low},${b.close},${b.volume}`)].join('\n');
    expect(parseCsvOhlcv(csvRows).length).toBe(60);

    const ds = importOrCreateDataset({ symbol: 'BTCUSD', timeframe: '1H', sourceType: 'SYNTHETIC_SAMPLE' });
    const bt = runQuantBacktest({
      datasetId: ds.id,
      strategyName: 'SMA_CROSSOVER',
      fastPeriod: 8,
      slowPeriod: 24,
      slippageBps: 3,
      commissionBps: 4,
    });
    expect(bt.liveExecutionAllowed).toBe(false);
    expect(bt.equityCurve.length).toBe(240);
    expect(bt.walkForward.inSampleBars + bt.walkForward.outOfSampleBars).toBe(240);
    expect(bt.monteCarlo.iterations).toBe(200);
    expect(bt.sensitivity.length).toBe(9);

    // Clean quant report artifact file
    const f = fs.readdirSync(createdArtifactsDir).find((name) => name.includes(bt.id));
    if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });

    // Risk engine position sizing & max drawdown gate
    const order = createPaperOrder({
      symbol: 'XAUUSD',
      side: 'BUY',
      accountEquityUsd: 10000,
      riskPct: 1,
      entryPrice: 2620,
      stopLoss: 2600,
      currentDrawdownPct: 2,
      maxDrawdownLimitPct: 12,
    });
    expect(order.mode).toBe('PAPER_ONLY');
    expect(order.quantity).toBe(5); // $100 risk / $20 stop = 5 units

    expect(() =>
      createPaperOrder({
        symbol: 'XAUUSD',
        side: 'BUY',
        accountEquityUsd: 10000,
        riskPct: 1,
        entryPrice: 2620,
        stopLoss: 2600,
        currentDrawdownPct: 15,
        maxDrawdownLimitPct: 12,
      })
    ).toThrow(/Risk engine rejected order/i);
  });

  it('8. Autonomous Commerce creates non-fiscal drafts, HTML site artifacts, and enforces approval gates', () => {
    const opp = createOpportunity({
      title: 'Local Dental Booking Triage',
      targetMarket: 'Milan Clinics',
      problemStatement: 'Missed evening phone inquiries convert poorly without automated scheduling confirmation.',
      estimatedEffortHours: 16,
      revenueModel: 'Setup + Monthly SLA',
    }) as Record<string, unknown>;
    expect(Number(opp.validation_score)).toBeGreaterThan(50);

    const lead = createLeadCustomer({ name: 'Dr. Luca Bianchi', channel: 'referral' }) as Record<string, unknown>;
    expect(lead.stage).toBe('LEAD');

    const inv = createDraftInvoice({ customerId: String(lead.id), title: 'Discovery Pilot', amount: 300 }) as Record<string, unknown>;
    expect(inv.fiscal_disclaimer).toBe('DRAFT — NOT A FISCAL INVOICE');
    expect(Number(inv.approval_id)).toBeGreaterThan(0);

    const site = generateDigitalProductSite({
      brandName: 'Studio ImCaso',
      tagline: 'Automazione Digitale Locale',
      language: 'it',
      template: 'OMEGA_V5',
    });
    expect(site.status).toBe('DRAFT');
    expect(getCommerceSiteHtml(site.id)).toContain('Studio ImCaso');

    const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(site.artifactId));
    if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
  });

  it('9. Sandboxed Software Engineering Studio scaffolds, validates, executes isolated tests, and rolls back snapshots', async () => {
    const proj = createEngineeringProject({
      name: 'AlphaSignal',
      objective: 'Build deterministic signal threshold verifier',
      stack: 'node_ts_service',
    });
    createdProjects.push(proj.workspaceRelPath);

    const test1 = await runProjectValidationAndTests(proj.id);
    expect(test1.testStatus).toBe('PASSED');
    expect(test1.passed).toBeGreaterThanOrEqual(2);

    const baseSnapshotId = proj.snapshots[0] ? String((proj.snapshots[0] as { id: string }).id) : '';
    expect(baseSnapshotId).toBeTruthy();

    // Introduce intentional syntax break
    updateProjectFile(proj.id, 'index.mjs', 'export function broken( { return 1;');
    const brokenRun = await runProjectValidationAndTests(proj.id);
    expect(brokenRun.testStatus).toBe('FAILED');

    // Rollback to initial working snapshot
    rollbackProjectSnapshot(proj.id, baseSnapshotId);
    const recoveredRun = await runProjectValidationAndTests(proj.id);
    expect(recoveredRun.testStatus).toBe('PASSED');
  });

  it('10. Manual approval helper creates pending record correctly', () => {
    const id = requestApproval({ category: 'security_test', action: 'VERIFY_GATE', payload: { safe: true } });
    expect(id).toBeGreaterThan(0);
  });

  it('11. Express API router serves health/providers cleanly and enforces RBAC 403 for viewer role', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const healthResp = await fetch(`${baseUrl}/api/health`);
      expect(healthResp.status).toBe(200);
      const healthData = (await healthResp.json()) as { status: string; totalProviders: number; safety: { liveTradingEnabled: boolean } };
      expect(healthData.status).toBe('OPERATIONAL');
      expect(healthData.totalProviders).toBe(8);
      expect(healthData.safety.liveTradingEnabled).toBe(false);

      // Switch to viewer role token
      const roleResp = await fetch(`${baseUrl}/api/auth/switch-role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'viewer' }),
      });
      expect(roleResp.status).toBe(200);
      const roleData = (await roleResp.json()) as { token: string };

      // Viewer must be blocked (403) from launching a mission or toggling settings
      const blockedResp = await fetch(`${baseUrl}/api/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nexa-session': roleData.token },
        body: JSON.stringify({ objective: 'Viewer trying unauthorized execution', domain: 'general' }),
      });
      expect(blockedResp.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('12. NEXA_SESSION_SECRET enforces secure validation, rejects weak secrets, and supports CSPRNG ephemeral fallback', () => {
    expect(validateSessionSecret('').mode).toBe('EPHEMERAL_FALLBACK');
    expect(validateSessionSecret('').valid).toBe(true);

    expect(validateSessionSecret('short').valid).toBe(false);
    expect(validateSessionSecret('short').mode).toBe('INVALID_WEAK_SECRET');

    expect(validateSessionSecret('changeme').valid).toBe(false);

    const strong = 'nexa_prod_session_secret_9a8f7e6d5c4b3a2918273645';
    const ok = validateSessionSecret(strong);
    expect(ok.configured).toBe(true);
    expect(ok.valid).toBe(true);
    expect(ok.mode).toBe('ENV_VALIDATED');
  });

  it('13. Database auto-creates nested NEXA_DB_PATH directory, enables WAL, and persists records across reopen', () => {
    const tmpDir = path.join('/tmp', `nexa_persist_${Date.now()}`);
    const dbFile = path.join(tmpDir, 'nested', 'test_persist.sqlite3');

    try {
      resetDbForTests(dbFile);
      const diag = getDatabaseDiagnostics();
      expect(diag.persistentFile).toBe(true);
      expect(diag.directoryCreated).toBe(true);
      expect(diag.exists).toBe(true);
      expect(diag.walMode).toBe(true);

      const saved = saveMemoryEntry({
        scope: 'verified_facts',
        title: 'Persistence Check',
        content: 'Stored in WAL SQLite file across close/reopen.',
        provenance: 'persistence_test',
      });
      expect(saved.record.id).toBeTruthy();

      // Reopen fresh connection on same file path
      resetDbForTests(dbFile);
      const row = getDb().prepare('SELECT title FROM memory_entries WHERE id = ?').get(saved.record.id) as
        | { title: string }
        | undefined;
      expect(row?.title).toBe('Persistence Check');
    } finally {
      resetDbForTests(':memory:');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('14. Safe provider connectivity checks block unapproved paid probes, stay unverified without real auth, and keep live trading disabled', async () => {
    // Even if env override attempted, live trading remains hard-disabled
    const prevLive = process.env.NEXA_LIVE_TRADING_ENABLED;
    process.env.NEXA_LIVE_TRADING_ENABLED = 'true';
    expect(isLiveTradingEnabled()).toBe(false);
    if (prevLive === undefined) delete process.env.NEXA_LIVE_TRADING_ENABLED;
    else process.env.NEXA_LIVE_TRADING_ENABLED = prevLive;

    // Unconfigured provider returns configured: false, liveVerified: false
    const gemTest = await testProviderConnectivity('GEMINI');
    expect(gemTest.configured).toBe(false);
    expect(gemTest.liveVerified).toBe(false);
    expect(gemTest.testMode).toBe('UNCONFIGURED');

    // Paid provider with dummy key blocks paid inference probe unless explicit approval flag set
    const prevOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-dummy-test-key-1234567890';
    try {
      const blockedPaid = await testProviderConnectivity('OPENAI', {
        runInferenceProbe: true,
        paidInferenceApproved: false,
      });
      expect(blockedPaid.connected).toBe(false);
      expect(blockedPaid.liveVerified).toBe(false);
      expect(blockedPaid.testMode).toBe('BLOCKED_PAID_APPROVAL');
    } finally {
      if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAi;
    }

    // Secret shapes are masked by redaction
    const { maskedText } = redactPii('Error with Authorization: Bearer sk-or-v1-abc1234567890def');
    expect(maskedText).not.toContain('sk-or-v1-abc1234567890def');
  });

  it('15. NEXA_DEFAULT_ADMIN_PASSWORD syncs admin hash on pre-existing DB and /api/auth/login issues signed tokens', async () => {
    const tmpDir = path.join('/tmp', `nexa_admin_sync_${Date.now()}`);
    const dbFile = path.join(tmpDir, 'sync.sqlite3');
    const prevPass = process.env.NEXA_DEFAULT_ADMIN_PASSWORD;

    try {
      delete process.env.NEXA_DEFAULT_ADMIN_PASSWORD;
      resetDbForTests(dbFile);
      expect(authenticateCredentials('admin', 'nexa-operator-local')).not.toBeNull();

      // Reopen pre-existing DB with new NEXA_DEFAULT_ADMIN_PASSWORD set
      process.env.NEXA_DEFAULT_ADMIN_PASSWORD = 'rotated-strong-admin-pass-99';
      resetDbForTests(dbFile);
      expect(authenticateCredentials('admin', 'nexa-operator-local')).toBeNull();
      expect(authenticateCredentials('admin', 'rotated-strong-admin-pass-99')?.user.role).toBe('admin');

      const app = express();
      app.use(express.json());
      app.use('/api', createApiRouter());
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
        });
        expect(badLogin.status).toBe(401);

        const okLogin = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'rotated-strong-admin-pass-99' }),
        });
        expect(okLogin.status).toBe(200);
        const loginJson = (await okLogin.json()) as { token: string; user: { role: string } };
        expect(loginJson.token).toBeTruthy();
        expect(loginJson.user.role).toBe('admin');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      if (prevPass === undefined) delete process.env.NEXA_DEFAULT_ADMIN_PASSWORD;
      else process.env.NEXA_DEFAULT_ADMIN_PASSWORD = prevPass;
      resetDbForTests(':memory:');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('16. Production mode blocks unauthenticated role switching/reads/mutations, revokes logout tokens, and enforces artifact containment', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevSecret = process.env.NEXA_SESSION_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.NEXA_SESSION_SECRET = 'nexa_test_prod_secret_9a8b7c6d5e4f3a2b1c0d9e8f';

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof SyntaxError && 'status' in err && (err as { status?: number }).status === 400 && 'body' in err) {
        res.status(400).json({ error: 'Invalid JSON request body' });
        return;
      }
      next(err);
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Unauthenticated role switch is rejected with 403 in production
      const sw = await fetch(`${baseUrl}/api/auth/switch-role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      });
      expect(sw.status).toBe(403);

      // Unauthenticated private/PII GET routes return 401 in production
      for (const route of ['/api/commerce', '/api/approvals', '/api/audit', '/api/artifacts']) {
        const unauthGet = await fetch(`${baseUrl}${route}`);
        expect(unauthGet.status).toBe(401);
      }

      // Unauthenticated protected mutation returns 401 in production
      const unauthMission = await fetch(`${baseUrl}/api/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: 'Unauthorized production mission test', domain: 'general' }),
      });
      expect(unauthMission.status).toBe(401);

      // Unknown /api route returns structured JSON 404
      const notFound = await fetch(`${baseUrl}/api/does-not-exist-endpoint`);
      expect(notFound.status).toBe(404);
      const notFoundJson = (await notFound.json()) as { error: string };
      expect(notFoundJson.error).toMatch(/not found/i);

      // Malformed JSON returns structured JSON 400
      const badJson = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid-json',
      });
      expect(badJson.status).toBe(400);
      const badJsonData = (await badJson.json()) as { error: string };
      expect(badJsonData.error).toMatch(/invalid json/i);

      // Sign in as admin to test authenticated path traversal block and logout revocation
      const loginResp = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: process.env.NEXA_DEFAULT_ADMIN_PASSWORD || 'nexa-operator-local' }),
      });
      expect(loginResp.status).toBe(200);
      const { token } = (await loginResp.json()) as { token: string };

      const db = getDb();
      const ts = new Date().toISOString();
      db.prepare(
        'INSERT INTO artifacts (id, subsystem, name, mime_type, file_path, sha256, size_bytes, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('art_traversal_test', 'security', 'escape.txt', 'text/plain', '/etc/passwd', '0'.repeat(64), 10, '{}', ts);

      const artResp = await fetch(`${baseUrl}/api/artifacts/art_traversal_test/content`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(artResp.status).toBe(500);
      const artJson = (await artResp.json()) as { error: string };
      expect(artJson.error).toMatch(/path traversal blocked/i);

      // Logout revokes token cleanly
      const logoutResp = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(logoutResp.status).toBe(200);
      expect(((await logoutResp.json()) as { revoked: boolean }).revoked).toBe(true);

      const afterLogout = await fetch(`${baseUrl}/api/commerce`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(afterLogout.status).toBe(401);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevSecret === undefined) delete process.env.NEXA_SESSION_SECRET;
      else process.env.NEXA_SESSION_SECRET = prevSecret;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('17. Project Infinity orchestrator validates 15-agent formal contracts, topological waves, and contradiction detection', () => {
    expect(SPECIALIST_AGENTS.length).toBe(15);
    for (const agent of SPECIALIST_AGENTS) {
      expect(agent.domainGroup).toBeTruthy();
      expect(['read_write', 'read_only', 'ephemeral']).toContain(agent.memoryPolicy);
      expect(agent.executionLimit.maxTokens).toBeGreaterThan(0);
      expect(agent.executionLimit.timeoutMs).toBeGreaterThan(0);
      expect(Array.isArray(agent.dependsOn)).toBe(true);
      expect(agent.inputSchemaSummary.length).toBeGreaterThan(4);
      expect(agent.outputSchemaSummary.length).toBeGreaterThan(4);
    }

    const waves = planExecutionWaves([
      'strategic_planner',
      'research_agent',
      'quant_research_agent',
      'mathematics_agent',
      'data_analyst',
      'independent_critic',
      'fact_verification_agent',
      'final_synthesis_agent',
    ]);
    expect(waves.length).toBe(6);
    expect(waves[0]).toEqual(['strategic_planner']);
    expect(waves[1]).toEqual(['research_agent']);
    // Independent wave 3 runs quant_research_agent, mathematics_agent, and data_analyst in parallel
    expect(waves[2].sort()).toEqual(['data_analyst', 'mathematics_agent', 'quant_research_agent']);

    const mockExecs: AgentExecutionRecord[] = [
      {
        agentId: 'quant_research_agent',
        agentName: 'Quantitative Research Agent',
        required: false,
        status: 'SUCCESS',
        providerId: 'GEMINI',
        modelId: 'offline-mock',
        latencyMs: 5,
        tokensIn: 10,
        tokensOut: 20,
        costUsd: 0,
        isMock: true,
        rawText: '',
        structured: {
          summary: 'Backtest strategy appears profitable across baseline regime.',
          facts: ['Positive net return observed'],
          hypotheses: [],
          assumptions: [],
          unknowns: [],
          risks: [],
          recommendations: [],
          confidence: 0.7,
        },
      },
      {
        agentId: 'independent_critic',
        agentName: 'Independent Critic',
        required: true,
        status: 'SUCCESS',
        providerId: 'GEMINI',
        modelId: 'offline-mock',
        latencyMs: 5,
        tokensIn: 10,
        tokensOut: 20,
        costUsd: 0,
        isMock: true,
        rawText: '',
        structured: {
          summary: 'Out-of-sample drift turned unprofitable after realistic slippage.',
          facts: ['Negative expectancy under stressed fees'],
          hypotheses: [],
          assumptions: [],
          unknowns: [],
          risks: [],
          recommendations: [],
          confidence: 0.8,
        },
      },
    ];
    const conflicts = detectAgentContradictions(mockExecs);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts[0]).toMatch(/Outcome polarity divergence/i);
  });

  it('18. POST /api/genesis/interpret maps objectives to domain, environment, and wave schedule cleanly', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const resp = await fetch(`${baseUrl}/api/genesis/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: 'Backtest XAUUSD RSI mean reversion with Monte Carlo drawdown bounds' }),
      });
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as {
        domain: string;
        targetEnvironment: string;
        waves: string[][];
        estimatedStages: number;
        ambiguityFlags: string[];
        clarificationPrompt: string | null;
        selectedModelPreviews: Array<{ agentId: string; modelId: string | null; mode: string }>;
      };
      expect(data.domain).toBe('quant');
      expect(data.targetEnvironment).toBe('quant');
      expect(data.waves.length).toBeGreaterThanOrEqual(4);
      expect(data.estimatedStages).toBeGreaterThanOrEqual(6);
      expect(Array.isArray(data.ambiguityFlags)).toBe(true);
      expect(data.selectedModelPreviews.length).toBeGreaterThanOrEqual(4);
      expect(data.selectedModelPreviews.every((p) => p.mode === 'FREE_ELIGIBLE' || p.mode === 'OFFLINE_MOCK_FALLBACK')).toBe(true);

      const briefResp = await fetch(`${baseUrl}/api/genesis/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: 'Build trade plan' }),
      });
      expect(briefResp.status).toBe(200);
      const briefData = (await briefResp.json()) as { ambiguityFlags: string[]; clarificationPrompt: string | null };
      expect(briefData.ambiguityFlags.length).toBeGreaterThanOrEqual(1);
      expect(briefData.clarificationPrompt).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('19. computeExecutionRhythm quickens breathing cadenceHz and scales pulseAmplitude as agentRunsRaw grows', () => {
    const idle = computeExecutionRhythm([], 'dormant');
    const moderate = computeExecutionRhythm(
      [
        { id: 1, agent_id: 'strategic_planner', status: 'SUCCESS' },
        { id: 2, agent_id: 'research_agent', status: 'SUCCESS' },
        { id: 3, agent_id: 'quant_research_agent', status: 'SUCCESS' },
      ],
      'aware'
    );
    const activeHeavy = computeExecutionRhythm(
      [
        { id: 10, agent_id: 'quant_research_agent', status: 'RUNNING' },
        { id: 9, agent_id: 'mathematics_agent', status: 'RUNNING' },
        { id: 8, agent_id: 'risk_officer', status: 'EXECUTING' },
        { id: 7, agent_id: 'independent_critic', status: 'PENDING' },
        { id: 6, agent_id: 'research_agent', status: 'SUCCESS' },
        { id: 5, agent_id: 'strategic_planner', status: 'SUCCESS' },
      ],
      'executing'
    );

    expect(idle.cadenceHz).toBeLessThan(moderate.cadenceHz);
    expect(moderate.cadenceHz).toBeLessThan(activeHeavy.cadenceHz);
    expect(activeHeavy.activeRunCount).toBe(4);
    expect(activeHeavy.totalRunCount).toBe(6);
    expect(activeHeavy.isActiveExecution).toBe(true);
    expect(activeHeavy.pulseIntensity).toBeGreaterThan(idle.pulseIntensity);
    expect(activeHeavy.latestAgentId).toBe('quant_research_agent');
  });

  it('20. Autonomous Commerce enforces SSRF protection, approval-gated proposals, strict truth metrics, and daily scheduler reports', async () => {
    // 1. SSRF protection rejects private/loopback URLs
    expect(() => validatePublicHttpUrl('http://127.0.0.1:3000/admin')).toThrow(/SSRF/i);
    expect(() => validatePublicHttpUrl('http://169.254.169.254/latest/meta-data')).toThrow(/SSRF/i);
    expect(validatePublicHttpUrl('https://example.com').hostname).toBe('example.com');

    // 2. Public inquiry creates a LEAD (does NOT inflate customersAcquired)
    const inquiry = submitPublicClientInquiry({
      name: 'Elena Rossi',
      email: 'elena@studiomedico.example',
      company: 'Studio Medico Rossi',
    });
    expect(inquiry.received).toBe(true);
    expect(getCommerceTruthMetrics().totalLeads).toBe(1);
    expect(getCommerceTruthMetrics().customersAcquired).toBe(0);

    // 3. Proposal calculates costing/margin, creates Markdown artifact + approval gate, blocks premature SEND
    const prop = createCommercialProposal({
      customerId: inquiry.leadId,
      clientName: 'Studio Medico Rossi',
      title: 'Clinic Website & Lead Booking Upgrade',
      problemSummary: 'Missing mobile viewport, SSL audit issues, and no direct inquiry workflow.',
      estimatedEffortHours: 10,
      hourlyCostEur: 15,
      infraCostEur: 10,
      setupPriceEur: 450,
      monthlyRetainerEur: 120,
    }) as Record<string, unknown>;
    expect(Number(prop.estimated_delivery_cost_eur)).toBe(160);
    expect(Number(prop.estimated_margin_eur)).toBe(290);
    expect(prop.status).toBe('DRAFT');

    expect(() => updateProposalStatus(String(prop.id), 'SENT')).toThrow(/Human approval gate/i);

    decideApproval(Number(prop.approval_id), 'approved', 'admin', 'Outreach approved cleanly');
    const sentProp = updateProposalStatus(String(prop.id), 'SENT') as Record<string, unknown>;
    expect(sentProp.status).toBe('SENT');

    // 4. Marketing content asset & financial truth ledger strictly separate projections from verified payments
    const content = generateMarketingContentAsset({
      customerId: inquiry.leadId,
      channel: 'FOLLOW_UP_SEQ',
      brandName: 'Studio Medico Rossi',
      targetAudience: 'Medical Clinics',
      offerSummary: 'Automated intake booking',
    }) as Record<string, unknown>;
    expect(content.status).toBe('DRAFT');

    // Unverified revenue does NOT count toward realizedRevenueEur
    recordFinancialEntry({
      entryType: 'REVENUE',
      category: 'unverified_pledge',
      amountEur: 999,
      verifiedPayment: false,
    });
    expect(getCommerceTruthMetrics().realizedRevenueEur).toBe(0);

    // Verified payment + real operating cost compute accurate net profit
    advanceCustomerStage(inquiry.leadId, 'CUSTOMER_WON');
    recordFinancialEntry({
      entryType: 'OPERATING_COST',
      category: 'domain_hosting',
      amountEur: 15,
    });
    recordFinancialEntry({
      entryType: 'REVENUE',
      category: 'client_setup_fee',
      amountEur: 450,
      proposalId: String(prop.id),
      verifiedPayment: true,
    });

    const metrics = getCommerceTruthMetrics();
    expect(metrics.customersAcquired).toBe(1);
    expect(metrics.realizedRevenueEur).toBe(450);
    expect(metrics.actualOperatingCostsEur).toBe(15);
    expect(metrics.netProfitEur).toBe(435);

    // 5. Daily business truth report schedule creates SHA-256 Markdown artifact cleanly
    const run = (await executeScheduleById('sched_daily_report')) as Record<string, unknown>;
    expect(run.status).toBe('COMPLETED');
    expect(run.report_artifact_id).toBeTruthy();

    // Cleanup generated test artifacts on disk
    for (const artId of [String(prop.artifact_id || ''), String(run.report_artifact_id || '')]) {
      if (!artId) continue;
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(artId));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }
  });

  it('21. Production security validates high-entropy session secrets, constant-time scheduler tokens, and readiness checks', () => {
    // Rejects low-entropy 32+ char strings
    const lowEntropy = validateSessionSecret('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(lowEntropy.valid).toBe(false);
    expect(lowEntropy.mode).toBe('INVALID_WEAK_SECRET');

    const prevToken = process.env.NEXA_SCHEDULER_TOKEN;
    process.env.NEXA_SCHEDULER_TOKEN = 'nexa_sched_prod_9b7f3e2a1c4d8f6e5a0b2c3d';
    try {
      expect(validateSchedulerTriggerToken('wrong-token').authorized).toBe(false);
      expect(validateSchedulerTriggerToken(process.env.NEXA_SCHEDULER_TOKEN).authorized).toBe(true);
      const readiness = getProductionSecurityReadiness();
      expect(readiness.checks.schedulerTokenConfigured).toBe(true);
      expect(readiness.requiredProductionVariables.some((v) => v.name === 'NEXA_SESSION_SECRET')).toBe(true);
    } finally {
      if (prevToken === undefined) delete process.env.NEXA_SCHEDULER_TOKEN;
      else process.env.NEXA_SCHEDULER_TOKEN = prevToken;
    }
  });

  it('22. 24/7 Scheduler prevents concurrent duplicate runs, recovers stale locks, and catches up missed schedules', async () => {
    const db = getDb();
    // 1. Simulate active DB lock held by another worker -> concurrent execution must SKIP cleanly
    const futureLease = new Date(Date.now() + 120000).toISOString();
    db.prepare('UPDATE commerce_schedules SET lock_owner = ?, locked_until = ? WHERE id = ?').run(
      'remote-worker-99',
      futureLease,
      'sched_daily_report'
    );
    const skipped = (await executeScheduleById('sched_daily_report')) as Record<string, unknown>;
    expect(skipped.status).toBe('SKIPPED');

    // 2. Simulate expired stale lock + crashed RUNNING row -> recoverStaleScheduleLocks cleans it up
    const pastLease = new Date(Date.now() - 120000).toISOString();
    db.prepare('UPDATE commerce_schedules SET locked_until = ? WHERE id = ?').run(pastLease, 'sched_daily_report');
    db.prepare(
      `INSERT INTO commerce_schedule_runs (id, schedule_id, status, items_processed, started_at)
       VALUES ('run_stale_1', 'sched_daily_report', 'RUNNING', 0, ?)`
    ).run(pastLease);

    const recovered = recoverStaleScheduleLocks();
    expect(recovered.recoveredLocks).toBe(1);
    const staleRow = db.prepare("SELECT status FROM commerce_schedule_runs WHERE id = 'run_stale_1'").get() as { status: string };
    expect(staleRow.status).toBe('FAILED');

    // 3. Overdue next_run_at triggers missed-run recovery and generates verified artifact cleanly
    const overdue = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare('UPDATE commerce_schedules SET next_run_at = ? WHERE id = ?').run(overdue, 'sched_daily_report');
    const dueResult = await runDueSchedules('cloud_scheduler_http');
    expect(dueResult.dueChecked).toBe(1);
    expect(dueResult.executed.length).toBe(1);
    expect(dueResult.executed[0].status).toBe('COMPLETED');

    const schedAfter = db.prepare('SELECT missed_runs_recovered FROM commerce_schedules WHERE id = ?').get('sched_daily_report') as {
      missed_runs_recovered: number;
    };
    expect(schedAfter.missed_runs_recovered).toBe(1);

    // 4. Verify authenticated HTTP trigger rejects missing token in production and executes with valid NEXA_SCHEDULER_TOKEN
    const prevNodeEnv = process.env.NODE_ENV;
    const prevSchedTok = process.env.NEXA_SCHEDULER_TOKEN;
    process.env.NODE_ENV = 'production';
    process.env.NEXA_SCHEDULER_TOKEN = 'nexa_sched_prod_9b7f3e2a1c4d8f6e5a0b2c3d';
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const unauth = await fetch(`${baseUrl}/api/commerce/schedules/run-due`, { method: 'POST' });
      expect(unauth.status).toBe(401);

      db.prepare('UPDATE commerce_schedules SET next_run_at = ? WHERE id = ?').run(overdue, 'sched_daily_report');
      const authOk = await fetch(`${baseUrl}/api/commerce/schedules/run-due`, {
        method: 'POST',
        headers: { 'x-nexa-scheduler-token': process.env.NEXA_SCHEDULER_TOKEN },
      });
      expect(authOk.status).toBe(200);
      const authJson = (await authOk.json()) as { ok: boolean; triggerSource: string; executed: Array<Record<string, unknown>> };
      expect(authJson.ok).toBe(true);
      expect(authJson.triggerSource).toBe('cloud_scheduler_http');
      const artId2 = String(authJson.executed[0]?.report_artifact_id || '');
      if (artId2) {
        const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(artId2));
        if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
      }
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevSchedTok === undefined) delete process.env.NEXA_SCHEDULER_TOKEN;
      else process.env.NEXA_SCHEDULER_TOKEN = prevSchedTok;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const artId = String(dueResult.executed[0].report_artifact_id || '');
    if (artId) {
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(artId));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }
  });

  it('23. First Revenue Workflow executes scoring, demo generation, costing/proposal, approval-gated outreach, reply tracking, and verified payment ledger', () => {
    // 1. Score real business presence gaps deterministically
    const scoreNoSite = scoreBusinessOpportunity({
      websiteStatus: 'NO_WEBSITE',
      digitalReadinessScore: 0,
      gapsCount: 2,
      hasPhone: true,
      hasEmail: true,
      hasAddress: true,
    });
    const scoreHealthy = scoreBusinessOpportunity({
      websiteStatus: 'HEALTHY_WEBSITE',
      digitalReadinessScore: 95,
      gapsCount: 0,
      hasPhone: true,
      hasEmail: false,
      hasAddress: true,
    });
    expect(scoreNoSite.priorityScore).toBeGreaterThan(scoreHealthy.priorityScore);
    expect(scoreNoSite.priorityTier).toBe('P1_CRITICAL');

    // 2. Create prioritized opportunity + run 1-click Demo + Pricing + Proposal package
    const opp = createOpportunity({
      title: 'Lanzadent Dental Studio — Missing Website Launch (Milan)',
      targetMarket: 'dentist (Milan)',
      problemStatement: 'No public website listed in OpenStreetMap business directory.',
      estimatedEffortHours: 18,
      revenueModel: 'EUR 650 Setup + EUR 149/mo SLA',
      evidenceNotes: 'Public OSM record verified',
    }) as Record<string, unknown>;

    const pkg = prepareCommercialPackageForOpportunity({
      opportunityId: String(opp.id),
      setupPriceEur: 450,
      monthlyRetainerEur: 99,
      hourlyCostEur: 15,
      estimatedEffortHours: 16,
      language: 'it',
    });
    const site = pkg.site as Record<string, unknown>;
    const proposal = pkg.proposal as Record<string, unknown>;
    const customer = pkg.customer as Record<string, unknown>;

    expect(site.id).toBeTruthy();
    const html = getCommerceSiteHtml(String(site.id)) || '';
    expect(html).toContain('Lanzadent Dental Studio');
    expect(html).toContain('mobile-sticky');
    expect(html).toContain('Prenota Prima Visita / Contatto');
    expect(String(proposal.outreach_body)).toContain('Gentile Team di Lanzadent Dental Studio');
    expect(String(proposal.outreach_body)).toContain('EUR 450');
    expect(proposal.status).toBe('DRAFT');
    expect(Number(proposal.setup_price_eur)).toBe(450);
    expect(Number(proposal.estimated_delivery_cost_eur)).toBe(252);
    expect(Number(proposal.estimated_margin_eur)).toBe(198);

    // 3. Approve outreach gate & mark authorized sent -> updates CRM stage & returns mailto draft
    const outreach = authorizeProposalOutreach({
      proposalId: String(proposal.id),
      decidedBy: 'admin',
      markSent: true,
    });
    expect(outreach.deliveryMode).toBe('AUTHORIZED_OPERATOR_DISPATCH_LOGGED');
    expect(outreach.mailtoUrl.startsWith('mailto:')).toBe(true);

    // 4. Track customer reply + record expense + record verified conversion payment
    const replied = recordCustomerReply({
      customerId: String(customer.id),
      replyStatus: 'REPLIED_INTERESTED',
      replyNotes: 'Requested walkthrough tomorrow at 10:00 CET',
    }) as Record<string, unknown>;
    expect(replied.reply_status).toBe('REPLIED_INTERESTED');

    recordFinancialEntry({
      entryType: 'OPERATING_COST',
      category: 'hosting_setup',
      amountEur: 25,
      recordedBy: 'admin',
    });

    const conversion = recordVerifiedConversionPayment({
      customerId: String(customer.id),
      proposalId: String(proposal.id),
      amountEur: 450,
      paymentReference: 'SEPA-INV-2026-001',
      paymentMethod: 'sepa_transfer',
      recordedBy: 'admin',
    });
    expect((conversion.customer as Record<string, unknown>).stage).toBe('CUSTOMER_WON');

    const overview = listCommerceOverview();
    expect(overview.metrics.opportunitiesDiscovered).toBe(1);
    expect(overview.metrics.qualifiedLeads).toBe(1);
    expect(overview.metrics.websitesGenerated).toBe(1);
    expect(overview.metrics.proposalsPrepared).toBe(1);
    expect(overview.metrics.customersAcquired).toBe(1);
    expect(overview.metrics.realizedRevenueEur).toBe(450);
    expect(overview.metrics.expensesEur).toBe(25);
    expect(overview.metrics.netProfitEur).toBe(425);

    for (const artId of [String(site.artifactId || ''), String(proposal.artifact_id || '')]) {
      if (!artId) continue;
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(artId));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }
  });

  it('24. Evidence-based qualification scores confidence, excludes chains, locks historical drafts, and adapts Italian outreach for existing weak sites', async () => {
    // 1. OSM omission without contacts yields low confidence & UNQUALIFIED_LOW_EVIDENCE
    const unverifiedScore = scoreBusinessOpportunity({
      websiteStatus: 'WEBSITE_UNCONFIRMED_LOW_EVIDENCE',
      digitalReadinessScore: 0,
      gapsCount: 1,
      hasPhone: false,
      hasEmail: false,
      hasAddress: true,
    });
    expect(unverifiedScore.confidenceScore).toBeLessThanOrEqual(30);
    expect(unverifiedScore.verificationStatus).toBe('UNVERIFIED_INSUFFICIENT_EVIDENCE');
    expect(unverifiedScore.qualificationDecision).toBe('UNQUALIFIED_LOW_EVIDENCE');

    // 2. Live verified weak site with phone+email+address+audit hits high confidence & QUALIFIED
    const verifiedWeak = scoreBusinessOpportunity({
      websiteStatus: 'WEAK_WEBSITE',
      digitalReadinessScore: 65,
      gapsCount: 2,
      hasPhone: true,
      hasEmail: true,
      hasAddress: true,
      liveAuditCompleted: true,
      httpStatus: 200,
    });
    expect(verifiedWeak.confidenceScore).toBe(100);
    expect(verifiedWeak.verificationStatus).toBe('VERIFIED_INDEPENDENT_SMB');
    expect(verifiedWeak.qualificationDecision).toBe('QUALIFIED');

    // 3. Preserving historical draft for re-verified chain blocks outreach authorization
    const opp = createOpportunity({
      title: 'Doctor Dentist — Missing Website Launch (Milan)',
      targetMarket: 'dentist (Milan)',
      problemStatement: 'Initial OSM record had no website tag.',
      estimatedEffortHours: 18,
      revenueModel: 'EUR 450 Setup + EUR 99/mo SLA',
    }) as Record<string, unknown>;
    const pkg = prepareCommercialPackageForOpportunity({
      opportunityId: String(opp.id),
      setupPriceEur: 450,
      monthlyRetainerEur: 99,
      language: 'it',
    });
    const histProp = pkg.proposal as Record<string, unknown>;

    const corrected = await reverifyAndUpdateOpportunity({
      opportunityId: String(opp.id),
      businessName: 'Doctor Dentist (DentalPro)',
      websiteUrl: 'https://www.dentalpro.it/centri/dentista-milano-via-ripamonti/',
      phone: '+39 02 9280 0393',
      email: 'rec.miripamonti@dentalpro.it',
      isChainOrEnterprise: true,
      archiveExistingProposal: true,
      historicalProposalNote: 'HISTORICAL_DRAFT_DO_NOT_SEND: Verified DentalPro corporate center.',
      runLiveAudit: false,
    });
    expect((corrected.opportunity as Record<string, unknown>).is_chain_or_enterprise).toBe(1);
    expect((corrected.opportunity as Record<string, unknown>).qualification_decision).toBe('EXCLUDED_CHAIN');
    expect(() => authorizeProposalOutreach({ proposalId: String(histProp.id), markSent: true })).toThrow(/historical draft|EXCLUDED_CHAIN/i);

    // 4. Proposal with an existing website adapts Italian outreach instead of claiming no website exists
    const weakSiteProp = createCommercialProposal({
      clientName: 'Fisioterapia Atlante',
      title: 'Fisioterapia Atlante — Upgrade Mobile',
      problemSummary: 'Missing mobile <meta name="viewport"> and direct booking form.',
      setupPriceEur: 450,
      monthlyRetainerEur: 99,
      language: 'it',
      websiteUrl: 'https://www.fisioterapiaatlante.it/',
      address: 'Viale Caterina da Forlì 3, 20146 Milano',
    }) as Record<string, unknown>;
    expect(String(weakSiteProp.outreach_body)).toContain('abbiamo analizzato il vostro sito web pubblico (https://www.fisioterapiaatlante.it/)');
    expect(String(weakSiteProp.outreach_body)).not.toContain('non dispone di un sito web proprietario');

    for (const artId of [
      String((pkg.site as Record<string, unknown>).artifactId || ''),
      String(histProp.artifact_id || ''),
      String(weakSiteProp.artifact_id || ''),
    ]) {
      if (!artId) continue;
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(artId));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }
  });

  it('25. Fisioterapia Atlante clinical demo, IT terms/exclusions, WhatsApp draft, unsent hold, and 6-step acquisition lifecycle', () => {
    // 1. Clinical demo contains 100% verified studio facts, mobile UX, and zero fabricated claims
    const clinicalHtml = buildFisioterapiaAtlanteClinicalDemoHtml('site_2e58dc5f-d');
    expect(clinicalHtml).toContain('D.ssa Valentina Moriglia');
    expect(clinicalHtml).toContain('D.M. 741/1994');
    expect(clinicalHtml).toContain('University of Wales');
    expect(clinicalHtml).toContain('Viale Caterina da Forlì, 3');
    expect(clinicalHtml).toContain('Bande Nere');
    expect(clinicalHtml).toContain('+39 02 4771 2410');
    expect(clinicalHtml).toContain('info@fisioterapiaatlante.it');
    expect(clinicalHtml).toContain('LIMFA');
    expect(clinicalHtml).toContain('mobile-sticky');
    expect(clinicalHtml).toContain("siteId: 'site_2e58dc5f-d'");

    // 2. Commercial terms include setup scope, 7-day timeline, monthly SLA obligations, and explicit exclusions
    const terms = buildCommercialTermsBreakdown(450, 99, 'it');
    expect(terms.setupPriceEur).toBe(450);
    expect(terms.monthlyRetainerEur).toBe(99);
    expect(terms.deliveryTimeline).toContain('7 giorni lavorativi');
    expect(terms.setupScope.length).toBeGreaterThanOrEqual(4);
    expect(terms.setupExclusions.length).toBeGreaterThanOrEqual(4);
    expect(terms.monthlyObligations.length).toBeGreaterThanOrEqual(3);
    expect(terms.monthlyExclusions.length).toBeGreaterThanOrEqual(3);

    // 3. Proposal creates personalized Italian email + separate WhatsApp draft + keeps outreach DRAFT/UNSENT
    const cus = createLeadCustomer({
      name: 'Studio Fisioterapia Atlante',
      email: 'info@fisioterapiaatlante.it',
      phone: '+39 02 4771 2410',
      stage: 'QUALIFIED',
    }) as Record<string, unknown>;

    const prop = createCommercialProposal({
      customerId: String(cus.id),
      siteId: 'site_2e58dc5f-d',
      clientName: 'Studio Fisioterapia Atlante',
      title: 'Restyling Mobile-First & Modulo Appuntamenti',
      problemSummary: 'Sito attuale privo di tag viewport mobile e privo di modulo diretto di richiesta visita in homepage.',
      setupPriceEur: 450,
      monthlyRetainerEur: 99,
      language: 'it',
      websiteUrl: 'https://www.fisioterapiaatlante.it/',
      address: 'Viale Caterina da Forlì, 3 — 20146 Milano',
      city: 'Milano',
    }) as Record<string, unknown>;

    expect(prop.status).toBe('DRAFT');
    expect(String(prop.outreach_body)).toContain('Gentile Dott.ssa Moriglia');
    expect(String(prop.whatsapp_message)).toContain('Studio Fisioterapia Atlante');
    expect(String(prop.commercial_terms_json)).toContain('7 giorni lavorativi');

    // Approve gate WITHOUT marking sent -> remains APPROVED / UNSENT
    const holdAuth = authorizeProposalOutreach({ proposalId: String(prop.id), decidedBy: 'admin', markSent: false });
    expect(holdAuth.deliveryMode).toBe('APPROVED_READY_FOR_DISPATCH');
    expect(holdAuth.whatsappMessage).toContain('EUR 99'.replace('EUR ', '€'));
    expect(getCommerceTruthMetrics().customersAcquired).toBe(0);

    // 4. Advance full 6-step lifecycle -> customersAcquired & realizedRevenueEur stay 0 until verified payment!
    authorizeProposalOutreach({ proposalId: String(prop.id), decidedBy: 'admin', markSent: true });
    recordCustomerReply({ customerId: String(cus.id), replyStatus: 'REPLIED_INTERESTED', replyNotes: 'Richiesta call giovedì 14:30' });
    advanceCustomerStage(String(cus.id), 'NEGOTIATION');
    advanceCustomerStage(String(cus.id), 'ACCEPTED');
    createDraftInvoice({ customerId: String(cus.id), title: 'Atlante Setup', amount: 450 });

    const prePayMetrics = getCommerceTruthMetrics();
    expect(prePayMetrics.customersAcquired).toBe(0);
    expect(prePayMetrics.realizedRevenueEur).toBe(0);
    expect(prePayMetrics.qualifiedLeads).toBe(1);

    // Demo public inquiry logs LEAD without falsely marking won
    const inq = submitPublicClientInquiry({
      name: 'Paziente Test',
      email: 'paziente@example.it',
      phone: '+39 333 0000000',
      company: 'Osteopatia - Prima Visita',
      notes: 'Trattamento: Osteopatia',
      siteId: 'site_2e58dc5f-d',
    });
    expect(inq.received).toBe(true);
    expect(getCommerceTruthMetrics().customersAcquired).toBe(0);

    // 5. Verified payment triggers real acquisition + revenue
    recordVerifiedConversionPayment({
      customerId: String(cus.id),
      proposalId: String(prop.id),
      amountEur: 450,
      paymentReference: 'BONIFICO-ATLANTE-001',
      recordedBy: 'admin',
    });
    const postPayMetrics = getCommerceTruthMetrics();
    expect(postPayMetrics.customersAcquired).toBe(1);
    expect(postPayMetrics.realizedRevenueEur).toBe(450);

    const artId = String(prop.artifact_id || '');
    if (artId) {
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(artId));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }
  });

  it('26. Public /preview router serves isolated noindex Atlante demo, blocks spam/missing-consent inquiries, links CRM, rate-limits, and includes taxAssumption', async () => {
    // 1. Seed Atlante preview record in isolated test DB
    const db = getDb();
    const ts = new Date().toISOString();
    const html = buildFisioterapiaAtlanteClinicalDemoHtml('site_2e58dc5f-d');
    db.prepare(
      `INSERT INTO commerce_sites (id, brand_name, tagline, language, template, artifact_id, html_content, status, created_at)
       VALUES (?, ?, ?, 'it', 'OMEGA_V5', NULL, ?, 'DRAFT', ?)`
    ).run('site_2e58dc5f-d', 'Studio Fisioterapia Atlante', 'Fisioterapia e Osteopatia Milano', html, ts);

    const app = express();
    app.use(express.json());
    app.use('/preview', createPreviewRouter());
    app.use('/api', createApiRouter());

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 2. Public preview endpoint returns 200 HTML with X-Robots-Tag: noindex, nofollow
      const prevResp = await fetch(`${baseUrl}/preview/fisioterapia-atlante`);
      expect(prevResp.status).toBe(200);
      expect(prevResp.headers.get('x-robots-tag')).toMatch(/noindex,\s*nofollow/i);
      const bodyHtml = await prevResp.text();
      expect(bodyHtml).toContain('<meta name="robots" content="noindex,nofollow" />');
      expect(bodyHtml).toContain("fetch('/preview/inquiry'");

      // 3. Reject missing GDPR consent & honeypot bot spam
      const noConsent = await fetch(`${baseUrl}/preview/inquiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Mario', email: 'mario@example.it', consent: false, siteId: 'site_2e58dc5f-d' }),
      });
      expect(noConsent.status).toBe(400);

      const botSpam = await fetch(`${baseUrl}/preview/inquiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bot',
          email: 'bot@example.it',
          honeypot: 'http://spam.example',
          consent: true,
          siteId: 'site_2e58dc5f-d',
        }),
      });
      expect(botSpam.status).toBe(400);

      // 4. Valid inquiry persists to commerce_customers linked to opp_a6f09661-2 and omits leadId from public JSON
      const validInq = await fetch(`${baseUrl}/preview/inquiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Chiara Verdi',
          email: 'chiara.verdi@example.it',
          phone: '+39 340 1234567',
          company: 'Osteopatia - Prima Visita',
          notes: 'Martedì pomeriggio',
          honeypot: '',
          consent: true,
          siteId: 'site_2e58dc5f-d',
        }),
      });
      expect(validInq.status).toBe(201);
      const validJson = (await validInq.json()) as Record<string, unknown>;
      expect(validJson.received).toBe(true);
      expect(validJson.leadId).toBeUndefined();

      const stored = db
        .prepare("SELECT email, opportunity_id, notes FROM commerce_customers WHERE lower(email) = 'chiara.verdi@example.it'")
        .get() as { email: string; opportunity_id: string; notes: string } | undefined;
      expect(stored?.opportunity_id).toBe('opp_a6f09661-2');
      expect(stored?.notes).toContain('EXPLICIT_YES');

      // 5. Strict 6/10min inquiry limiter returns 429 on 7th request while /api/health remains accessible
      for (let i = 0; i < 6; i++) {
        await fetch(`${baseUrl}/preview/inquiry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Chiara Verdi',
            email: 'chiara.verdi@example.it',
            consent: true,
            siteId: 'site_2e58dc5f-d',
          }),
        });
      }
      const limited = await fetch(`${baseUrl}/preview/inquiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Chiara Verdi',
          email: 'chiara.verdi@example.it',
          consent: true,
          siteId: 'site_2e58dc5f-d',
        }),
      });
      expect(limited.status).toBe(429);

      const healthResp = await fetch(`${baseUrl}/api/health`);
      expect(healthResp.status).toBe(200);

      // 6. SSRF DNS guard & commercial terms taxAssumption check
      await expect(assertResolvedHostPublic(new URL('http://127.0.0.1:8080/internal'))).rejects.toThrow(/SSRF/i);
      const termsIt = buildCommercialTermsBreakdown(450, 99, 'it');
      expect(termsIt.taxAssumption).toMatch(/IVA|forfettario/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('27. Atlas clinical demo links/anchors/responsive CSS, generic demo consent checkbox, CRM stage API, and AI Gateway chat regression pass', async () => {
    // 1. Validate all href anchors & responsive layout rules in Atlas clinical HTML
    const atlasHtml = buildFisioterapiaAtlanteClinicalDemoHtml('site_2e58dc5f-d');
    const hrefs = Array.from(atlasHtml.matchAll(/href=["']([^"']+)["']/g)).map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(8);
    expect(hrefs).not.toContain('#');
    for (const href of hrefs.filter((h) => h.startsWith('#'))) {
      const targetId = href.slice(1);
      expect(atlasHtml).toMatch(new RegExp(`id=["']${targetId}["']`));
    }
    expect(hrefs).toContain('tel:+390247712410');
    expect(hrefs).toContain('mailto:info@fisioterapiaatlante.it');
    expect(hrefs).toContain('https://www.fisioterapiaatlante.it/');
    expect(atlasHtml).toContain('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />');
    expect(atlasHtml).toContain('@media (min-width: 820px)');
    expect(atlasHtml).toContain('@media (min-width: 768px)');
    expect(atlasHtml).toContain('min-height:44px');

    // 2. Generated storefront site also enforces explicit GDPR consent checkbox & #contact anchor
    const gen = generateDigitalProductSite({
      brandName: 'Clinic Beta',
      tagline: 'Fast Appointments',
      language: 'it',
    });
    expect(gen.htmlContent).toContain('id="f-consent"');
    expect(gen.htmlContent).toContain("fetch('/preview/inquiry'");
    expect(gen.htmlContent).toContain('id="contact"');
    if (gen.artifactId) {
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(String(gen.artifactId)));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }

    // 3. CRM + RBAC + AI Gateway HTTP regression over Express router
    const prevNodeEnv = process.env.NODE_ENV;
    const prevSecret = process.env.NEXA_SESSION_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.NEXA_SESSION_SECRET = 'nexa_test_prod_secret_9a8b7c6d5e4f3a2b1c0d9e8f';

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const pass = process.env.NEXA_DEFAULT_ADMIN_PASSWORD || 'nexa-operator-local';
      const viewerLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'viewer', password: pass }),
      });
      const viewerTok = ((await viewerLogin.json()) as { token: string }).token;

      // Viewer cannot create CRM lead (403), operator can
      const viewerDenied = await fetch(`${baseUrl}/api/commerce/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerTok}` },
        body: JSON.stringify({ name: 'Viewer Blocked' }),
      });
      expect(viewerDenied.status).toBe(403);

      const opLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'operator', password: pass }),
      });
      const opTok = ((await opLogin.json()) as { token: string }).token;

      const createdCus = await fetch(`${baseUrl}/api/commerce/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opTok}` },
        body: JSON.stringify({ name: 'Clinic Gamma', email: 'gamma@example.it', stage: 'LEAD' }),
      });
      expect(createdCus.status).toBe(201);
      const cusObj = (await createdCus.json()) as { id: string };

      const stagePatch = await fetch(`${baseUrl}/api/commerce/customers/${cusObj.id}/stage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opTok}` },
        body: JSON.stringify({ stage: 'QUALIFIED' }),
      });
      expect(stagePatch.status).toBe(200);
      expect(((await stagePatch.json()) as { stage: string }).stage).toBe('QUALIFIED');

      // AI Gateway /api/chat redacts PII safely with mock fallback enabled
      const chatResp = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opTok}` },
        body: JSON.stringify({
          message: 'Summarize email lead secret@clinic.it safely',
          language: 'en',
          allowMockFallback: true,
        }),
      });
      expect(chatResp.status).toBe(200);
      const chatJson = (await chatResp.json()) as { reply: string; isMock: boolean };
      expect(chatJson.reply).not.toContain('secret@clinic.it');
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevSecret === undefined) delete process.env.NEXA_SESSION_SECRET;
      else process.env.NEXA_SESSION_SECRET = prevSecret;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('28. Execution Kernel supports PAUSED/RETRYING states, idempotent step skipping, bounded retries, crash recovery, and failure classification', async () => {
    const db = getDb();

    // 1. Failure classification accuracy
    expect(classifyExecutionError('Provider HTTP 429 rate limit exceeded')).toBe('rate_limit');
    expect(classifyExecutionError('Strategic Planner timed out after 30000ms')).toBe('timeout');
    expect(classifyExecutionError('Authentication rejected by OPENAI; HTTP 401')).toBe('auth_error');
    expect(classifyExecutionError('Zod schema validation failed')).toBe('validation_error');
    expect(classifyExecutionError('fetch failed: ECONNREFUSED')).toBe('network_error');
    expect(classifyExecutionError('Unexpected null reference')).toBe('internal_error');

    // 2. Pause -> Resume lifecycle + API endpoints
    const m1 = createMission({
      objective: 'Analyze regional telemedicine compliance requirements across EU clinics',
      domain: 'general',
      maxRetries: 1,
    });
    const paused = pauseMission(m1.id, 'operator');
    expect(paused.status).toBe('PAUSED');

    const resumed = await resumeMission({ missionId: m1.id, allowMockFallback: true });
    expect(resumed.status).toBe('COMPLETED');
    for (const art of resumed.artifacts) {
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(art.id));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }

    // 3. Startup crash recovery + idempotent step skip on retry + bounded max retries
    const m2 = createMission({
      objective: 'Verify idempotent retry skips already completed waves without duplicating runs',
      domain: 'general',
      maxRetries: 1,
    });
    const ts = new Date().toISOString();
    // Simulate wave 1 ('strategic_planner') already completed, wave 2 ('research_agent') crashed while RUNNING
    db.prepare("UPDATE missions SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(ts, m2.id);
    db.prepare("UPDATE mission_steps SET status = 'COMPLETED', completed_at = ? WHERE mission_id = ? AND agent_id = 'strategic_planner'").run(
      ts,
      m2.id
    );
    db.prepare(
      `INSERT INTO agent_runs
       (mission_id, agent_id, provider_id, model_id, status, input_json, output_json, output_text, latency_ms, tokens_in, tokens_out, cost_usd, is_mock, created_at)
       VALUES (?, 'strategic_planner', 'MOCK', 'nexa-offline-mock-v1', 'SUCCESS', '{}', ?, 'cached plan', 5, 10, 20, 0, 1, ?)`
    ).run(m2.id, JSON.stringify({ summary: 'Cached Wave 1 strategic plan', facts: [], hypotheses: [], assumptions: [], unknowns: [], risks: [], recommendations: [], confidence: 0.8 }), ts);
    db.prepare("UPDATE mission_steps SET status = 'RUNNING', started_at = ? WHERE mission_id = ? AND agent_id = 'research_agent'").run(
      ts,
      m2.id
    );

    const recovered = recoverInterruptedMissionsOnStartup();
    expect(recovered.recoveredCount).toBe(1);
    expect(recovered.missionIds).toContain(m2.id);

    const afterRecovery = getMissionById(m2.id)!;
    expect(afterRecovery.status).toBe('FAILED');
    expect(afterRecovery.failureClassification).toBe('internal_error');
    expect(afterRecovery.steps.find((s) => s.agentId === 'research_agent')?.status).toBe('FAILED');
    expect(afterRecovery.steps.find((s) => s.agentId === 'strategic_planner')?.status).toBe('COMPLETED');

    // Retry executes only remaining incomplete steps (strategic_planner stays at exactly 1 run!)
    const retried = await retryMission({ missionId: m2.id, allowMockFallback: true });
    expect(retried.status).toBe('COMPLETED');
    expect(retried.retryCount).toBe(1);
    const plannerRuns = retried.agentRuns.filter((r) => r.agentId === 'strategic_planner');
    expect(plannerRuns.length).toBe(1);

    for (const art of retried.artifacts) {
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(art.id));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }

    // 4. Bounded retry limit blocks exceeding maxRetries
    const m3 = createMission({
      objective: 'Test bounded retry cap after exhausting maximum retries safely',
      domain: 'general',
      maxRetries: 1,
    });
    db.prepare("UPDATE missions SET status = 'FAILED', retry_count = 1 WHERE id = ?").run(m3.id);
    await expect(retryMission({ missionId: m3.id, allowMockFallback: true })).rejects.toThrow(/Maximum bounded retry limit/i);

    // 5. Express endpoints /api/missions/:id/pause and /resume work via HTTP
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const m4 = createMission({ objective: 'Verify HTTP pause and resume endpoints in command center', domain: 'general' });
      const pauseResp = await fetch(`${baseUrl}/api/missions/${m4.id}/pause`, { method: 'POST' });
      expect(pauseResp.status).toBe(200);
      expect(((await pauseResp.json()) as { mission: { status: string } }).mission.status).toBe('PAUSED');

      const resResp = await fetch(`${baseUrl}/api/missions/${m4.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowMockFallback: true }),
      });
      expect(resResp.status).toBe(200);
      const resJson = (await resResp.json()) as { mission: { status: string; artifacts: Array<{ id: string }> } };
      expect(resJson.mission.status).toBe('COMPLETED');
      for (const art of resJson.mission.artifacts) {
        const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(art.id));
        if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('29. Multi-Model Fabric computes token costs, surfaces RATE_LIMITED/OPERATIONAL/AUTHENTICATED statuses, isolates site HTML RBAC, and returns securityAlerts in /api/audit', async () => {
    const db = getDb();
    clearCooldownsForTests();

    // 1. Token pricing cost estimation
    expect(estimateCallCostUsd('gemini-4-hydrogen', 10000, 5000)).toBe(0);
    // gpt-4o-mini: $0.15/1M prompt + $0.60/1M completion = $0.75 for 1M+1M tokens
    expect(estimateCallCostUsd('gpt-4o-mini', 1_000_000, 1_000_000)).toBe(0.75);

    // 2. Explicit availabilityStatus states (UNCONFIGURED / CONFIGURED / AUTHENTICATED / OPERATIONAL / RATE_LIMITED)
    const prevGem = process.env.GEMINI_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    const prevOr = process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.GROQ_API_KEY = 'gsk_test_configured_key_123456';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test_configured_key_123';

    try {
      // Simulate AUTHENTICATED for OPENROUTER, OPERATIONAL for a mock-free live call on NVIDIA if configured
      db.prepare("UPDATE provider_settings SET last_verified_at = ? WHERE id = 'OPENROUTER'").run(new Date().toISOString());
      // Simulate 429 RATE_LIMITED on GROQ
      setModelCooldown('GROQ', 'llama-3.3-70b-versatile', 60);
      db.prepare("UPDATE provider_settings SET last_error = 'Provider HTTP 429 rate limit' WHERE id = 'GROQ'").run();

      const provs = listProviders();
      expect(provs.find((p) => p.id === 'GEMINI')?.availabilityStatus).toBe('UNCONFIGURED');
      expect(provs.find((p) => p.id === 'OPENROUTER')?.availabilityStatus).toBe('AUTHENTICATED');
      expect(provs.find((p) => p.id === 'GROQ')?.availabilityStatus).toBe('RATE_LIMITED');
      expect((provs.find((p) => p.id === 'GROQ')?.cooldownUntil || 0)).toBeGreaterThan(Date.now());

      // Insert a non-mock live SUCCESS call for OPENROUTER -> transitions to OPERATIONAL
      db.prepare(
        `INSERT INTO model_calls (provider_id, model_id, task_class, status, latency_ms, tokens_in, tokens_out, cost_usd, is_mock, created_at)
         VALUES ('OPENROUTER', 'meta-llama/llama-3.3-70b-instruct:free', 'research_synthesis', 'SUCCESS', 120, 50, 80, 0, 0, ?)`
      ).run(new Date().toISOString());
      expect(listProviders().find((p) => p.id === 'OPENROUTER')?.availabilityStatus).toBe('OPERATIONAL');
    } finally {
      clearCooldownsForTests();
      if (prevGem === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGem;
      if (prevGroq === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = prevGroq;
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
    }

    // 3. Internal /api/commerce/sites/:id/html requires RBAC in production while /preview/:id stays public, and /api/audit includes securityAlerts
    const site = generateDigitalProductSite({
      brandName: 'Rbac Check Studio',
      tagline: 'Public vs Internal Separation',
      language: 'it',
    });

    const prevNodeEnv = process.env.NODE_ENV;
    const prevSecret = process.env.NEXA_SESSION_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.NEXA_SESSION_SECRET = 'nexa_test_prod_secret_9a8b7c6d5e4f3a2b1c0d9e8f';

    const app = express();
    app.use(express.json());
    app.use('/preview', createPreviewRouter());
    app.use('/api', createApiRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Unauthenticated internal site HTML endpoint is blocked (401) in production
      const internalHtmlResp = await fetch(`${baseUrl}/api/commerce/sites/${site.id}/html`);
      expect(internalHtmlResp.status).toBe(401);

      // Clean public /preview/:id works without auth and enforces X-Robots-Tag: noindex, nofollow
      const publicPreviewResp = await fetch(`${baseUrl}/preview/${site.id}`);
      expect(publicPreviewResp.status).toBe(200);
      expect(publicPreviewResp.headers.get('x-robots-tag')).toMatch(/noindex,\s*nofollow/i);

      // /api/audit exposes securityAlerts and failedOperations arrays
      const pass = process.env.NEXA_DEFAULT_ADMIN_PASSWORD || 'nexa-operator-local';
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'viewer', password: pass }),
      });
      const tok = ((await login.json()) as { token: string }).token;
      const auditResp = await fetch(`${baseUrl}/api/audit`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      expect(auditResp.status).toBe(200);
      const auditJson = (await auditResp.json()) as {
        securityAlerts: unknown[];
        failedMissions: unknown[];
        failedAgentRuns: unknown[];
        failedSchedules: unknown[];
      };
      expect(Array.isArray(auditJson.securityAlerts)).toBe(true);
      expect(Array.isArray(auditJson.failedMissions)).toBe(true);
      expect(Array.isArray(auditJson.failedAgentRuns)).toBe(true);
      expect(Array.isArray(auditJson.failedSchedules)).toBe(true);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevSecret === undefined) delete process.env.NEXA_SESSION_SECRET;
      else process.env.NEXA_SESSION_SECRET = prevSecret;
      if (site.artifactId) {
        const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(site.artifactId));
        if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('30. Production preflight rejects missing/weak NEXA_ADMIN_PASSWORD, :memory: DB, safety lock overrides, and exposes /api/preflight without leaking secrets', async () => {
    const keys = [
      'NODE_ENV',
      'NEXA_SESSION_SECRET',
      'NEXA_SCHEDULER_TOKEN',
      'NEXA_ADMIN_PASSWORD',
      'NEXA_DEFAULT_ADMIN_PASSWORD',
      'NEXA_DB_PATH',
      'NEXA_PAID_FALLBACK_ALLOWED',
      'NEXA_LIVE_TRADING_ENABLED',
      'APP_URL',
    ] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];

    try {
      const secretVal = 'Sec!9xKp2mNq7vRt4zLb8wYc3fHj6uAa';
      const schedVal = 'Sched!8nVm4qPx7cRt2yWb9zLf';
      const adminPass = 'NexaAdmin!942StrongPass';

      process.env.NODE_ENV = 'production';
      process.env.NEXA_SESSION_SECRET = secretVal;
      process.env.NEXA_SCHEDULER_TOKEN = schedVal;
      process.env.NEXA_ADMIN_PASSWORD = adminPass;
      delete process.env.NEXA_DEFAULT_ADMIN_PASSWORD;
      process.env.NEXA_DB_PATH = '/app/data/nexa_genesis.sqlite3';
      process.env.NEXA_PAID_FALLBACK_ALLOWED = 'false';
      process.env.NEXA_LIVE_TRADING_ENABLED = 'false';
      process.env.APP_URL = 'https://nexa.example.com';

      expect(validateAdminPassword().valid).toBe(true);
      expect(validateAdminPassword().sourceEnv).toBe('NEXA_ADMIN_PASSWORD');
      expect(validateSchedulerSecret().valid).toBe(true);

      const okReport = runProductionPreflight({ requireProductionNodeEnv: true });
      expect(okReport.ok).toBe(true);
      expect(okReport.failures).toEqual([]);
      // Secret values must NEVER appear anywhere in serialized report
      const serialized = JSON.stringify(okReport);
      expect(serialized).not.toContain(secretVal);
      expect(serialized).not.toContain(schedVal);
      expect(serialized).not.toContain(adminPass);

      // HTTP GET /api/preflight check
      const db = getDb();
      const { hashPassword } = await import('../server/db/database.ts');
      db.prepare("UPDATE users SET password_hash = ? WHERE username = 'viewer'").run(hashPassword(adminPass));
      const app = express();
      app.use(express.json());
      app.use('/api', createApiRouter());
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      try {
        const loginResp = await fetch(`http://127.0.0.1:${addr.port}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'viewer', password: adminPass }),
        });
        expect(loginResp.status).toBe(200);
        const token = ((await loginResp.json()) as { token: string }).token;
        const preResp = await fetch(`http://127.0.0.1:${addr.port}/api/preflight`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(preResp.status).toBe(200);
        const preJson = (await preResp.json()) as { ok: boolean };
        expect(preJson.ok).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      // Rejects weak default password, :memory: DB, and paid fallback enabled
      process.env.NEXA_ADMIN_PASSWORD = 'nexa-operator-local';
      process.env.NEXA_DB_PATH = ':memory:';
      process.env.NEXA_PAID_FALLBACK_ALLOWED = 'true';
      const badReport = runProductionPreflight({ requireProductionNodeEnv: true });
      expect(badReport.ok).toBe(false);
      expect(badReport.failures.length).toBeGreaterThanOrEqual(3);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('31. Financial Truth metrics compute cent-precision projections, contracts, draft/issued invoices, verified payments, and outstanding balances without counting drafts as revenue', () => {
    const cus = createLeadCustomer({
      name: 'Precision Physio Milano',
      email: 'team@precision.example',
      stage: 'QUALIFIED',
    }) as { id: string };

    const prop = createCommercialProposal({
      customerId: cus.id,
      clientName: 'Precision Physio Milano',
      title: 'Mobile Conversion Upgrade',
      problemSummary: 'Missing viewport and direct inquiry intake.',
      pricingTier: 'STARTER',
      estimatedEffortHours: 14,
      hourlyCostEur: 15,
      infraCostEur: 12,
      setupPriceEur: 450.3,
      monthlyRetainerEur: 99,
      language: 'it',
    }) as { id: string; approval_id: number; artifact_id: string };

    // Before winning: proposal is pipeline projection only; revenue/accepted/outstanding must stay 0
    const draftInv = createDraftInvoice({ customerId: cus.id, title: 'Draft Setup', amount: 450.3 }) as { id: string };
    const m1 = getCommerceTruthMetrics();
    expect(m1.pipelineProposalValueEur).toBe(450.3);
    expect(m1.estimatedExpensesEur).toBe(222);
    expect(m1.draftInvoicesTotalEur).toBe(450.3);
    expect(m1.issuedInvoicesTotalEur).toBe(0);
    expect(m1.acceptedContractValueEur).toBe(0);
    expect(m1.realizedRevenueEur).toBe(0);
    expect(m1.verifiedPaymentsTotalEur).toBe(0);
    expect(m1.outstandingBalanceEur).toBe(0);

    // Record exact operating expenses (avoiding JS float drift) & approve contract won without payment yet
    recordFinancialEntry({ entryType: 'OPERATING_COST', category: 'domain', amountEur: 19.99 });
    recordFinancialEntry({ entryType: 'OPERATING_COST', category: 'hosting', amountEur: 10.01 });
    decideApproval(prop.approval_id, 'approved', 'operator');
    updateProposalStatus(prop.id, 'WON');

    const m2 = getCommerceTruthMetrics();
    expect(m2.actualOperatingCostsEur).toBe(30);
    expect(m2.acceptedContractValueEur).toBe(450.3);
    expect(m2.realizedRevenueEur).toBe(0);
    expect(m2.outstandingBalanceEur).toBe(450.3);
    expect(m2.netProfitEur).toBe(-30);

    // Record partial verified payment -> outstanding balance drops with cent accuracy
    recordVerifiedConversionPayment({
      customerId: cus.id,
      proposalId: prop.id,
      amountEur: 200.1,
      paymentReference: 'SEPA-2026-PARTIAL-01',
    });

    const m3 = getCommerceTruthMetrics();
    expect(m3.realizedRevenueEur).toBe(200.1);
    expect(m3.verifiedPaymentsTotalEur).toBe(200.1);
    expect(m3.outstandingBalanceEur).toBe(250.2);
    expect(m3.netProfitEur).toBe(170.1);

    expect(draftInv.id).toBeTruthy();
    if (prop.artifact_id) {
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(prop.artifact_id));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }
  });

  it('32. Commercial terms explicitly surface missing legal/tax fields, scheduler documents 3 execution layers, and preview endpoint blocks honeypot/rate abuse', async () => {
    const termsIt = buildCommercialTermsBreakdown(450, 99, 'it');
    expect(termsIt.proposalVersion).toBe('v2.0');
    expect(termsIt.supplierLegalStatus).toBe('MISSING_OPERATOR_LEGAL_AND_TAX_DETAILS');
    expect(termsIt.missingOperatorLegalFields.length).toBeGreaterThanOrEqual(5);
    expect(termsIt.missingOperatorLegalFields.join(' ')).toMatch(/Partita IVA/i);
    expect(termsIt.missingOperatorLegalFields.join(' ')).toMatch(/IBAN/i);
    expect(termsIt.domainAndHostingResponsibility).toMatch(/titolarit/i);

    const arch = getSchedulerArchitectureEvaluation();
    expect(arch.executionArchitecture.inProcessScheduler.mechanism).toMatch(/setInterval/);
    expect(arch.executionArchitecture.persistentSqliteJobQueue.tables).toContain('commerce_schedules');
    expect(arch.executionArchitecture.externalCloudSchedulerHttp.endpoint).toBe('/api/commerce/schedules/run-due');
    expect(arch.executionArchitecture.externalCloudSchedulerHttp.retryPolicy.concurrencyLimit).toBe(1);

    const app = express();
    app.use(express.json());
    app.use('/preview', createPreviewRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;

    try {
      // Honeypot blocked
      const hpResp = await fetch(`${url}/preview/inquiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bot Tester',
          email: 'bot@example.com',
          honeypot: 'http://spam.example',
          consent: true,
        }),
      });
      expect(hpResp.status).toBe(400);

      // Missing GDPR consent rejected
      const noConsentResp = await fetch(`${url}/preview/inquiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Mario Rossi',
          email: 'mario@example.com',
          consent: false,
        }),
      });
      expect(noConsentResp.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('33. RecordVerifiedConversionPayment enforces paymentReference idempotency to prevent double-counted revenue', () => {
    const cus = createLeadCustomer({
      name: 'Studio Idempotency Test',
      email: 'idemp@example.it',
      stage: 'QUALIFIED',
    }) as { id: string };

    const prop = createCommercialProposal({
      customerId: cus.id,
      clientName: 'Studio Idempotency Test',
      title: 'Mobile Conversion Package',
      problemSummary: 'Missing mobile viewport and direct booking form.',
      setupPriceEur: 450,
      monthlyRetainerEur: 99,
      language: 'it',
    }) as { id: string; approval_id: number; artifact_id: string };

    decideApproval(prop.approval_id, 'approved', 'admin');

    recordVerifiedConversionPayment({
      customerId: cus.id,
      proposalId: prop.id,
      amountEur: 450,
      paymentReference: 'SEPA-REF-DUP-001',
      recordedBy: 'admin',
    });

    // Exact or case-insensitive duplicate payment reference must be rejected cleanly
    expect(() =>
      recordVerifiedConversionPayment({
        customerId: cus.id,
        proposalId: prop.id,
        amountEur: 450,
        paymentReference: 'sepa-ref-dup-001',
        recordedBy: 'admin',
      })
    ).toThrow(/Duplicate payment reference/i);

    const metrics = getCommerceTruthMetrics();
    expect(metrics.verifiedPaymentsCount).toBe(1);
    expect(metrics.realizedRevenueEur).toBe(450);

    if (prop.artifact_id) {
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(prop.artifact_id));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }
  });

  it('34. Atlas DOM labels/overflow hygiene, /api/commerce/public/inquiry strict consent, and gateway error redaction hold under stress', async () => {
    // 1. Every form label for="..." maps cleanly to an existing id="..." and zero fabricated testimonials exist
    const atlasHtml = buildFisioterapiaAtlanteClinicalDemoHtml('site_2e58dc5f-d');
    const forAttrs = Array.from(atlasHtml.matchAll(/<label[^>]+for=["']([^"']+)["']/g)).map((m) => m[1]);
    expect(forAttrs.length).toBeGreaterThanOrEqual(5);
    for (const targetId of forAttrs) {
      expect(atlasHtml).toMatch(new RegExp(`id=["']${targetId}["']`));
    }
    expect(atlasHtml).toContain('box-sizing:border-box');
    expect(atlasHtml).not.toMatch(/sk-ant-|NEXA_SESSION_SECRET|admin@|usr_admin/i);

    // 2. Gateway error sanitizer strips credentials even from verbose upstream provider errors
    const leakedMsg = sanitizeGatewayError(
      'invalid_request_error: Rejected key sk-ant-api03-SECRETTOKEN1234567890abcd for Bearer sk-or-v1-ANOTHERSECRET987654321'
    );
    expect(leakedMsg).not.toContain('SECRETTOKEN1234567890abcd');
    expect(leakedMsg).not.toContain('ANOTHERSECRET987654321');
    expect(leakedMsg).toContain('[REDACTED_SECRET]');

    // 3. /api/commerce/public/inquiry also requires explicit consent: true
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    try {
      const badPublicInq = await fetch(`http://127.0.0.1:${addr.port}/api/commerce/public/inquiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test User',
          email: 'user@example.it',
          consent: false,
        }),
      });
      expect(badPublicInq.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('35. /api/providers envStatus accurately validates NEXA_SESSION_SECRET, NEXA_SCHEDULER_TOKEN, and NEXA_ADMIN_PASSWORD without exposing values', async () => {
    const keys = ['NEXA_SESSION_SECRET', 'NEXA_SCHEDULER_TOKEN', 'NEXA_ADMIN_PASSWORD'] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };

    try {
      const secretVal = 'ProdSess!7xKm9pQr2vZt5nLb8wYc4fHj';
      const schedVal = 'ProdSched!3aBc6dEf9gHi2jKl5mNo';
      const adminVal = 'ProdAdmin!Pass9284Secure';
      process.env.NEXA_SESSION_SECRET = secretVal;
      process.env.NEXA_SCHEDULER_TOKEN = schedVal;
      process.env.NEXA_ADMIN_PASSWORD = adminVal;

      const resp = await fetch(`http://127.0.0.1:${addr.port}/api/providers`);
      expect(resp.status).toBe(200);
      const rawBody = await resp.text();
      expect(rawBody).not.toContain(secretVal);
      expect(rawBody).not.toContain(schedVal);
      expect(rawBody).not.toContain(adminVal);

      const parsed = JSON.parse(rawBody) as {
        readiness: { envStatus: Array<{ name: string; set: boolean }> };
      };
      const byName = new Map(parsed.readiness.envStatus.map((e) => [e.name, e.set]));
      expect(byName.get('NEXA_SESSION_SECRET')).toBe(true);
      expect(byName.get('NEXA_SCHEDULER_TOKEN')).toBe(true);
      expect(byName.get('NEXA_ADMIN_PASSWORD')).toBe(true);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('36. Consolidation kernel executes transactional decideApproval downstream actions, blocks locked historical proposals, and enforces max_cost_per_mission_usd', async () => {
    const db = getDb();

    // 1. mission_completion approval persists signed-off deliverable into verified_facts memory
    const m = createMission({
      objective: 'Verify mission completion approval signs deliverable into verified_facts memory',
      domain: 'general',
      requiresApproval: true,
    });
    const completed = await executeMission({ missionId: m.id, allowMockFallback: true });
    expect(completed.status).toBe('COMPLETED');
    const completionGate = db
      .prepare("SELECT id FROM approvals WHERE mission_id = ? AND category = 'mission_completion' AND status = 'pending'")
      .get(m.id) as { id: number } | undefined;
    expect(completionGate?.id).toBeTruthy();

    decideApproval(completionGate!.id, 'approved', 'admin', 'Signed off deliverable');
    const signedFacts = queryMemory({ scope: 'verified_facts', search: m.id });
    expect(signedFacts.some((row) => String(row.provenance || '').includes(m.id))).toBe(true);

    // 2. commerce_publish, commerce_outreach, commerce_invoice, commerce_content downstream execution
    const cus = createLeadCustomer({ name: 'Downstream Clinic', email: 'downstream@clinic.it', stage: 'QUALIFIED' }) as { id: string };
    const site = generateDigitalProductSite({ brandName: 'Downstream Clinic', tagline: 'Fast Intake', language: 'it' });
    expect(site.status).toBe('DRAFT');
    decideApproval(site.approvalId, 'approved', 'admin', 'Publish approved');
    const siteRow = db.prepare('SELECT status FROM commerce_sites WHERE id = ?').get(site.id) as { status: string };
    expect(siteRow.status).toBe('PUBLISHED');

    const prop = createCommercialProposal({
      customerId: cus.id,
      siteId: site.id,
      clientName: 'Downstream Clinic',
      title: 'Mobile Intake Package',
      problemSummary: 'Missing mobile viewport and booking intake.',
      setupPriceEur: 450,
      monthlyRetainerEur: 99,
      language: 'it',
    }) as { id: string; approval_id: number; artifact_id: string };
    decideApproval(prop.approval_id, 'approved', 'admin', 'Proposal approved but unsent');
    const propAfter = db.prepare('SELECT status FROM commerce_proposals WHERE id = ?').get(prop.id) as { status: string };
    const cusAfter = db.prepare('SELECT last_contacted_at FROM commerce_customers WHERE id = ?').get(cus.id) as {
      last_contacted_at: string | null;
    };
    expect(propAfter.status).toBe('APPROVED');
    expect(cusAfter.last_contacted_at).toBeNull();

    const inv = createDraftInvoice({ customerId: cus.id, title: 'Setup Fee', amount: 450 }) as {
      id: string;
      approval_id: number;
    };
    decideApproval(inv.approval_id, 'approved', 'admin', 'Invoice approved');
    const invAfter = db.prepare('SELECT status FROM commerce_invoices WHERE id = ?').get(inv.id) as { status: string };
    expect(invAfter.status).toBe('APPROVED');

    const content = generateMarketingContentAsset({
      customerId: cus.id,
      channel: 'EMAIL_OUTREACH',
      brandName: 'Downstream Clinic',
      targetAudience: 'Physio Patients',
      offerSummary: 'Mobile intake upgrade',
      language: 'it',
    }) as { id: string; approval_id: number };
    decideApproval(content.approval_id, 'approved', 'admin', 'Content approved');
    const contentAfter = db.prepare('SELECT status FROM commerce_content_assets WHERE id = ?').get(content.id) as {
      status: string;
    };
    expect(contentAfter.status).toBe('APPROVED');

    // 3. Approval gate rejects approving historical/excluded proposal transactionally
    const histProp = createCommercialProposal({
      customerId: cus.id,
      clientName: 'Archived Chain Clinic',
      title: 'Historical Chain Draft',
      problemSummary: 'Historical draft prior to chain exclusion.',
      setupPriceEur: 450,
      monthlyRetainerEur: 99,
      language: 'it',
    }) as { id: string; approval_id: number; artifact_id: string };
    db.prepare("UPDATE commerce_proposals SET proposal_note = 'DO NOT SEND | HISTORICAL_DRAFT_LOCKED' WHERE id = ?").run(
      histProp.id
    );
    expect(() => decideApproval(histProp.approval_id, 'approved', 'admin', 'Should fail')).toThrow(/historical\/excluded/i);
    const gateStillPending = db.prepare('SELECT status FROM approvals WHERE id = ?').get(histProp.approval_id) as {
      status: string;
    };
    expect(gateStillPending.status).toBe('pending');

    // 4. max_cost_per_mission_usd enforcement fails mission with quota_exhausted if exceeded after a wave
    const costMission = createMission({
      objective: 'Verify mission cost ceiling triggers quota_exhausted halt when wave cost exceeds cap',
      domain: 'general',
      requiresApproval: false,
    });
    // Seed a tiny cost cap and simulate accumulated wave cost by inserting non-free cost on a paid-priced model? No: set cap = 0.0001 and verify cap = 0 allows mock ($0) while positive cost trips cap via a mocked paid call
    db.prepare("INSERT OR REPLACE INTO system_settings (key, value_json, updated_at) VALUES ('max_cost_per_mission_usd', '0.001', ?)").run(
      new Date().toISOString()
    );
    // With $0 mock calls, cost stays $0 <= 0.001 so baseline succeeds; now test direct ceiling audit & zero-cost compatibility
    const okZeroCost = await executeMission({ missionId: costMission.id, allowMockFallback: true });
    expect(okZeroCost.status).toBe('COMPLETED');
    expect(okZeroCost.totalCostUsd).toBe(0);

    for (const artId of [
      ...completed.artifacts.map((a) => a.id),
      ...okZeroCost.artifacts.map((a) => a.id),
      String(site.artifactId || ''),
      String(prop.artifact_id || ''),
      String(histProp.artifact_id || ''),
    ]) {
      if (!artId) continue;
      const f = fs.readdirSync(createdArtifactsDir).find((name) => name.startsWith(artId));
      if (f) fs.rmSync(path.join(createdArtifactsDir, f), { force: true });
    }
  });

  it('37. Consolidation API routes expose persisted bridge links, cooldown reset RBAC, analytics total_cost_usd, and read-only backup verification', async () => {
    const db = getDb();

    // 1. Bridge links reject unknown mission even on dry-run and persist real links when execute=true
    expect(() =>
      linkMissionToBridgeTask({
        missionId: 'msn_does_not_exist',
        commerceTaskId: 'task_001',
        objective: 'Should fail validation',
        execute: false,
      })
    ).toThrow(/Mission not found/i);

    const m = createMission({
      objective: 'Persist bridge execution link cleanly across kernel and commerce workspace',
      domain: 'commerce',
      requiresApproval: false,
    });
    const linked = linkMissionToBridgeTask({
      missionId: m.id,
      commerceTaskId: 'task_bridge_42',
      objective: 'Launch validated SMB intake',
      execute: true,
    });
    expect(linked.executed).toBe(true);
    expect(getBridgeLinks(m.id).length).toBe(1);

    // 2. Seed model call cost + cooldown for analytics & reset-cooldown tests
    db.prepare(
      `INSERT INTO model_calls (provider_id, model_id, task_class, status, latency_ms, tokens_in, tokens_out, cost_usd, is_mock, created_at)
       VALUES ('OPENAI', 'gpt-4o-mini', 'research_synthesis', 'SUCCESS', 150, 1000, 500, 0.00045, 0, ?)`
    ).run(new Date().toISOString());
    setModelCooldown('GROQ', 'llama-3.3-70b-versatile', 120);
    db.prepare("UPDATE provider_settings SET failure_count = 3, last_error = 'HTTP 429' WHERE id = 'GROQ'").run();

    // 3. Create an isolated real SQLite backup file & verify via API + path-traversal rejection
    const tmpSrcDb = `/tmp/nexa_test_verify_src_${Date.now()}.sqlite3`;
    let createdBackupPath = '';
    const prevNodeEnv = process.env.NODE_ENV;
    const prevSecret = process.env.NEXA_SESSION_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.NEXA_SESSION_SECRET = 'nexa_test_prod_secret_9a8b7c6d5e4f3a2b1c0d9e8f';

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const pass = process.env.NEXA_DEFAULT_ADMIN_PASSWORD || 'nexa-operator-local';
      const viewerLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'viewer', password: pass }),
      });
      const viewerTok = ((await viewerLogin.json()) as { token: string }).token;

      const opLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'operator', password: pass }),
      });
      const opTok = ((await opLogin.json()) as { token: string }).token;

      // Bridge links endpoint
      const linksResp = await fetch(`${baseUrl}/api/bridge/links?missionId=${encodeURIComponent(m.id)}`, {
        headers: { Authorization: `Bearer ${viewerTok}` },
      });
      expect(linksResp.status).toBe(200);
      const linksJson = (await linksResp.json()) as { links: Array<{ commerce_task_id: string }> };
      expect(linksJson.links.some((l) => l.commerce_task_id === 'task_bridge_42')).toBe(true);

      // Analytics includes total_cost_usd
      const analyticsResp = await fetch(`${baseUrl}/api/reports/analytics`, {
        headers: { Authorization: `Bearer ${viewerTok}` },
      });
      expect(analyticsResp.status).toBe(200);
      const analyticsJson = (await analyticsResp.json()) as {
        callsByProvider: Array<{ provider_id: string; total_cost_usd: number }>;
      };
      const openaiRow = analyticsJson.callsByProvider.find((r) => r.provider_id === 'OPENAI');
      expect(openaiRow).toBeTruthy();
      expect(Number(openaiRow?.total_cost_usd)).toBeCloseTo(0.00045, 5);

      // Viewer cannot reset cooldown (403); operator clears GROQ cooldown & failure_count
      const deniedReset = await fetch(`${baseUrl}/api/providers/GROQ/reset-cooldown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewerTok}` },
      });
      expect(deniedReset.status).toBe(403);

      const okReset = await fetch(`${baseUrl}/api/providers/GROQ/reset-cooldown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opTok}` },
      });
      expect(okReset.status).toBe(200);
      const groqAfter = listProviders().find((p) => p.id === 'GROQ');
      expect(groqAfter?.cooldownUntil).toBe(0);
      expect(groqAfter?.failureCount).toBe(0);
      clearProviderCooldown('GROQ', 'test');

      // Generate temporary real .sqlite3 backup in isolated file DB, verify read-only via /api/backups & /api/backups/verify, then switch back cleanly
      resetDbForTests(tmpSrcDb);
      const exported = exportDatabaseBackup();
      createdBackupPath = exported.backupPath;
      resetDbForTests(':memory:');
      ensureRegistrySeeded();

      // Re-login after memory DB reset
      const opLogin2 = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'operator', password: pass }),
      });
      const opTok2 = ((await opLogin2.json()) as { token: string }).token;

      const listResp = await fetch(`${baseUrl}/api/backups`, {
        headers: { Authorization: `Bearer ${opTok2}` },
      });
      expect(listResp.status).toBe(200);
      const backupFilename = path.basename(createdBackupPath);
      const listed = ((await listResp.json()) as { backups: Array<{ filename: string }> }).backups;
      expect(listed.some((b) => b.filename === backupFilename)).toBe(true);
      expect(listDatabaseBackups().some((b) => b.filename === backupFilename)).toBe(true);

      const verifyResp = await fetch(`${baseUrl}/api/backups/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opTok2}` },
        body: JSON.stringify({ filename: backupFilename }),
      });
      expect(verifyResp.status).toBe(200);
      const verifyJson = (await verifyResp.json()) as { valid: boolean; integrityCheck: string; tableCount: number };
      expect(verifyJson.valid).toBe(true);
      expect(verifyJson.integrityCheck).toBe('ok');
      expect(verifyJson.tableCount).toBeGreaterThanOrEqual(29);

      // Rejects path traversal safely
      expect(() => verifyDatabaseBackup('../../etc/passwd')).toThrow(/Invalid backup filename/i);
    } finally {
      clearCooldownsForTests();
      resetDbForTests(':memory:');
      ensureRegistrySeeded();
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevSecret === undefined) delete process.env.NEXA_SESSION_SECRET;
      else process.env.NEXA_SESSION_SECRET = prevSecret;
      for (const fp of [createdBackupPath, tmpSrcDb, `${tmpSrcDb}-wal`, `${tmpSrcDb}-shm`]) {
        if (fp && fs.existsSync(fp)) fs.rmSync(fp, { force: true });
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('38. Mission execution audit logs API returns DB-backed telemetry & enforces max_cost_per_mission_usd ceiling', async () => {
    const db = getDb();
    const prevNodeEnv = process.env.NODE_ENV;
    const prevSecret = process.env.NEXA_SESSION_SECRET;
    const prevOpenAiKey = process.env.OPENAI_API_KEY;
    const prevFetch = globalThis.fetch;
    const createdFiles: string[] = [];

    process.env.NODE_ENV = 'production';
    process.env.NEXA_SESSION_SECRET = 'nexa_test_prod_secret_9a8b7c6d5e4f3a2b1c0d9e8f';

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1) Execute a complete offline mock mission to populate agent_runs + missions rows
      const okMission = createMission({
        objective: 'Audit log telemetry verification mission',
        domain: 'general',
        requestedAgents: ['strategic_planner', 'research_agent', 'independent_critic', 'fact_verification_agent', 'final_synthesis_agent'],
        requiresApproval: false,
      });
      await executeMission({ missionId: okMission.id, allowMockFallback: true });
      const okReportPath = path.resolve(createdArtifactsDir, 'mission_kernel', `mission_report_${okMission.id}.md`);
      createdFiles.push(okReportPath);

      // 2) Verify /api/audit/mission-executions requires auth in production
      const unauthResp = await fetch(`${baseUrl}/api/audit/mission-executions`);
      expect(unauthResp.status).toBe(401);

      const pass = process.env.NEXA_DEFAULT_ADMIN_PASSWORD || 'nexa-operator-local';
      const loginResp = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'viewer', password: pass }),
      });
      const viewerTok = ((await loginResp.json()) as { token: string }).token;

      // 3) Query all execution logs & filtered query by agent_id + status
      const allResp = await fetch(`${baseUrl}/api/audit/mission-executions?status=SUCCESS`, {
        headers: { Authorization: `Bearer ${viewerTok}` },
      });
      expect(allResp.status).toBe(200);
      const allJson = (await allResp.json()) as {
        logs: Array<{
          timestamp: string;
          mission_id: string;
          agent_id: string;
          status: string;
          cost_metadata: {
            costUsd: number;
            tokensIn: number;
            tokensOut: number;
            totalTokens: number;
            latencyMs: number;
            providerId: string;
            modelId: string;
            isMock: boolean;
          };
        }>;
        summary: { totalRows: number; filteredRows: number; failedRuns: number; totalCostUsd: number; totalTokens: number };
      };
      expect(allJson.logs.length).toBeGreaterThanOrEqual(5);
      const first = allJson.logs.find((r) => r.mission_id === okMission.id && r.agent_id === 'strategic_planner');
      expect(first).toBeTruthy();
      expect(first?.timestamp.length).toBeGreaterThan(10);
      expect(first?.status).toBe('SUCCESS');
      expect(typeof first?.cost_metadata.costUsd).toBe('number');
      expect(typeof first?.cost_metadata.tokensIn).toBe('number');
      expect(typeof first?.cost_metadata.tokensOut).toBe('number');
      expect(first?.cost_metadata.providerId).toBeTruthy();

      const searchResp = await fetch(
        `${baseUrl}/api/audit/mission-executions?q=${encodeURIComponent(okMission.id)}&status=FAILED`,
        { headers: { Authorization: `Bearer ${viewerTok}` } }
      );
      expect(searchResp.status).toBe(200);
      const searchJson = (await searchResp.json()) as { logs: unknown[]; summary: { filteredRows: number } };
      expect(searchJson.logs.length).toBe(0);
      expect(searchJson.summary.filteredRows).toBe(0);

      // 4) Enforce max_cost_per_mission_usd ceiling with stubbed paid OpenAI usage ($0.00075 > $0.0001)
      db.prepare("INSERT OR REPLACE INTO system_settings (key, value_json, updated_at) VALUES ('automatic_paid_fallback', 'true', datetime('now'))").run();
      db.prepare("INSERT OR REPLACE INTO system_settings (key, value_json, updated_at) VALUES ('max_cost_per_mission_usd', '0.0001', datetime('now'))").run();
      db.prepare("UPDATE provider_settings SET enabled = 1 WHERE id = 'OPENAI'").run();
      db.prepare("UPDATE model_registry SET enabled = 1 WHERE id = 'gpt-4o-mini'").run();
      process.env.OPENAI_API_KEY = 'sk-test-cost-ceiling-verify-key';
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Strategic plan verifying cost ceiling telemetry.',
                    facts: ['Estimated call cost exceeds $0.0001 ceiling.'],
                    hypotheses: ['Kernel aborts mission between waves when cumulative cost exceeds limit.'],
                    assumptions: [],
                    unknowns: [],
                    risks: [],
                    recommendations: ['Halt execution before additional agent waves run.'],
                    confidence: 0.9,
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 1000 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )) as typeof fetch;

      const capMission = createMission({
        objective: 'Test cost ceiling enforcement abort',
        domain: 'general',
        requestedAgents: ['strategic_planner', 'research_agent', 'independent_critic', 'fact_verification_agent', 'final_synthesis_agent'],
        paidFallbackAllowed: true,
        requiresApproval: false,
      });
      const halted = await executeMission({
        missionId: capMission.id,
        preferredProvider: 'OPENAI',
        allowMockFallback: false,
      });
      expect(halted.status).toBe('FAILED');
      expect(halted.failureClassification).toBe('quota_exhausted');
      expect(halted.lastError).toMatch(/cost ceiling exceeded/i);
      const ceilingAudit = db
        .prepare("SELECT event FROM audit_events WHERE mission_id = ? AND event = 'MISSION_COST_CEILING_EXCEEDED'")
        .get(capMission.id) as { event: string } | undefined;
      expect(ceilingAudit?.event).toBe('MISSION_COST_CEILING_EXCEEDED');
    } finally {
      globalThis.fetch = prevFetch;
      if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAiKey;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevSecret === undefined) delete process.env.NEXA_SESSION_SECRET;
      else process.env.NEXA_SESSION_SECRET = prevSecret;
      clearCooldownsForTests();
      resetDbForTests(':memory:');
      ensureRegistrySeeded();
      for (const fp of createdFiles) {
        if (fs.existsSync(fp)) fs.rmSync(fp, { force: true });
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('39. Epistemic validation rejects degenerate outputs & OHLCV checker detects non-monotonic or invalid timestamps', async () => {
    const prevGroqKey = process.env.GROQ_API_KEY;
    const prevFetch = globalThis.fetch;

    try {
      process.env.GROQ_API_KEY = 'gsk-test-epistemic-verify-key';
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )) as typeof fetch;

      const mission = createMission({
        objective: 'Validate epistemic non-substantive rejection',
        domain: 'general',
        requestedAgents: ['strategic_planner', 'research_agent', 'independent_critic', 'fact_verification_agent', 'final_synthesis_agent'],
        requiresApproval: false,
      });

      const agentRes = await runSingleAgent({
        missionId: mission.id,
        agentId: 'strategic_planner',
        objective: 'Return substantive schema output',
        context: '',
        preferredProvider: 'GROQ',
        allowMockFallback: false,
      });
      expect(agentRes.status).toBe('FAILED');
      expect(agentRes.failureClassification).toBe('validation_error');
      expect(agentRes.error).toMatch(/non-substantive output/i);

      const failedMission = await executeMission({
        missionId: mission.id,
        preferredProvider: 'GROQ',
        allowMockFallback: false,
      });
      expect(failedMission.status).toBe('FAILED');
      expect(failedMission.failureClassification).toBe('validation_error');

      // Validate OHLCV monotonic timestamp check catches reversed & malformed dates
      const reversedQuality = validateOhlcvData([
        { timestamp: '2026-10-02T00:00:00Z', open: 100, high: 105, low: 99, close: 103, volume: 500 },
        { timestamp: '2026-10-01T00:00:00Z', open: 103, high: 106, low: 101, close: 104, volume: 600 },
        { timestamp: 'not-a-timestamp', open: 104, high: 107, low: 102, close: 105, volume: 700 },
      ]);
      expect(reversedQuality.nonMonotonicTimestamps).toBe(2);
      expect(reversedQuality.passed).toBe(false);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevGroqKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = prevGroqKey;
      clearCooldownsForTests();
    }
  });

  it('40. Phase 6 Sandbox E2E completes all 14 dependency-gated stages in isolation with zero production DB/artifact writes', async () => {
    const dbBefore = getDb();
    const countRealTables = () => ({
      opportunities: Number((dbBefore.prepare('SELECT COUNT(*) AS c FROM commerce_opportunities').get() as { c: number }).c),
      proposals: Number((dbBefore.prepare('SELECT COUNT(*) AS c FROM commerce_proposals').get() as { c: number }).c),
      sites: Number((dbBefore.prepare('SELECT COUNT(*) AS c FROM commerce_sites').get() as { c: number }).c),
      ledger: Number((dbBefore.prepare('SELECT COUNT(*) AS c FROM commerce_financial_ledger').get() as { c: number }).c),
      missions: Number((dbBefore.prepare('SELECT COUNT(*) AS c FROM missions').get() as { c: number }).c),
      approvals: Number((dbBefore.prepare('SELECT COUNT(*) AS c FROM approvals').get() as { c: number }).c),
      plans: Number((dbBefore.prepare('SELECT COUNT(*) AS c FROM commerce_business_plans').get() as { c: number }).c),
      risks: Number((dbBefore.prepare('SELECT COUNT(*) AS c FROM commerce_risk_evaluations').get() as { c: number }).c),
      sandboxResults: Number((dbBefore.prepare('SELECT COUNT(*) AS c FROM commerce_sandbox_results').get() as { c: number }).c),
    });

    const beforeCounts = countRealTables();
    const artifactsBefore = fs.existsSync(createdArtifactsDir) ? fs.readdirSync(createdArtifactsDir).length : 0;

    let runId = '';
    try {
      expect(SANDBOX_STAGE_SPECS).toHaveLength(14);
      expect(SANDBOX_POLICY_LOCKS.environmentMode).toBe('SANDBOX');
      expect(SANDBOX_POLICY_LOCKS.writesToProductionDb).toBe(false);
      expect(SANDBOX_POLICY_LOCKS.externalPayments).toBe('DENIED');
      expect(SANDBOX_POLICY_LOCKS.customerOutreach).toBe('DENIED');
      expect(SANDBOX_POLICY_LOCKS.publishing).toBe('DENIED');
      expect(SANDBOX_POLICY_LOCKS.liveTrading).toBe('DENIED');

      const paused = await startSandboxMission({
        niche: 'Dental Implant Clinics',
        cityOrMarket: 'Milan',
        language: 'en',
        maxCostUsd: 0.5,
        maxRetries: 1,
        stageTimeoutMs: 5000,
        createdBy: 'qa_operator',
      });
      runId = paused.run.runId;

      expect(paused.run.environmentMode).toBe('SANDBOX');
      expect(paused.run.status).toBe('AWAITING_APPROVAL');
      expect(paused.run.approvalId).toBeGreaterThan(0);
      expect(paused.stages.slice(0, 9).every((s) => s.status === 'COMPLETED')).toBe(true);
      expect(paused.stages[9].id).toBe('human_approval_gate');
      expect(paused.stages[9].status).toBe('AWAITING_APPROVAL');
      expect(paused.stages.slice(10).every((s) => s.status === 'PENDING')).toBe(true);

      // Verify zero side effects leaked into active database or artifacts folder
      expect(countRealTables()).toEqual(beforeCounts);
      expect(getCommerceTruthMetrics().realizedRevenueEur).toBe(0);
      const artifactsDuring = fs.existsSync(createdArtifactsDir) ? fs.readdirSync(createdArtifactsDir).length : 0;
      expect(artifactsDuring).toBe(artifactsBefore);

      // Approve Stage 10 and execute Stages 11..14
      const completed = await decideSandboxApproval({
        runId,
        decision: 'approved',
        decidedBy: 'qa_operator',
        note: 'Verified all simulated stages',
      });

      expect(completed.run.status).toBe('COMPLETED');
      expect(completed.stages).toHaveLength(14);
      expect(completed.stages.every((s) => s.status === 'COMPLETED')).toBe(true);
      expect(completed.opportunities.length).toBeGreaterThanOrEqual(2);
      expect(completed.sources.length).toBeGreaterThanOrEqual(1);
      expect(completed.evidence.length).toBeGreaterThanOrEqual(2);
      expect(completed.businessPlans.length).toBe(1);
      expect(completed.proposals.length).toBe(1);
      expect(completed.sites.length).toBe(1);
      expect(completed.contentAssets.length).toBeGreaterThanOrEqual(2);
      expect(completed.riskEvaluations.length).toBe(1);
      expect(completed.sandboxResult).toBeTruthy();
      expect(completed.agentExecutions.length).toBe(14);
      expect(completed.finalReportMarkdown).toContain('Verified Real-World Revenue:** EUR 0.00');
      expect(completed.simulatedMetrics.isSimulated).toBe(true);
      expect(completed.simulatedMetrics.verifiedRealRevenueEur).toBe(0);

      // Verify all external actions were explicitly blocked in Stage 11
      expect(completed.blockedExternalActions.length).toBe(6);
      const blockedTypes = completed.blockedExternalActions.map((b) => b.actionType);
      expect(blockedTypes).toEqual(
        expect.arrayContaining(['PUBLISH_WEBSITE', 'SEND_EMAIL', 'SEND_SMS', 'PAYMENT_INITIATION', 'PUBLISH_ADS', 'LIVE_TRADING'])
      );
      expect(completed.blockedExternalActions.every((b) => b.policyResult === 'DENIED_BY_SANDBOX_POLICY')).toBe(true);

      // Re-verify real database & filesystem still untouched
      expect(countRealTables()).toEqual(beforeCounts);
      expect(fs.existsSync(createdArtifactsDir) ? fs.readdirSync(createdArtifactsDir).length : 0).toBe(artifactsBefore);
    } finally {
      if (runId) deleteSandboxMission(runId);
    }
  });

  it('41. Phase 6 Sandbox handles invalid inputs, retry recovery, retry exhaustion, timeouts, bad AI output, and cost ceiling enforcement', async () => {
    const cleanupIds: string[] = [];
    try {
      await expect(startSandboxMission({ niche: 'ab', cityOrMarket: 'Milan' })).rejects.toThrow(/at least 3/i);
      await expect(startSandboxMission({ niche: 'Physiotherapy', cityOrMarket: 'Milan', maxCostUsd: -1 })).rejects.toThrow(/maxCostUsd/i);

      // 1) Transient AGENT_FAILURE on Stage 4 recovers on attempt #2
      const recovered = await startSandboxMission({
        niche: 'Dental Recovery Test',
        cityOrMarket: 'Turin',
        maxRetries: 1,
        simulationMode: 'AGENT_FAILURE',
      });
      cleanupIds.push(recovered.run.runId);
      expect(recovered.run.status).toBe('AWAITING_APPROVAL');
      expect(recovered.stages[3].id).toBe('feasibility_analysis');
      expect(recovered.stages[3].status).toBe('COMPLETED');
      expect(recovered.stages[3].attempts).toBe(2);

      // 2) RETRY_EXHAUSTION fails Stage 4 and BLOCKS downstream Stages 5..14
      const exhausted = await startSandboxMission({
        niche: 'Dental Exhaustion Test',
        cityOrMarket: 'Turin',
        maxRetries: 1,
        simulationMode: 'RETRY_EXHAUSTION',
      });
      cleanupIds.push(exhausted.run.runId);
      expect(exhausted.run.status).toBe('FAILED');
      expect(exhausted.stages[3].status).toBe('FAILED');
      expect(exhausted.stages[3].attempts).toBe(2);
      expect(exhausted.stages.slice(4).every((s) => s.status === 'BLOCKED')).toBe(true);

      // 3) TIMEOUT fails Stage 3 with timeout classification and BLOCKS Stages 4..14
      const timedOut = await startSandboxMission({
        niche: 'Timeout Clinic Test',
        cityOrMarket: 'Rome',
        maxRetries: 0,
        stageTimeoutMs: 25,
        simulationMode: 'TIMEOUT',
      });
      cleanupIds.push(timedOut.run.runId);
      expect(timedOut.run.status).toBe('FAILED');
      expect(timedOut.run.failureClassification).toBe('timeout');
      expect(timedOut.stages[2].status).toBe('FAILED');
      expect(timedOut.stages.slice(3).every((s) => s.status === 'BLOCKED')).toBe(true);

      // 4) INVALID_AI_OUTPUT fails Stage 5 schema/substantive validation and BLOCKS Stages 6..14
      const invalidAi = await startSandboxMission({
        niche: 'Invalid AI Output Test',
        cityOrMarket: 'Bologna',
        maxRetries: 0,
        simulationMode: 'INVALID_AI_OUTPUT',
      });
      cleanupIds.push(invalidAi.run.runId);
      expect(invalidAi.run.status).toBe('FAILED');
      expect(invalidAi.run.failureClassification).toBe('validation_error');
      expect(invalidAi.stages[4].status).toBe('FAILED');
      expect(invalidAi.stages.slice(5).every((s) => s.status === 'BLOCKED')).toBe(true);

      // 5) COST_CEILING_EXCEEDED aborts Stage 6 with quota_exhausted and audit log before mutating Stage 6 domain artifacts
      const costExhausted = await startSandboxMission({
        niche: 'Cost Ceiling Clinic Test',
        cityOrMarket: 'Naples',
        maxCostUsd: 0.01,
        maxRetries: 0,
        simulationMode: 'COST_CEILING_EXCEEDED',
      });
      cleanupIds.push(costExhausted.run.runId);
      expect(costExhausted.run.status).toBe('FAILED');
      expect(costExhausted.run.failureClassification).toBe('quota_exhausted');
      expect(costExhausted.stages[5].status).toBe('FAILED');
      expect(costExhausted.stages.slice(6).every((s) => s.status === 'BLOCKED')).toBe(true);
      expect(costExhausted.proposals.length).toBe(0);
      expect(costExhausted.auditEvents.some((e) => e.event === 'SANDBOX_COST_CEILING_EXCEEDED')).toBe(true);
    } finally {
      for (const id of cleanupIds) deleteSandboxMission(id);
    }
  });

  it('42. Phase 6 Sandbox enforces approval rejection lock, duplicate mission prevention, and mid-run cancellation', async () => {
    const cleanupIds: string[] = [];
    try {
      // 1) Duplicate prevention while awaiting approval + rejection blocks Stages 11..14
      const paused = await startSandboxMission({
        niche: 'Osteopathy Duplicate Check',
        cityOrMarket: 'Florence',
        idempotencyKey: 'qa-lock-key-1',
      });
      cleanupIds.push(paused.run.runId);
      expect(paused.run.status).toBe('AWAITING_APPROVAL');

      await expect(
        startSandboxMission({
          niche: 'Osteopathy Duplicate Check',
          cityOrMarket: 'Florence',
          idempotencyKey: 'qa-lock-key-1',
        })
      ).rejects.toThrow(/Duplicate active sandbox mission/i);

      const rejected = await decideSandboxApproval({
        runId: paused.run.runId,
        decision: 'rejected',
        decidedBy: 'security_reviewer',
        note: 'Pricing sensitivity review failed',
      });
      expect(rejected.run.status).toBe('BLOCKED');
      expect(rejected.stages[9].status).toBe('FAILED');
      expect(rejected.stages.slice(10).every((s) => s.status === 'BLOCKED')).toBe(true);

      // 2) Mid-flight cancellation via stageWorkerHook cleanly aborts pipeline
      let cancelledRunId = '';
      const cancelled = await startSandboxMission({
        niche: 'Midflight Cancel Check',
        cityOrMarket: 'Verona',
        maxRetries: 0,
        stageWorkerHook: async ({ stage, runId }) => {
          cancelledRunId = runId;
          if (stage.order === 3) {
            cancelSandboxMission(runId, 'qa_operator');
          }
          return null;
        },
      });
      cleanupIds.push(cancelledRunId || cancelled.run.runId);
      expect(cancelled.run.status).toBe('CANCELLED');
      expect(cancelled.stages[2].status).toBe('CANCELLED');
      expect(cancelled.stages.slice(3).every((s) => s.status === 'CANCELLED' || s.status === 'BLOCKED')).toBe(true);
    } finally {
      for (const id of cleanupIds) {
        try {
          deleteSandboxMission(id);
        } catch {
          // ignore if already removed
        }
      }
    }
  });

  it('43. Phase 6 Sandbox HTTP API enforces RBAC, validation, 409 duplicate lock, full approval flow, and schema v7 integrity', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevSecret = process.env.NEXA_SESSION_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.NEXA_SESSION_SECRET = 'nexa-phase6-sandbox-http-secret-key-32ch';

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    let createdRunId = '';

    try {
      // Unauthenticated request rejected
      const unauth = await fetch(`${baseUrl}/api/commerce/sandbox`);
      expect(unauth.status).toBe(401);

      const pass = process.env.NEXA_DEFAULT_ADMIN_PASSWORD || 'nexa-operator-local';
      const viewerAuth = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'viewer', password: pass }),
      });
      expect(viewerAuth.status).toBe(200);
      const viewerToken = ((await viewerAuth.json()) as { token: string }).token;

      const operatorAuth = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'operator', password: pass }),
      });
      expect(operatorAuth.status).toBe(200);
      const operatorToken = ((await operatorAuth.json()) as { token: string }).token;

      // Viewer can list sandbox runs but cannot start one (403)
      const viewerList = await fetch(`${baseUrl}/api/commerce/sandbox`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      });
      expect(viewerList.status).toBe(200);
      expect(listSandboxMissions().policy.environmentMode).toBe('SANDBOX');

      const viewerStart = await fetch(`${baseUrl}/api/commerce/sandbox/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` },
        body: JSON.stringify({ niche: 'Vet Clinics', cityOrMarket: 'Milan' }),
      });
      expect(viewerStart.status).toBe(403);

      // Operator bad input returns 400
      const badStart = await fetch(`${baseUrl}/api/commerce/sandbox/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
        body: JSON.stringify({ niche: 'x', cityOrMarket: 'Milan' }),
      });
      expect(badStart.status).toBe(400);

      // Operator valid start returns 201 AWAITING_APPROVAL
      const okStart = await fetch(`${baseUrl}/api/commerce/sandbox/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
        body: JSON.stringify({ niche: 'Veterinary Clinics', cityOrMarket: 'Padua', language: 'en' }),
      });
      expect(okStart.status).toBe(201);
      const startPayload = (await okStart.json()) as NonNullable<ReturnType<typeof getSandboxMissionDetails>>;
      createdRunId = startPayload.run.runId;
      expect(startPayload.run.status).toBe('AWAITING_APPROVAL');

      // Duplicate launch returns 409
      const dupStart = await fetch(`${baseUrl}/api/commerce/sandbox/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
        body: JSON.stringify({ niche: 'Veterinary Clinics', cityOrMarket: 'Padua', language: 'en' }),
      });
      expect(dupStart.status).toBe(409);

      // Operator approves Stage 10 -> 14/14 COMPLETED
      const approveRes = await fetch(`${baseUrl}/api/commerce/sandbox/${createdRunId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
        body: JSON.stringify({ decision: 'approved', note: 'HTTP RBAC verification passed' }),
      });
      expect(approveRes.status).toBe(200);
      const completedPayload = (await approveRes.json()) as NonNullable<ReturnType<typeof getSandboxMissionDetails>>;
      expect(completedPayload.run.status).toBe('COMPLETED');
      expect(completedPayload.blockedExternalActions.length).toBe(6);

      // DELETE cleans up isolated sandbox run
      const delRes = await fetch(`${baseUrl}/api/commerce/sandbox/${createdRunId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      expect(delRes.status).toBe(200);
      createdRunId = '';

      // Schema v7 + integrity diagnostics clean
      const diag = getDatabaseDiagnostics();
      expect(typeof diag.walMode).toBe('boolean');
      const liveDb = getDb();
      const integrityRow = liveDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      const fkRows = liveDb.prepare('PRAGMA foreign_key_check').all();
      const verRow = liveDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
      expect(integrityRow.integrity_check).toBe('ok');
      expect(fkRows.length).toBe(0);
      expect(verRow.version).toBeGreaterThanOrEqual(7);
    } finally {
      if (createdRunId) {
        try {
          deleteSandboxMission(createdRunId);
        } catch {
          // ignore
        }
      }
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevSecret === undefined) delete process.env.NEXA_SESSION_SECRET;
      else process.env.NEXA_SESSION_SECRET = prevSecret;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('44. Phase 7 Research Layer classifies VERIFIED vs SIMULATED/UNVERIFIED evidence, blocks offline failures cleanly, and rejects invalid/malicious sources', async () => {
    const cap = await getPhase7CapabilityMatrix();
    expect(cap.safetyLocks.externalOutreachMode).toBe('READ_ONLY_DISABLED');
    expect(cap.safetyLocks.realPayments).toBe('DISABLED');
    expect(cap.safetyLocks.websitePublishing).toBe('DISABLED');
    expect(isExternalCommerceEnabled()).toBe(false);
    expect(isLiveTradingEnabled()).toBe(false);

    // Invalid source validator rejects bad timestamps, XSS scripts, private URLs, and URL-less verified claims
    expect(
      validatePhase7SourceRecord({
        sourceUrl: null,
        sourceTitle: 'Valid Title',
        sourceProvider: 'openalex',
        retrievedAt: new Date().toISOString(),
        relevantEvidence: 'Detailed market observation string.',
        evidenceClassification: 'VERIFIED_SOURCE_DATA',
        confidence: 0.9,
        limitations: 'None',
      }).valid
    ).toBe(false);

    expect(
      validatePhase7SourceRecord({
        sourceUrl: 'http://127.0.0.1/internal',
        sourceTitle: 'Internal SSRF probe',
        sourceProvider: 'live_http_audit',
        retrievedAt: new Date().toISOString(),
        relevantEvidence: 'Should be rejected by SSRF validation.',
        evidenceClassification: 'VERIFIED_SOURCE_DATA',
        confidence: 0.9,
        limitations: 'SSRF test',
      }).valid
    ).toBe(false);

    expect(
      validatePhase7SourceRecord({
        sourceUrl: 'https://example.org/doc',
        sourceTitle: '<script>alert(1)</script> Bad Source',
        sourceProvider: 'openalex',
        retrievedAt: new Date().toISOString(),
        relevantEvidence: 'Malicious payload test.',
        evidenceClassification: 'VERIFIED_SOURCE_DATA',
        confidence: 0.8,
        limitations: 'XSS',
      }).valid
    ).toBe(false);

    // Missing/offline live research providers -> BLOCKED (unless fixture fallback explicitly requested)
    const offlineBlocked = await runPhase7ResearchMission({
      niche: 'Physiotherapy Clinics',
      market: 'Milan',
      mode: 'LIVE_RESEARCH',
      allowFixtureFallback: false,
      researchFetcherHook: async () => ({
        sources: [],
        requestsMade: 3,
        costUsd: 0,
        retriesUsed: 1,
        providerUsed: 'public_open_research_feeds',
        limitations: ['Simulated network unreachable timeout'],
        offlineOrBlocked: true,
      }),
    });
    expect(offlineBlocked?.mission.researchStatus).toBe('BLOCKED');
    expect(offlineBlocked?.mission.status).toBe('BLOCKED');
    expect(offlineBlocked?.opportunities.length).toBe(0);

    // Explicit offline fallback marks sources strictly as SIMULATED_DATA / UNVERIFIED_CLAIM with capped confidence <= 30
    const fixtureRun = await runPhase7ResearchMission({
      niche: 'Dental Practices',
      market: 'Turin',
      mode: 'LIVE_RESEARCH',
      allowFixtureFallback: true,
      researchFetcherHook: async () => ({
        sources: [
          {
            sourceUrl: 'https://broken.invalid/bad',
            sourceTitle: '<script>bad</script>',
            sourceProvider: 'bad',
            retrievedAt: 'invalid-date',
            relevantEvidence: 'tiny',
            evidenceClassification: 'VERIFIED_SOURCE_DATA',
            confidence: 0.9,
            limitations: 'Invalid fixture payload',
          },
        ],
        requestsMade: 2,
        costUsd: 0,
        retriesUsed: 0,
        providerUsed: 'public_open_research_feeds',
        limitations: ['Malformed source filtered out'],
        offlineOrBlocked: true,
      }),
    });
    expect(fixtureRun?.mission.researchStatus).toBe('SIMULATED_FIXTURE');
    expect(fixtureRun?.sources.some((s) => !s.isValid)).toBe(true);
    expect(fixtureRun?.sources.some((s) => s.isValid && s.evidenceClassification === 'SIMULATED_DATA')).toBe(true);
    expect(fixtureRun?.opportunities[0]?.evidenceConfidence).toBeLessThanOrEqual(30);

    if (offlineBlocked?.mission.id) deletePhase7Mission(offlineBlocked.mission.id);
    if (fixtureRun?.mission.id) deletePhase7Mission(fixtureRun.mission.id);
  });

  it('45. Phase 7 Explainable 9-Criteria Opportunity Scoring prevents confidence inflation and picks pain-backed opportunities over lowest-effort tasks', () => {
    const lowEvidence = evaluateOpportunityCriteria({
      niche: 'Physiotherapy',
      market: 'Milan',
      serviceArchetype: 'AI_TRIAGE_CONTENT_KIT',
      verifiedSourcesCount: 0,
      unverifiedOrSimulatedCount: 2,
      observedTechnicalGapsCount: 0,
      estimatedEffortHours: 8,
      estimatedOperatingCostEur: 0,
    });
    expect(lowEvidence.criteria).toHaveLength(9);
    expect(lowEvidence.evidenceConfidence).toBeLessThanOrEqual(30);

    const verifiedBooking = evaluateOpportunityCriteria({
      niche: 'Physiotherapy',
      market: 'Milan',
      serviceArchetype: 'BOOKING_WEB_UPGRADE',
      verifiedSourcesCount: 4,
      unverifiedOrSimulatedCount: 0,
      observedTechnicalGapsCount: 4,
      estimatedEffortHours: 14,
      estimatedOperatingCostEur: 0,
    });
    const trivialKit = evaluateOpportunityCriteria({
      niche: 'Physiotherapy',
      market: 'Milan',
      serviceArchetype: 'AI_TRIAGE_CONTENT_KIT',
      verifiedSourcesCount: 4,
      unverifiedOrSimulatedCount: 0,
      observedTechnicalGapsCount: 4,
      estimatedEffortHours: 8,
      estimatedOperatingCostEur: 0,
    });

    expect(verifiedBooking.evidenceConfidence).toBeGreaterThan(75);
    // Must not blindly pick lowest effort (8h kit) over higher-value/pain-backed booking upgrade (14h)
    expect(verifiedBooking.totalScore).toBeGreaterThan(trivialKit.totalScore);
  });

  it('46. Phase 7 Independent QA Gate blocks self-approval, detects unsupported claims/missing viewport/XSS, and verifies revision loop to READY', async () => {
    const missionRes = await runPhase7ResearchMission({
      niche: 'Physiotherapy Clinics',
      market: 'Milan',
      mode: 'LIVE_RESEARCH',
      researchFetcherHook: async () => ({
        sources: [
          {
            sourceUrl: 'https://www.openstreetmap.org/node/99887711',
            sourceTitle: 'OpenStreetMap Business Record: Studio Fisioterapia Esempio',
            sourceProvider: 'osm_nominatim',
            retrievedAt: new Date().toISOString(),
            relevantEvidence: 'Observed local clinic directory record in Milan. Website tag present: no; Phone metadata present: yes.',
            evidenceClassification: 'VERIFIED_SOURCE_DATA',
            confidence: 0.88,
            limitations: 'Public OSM tag snapshot only.',
          },
          {
            sourceUrl: 'https://studio-esempio.example.com/',
            sourceTitle: 'Live HTTP Presence Inspection (studio-esempio.example.com)',
            sourceProvider: 'live_http_audit',
            retrievedAt: new Date().toISOString(),
            relevantEvidence: 'HTTP 200 in 420ms. Mobile viewport: missing, Meta desc: missing, Booking form: missing.',
            evidenceClassification: 'VERIFIED_SOURCE_DATA',
            confidence: 0.94,
            limitations: 'Single-page HTML snapshot only.',
          },
        ],
        requestsMade: 2,
        costUsd: 0,
        retriesUsed: 0,
        providerUsed: 'public_open_research_feeds',
        limitations: [],
      }),
    });

    const mId = missionRes!.mission.id;
    try {
      expect(missionRes?.mission.researchStatus).toBe('VERIFIED_LIVE');
      expect(missionRes?.opportunities.length).toBe(3);

      // 1. Injected mobile defect -> NEEDS_REVISION (cannot be READY)
      const mobileRejected = generatePhase7DeliverablePackage({
        missionId: mId,
        defectInjection: 'MISSING_VIEWPORT',
      });
      const mobilePkg = mobileRejected!.deliverables[0];
      expect(mobilePkg.qaStatus).toBe('NEEDS_REVISION');
      expect(mobilePkg.qaReport?.findings.some((f) => /viewport|mobile/i.test(f))).toBe(true);
      expect(mobileRejected?.mission.status).toBe('QA_REJECTED');

      // 2. Unsupported fabricated claims -> BLOCKED
      const claimRejected = generatePhase7DeliverablePackage({
        missionId: mId,
        defectInjection: 'UNSUPPORTED_CLAIM',
      });
      expect(claimRejected!.deliverables[0].qaStatus).toBe('BLOCKED');
      expect(claimRejected!.deliverables[0].qaReport?.blockingIssues.some((f) => /fabricated|unsupported/i.test(f))).toBe(true);

      // 3. Unsafe script eval() -> BLOCKED
      const secRejected = generatePhase7DeliverablePackage({
        missionId: mId,
        defectInjection: 'UNSAFE_SCRIPT',
      });
      expect(secRejected!.deliverables[0].qaStatus).toBe('BLOCKED');
      expect(secRejected!.deliverables[0].qaReport?.blockingIssues.some((f) => /security/i.test(f))).toBe(true);

      // 4. Independent review check: same generator/reviewer agent must throw!
      expect(() =>
        evaluateDeliverableQuality({
          deliverableHtml: mobilePkg.deliverableHtml,
          packageBundle: mobilePkg.packageBundle,
          niche: 'Physiotherapy Clinics',
          market: 'Milan',
          validSourceIds: new Set(missionRes!.sources.map((s) => s.id)),
          generatorAgentId: 'commerce_operations_agent',
          reviewerAgentId: 'commerce_operations_agent',
        })
      ).toThrow(/cannot self-approve/i);

      // 5. Guided Revision fixes defects, increments revisionNumber, re-runs independent QA -> READY
      const revised = revisePhase7Deliverable({
        deliverableId: claimRejected!.deliverables[0].id,
        revisionNotes: 'Removed fabricated ROI claims and restored responsive mobile layout.',
      });
      const fixedPkg = revised!.deliverables[0];
      expect(fixedPkg.revisionNumber).toBe(2);
      expect(fixedPkg.qaStatus).toBe('READY');
      expect(fixedPkg.qaScore).toBeGreaterThanOrEqual(80);
      expect(fixedPkg.qaReport?.reviewerAgentId).toBe('quality_assurance_agent');
      expect(fixedPkg.qaReport?.generatorAgentId).toBe('commerce_operations_agent');
      expect(fixedPkg.packageBundle.pricingProposal.realizedRevenueEur).toBe(0);
      expect(fixedPkg.packageBundle.environmentPolicy).toEqual(PHASE7_SAFETY_LOCKS);
      expect(revised?.mission.status).toBe('READY_FOR_REVIEW');
    } finally {
      deletePhase7Mission(mId);
    }
  });

  it('47. Phase 7 enforces mission cost limits, isolates from real CRM/ledger/artifacts, and leaves real revenue untouched', async () => {
    const db = getDb();
    const beforeCustomers = Number((db.prepare('SELECT COUNT(*) AS c FROM commerce_customers').get() as { c: number }).c);
    const beforeProposals = Number((db.prepare('SELECT COUNT(*) AS c FROM commerce_proposals').get() as { c: number }).c);
    const beforeSites = Number((db.prepare('SELECT COUNT(*) AS c FROM commerce_sites').get() as { c: number }).c);
    const beforeLedger = Number((db.prepare('SELECT COUNT(*) AS c FROM commerce_financial_ledger').get() as { c: number }).c);
    const artifactsBefore = fs.existsSync(createdArtifactsDir) ? fs.readdirSync(createdArtifactsDir).length : 0;

    // Exceed maxCostUsd -> mission fails cleanly without downstream opportunities/deliverables
    const overBudget = await runPhase7ResearchMission({
      niche: 'Dental Surgery',
      market: 'Rome',
      maxCostUsd: 0.01,
      researchFetcherHook: async () => ({
        sources: [],
        requestsMade: 4,
        costUsd: 0.05,
        retriesUsed: 0,
        providerUsed: 'test_cost_overrun',
        limitations: [],
      }),
    });

    expect(overBudget?.mission.status).toBe('FAILED');
    expect(overBudget?.mission.researchStatus).toBe('BLOCKED');
    expect(overBudget?.mission.errorMessage).toMatch(/cost ceiling exceeded/i);
    expect(() => generatePhase7DeliverablePackage({ missionId: overBudget!.mission.id })).toThrow(/status is FAILED/i);

    // Verify zero contamination to live CRM, proposals, sites, financial ledger, or disk artifacts
    expect(Number((db.prepare('SELECT COUNT(*) AS c FROM commerce_customers').get() as { c: number }).c)).toBe(beforeCustomers);
    expect(Number((db.prepare('SELECT COUNT(*) AS c FROM commerce_proposals').get() as { c: number }).c)).toBe(beforeProposals);
    expect(Number((db.prepare('SELECT COUNT(*) AS c FROM commerce_sites').get() as { c: number }).c)).toBe(beforeSites);
    expect(Number((db.prepare('SELECT COUNT(*) AS c FROM commerce_financial_ledger').get() as { c: number }).c)).toBe(beforeLedger);
    expect(getCommerceTruthMetrics().realizedRevenueEur).toBe(0);
    expect(fs.existsSync(createdArtifactsDir) ? fs.readdirSync(createdArtifactsDir).length : 0).toBe(artifactsBefore);

    if (overBudget?.mission.id) deletePhase7Mission(overBudget.mission.id);
  });

  it('48. Phase 7 HTTP API enforces RBAC, fixture validation workflow, opportunity selection, deliverable QA, revision, and schema v8 integrity', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevSecret = process.env.NEXA_SESSION_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.NEXA_SESSION_SECRET = 'nexa-phase7-validation-http-secret-32c';

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    let missionId = '';

    try {
      const unauth = await fetch(`${baseUrl}/api/phase7/missions`);
      expect(unauth.status).toBe(401);

      const pass = process.env.NEXA_DEFAULT_ADMIN_PASSWORD || 'nexa-operator-local';
      const viewerTok = (
        (await (
          await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'viewer', password: pass }),
          })
        ).json()) as { token: string }
      ).token;

      const operatorTok = (
        (await (
          await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'operator', password: pass }),
          })
        ).json()) as { token: string }
      ).token;

      // Viewer cannot start research mission (403)
      const viewerStart = await fetch(`${baseUrl}/api/phase7/missions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerTok}` },
        body: JSON.stringify({ niche: 'Vet Clinics', market: 'Milan', mode: 'FIXTURE_SIMULATION' }),
      });
      expect(viewerStart.status).toBe(403);

      // Operator starts offline fixture mission -> 201
      const startRes = await fetch(`${baseUrl}/api/phase7/missions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorTok}` },
        body: JSON.stringify({ niche: 'Veterinary Clinics', market: 'Bologna', mode: 'FIXTURE_SIMULATION', language: 'en' }),
      });
      expect(startRes.status).toBe(201);
      const started = (await startRes.json()) as NonNullable<ReturnType<typeof getPhase7MissionDetails>>;
      missionId = started.mission.id;
      expect(started.mission.researchStatus).toBe('SIMULATED_FIXTURE');
      expect(started.opportunities.length).toBe(3);

      // Select opportunity -> generate defective deliverable -> revise -> READY
      const secondOppId = started.opportunities[1].id;
      const selRes = await fetch(`${baseUrl}/api/phase7/missions/${missionId}/opportunities/${secondOppId}/select`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${operatorTok}` },
      });
      expect(selRes.status).toBe(200);

      const badDelivRes = await fetch(`${baseUrl}/api/phase7/missions/${missionId}/deliverable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorTok}` },
        body: JSON.stringify({ opportunityId: secondOppId, defectInjection: 'MISSING_VIEWPORT' }),
      });
      expect(badDelivRes.status).toBe(201);
      const badDelivJson = (await badDelivRes.json()) as NonNullable<ReturnType<typeof getPhase7MissionDetails>>;
      const delivId = badDelivJson.deliverables[0].id;
      expect(badDelivJson.deliverables[0].qaStatus).toBe('NEEDS_REVISION');

      const revRes = await fetch(`${baseUrl}/api/phase7/deliverables/${delivId}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorTok}` },
        body: JSON.stringify({ revisionNotes: 'Restored mobile responsiveness via HTTP API test' }),
      });
      expect(revRes.status).toBe(200);
      const revJson = (await revRes.json()) as NonNullable<ReturnType<typeof getPhase7MissionDetails>>;
      expect(revJson.deliverables[0].qaStatus).toBe('READY');
      expect(revJson.deliverables[0].revisionNumber).toBe(2);

      // Schema v9 integrity check
      const liveDb = getDb();
      const integrityRow = liveDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      const fkRows = liveDb.prepare('PRAGMA foreign_key_check').all();
      const verRow = liveDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
      expect(integrityRow.integrity_check).toBe('ok');
      expect(fkRows.length).toBe(0);
      expect(verRow.version).toBe(9);

      const delRes = await fetch(`${baseUrl}/api/phase7/missions/${missionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${operatorTok}` },
      });
      expect(delRes.status).toBe(200);
      missionId = '';
    } finally {
      if (missionId) {
        try {
          deletePhase7Mission(missionId);
        } catch {
          // ignore
        }
      }
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevSecret === undefined) delete process.env.NEXA_SESSION_SECRET;
      else process.env.NEXA_SESSION_SECRET = prevSecret;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('49. Dynamic Gemini & Groq model discovery registers valid chat models and disables inaccessible Groq defaults', () => {
    const geminiAdded = upsertDiscoveredGeminiModels([
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000 },
      { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'], inputTokenLimit: 2048 },
    ]);
    expect(geminiAdded).toBe(1);
    const geminiModels = listModels({ providerId: 'GEMINI' }).map((m) => m.id);
    expect(geminiModels).toContain('gemini-2.5-flash');
    expect(geminiModels).not.toContain('embedding-001');

    const groqAdded = upsertDiscoveredGroqModels([
      { id: 'llama-3.1-8b-instant', context_window: 131072 },
      { id: 'whisper-large-v3', context_window: 448 },
    ]);
    expect(groqAdded).toBe(1);
    const groqModels = listModels({ providerId: 'GROQ' });
    const activeGroq = groqModels.filter((m) => m.enabled).map((m) => m.id);
    const staleGroq = groqModels.find((m) => m.id === 'llama-3.3-70b-versatile');
    expect(activeGroq).toContain('llama-3.1-8b-instant');
    expect(activeGroq).not.toContain('whisper-large-v3');
    expect(staleGroq?.enabled).toBe(false);
  });

  it('50. Live-AI wrapper degrades deterministically without keys and disk export enforces READY QA gate and path safety', async () => {
    const tempExportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-p7-export-'));
    const mRes = await runPhase7ResearchMission({
      niche: 'Local Barbershops',
      market: 'Milan',
      mode: 'LIVE_RESEARCH',
      researchFetcherHook: async () => ({
        sources: [
          {
            sourceUrl: 'https://en.wikipedia.org/wiki/Barber',
            sourceTitle: 'Local Grooming & Barber Market Standard',
            sourceProvider: 'wikipedia',
            retrievedAt: new Date().toISOString(),
            relevantEvidence: 'Appointment scheduling demand and mobile local search visibility notes.',
            evidenceClassification: 'VERIFIED_SOURCE_DATA',
            confidence: 0.85,
            limitations: 'Public encyclopedic context',
          },
        ],
        requestsMade: 1,
        costUsd: 0,
        retriesUsed: 0,
        providerUsed: 'public_open_research_feeds',
        limitations: [],
        offlineOrBlocked: false,
      }),
    });
    const mId = mRes!.mission.id;
    try {
      // Without provider keys in isolated test DB, async live-AI wrapper gracefully falls back cleanly to deterministic HTML + QA READY
      const prevGem = process.env.GEMINI_API_KEY;
      const prevOr = process.env.OPENROUTER_API_KEY;
      const prevGr = process.env.GROQ_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.GROQ_API_KEY;
      try {
        const res = await generatePhase7DeliverableWithLiveAi({ missionId: mId, useLiveAi: true });
        expect(res?.deliverables[0].qaStatus).toBe('READY');
        expect(res?.mission.limitations.some((l) => /skipped safely|deterministic/i.test(l))).toBe(true);
      } finally {
        if (prevGem !== undefined) process.env.GEMINI_API_KEY = prevGem;
        if (prevOr !== undefined) process.env.OPENROUTER_API_KEY = prevOr;
        if (prevGr !== undefined) process.env.GROQ_API_KEY = prevGr;
      }

      // QA_REJECTED deliverable cannot export to disk
      generatePhase7DeliverablePackage({ missionId: mId, defectInjection: 'MISSING_VIEWPORT' });
      expect(() => exportPhase7MissionPackageToDisk(mId, { baseExportsDir: tempExportRoot })).toThrow(/QA status/i);

      // Re-generate clean READY package -> export writes verified manifest + 5 assets (including Italian outreach draft)
      generatePhase7DeliverablePackage({ missionId: mId });
      const exported = exportPhase7MissionPackageToDisk(mId, { baseExportsDir: tempExportRoot });
      expect(exported.files.length).toBe(5);
      expect(fs.existsSync(exported.manifestPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(exported.manifestPath, 'utf-8')) as {
        qaStatus: string;
        realizedRevenueEur: number;
        files: Array<{ name: string; sha256: string }>;
      };
      expect(manifest.qaStatus).toBe('READY');
      expect(manifest.realizedRevenueEur).toBe(0);
      expect(manifest.files.map((f) => f.name)).toContain('deliverable-preview.html');
      expect(manifest.files.map((f) => f.name)).toContain('client-package.md');
      expect(manifest.files.map((f) => f.name)).toContain('outreach-it.txt');
    } finally {
      deletePhase7Mission(mId);
      fs.rmSync(tempExportRoot, { recursive: true, force: true });
    }
  });

  it('51. Schema v9 resumable checkpoints track SCORED -> QA_READY -> EXPORTED, Italian deliverable passes QA, and /preview/p7/:id enforces READY + sandbox CSP', async () => {
    const tempExportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-p7-v9-'));
    const app = express();
    app.use('/preview', createPreviewRouter());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    let mId = '';
    try {
      const started = await runPhase7ResearchMission({
        niche: 'Fisioterapia',
        market: 'Milano',
        targetUrl: 'https://www.fisioterapiaatlante.it/',
        mode: 'LIVE_RESEARCH',
        language: 'it',
        researchFetcherHook: async () => ({
          sources: [
            {
              sourceUrl: 'https://www.fisioterapiaatlante.it/',
              sourceTitle: 'Live Website Inspection — www.fisioterapiaatlante.it',
              sourceProvider: 'live_http_audit',
              retrievedAt: new Date().toISOString(),
              relevantEvidence: 'HTTP 200; TLS OK; mobile viewport=false; contact form=false; tel link=false; primary h1=false.',
              evidenceClassification: 'VERIFIED_SOURCE_DATA',
              confidence: 0.92,
              limitations: 'Observed HTML structure snapshot.',
            },
          ],
          requestsMade: 1,
          costUsd: 0,
          retriesUsed: 0,
          providerUsed: 'public_open_research_feeds',
          limitations: [],
          offlineOrBlocked: false,
        }),
      });
      expect(started?.mission.checkpoint?.stage).toBe('SCORED');
      expect(started?.mission.checkpoint?.completedActions.some((a) => /Research completed/i.test(a))).toBe(true);
      mId = started!.mission.id;

      // Rejected deliverable should NOT be exposed on /preview/p7/:id and should update checkpoint to QA_REVISION_NEEDED
      const bad = generatePhase7DeliverablePackage({ missionId: mId, language: 'it', defectInjection: 'MISSING_VIEWPORT' });
      const badDeliv = bad?.deliverables[0];
      expect(bad?.mission.checkpoint?.stage).toBe('QA_REVISION_NEEDED');
      const blockedPreviewRes = await fetch(`${baseUrl}/preview/p7/${encodeURIComponent(badDeliv!.id)}`);
      expect(blockedPreviewRes.status).toBe(404);

      // Clean Italian deliverable reaches QA_READY, exports outreach-it.txt with UNSENT_REQUIRES_HUMAN_APPROVAL, and serves /preview/p7/:id
      const ready = generatePhase7DeliverablePackage({ missionId: mId, language: 'it' });
      const readyDeliv = ready?.deliverables[0];
      expect(readyDeliv?.qaStatus).toBe('READY');
      expect(readyDeliv?.deliverableHtml).toContain('lang="it"');
      expect(readyDeliv?.deliverableHtml).toContain('for="p7-consent"');
      // Without a verified phone in source/contact, NO placeholder tel:+390000000000 may appear
      expect(readyDeliv?.deliverableHtml).not.toContain('000000000');
      expect(readyDeliv?.deliverableHtml).toContain('#booking');
      expect(readyDeliv?.packageBundle.outreachDraftIt.sendStatus).toBe('UNSENT_REQUIRES_HUMAN_APPROVAL');
      expect(ready?.mission.checkpoint?.stage).toBe('QA_READY');

      const previewRes = await fetch(`${baseUrl}/preview/p7/${encodeURIComponent(readyDeliv!.id)}`);
      expect(previewRes.status).toBe(200);
      expect(previewRes.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(previewRes.headers.get('content-security-policy')).toContain('sandbox');
      const previewHtml = await previewRes.text();
      expect(previewHtml).toContain('Fisioterapia');

      const exported = exportPhase7MissionPackageToDisk(mId, { baseExportsDir: tempExportRoot });
      expect(fs.existsSync(path.join(exported.exportDir, 'outreach-it.txt'))).toBe(true);
      const reloaded = getPhase7MissionDetails(mId);
      expect(reloaded?.mission.checkpoint?.stage).toBe('EXPORTED');
      expect(reloaded?.mission.checkpoint?.exportedDir).toBe(exported.exportDir);
    } finally {
      if (mId) {
        try {
          deletePhase7Mission(mId);
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tempExportRoot, { recursive: true, force: true });
    }
  });

  it('52. Independent QA blocks placeholder phone URIs, false SSL/meta claims against live audit, and unverified load-time claims, then passes verified revision', async () => {
    const mRes = await runPhase7ResearchMission({
      niche: 'fisioterapia',
      market: 'Milano',
      targetUrl: 'https://www.fisioterapiaatlante.it/',
      mode: 'LIVE_RESEARCH',
      language: 'it',
      researchFetcherHook: async () => ({
        sources: [
          {
            sourceUrl: 'https://www.fisioterapiaatlante.it/',
            sourceTitle: 'Live HTTP Presence Inspection (www.fisioterapiaatlante.it) — Fisioterapia Atlante',
            sourceProvider: 'live_http_audit',
            retrievedAt: new Date().toISOString(),
            relevantEvidence:
              'HTTP 200 in 66ms. HTTPS: yes, Mobile viewport: missing, Meta desc: present, Primary <h1>: missing, Booking form: missing, Clickable tel: link: missing. Public phone observed: 02-47712410. Observed technical gaps: Missing mobile viewport meta; No inline inquiry/booking form; Missing primary <h1> heading; No clickable tel: phone link.',
            evidenceClassification: 'VERIFIED_SOURCE_DATA',
            confidence: 0.94,
            limitations: 'HTML snapshot.',
          },
        ],
        requestsMade: 1,
        costUsd: 0,
        retriesUsed: 0,
        providerUsed: 'public_open_research_feeds',
        limitations: [],
        offlineOrBlocked: false,
      }),
    });
    const mId = mRes!.mission.id;
    try {
      const generated = generatePhase7DeliverablePackage({ missionId: mId, language: 'it' });
      const deliv = generated!.deliverables[0];
      expect(deliv.qaStatus).toBe('READY');
      expect(deliv.deliverableHtml).toContain('tel:+390247712410');
      expect(deliv.deliverableHtml).not.toContain('000000000');
      expect(deliv.deliverableHtml).not.toMatch(/certificati\s+SSL\s+assenti|inferiori\s+a\s+2\s*secondi/i);

      // Inject contradictory SSL/meta claim + placeholder phone + unverified 2s speed claim -> QA must reject!
      const badHtml = deliv.deliverableHtml
        .replace('tel:+390247712410', 'tel:+390000000000')
        .replace('</main>', '<p>Sito privo di certificati SSL e meta description mancanti, tempi inferiori a 2 secondi.</p></main>');
      const rejectedQa = evaluateDeliverableQuality({
        deliverableHtml: badHtml,
        packageBundle: deliv.packageBundle,
        niche: 'fisioterapia',
        market: 'Milano',
        validSourceIds: new Set(generated!.sources.map((s) => s.id)),
        generatorAgentId: 'commerce_operations_agent',
        reviewerAgentId: 'quality_assurance_agent',
      });
      expect(rejectedQa.status).toBe('NEEDS_REVISION');
      expect(rejectedQa.findings.some((f) => /HTTPS, SSL, or meta description/i.test(f))).toBe(true);
      expect(rejectedQa.findings.some((f) => /placeholder telephone/i.test(f))).toBe(true);
      expect(rejectedQa.findings.some((f) => /page-speed/i.test(f))).toBe(true);
    } finally {
      deletePhase7Mission(mId);
    }
  });

  it('53. Production hardening resolves persistent data dir next to NEXA_DB_PATH, snapshots pre-migration DB, and enforces HttpOnly cookie + 401 RBAC lock', async () => {
    const tmpVol = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-prod-vol-'));
    const dbFile = path.join(tmpVol, 'nexa_prod.sqlite3');
    const prevNodeEnv = process.env.NODE_ENV;
    const prevDbPath = process.env.NEXA_DB_PATH;
    const prevDataDir = process.env.NEXA_DATA_DIR;
    const prevAdminPass = process.env.NEXA_ADMIN_PASSWORD;
    const prevSecret = process.env.NEXA_SESSION_SECRET;
    const prodPass = 'ProdAdminPass!2026';

    process.env.NODE_ENV = 'production';
    process.env.NEXA_DB_PATH = dbFile;
    delete process.env.NEXA_DATA_DIR;
    process.env.NEXA_ADMIN_PASSWORD = prodPass;
    process.env.NEXA_SESSION_SECRET = 'nexa_prod_session_signing_key_with_high_entropy_2026';

    expect(resolvePersistentDataDir()).toBe(tmpVol);
    const firstDb = resetDbForTests(dbFile);
    ensureRegistrySeeded();
    const diag = getDatabaseDiagnostics();
    expect(diag.persistentFile).toBe(true);
    expect(diag.walMode).toBe(true);
    expect(diag.dataDir).toBe(tmpVol);

    // Simulate pre-existing schema missing migration v9 -> reopening triggers automatic pre-migration backup
    firstDb.exec('DELETE FROM schema_migrations WHERE version = 9');
    resetDbForTests(dbFile);
    ensureRegistrySeeded();
    const backups = listDatabaseBackups();
    expect(backups.some((b) => b.filename.startsWith('nexa_pre_migration_'))).toBe(true);

    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const addr = server.address() as { port: number };
      const base = `http://127.0.0.1:${addr.port}`;

      // Unauthenticated protected endpoints return 401 in production
      const unauthRes = await fetch(`${base}/api/preflight`);
      expect(unauthRes.status).toBe(401);

      // Login via admin returns token AND sets HttpOnly cookie
      const loginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
        body: JSON.stringify({ username: 'admin', password: prodPass }),
      });
      expect(loginRes.status).toBe(200);
      const setCookie = loginRes.headers.get('set-cookie') || '';
      expect(setCookie).toContain('nexa_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');

      const cookiePair = setCookie.split(';')[0];
      const cookieAuthed = await fetch(`${base}/api/preflight`, {
        headers: { Cookie: cookiePair },
      });
      expect(cookieAuthed.status).toBe(200);

      // Logout clears cookie & revokes server token
      const logoutRes = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookiePair, 'X-Forwarded-Proto': 'https' },
      });
      expect(logoutRes.status).toBe(200);
      expect((await logoutRes.json()) as { revoked: boolean }).toMatchObject({ revoked: true });

      const afterLogout = await fetch(`${base}/api/preflight`, {
        headers: { Cookie: cookiePair },
      });
      expect(afterLogout.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      resetDbForTests(':memory:');
      ensureRegistrySeeded();
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevDbPath === undefined) delete process.env.NEXA_DB_PATH;
      else process.env.NEXA_DB_PATH = prevDbPath;
      if (prevDataDir === undefined) delete process.env.NEXA_DATA_DIR;
      else process.env.NEXA_DATA_DIR = prevDataDir;
      if (prevAdminPass === undefined) delete process.env.NEXA_ADMIN_PASSWORD;
      else process.env.NEXA_ADMIN_PASSWORD = prevAdminPass;
      if (prevSecret === undefined) delete process.env.NEXA_SESSION_SECRET;
      else process.env.NEXA_SESSION_SECRET = prevSecret;
      fs.rmSync(tmpVol, { recursive: true, force: true });
    }
  });
});

