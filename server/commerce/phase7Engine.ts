import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { getDb, nowIso, recordAuditEvent, resolvePersistentDataDir } from '../db/database.ts';
import { getAgentById } from '../agents/agentRegistry.ts';
import { routeInference } from '../ai/router.ts';
import { testProviderConnectivity } from '../ai/gateway.ts';
import { listProviders } from '../ai/registry.ts';
import { buildCommercialTermsBreakdown, validatePublicHttpUrl, assertResolvedHostPublic } from './commerceEngine.ts';
import type { AgentId, ProviderId } from '../types/nexa.ts';

export const PHASE7_SAFETY_LOCKS = {
  externalOutreachMode: 'READ_ONLY_DISABLED' as const,
  clientEmails: 'DISABLED' as const,
  whatsappMessages: 'DISABLED' as const,
  smsMessages: 'DISABLED' as const,
  websitePublishing: 'DISABLED' as const,
  adsPublishing: 'DISABLED' as const,
  realPayments: 'DISABLED' as const,
  customerAccountCreation: 'DISABLED' as const,
  trading: 'DISABLED' as const,
  purchases: 'DISABLED' as const,
  usesProductionCustomerDataForTests: false,
};

export type EpistemicClassification =
  | 'VERIFIED_SOURCE_DATA'
  | 'AI_INFERENCE'
  | 'UNVERIFIED_CLAIM'
  | 'SIMULATED_DATA';

export type Phase7ResearchMode = 'LIVE_RESEARCH' | 'FIXTURE_SIMULATION';

export type Phase7ResearchStatus =
  | 'VERIFIED_LIVE'
  | 'PARTIAL_LIVE'
  | 'BLOCKED'
  | 'UNVERIFIED'
  | 'SIMULATED_FIXTURE';

export type Phase7MissionStatus =
  | 'CREATED'
  | 'RESEARCHED'
  | 'SCORED'
  | 'VALIDATED'
  | 'QA_REJECTED'
  | 'READY_FOR_REVIEW'
  | 'BLOCKED'
  | 'FAILED';

export interface Phase7SourceInput {
  sourceUrl?: string | null;
  sourceTitle: string;
  sourceProvider: string;
  retrievedAt: string;
  relevantEvidence: string;
  evidenceClassification: EpistemicClassification;
  confidence: number;
  limitations: string;
}

export interface Phase7SourceRecord extends Phase7SourceInput {
  id: string;
  missionId: string;
  isValid: boolean;
}

export interface OpportunityCriterionScore {
  key:
    | 'demandEvidence'
    | 'customerPain'
    | 'competition'
    | 'potentialValue'
    | 'implementationDifficulty'
    | 'cost'
    | 'risk'
    | 'timeToDeliver'
    | 'confidenceInEvidence';
  label: string;
  weight: number;
  score: number;
  rationale: string;
}

export interface Phase7OpportunityCandidate {
  id: string;
  missionId: string;
  title: string;
  customerSegment: string;
  serviceCategory: string;
  problemStatement: string;
  proposedSolution: string;
  valueThesis: string;
  criteria: OpportunityCriterionScore[];
  totalScore: number;
  evidenceConfidence: number;
  supportingSourceIds: string[];
  assumptions: string[];
  risks: string[];
  estimatedEffortHours: number;
  estimatedOperatingCostEur: number;
  isSelected: boolean;
  createdAt: string;
}

export interface QaCriterionResult {
  criterion:
    | 'accuracy'
    | 'completeness'
    | 'designQuality'
    | 'functionality'
    | 'customerRelevance'
    | 'usability'
    | 'mobileResponsiveness'
    | 'technicalConsistency'
    | 'unsupportedClaims'
    | 'securityRisks';
  label: string;
  score: number;
  maxScore: number;
  passed: boolean;
  finding: string;
}

export interface DeliverableQaReport {
  reviewerAgentId: AgentId;
  generatorAgentId: AgentId;
  independentReviewVerified: boolean;
  status: 'READY' | 'NEEDS_REVISION' | 'BLOCKED';
  totalScore: number;
  findings: string[];
  blockingIssues: string[];
  criteria: QaCriterionResult[];
  reviewedAt: string;
}

export interface ClientPackageBundle {
  environmentPolicy: typeof PHASE7_SAFETY_LOCKS;
  isSimulatedFixture: boolean;
  opportunityReport: {
    opportunityId: string;
    title: string;
    customerSegment: string;
    serviceCategory: string;
    totalScore: number;
    evidenceConfidence: number;
    criteriaBreakdown: OpportunityCriterionScore[];
  };
  researchEvidence: Array<{
    id: string;
    sourceTitle: string;
    sourceUrl: string | null;
    sourceProvider: string;
    retrievedAt: string;
    relevantEvidence: string;
    evidenceClassification: EpistemicClassification;
    confidence: number;
    limitations: string;
  }>;
  problemStatement: string;
  proposedSolution: string;
  valueThesis: string;
  websiteOrProductPreview: {
    previewType: 'RESPONSIVE_HTML5_CONCEPT';
    publishedExternally: false;
    title: string;
    htmlByteLength: number;
  };
  marketingStrategy: {
    positioningStatement: string;
    outboundAutomationEnabled: false;
    recommendedHumanReviewedChannels: string[];
    objectionHandlingNotes: string[];
  };
  scopeOfWork: {
    includedDeliverables: string[];
    explicitExclusions: string[];
    estimatedEffortHours: number;
    estimatedInitialOperatingCostEur: number;
  };
  estimatedDeliveryTimeline: Array<{
    phase: string;
    durationDays: string;
    output: string;
  }>;
  pricingProposal: {
    label: string;
    setupPriceEurEstimate: number;
    optionalMonthlySupportEurEstimate: number;
    realizedRevenueEur: 0;
    commercialTerms: ReturnType<typeof buildCommercialTermsBreakdown>;
  };
  risksAndAssumptions: {
    assumptions: string[];
    risks: string[];
  };
  outreachDraftIt: {
    sendStatus: 'UNSENT_REQUIRES_HUMAN_APPROVAL';
    targetProspectUrl: string | null;
    subject: string;
    message: string;
  };
  finalQualityReview: DeliverableQaReport | null;
}

export interface VerifiedTargetContact {
  clinicName?: string | null;
  phone?: string | null;
  address?: string | null;
  hours?: string | null;
}

export interface ResumableMissionCheckpoint {
  objective: string;
  stage: 'CREATED' | 'RESEARCHED' | 'SCORED' | 'DELIVERABLE_GENERATED' | 'QA_READY' | 'QA_REVISION_NEEDED' | 'EXPORTED' | 'BLOCKED' | 'FAILED';
  completedActions: string[];
  failedActions: string[];
  nextExecutableAction: string;
  exportedDir: string | null;
  updatedAt: string;
}

export interface Phase7ResearchFetcherResult {
  sources: Phase7SourceInput[];
  requestsMade: number;
  costUsd: number;
  retriesUsed: number;
  providerUsed: string;
  limitations: string[];
  offlineOrBlocked?: boolean;
  quotaExhausted?: boolean;
}

export interface RunPhase7ResearchInput {
  niche: string;
  market: string;
  targetUrl?: string | null;
  mode?: Phase7ResearchMode;
  language?: 'en' | 'it' | 'ar' | 'fr';
  maxCostUsd?: number;
  maxRequests?: number;
  maxRetries?: number;
  timeoutMs?: number;
  allowFixtureFallback?: boolean;
  createdBy?: string;
  dbOverride?: DatabaseSync;
  researchFetcherHook?: (ctx: {
    niche: string;
    market: string;
    targetUrl: string | null;
    maxRequests: number;
    maxRetries: number;
    timeoutMs: number;
  }) => Promise<Phase7ResearchFetcherResult>;
}

const activePhase7MissionLocks = new Set<string>();

function resolveTargetDb(dbOverride?: DatabaseSync): DatabaseSync {
  return dbOverride || getDb();
}

function updateMissionCheckpoint(
  db: DatabaseSync,
  missionId: string,
  patch: Partial<ResumableMissionCheckpoint> & { addCompleted?: string; addFailed?: string }
): ResumableMissionCheckpoint | null {
  try {
    const row = db
      .prepare('SELECT niche, market, target_url, checkpoint_json FROM phase7_validation_missions WHERE id = ?')
      .get(missionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let current: ResumableMissionCheckpoint = {
      objective: `Research, score, validate, and prepare client-ready deliverable for ${String(row.niche)} in ${String(row.market)}${row.target_url ? ` (${String(row.target_url)})` : ''}`,
      stage: 'CREATED',
      completedActions: [],
      failedActions: [],
      nextExecutableAction: 'Inspect research evidence and score opportunities',
      exportedDir: null,
      updatedAt: nowIso(),
    };
    if (row.checkpoint_json) {
      try {
        current = { ...current, ...(JSON.parse(String(row.checkpoint_json)) as Partial<ResumableMissionCheckpoint>) };
      } catch {
        // fallback cleanly
      }
    }
    if (patch.addCompleted && !current.completedActions.includes(patch.addCompleted)) {
      current.completedActions.push(patch.addCompleted);
    }
    if (patch.addFailed && !current.failedActions.includes(patch.addFailed)) {
      current.failedActions.push(patch.addFailed);
    }
    const next: ResumableMissionCheckpoint = {
      ...current,
      ...(patch.stage ? { stage: patch.stage } : {}),
      ...(patch.nextExecutableAction ? { nextExecutableAction: patch.nextExecutableAction } : {}),
      ...(patch.exportedDir !== undefined ? { exportedDir: patch.exportedDir } : {}),
      updatedAt: nowIso(),
    };
    db.prepare('UPDATE phase7_validation_missions SET checkpoint_json = ? WHERE id = ?').run(JSON.stringify(next), missionId);
    return next;
  } catch {
    return null;
  }
}

export function getReadyPhase7DeliverableHtml(deliverableId: string, dbOverride?: DatabaseSync): string | null {
  const db = resolveTargetDb(dbOverride);
  const row = db
    .prepare("SELECT deliverable_html FROM phase7_deliverable_packages WHERE id = ? AND qa_status = 'READY'")
    .get(deliverableId) as { deliverable_html?: string } | undefined;
  return row?.deliverable_html ? String(row.deliverable_html) : null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizeProviderCostCaveat(providerId: string): string {
  return `Provider ${providerId}: usage subject to upstream account tier limits & quotas; tracked locally against mission cost cap (zero unverified "unlimited free" claim).`;
}

export async function getPhase7CapabilityMatrix() {
  const providers = listProviders().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    configured: p.configured,
    availabilityStatus: p.availabilityStatus || (p.configured ? 'CONFIGURED' : 'UNCONFIGURED'),
    isPaidByDefault: p.isPaidByDefault,
    lastVerifiedAt: p.lastVerifiedAt,
    lastError: p.lastError,
    usageNote: normalizeProviderCostCaveat(p.id),
  }));

  return {
    safetyLocks: PHASE7_SAFETY_LOCKS,
    researchFeeds: [
      { id: 'openalex', name: 'OpenAlex Public Scholarly Works API', requiresKey: false, externalSideEffects: false },
      { id: 'wikipedia', name: 'Wikipedia Action Search API', requiresKey: false, externalSideEffects: false },
      { id: 'osm_nominatim', name: 'OpenStreetMap Nominatim & Photon Public Directory', requiresKey: false, externalSideEffects: false },
      { id: 'live_http_audit', name: 'SSRF-Protected Public Website Presence Auditor', requiresKey: false, externalSideEffects: false },
    ],
    agents: {
      researcher: getAgentById('research_agent').id,
      scorer: getAgentById('business_intelligence_agent').id,
      generator: getAgentById('commerce_operations_agent').id,
      independentQa: getAgentById('quality_assurance_agent').id,
      verifier: getAgentById('fact_verification_agent').id,
    },
    providers,
  };
}

export async function probeProviderAuthSafe(providerId: ProviderId) {
  return testProviderConnectivity(providerId, { runInferenceProbe: false, paidInferenceApproved: false });
}

export function validatePhase7SourceRecord(src: Phase7SourceInput): { valid: boolean; reason?: string } {
  const title = (src.sourceTitle || '').trim();
  const evidence = (src.relevantEvidence || '').trim();
  if (title.length < 4) return { valid: false, reason: 'Invalid source title (<4 chars).' };
  if (evidence.length < 10) return { valid: false, reason: 'Insufficient relevant evidence (<10 chars).' };
  if (!Number.isFinite(src.confidence) || src.confidence < 0 || src.confidence > 1) {
    return { valid: false, reason: 'Source confidence out of bounds [0,1].' };
  }
  const parsedTime = Date.parse(src.retrievedAt);
  if (!Number.isFinite(parsedTime)) {
    return { valid: false, reason: 'Invalid retrieval timestamp.' };
  }
  if (/<script[\s>]|javascript:/i.test(`${title} ${evidence}`)) {
    return { valid: false, reason: 'Rejected source containing unsafe script payload.' };
  }
  if (src.sourceUrl) {
    try {
      validatePublicHttpUrl(src.sourceUrl);
    } catch (err) {
      return { valid: false, reason: err instanceof Error ? err.message : 'Invalid source URL.' };
    }
  } else if (src.evidenceClassification === 'VERIFIED_SOURCE_DATA') {
    return { valid: false, reason: 'VERIFIED_SOURCE_DATA requires a valid public source URL.' };
  }
  return { valid: true };
}

async function fetchJsonWithBudget(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${new URL(url).hostname}`);
  }
  return resp.json();
}

async function performLivePublicResearch(params: {
  niche: string;
  market: string;
  targetUrl: string | null;
  maxRequests: number;
  maxRetries: number;
  timeoutMs: number;
}): Promise<Phase7ResearchFetcherResult> {
  const sources: Phase7SourceInput[] = [];
  const limitations: string[] = [];
  let requestsMade = 0;
  let retriesUsed = 0;
  let reachSuccess = 0;
  let reachFailures = 0;

  const canSpendRequest = () => requestsMade < params.maxRequests;

  const runWithRetry = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
      if (!canSpendRequest()) {
        limitations.push(`Request budget exhausted (${params.maxRequests} max requests).`);
        return null;
      }
      requestsMade += 1;
      try {
        return await fn();
      } catch (err) {
        if (attempt < params.maxRetries) {
          retriesUsed += 1;
          continue;
        }
        reachFailures += 1;
        limitations.push(err instanceof Error ? err.message : 'Network research error');
        return null;
      }
    }
    return null;
  };

  // 1. OpenStreetMap Nominatim real local business segment signal (with single-keyword fallback)
  const fetchOsmMatches = async (queryText: string) =>
    (await runWithRetry(() =>
      fetchJsonWithBudget(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(queryText)}&format=jsonv2&extratags=1&limit=4`,
        { 'User-Agent': 'NEXA-PHASE7-INTELLIGENCE/1.0' },
        params.timeoutMs
      )
    )) as Array<{ osm_type?: string; osm_id?: number; name?: string; display_name?: string; extratags?: Record<string, string> }> | null;

  let osmData = await fetchOsmMatches(`${params.niche} ${params.market}`);
  if (osmData && osmData.length === 0 && params.niche.trim().includes(' ') && canSpendRequest()) {
    const primaryKeyword = params.niche.trim().split(/\s+/)[0];
    if (primaryKeyword.length >= 3) {
      osmData = await fetchOsmMatches(`${primaryKeyword} ${params.market}`);
    }
  }

  if (osmData && Array.isArray(osmData)) {
    reachSuccess += 1;
    const retrievedAt = nowIso();
    for (const item of osmData.slice(0, 3)) {
      const displayName = (item.name || item.display_name || '').trim();
      if (!displayName || !item.osm_type || !item.osm_id) continue;
      const tags = item.extratags || {};
      const websiteVal = tags.website || tags['contact:website'] || tags.url || null;
      const hasWebsite = Boolean(websiteVal);
      const hasPhone = Boolean(tags.phone || tags['contact:phone']);
      sources.push({
        sourceUrl: `https://www.openstreetmap.org/${item.osm_type}/${item.osm_id}`,
        sourceTitle: `OpenStreetMap Business Record: ${displayName.slice(0, 90)}`,
        sourceProvider: 'osm_nominatim',
        retrievedAt,
        relevantEvidence: `Observed public directory listing for "${displayName}" in ${params.market}. Website tag present: ${hasWebsite ? `yes (${websiteVal})` : 'no'}; Phone metadata present: ${hasPhone ? 'yes' : 'no'}.`,
        evidenceClassification: 'VERIFIED_SOURCE_DATA',
        confidence: 0.85,
        limitations: 'OpenStreetMap relies on crowd-maintained metadata; website omission does not guarantee the business lacks an unlisted site.',
      });
    }
    if (osmData.length === 0) {
      limitations.push(`OpenStreetMap returned 0 directory matches for "${params.niche} ${params.market}".`);
    }
  }

  // 2. OpenAlex scholarly/industry workflow & digital adoption context
  const oaUrl = `https://api.openalex.org/works?search=${encodeURIComponent(
    `${params.niche} small business digital website booking`
  )}&per-page=2&select=id,title,publication_date,primary_location`;
  const oaData = (await runWithRetry(() =>
    fetchJsonWithBudget(oaUrl, { 'User-Agent': 'NEXA-PHASE7-INTELLIGENCE/1.0' }, params.timeoutMs)
  )) as { results?: Array<{ id?: string; title?: string; publication_date?: string; primary_location?: { landing_page_url?: string } }> } | null;

  if (oaData && Array.isArray(oaData.results)) {
    reachSuccess += 1;
    const retrievedAt = nowIso();
    for (const w of oaData.results.slice(0, 2)) {
      if (!w.title) continue;
      const url = w.primary_location?.landing_page_url || w.id || 'https://openalex.org';
      sources.push({
        sourceUrl: url,
        sourceTitle: `OpenAlex Study: ${w.title.slice(0, 120)}`,
        sourceProvider: 'openalex',
        retrievedAt,
        relevantEvidence: `Indexed industry/academic work (${w.publication_date || 'undated'}) matching domain search "${params.niche}" and digital service adoption.`,
        evidenceClassification: 'VERIFIED_SOURCE_DATA',
        confidence: 0.78,
        limitations: 'Broad academic metadata; does not directly measure local customer demand inside a single neighborhood.',
      });
    }
  }

  // 3. Wikipedia domain baseline verification
  const wpUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    params.niche
  )}&format=json&srlimit=2`;
  const wpData = (await runWithRetry(() =>
    fetchJsonWithBudget(wpUrl, { 'User-Agent': 'NEXA-PHASE7-INTELLIGENCE/1.0' }, params.timeoutMs)
  )) as { query?: { search?: Array<{ pageid: number; title: string; snippet: string }> } } | null;

  if (wpData?.query?.search) {
    reachSuccess += 1;
    const retrievedAt = nowIso();
    for (const s of wpData.query.search.slice(0, 1)) {
      const clean = s.snippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      sources.push({
        sourceUrl: `https://en.wikipedia.org/?curid=${s.pageid}`,
        sourceTitle: `Wikipedia Reference: ${s.title}`,
        sourceProvider: 'wikipedia',
        retrievedAt,
        relevantEvidence: clean || `Encyclopedic industry context for ${s.title}.`,
        evidenceClassification: 'VERIFIED_SOURCE_DATA',
        confidence: 0.72,
        limitations: 'General sector overview only; not empirical pricing or revenue proof.',
      });
    }
  }

  // 4. Optional SSRF-safe live audit of a real business public URL
  if (params.targetUrl && canSpendRequest()) {
    const parsed = validatePublicHttpUrl(params.targetUrl);
    const audited = await runWithRetry(async () => {
      await assertResolvedHostPublic(parsed);
      const t0 = Date.now();
      const resp = await fetch(parsed.toString(), {
        headers: { 'User-Agent': 'NEXA-PHASE7-AUDIT/1.0', Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(params.timeoutMs),
      });
      await assertResolvedHostPublic(validatePublicHttpUrl(resp.url || parsed.toString()));
      const latency = Date.now() - t0;
      const html = (await resp.text()).slice(0, 120000);
      return { status: resp.status, latency, html, finalUrl: resp.url || parsed.toString() };
    });

    if (audited) {
      reachSuccess += 1;
      const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(audited.html);
      const hasMetaDesc = /<meta[^>]+name=["']description["']/i.test(audited.html);
      const hasForm = /<form[\s>]/i.test(audited.html);
      const hasH1 = /<h1[\s>]/i.test(audited.html);
      const hasTelLink = /href=["']tel:/i.test(audited.html);
      const hasSsl = audited.finalUrl.startsWith('https://');
      const titleMatch = audited.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
      const cleanTitle = titleMatch.replace(/\s+/g, ' ').trim().slice(0, 90);
      const strippedText = audited.html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const telHrefMatch = audited.html.match(/href=["']tel:([^"']+)["']/i)?.[1]?.trim() || '';
      const textPhoneMatch = strippedText.match(/(?:telefono|tel\.?|chiama[^0-9]{0,24})[:\s]*((?:\+39[\s.-]*)?0\d{1,3}[\s.-]*\d{5,8})/i)?.[1]?.trim() || '';
      const observedPhone = telHrefMatch || textPhoneMatch;
      const gaps: string[] = [];
      if (audited.status >= 400) gaps.push(`HTTP error ${audited.status}`);
      if (!hasSsl) gaps.push('Missing HTTPS');
      if (!hasViewport) gaps.push('Missing mobile viewport meta');
      if (!hasMetaDesc) gaps.push('Missing meta description');
      if (!hasForm) gaps.push('No inline inquiry/booking form');
      if (!hasH1) gaps.push('Missing primary <h1> heading');
      if (!hasTelLink) gaps.push('No clickable tel: phone link');

      sources.push({
        sourceUrl: audited.finalUrl,
        sourceTitle: `Live HTTP Presence Inspection (${parsed.hostname})${cleanTitle ? ` — ${cleanTitle}` : ''}`,
        sourceProvider: 'live_http_audit',
        retrievedAt: nowIso(),
        relevantEvidence: `HTTP ${audited.status} in ${audited.latency}ms. HTTPS: ${hasSsl ? 'yes' : 'no'}, Mobile viewport: ${hasViewport ? 'present' : 'missing'}, Meta desc: ${hasMetaDesc ? 'present' : 'missing'}, Primary <h1>: ${hasH1 ? 'present' : 'missing'}, Booking form: ${hasForm ? 'present' : 'missing'}, Clickable tel: link: ${hasTelLink ? 'present' : 'missing'}.${observedPhone ? ` Public phone observed: ${observedPhone}.` : ''} Observed technical gaps: ${gaps.length > 0 ? gaps.join('; ') : 'None critical'}.`,
        evidenceClassification: 'VERIFIED_SOURCE_DATA',
        confidence: audited.status < 400 ? 0.94 : 0.88,
        limitations: 'Single-page HTML snapshot only; JavaScript-rendered widgets or third-party external booking links require manual browser check.',
      });
    }
  }

  return {
    sources,
    requestsMade,
    costUsd: 0,
    retriesUsed,
    providerUsed: 'public_open_research_feeds',
    limitations,
    offlineOrBlocked: reachSuccess === 0 && reachFailures > 0,
    quotaExhausted: requestsMade >= params.maxRequests && sources.length === 0,
  };
}

function buildFixtureSimulationSources(niche: string, market: string): Phase7SourceInput[] {
  const ts = nowIso();
  return [
    {
      sourceUrl: null,
      sourceTitle: `[SIMULATED FIXTURE] Local ${niche} Digital Gap Pattern (${market})`,
      sourceProvider: 'fixture',
      retrievedAt: ts,
      relevantEvidence: `[SIMULATED DATA — NOT LIVE VERIFICATION] Test fixture simulating a local ${niche} service business in ${market} lacking mobile viewport responsiveness and self-service appointment capture.`,
      evidenceClassification: 'SIMULATED_DATA',
      confidence: 0.35,
      limitations: 'Simulated test fixture only. Does not reflect verified live businesses, real web traffic, or validated commercial willingness to pay.',
    },
    {
      sourceUrl: null,
      sourceTitle: `[SIMULATED FIXTURE] Small Service Workflow Friction Hypothesis`,
      sourceProvider: 'fixture',
      retrievedAt: ts,
      relevantEvidence: `[SIMULATED DATA — NOT LIVE VERIFICATION] Hypothesis that clear service pricing, contact forms, and mobile layout reduce missed inbound inquiries for ${niche}.`,
      evidenceClassification: 'UNVERIFIED_CLAIM',
      confidence: 0.25,
      limitations: 'Unverified hypothesis pending real business website audit or direct customer interview.',
    },
  ];
}

export async function runPhase7ResearchMission(input: RunPhase7ResearchInput) {
  const niche = (input.niche || '').trim();
  const market = (input.market || '').trim();
  if (niche.length < 3) throw new Error('Niche / customer segment must contain at least 3 characters.');
  if (market.length < 2) throw new Error('Target city or market must contain at least 2 characters.');

  const maxCostUsd = Number(input.maxCostUsd ?? 0.25);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0 || maxCostUsd > 20) {
    throw new Error('maxCostUsd must be between 0 and 20 USD.');
  }
  const maxRequests = Math.min(Math.max(Number(input.maxRequests ?? 8), 1), 15);
  const maxRetries = Math.min(Math.max(Number(input.maxRetries ?? 1), 0), 3);
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs ?? 6000), 50), 30000);
  const mode: Phase7ResearchMode = input.mode || 'LIVE_RESEARCH';
  const targetUrl = input.targetUrl?.trim() ? validatePublicHttpUrl(input.targetUrl.trim()).toString() : null;

  const lockKey = `${niche.toLowerCase()}::${market.toLowerCase()}::${mode}`;
  if (activePhase7MissionLocks.has(lockKey)) {
    throw new Error(`A Phase 7 research mission is already running for '${niche} (${market})'.`);
  }
  activePhase7MissionLocks.add(lockKey);

  const db = resolveTargetDb(input.dbOverride);
  const missionId = `p7_msn_${crypto.randomUUID().slice(0, 10)}`;
  const ts = nowIso();
  const actor = input.createdBy || 'operator';

  try {
    db.prepare(
      `INSERT INTO phase7_validation_missions
       (id, niche, market, target_url, mode, research_status, status, max_cost_usd, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'UNVERIFIED', 'CREATED', ?, ?, ?, ?)`
    ).run(missionId, niche, market, targetUrl, mode, maxCostUsd, actor, ts, ts);

    let fetcherRes: Phase7ResearchFetcherResult;
    if (mode === 'FIXTURE_SIMULATION') {
      fetcherRes = {
        sources: buildFixtureSimulationSources(niche, market),
        requestsMade: 0,
        costUsd: 0,
        retriesUsed: 0,
        providerUsed: 'offline_labeled_fixture',
        limitations: ['Executed in explicit FIXTURE_SIMULATION mode — no external market claims are verified.'],
      };
    } else if (input.researchFetcherHook) {
      fetcherRes = await input.researchFetcherHook({
        niche,
        market,
        targetUrl,
        maxRequests,
        maxRetries,
        timeoutMs,
      });
    } else {
      fetcherRes = await performLivePublicResearch({
        niche,
        market,
        targetUrl,
        maxRequests,
        maxRetries,
        timeoutMs,
      });
    }

    // Enforce mission cost ceiling cleanly
    if (fetcherRes.costUsd > maxCostUsd) {
      const errMsg = `Mission cost ceiling exceeded ($${fetcherRes.costUsd.toFixed(4)} > $${maxCostUsd.toFixed(4)} USD cap).`;
      db.prepare(
        `UPDATE phase7_validation_missions
         SET status = 'FAILED', research_status = 'BLOCKED', total_cost_usd = ?, total_requests = ?, retries_used = ?,
             provider_used = ?, limitations_json = ?, error_message = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        fetcherRes.costUsd,
        fetcherRes.requestsMade,
        fetcherRes.retriesUsed,
        fetcherRes.providerUsed,
        JSON.stringify([...fetcherRes.limitations, errMsg]),
        errMsg,
        nowIso(),
        missionId
      );
      recordAuditEvent(actor, 'PHASE7', 'COST_CEILING_EXCEEDED', { missionId, costUsd: fetcherRes.costUsd, maxCostUsd });
      return getPhase7MissionDetails(missionId, db);
    }

    const limitations = [...fetcherRes.limitations];
    let validVerifiedCount = 0;
    let validFixtureCount = 0;
    let rejectedSourcesCount = 0;

    const insSource = db.prepare(
      `INSERT INTO phase7_research_sources
       (id, mission_id, source_url, source_title, source_provider, retrieved_at, relevant_evidence, evidence_classification, confidence, limitations, is_valid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const rawSrc of fetcherRes.sources) {
      const validation = validatePhase7SourceRecord(rawSrc);
      const srcId = `p7_src_${crypto.randomUUID().slice(0, 10)}`;
      if (!validation.valid) {
        rejectedSourcesCount += 1;
        limitations.push(`Excluded invalid source "${rawSrc.sourceTitle || 'unnamed'}": ${validation.reason}`);
        insSource.run(
          srcId,
          missionId,
          rawSrc.sourceUrl || null,
          rawSrc.sourceTitle || 'INVALID_SOURCE',
          rawSrc.sourceProvider || 'unknown',
          rawSrc.retrievedAt || nowIso(),
          rawSrc.relevantEvidence || 'Invalid source payload',
          'UNVERIFIED_CLAIM',
          0,
          validation.reason || 'Validation failed',
          0
        );
        continue;
      }

      if (rawSrc.evidenceClassification === 'VERIFIED_SOURCE_DATA') validVerifiedCount += 1;
      else validFixtureCount += 1;

      insSource.run(
        srcId,
        missionId,
        rawSrc.sourceUrl || null,
        rawSrc.sourceTitle.trim(),
        rawSrc.sourceProvider,
        rawSrc.retrievedAt,
        rawSrc.relevantEvidence.trim(),
        rawSrc.evidenceClassification,
        Number(rawSrc.confidence.toFixed(2)),
        rawSrc.limitations.trim(),
        1
      );
    }

    // Handle offline / blocked fallback cleanly if live sources could not be collected
    if (mode === 'LIVE_RESEARCH' && validVerifiedCount === 0 && input.allowFixtureFallback) {
      limitations.push('Live research providers unavailable or returned zero verified records; appended clearly labeled FIXTURE fallback.');
      for (const f of buildFixtureSimulationSources(niche, market)) {
        insSource.run(
          `p7_src_${crypto.randomUUID().slice(0, 10)}`,
          missionId,
          null,
          f.sourceTitle,
          f.sourceProvider,
          f.retrievedAt,
          f.relevantEvidence,
          f.evidenceClassification,
          f.confidence,
          f.limitations,
          1
        );
        validFixtureCount += 1;
      }
    }

    let researchStatus: Phase7ResearchStatus = 'UNVERIFIED';
    let missionStatus: Phase7MissionStatus = 'RESEARCHED';

    if (mode === 'FIXTURE_SIMULATION' || (validVerifiedCount === 0 && validFixtureCount > 0)) {
      researchStatus = 'SIMULATED_FIXTURE';
    } else if (fetcherRes.offlineOrBlocked && validVerifiedCount === 0) {
      researchStatus = 'BLOCKED';
      missionStatus = 'BLOCKED';
      limitations.push('Live research endpoints offline or unreachable; scoring blocked unless explicit fixture simulation is enabled.');
    } else if (fetcherRes.quotaExhausted && validVerifiedCount === 0) {
      researchStatus = 'BLOCKED';
      missionStatus = 'BLOCKED';
    } else if (validVerifiedCount >= 2 && fetcherRes.limitations.length === 0) {
      researchStatus = 'VERIFIED_LIVE';
    } else if (validVerifiedCount >= 1) {
      researchStatus = 'PARTIAL_LIVE';
    } else {
      researchStatus = 'UNVERIFIED';
      limitations.push('Zero verified external sources found for query; treat any derived conclusions as unverified hypotheses.');
    }

    if (rejectedSourcesCount > 0) {
      limitations.push(`${rejectedSourcesCount} malformed/unsafe source record(s) excluded from scoring.`);
    }

    db.prepare(
      `UPDATE phase7_validation_missions
       SET research_status = ?, status = ?, total_cost_usd = ?, total_requests = ?, retries_used = ?,
           provider_used = ?, limitations_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      researchStatus,
      missionStatus,
      fetcherRes.costUsd,
      fetcherRes.requestsMade,
      fetcherRes.retriesUsed,
      fetcherRes.providerUsed,
      JSON.stringify(limitations),
      nowIso(),
      missionId
    );

    updateMissionCheckpoint(db, missionId, {
      stage: missionStatus === 'BLOCKED' ? 'BLOCKED' : 'RESEARCHED',
      addCompleted: `Research completed (${researchStatus}: ${validVerifiedCount} verified, ${validFixtureCount} fixture sources)`,
      ...(missionStatus === 'BLOCKED' ? { addFailed: 'Live sources unreachable in strict live mode' } : {}),
      nextExecutableAction:
        missionStatus === 'BLOCKED'
          ? 'Restore network/API access or explicitly enable FIXTURE_SIMULATION'
          : 'Score candidate opportunities across 9 weighted criteria',
    });

    recordAuditEvent(actor, 'PHASE7', 'RESEARCH_MISSION_EXECUTED', {
      missionId,
      mode,
      researchStatus,
      validVerifiedCount,
      validFixtureCount,
      rejectedSourcesCount,
      requestsMade: fetcherRes.requestsMade,
    });

    // Automatically generate transparent opportunity scores if mission isn't BLOCKED
    if (missionStatus !== 'BLOCKED') {
      scorePhase7Opportunities(missionId, { dbOverride: db, actor });
    }

    return getPhase7MissionDetails(missionId, db);
  } finally {
    activePhase7MissionLocks.delete(lockKey);
  }
}

export function evaluateOpportunityCriteria(params: {
  niche: string;
  market: string;
  serviceArchetype: 'BOOKING_WEB_UPGRADE' | 'PRESENCE_SEO_REMEDIATION' | 'AI_TRIAGE_CONTENT_KIT';
  verifiedSourcesCount: number;
  unverifiedOrSimulatedCount: number;
  observedTechnicalGapsCount: number;
  estimatedEffortHours: number;
  estimatedOperatingCostEur: number;
}): {
  criteria: OpportunityCriterionScore[];
  totalScore: number;
  evidenceConfidence: number;
} {
  const hasRealEvidence = params.verifiedSourcesCount > 0;
  const totalSources = params.verifiedSourcesCount + params.unverifiedOrSimulatedCount;
  const verifiedRatio = totalSources > 0 ? params.verifiedSourcesCount / totalSources : 0;

  // Strictly tie confidence in evidence to real verified sources; unsupported claims are capped <= 30
  const confidenceInEvidence = hasRealEvidence
    ? Math.min(92, Math.round(35 + verifiedRatio * 40 + Math.min(3, params.verifiedSourcesCount) * 6))
    : Math.min(28, 12 + params.unverifiedOrSimulatedCount * 6);

  const demandEvidence = hasRealEvidence
    ? Math.min(88, 42 + params.verifiedSourcesCount * 11)
    : 22;

  const customerPainBase =
    params.observedTechnicalGapsCount > 0
      ? Math.min(92, 58 + params.observedTechnicalGapsCount * 9)
      : hasRealEvidence
        ? 64
        : 34;

  const customerPain =
    params.serviceArchetype === 'PRESENCE_SEO_REMEDIATION' && params.observedTechnicalGapsCount >= 2
      ? Math.min(94, customerPainBase + 6)
      : params.serviceArchetype === 'BOOKING_WEB_UPGRADE'
        ? customerPainBase
        : Math.max(25, customerPainBase - 6);

  const competition =
    params.serviceArchetype === 'BOOKING_WEB_UPGRADE'
      ? 68
      : params.serviceArchetype === 'PRESENCE_SEO_REMEDIATION'
        ? 72
        : 60;

  const potentialValue =
    params.serviceArchetype === 'BOOKING_WEB_UPGRADE'
      ? 78
      : params.serviceArchetype === 'PRESENCE_SEO_REMEDIATION'
        ? 74
        : 62;

  // Higher score = easier implementation (still does not dominate over customer pain/evidence!)
  const implementationDifficulty = Math.max(30, Math.min(90, 96 - params.estimatedEffortHours * 2.2));
  const cost = params.estimatedOperatingCostEur === 0 ? 96 : Math.max(30, 90 - params.estimatedOperatingCostEur * 2);
  const risk =
    params.serviceArchetype === 'AI_TRIAGE_CONTENT_KIT'
      ? 72
      : 82;
  const timeToDeliver = Math.max(40, Math.min(92, 95 - params.estimatedEffortHours * 1.8));

  const criteria: OpportunityCriterionScore[] = [
    {
      key: 'demandEvidence',
      label: 'Demand Evidence',
      weight: 0.16,
      score: Math.round(demandEvidence),
      rationale: hasRealEvidence
        ? `Supported by ${params.verifiedSourcesCount} verified public record(s) for ${params.niche} in ${params.market}.`
        : 'Zero verified live sources; capped at low baseline until external evidence is gathered.',
    },
    {
      key: 'customerPain',
      label: 'Customer Pain',
      weight: 0.18,
      score: Math.round(customerPain),
      rationale:
        params.observedTechnicalGapsCount > 0
          ? `Observed ${params.observedTechnicalGapsCount} concrete digital presence gap(s) impacting lead capture.`
          : 'Estimated workflow friction; awaiting direct technical audit confirmation.',
    },
    {
      key: 'competition',
      label: 'Competition Headroom',
      weight: 0.08,
      score: competition,
      rationale: 'Local SMB digital service market is fragmented; tailored single-niche delivery lowers commoditization.',
    },
    {
      key: 'potentialValue',
      label: 'Potential Commercial Value',
      weight: 0.12,
      score: potentialValue,
      rationale: 'Fixed-scope SMB setup (EUR 450–650 estimate) addresses direct booking conversion leaks.',
    },
    {
      key: 'implementationDifficulty',
      label: 'Implementation Simplicity',
      weight: 0.08,
      score: Math.round(implementationDifficulty),
      rationale: `Estimated ${params.estimatedEffortHours}h focused frontend + lead-flow delivery.`,
    },
    {
      key: 'cost',
      label: 'Low Initial Operating Cost',
      weight: 0.08,
      score: Math.round(cost),
      rationale: `EUR ${params.estimatedOperatingCostEur} initial hosting/infra cost (static edge deployment ready).`,
    },
    {
      key: 'risk',
      label: 'Low Delivery & Compliance Risk',
      weight: 0.08,
      score: risk,
      rationale: 'Non-clinical, non-regulated web prototype behind explicit human review before any client outreach.',
    },
    {
      key: 'timeToDeliver',
      label: 'Time to Deliver',
      weight: 0.07,
      score: Math.round(timeToDeliver),
      rationale: 'Deliverable as interactive prototype + review package within 5–7 business days.',
    },
    {
      key: 'confidenceInEvidence',
      label: 'Confidence in Available Evidence',
      weight: 0.15,
      score: confidenceInEvidence,
      rationale: hasRealEvidence
        ? `${Math.round(verifiedRatio * 100)}% verified source ratio (${params.verifiedSourcesCount}/${totalSources} valid records).`
        : 'Unsupported / simulated evidence only — penalized against premature commercial commitment.',
    },
  ];

  const totalScore = Number(
    criteria.reduce((sum, item) => sum + item.score * item.weight, 0).toFixed(1)
  );

  return {
    criteria,
    totalScore,
    evidenceConfidence: confidenceInEvidence,
  };
}

export function scorePhase7Opportunities(
  missionId: string,
  options?: { dbOverride?: DatabaseSync; actor?: string }
) {
  const db = resolveTargetDb(options?.dbOverride);
  const mission = db.prepare('SELECT * FROM phase7_validation_missions WHERE id = ?').get(missionId) as
    | Record<string, unknown>
    | undefined;
  if (!mission) throw new Error(`Phase 7 mission not found: ${missionId}`);

  const sources = db
    .prepare('SELECT * FROM phase7_research_sources WHERE mission_id = ? AND is_valid = 1')
    .all(missionId) as Array<Record<string, unknown>>;

  const verifiedSources = sources.filter((s) => s.evidence_classification === 'VERIFIED_SOURCE_DATA');
  const unverifiedOrSim = sources.filter((s) => s.evidence_classification !== 'VERIFIED_SOURCE_DATA');
  const verifiedIds = verifiedSources.map((s) => String(s.id));
  const allValidIds = sources.map((s) => String(s.id));

  // Count real observed gaps from live HTTP audit or OSM records lacking website tags
  let observedGapsCount = 0;
  let auditSslMissing = false;
  let auditMetaMissing = false;
  const auditGapLabels: string[] = [];
  for (const s of verifiedSources) {
    const ev = String(s.relevant_evidence || '');
    if (/Website tag present:\s*no/i.test(ev)) observedGapsCount += 2;
    if (/HTTPS:\s*no/i.test(ev)) {
      observedGapsCount += 1;
      auditSslMissing = true;
      auditGapLabels.push('missing HTTPS');
    }
    if (/Mobile viewport:\s*missing/i.test(ev)) {
      observedGapsCount += 1;
      auditGapLabels.push('missing mobile viewport');
    }
    if (/Meta desc:\s*missing/i.test(ev)) {
      observedGapsCount += 1;
      auditMetaMissing = true;
      auditGapLabels.push('missing meta description');
    }
    if (/Booking form:\s*missing/i.test(ev)) {
      observedGapsCount += 1;
      auditGapLabels.push('missing inline booking form');
    }
    if (/Primary <h1>:\s*missing/i.test(ev)) {
      observedGapsCount += 1;
      auditGapLabels.push('missing primary <h1>');
    }
    if (/Clickable tel:\s*link:\s*missing/i.test(ev)) {
      observedGapsCount += 1;
      auditGapLabels.push('missing clickable tel: link');
    }
    if (/HTTP error/i.test(ev)) observedGapsCount += 2;
  }

  const niche = String(mission.niche);
  const market = String(mission.market);
  const nicheDisplay = niche;
  const marketDisplay = market;
  const uniqueGapLabels = Array.from(new Set(auditGapLabels));
  const auditSummaryText =
    uniqueGapLabels.length > 0
      ? `Observed HTML inspection deficiencies: ${uniqueGapLabels.join(', ')}.${!auditSslMissing && !auditMetaMissing ? ' Note: HTTPS and meta description were verified present.' : ''}`
      : `Observed local ${niche.toLowerCase()} digital presence gaps in ${market} (mobile viewport, semantic structure, or booking capture).`;
  const specs: Array<{
    archetype: 'BOOKING_WEB_UPGRADE' | 'PRESENCE_SEO_REMEDIATION' | 'AI_TRIAGE_CONTENT_KIT';
    title: string;
    serviceCategory: string;
    effortHours: number;
    operatingCostEur: number;
    problemStatement: string;
    proposedSolution: string;
    valueThesis: string;
    assumptions: string[];
    risks: string[];
  }> = [
    {
      archetype: 'BOOKING_WEB_UPGRADE',
      title: `${nicheDisplay} — Mobile Conversion Website & Appointment Request Flow (${marketDisplay})`,
      serviceCategory: 'Professional Business Website & Booking Experience',
      effortHours: 14,
      operatingCostEur: 0,
      problemStatement:
        observedGapsCount > 0
          ? `Verified checks in ${marketDisplay} detected ${observedGapsCount} concrete digital capture gap(s) (${uniqueGapLabels.join(', ') || 'missing mobile viewport/booking form'}) affecting ${nicheDisplay.toLowerCase()} mobile visitors.`
          : `Hypothesis: independent ${nicheDisplay.toLowerCase()} businesses in ${marketDisplay} lose high-intent mobile inquiries without a clear mobile booking landing page.`,
      proposedSolution:
        'Single-page responsive HTML5 website prototype with mobile viewport, primary <h1> hierarchy, verified public telephone CTA (when verified), and GDPR-consent inquiry capture form.',
      valueThesis:
        'Captures existing high-intent local search/referral visitors cleanly with zero server hosting cost (static deployable) without altering existing clinic/business back-office software.',
      assumptions: [
        'Business owner controls domain/DNS or agrees to publish a dedicated inquiry page.',
        'Quoted EUR 450 [ESTIMATE] one-time setup aligns with local independent business budget.',
      ],
      risks: [
        'Low conversion improvement if business fails to answer captured inquiries promptly.',
        'GDPR privacy policy & operator fiscal details must be finalized before public launch.',
      ],
    },
    {
      archetype: 'PRESENCE_SEO_REMEDIATION',
      title: `${nicheDisplay} — Mobile UX, Semantic Structure & Conversion Prototype (${marketDisplay})`,
      serviceCategory: 'Website Redesign Concept & Mobile Conversion Hygiene',
      effortHours: 12,
      operatingCostEur: 0,
      problemStatement: auditSummaryText,
      proposedSolution:
        'Deliver a factual HTML remediation summary paired with an interactive mobile-responsive redesign prototype addressing observed structural gaps (viewport, primary <h1>, booking form, and clickable tel: CTA).',
      valueThesis:
        'Establishes verifiable technical credibility with tangible before/after prototype proof grounded strictly in live HTML inspection.',
      assumptions: [
        'Existing site owner has access to hosting/CMS or approves migration to clean static bundle.',
      ],
      risks: [
        'Existing URL redirects must preserve search equity during cutover.',
      ],
    },
    {
      archetype: 'AI_TRIAGE_CONTENT_KIT',
      title: `${niche} — Local Presence Copy & Inquiry Workflow Starter Package (${market})`,
      serviceCategory: 'Social & Local Business Digital Presence Package',
      effortHours: 8,
      operatingCostEur: 0,
      problemStatement: `Independent ${niche.toLowerCase()} teams often lack consistent service descriptions, FAQ responses, and structured client onboarding messages.`,
      proposedSolution:
        'Prepare a human-reviewed content kit (landing copy, FAQ draft, and structured intake checklist) plus a static micro-page showcase — never auto-published.',
      valueThesis:
        'Fastest implementation path (~8h [ESTIMATE]) with zero ongoing software subscription required, though smaller standalone commercial pain than a full booking website.',
      assumptions: [
        'Business already receives baseline inbound interest via phone or social channels.',
      ],
      risks: [
        'Smaller pain urgency may result in lower perceived value than full web conversion upgrade.',
      ],
    },
  ];

  // Replace existing candidates for clean deterministic re-scoring
  db.prepare('DELETE FROM phase7_opportunity_scores WHERE mission_id = ?').run(missionId);

  const ins = db.prepare(
    `INSERT INTO phase7_opportunity_scores
     (id, mission_id, title, customer_segment, service_category, problem_statement, proposed_solution, value_thesis,
      criteria_json, total_score, evidence_confidence, supporting_source_ids_json, assumptions_json, risks_json,
      estimated_effort_hours, estimated_operating_cost_eur, is_selected, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  );

  const scored: Array<{ id: string; totalScore: number; effort: number; painScore: number }> = [];
  const ts = nowIso();

  for (const spec of specs) {
    const evalRes = evaluateOpportunityCriteria({
      niche,
      market,
      serviceArchetype: spec.archetype,
      verifiedSourcesCount: verifiedSources.length,
      unverifiedOrSimulatedCount: unverifiedOrSim.length,
      observedTechnicalGapsCount: observedGapsCount,
      estimatedEffortHours: spec.effortHours,
      estimatedOperatingCostEur: spec.operatingCostEur,
    });
    const oppId = `p7_opp_${crypto.randomUUID().slice(0, 10)}`;
    const sourceRefs = verifiedIds.length > 0 ? verifiedIds : allValidIds;
    ins.run(
      oppId,
      missionId,
      spec.title,
      `Independent ${niche} Businesses in ${market}`,
      spec.serviceCategory,
      spec.problemStatement,
      spec.proposedSolution,
      spec.valueThesis,
      JSON.stringify(evalRes.criteria),
      evalRes.totalScore,
      evalRes.evidenceConfidence,
      JSON.stringify(sourceRefs),
      JSON.stringify(spec.assumptions),
      JSON.stringify(spec.risks),
      spec.effortHours,
      spec.operatingCostEur,
      ts
    );
    const painScore = evalRes.criteria.find((c) => c.key === 'customerPain')?.score || 0;
    scored.push({ id: oppId, totalScore: evalRes.totalScore, effort: spec.effortHours, painScore });
  }

  // Select best value+pain opportunity rather than trivially picking easiest 8h content kit
  scored.sort((a, b) => (b.totalScore !== a.totalScore ? b.totalScore - a.totalScore : b.painScore - a.painScore));
  const bestId = scored[0]?.id || null;
  if (bestId) {
    db.prepare('UPDATE phase7_opportunity_scores SET is_selected = 1 WHERE id = ?').run(bestId);
  }
  db.prepare(
    `UPDATE phase7_validation_missions SET selected_opportunity_id = ?, status = 'SCORED', updated_at = ? WHERE id = ?`
  ).run(bestId, nowIso(), missionId);

  updateMissionCheckpoint(db, missionId, {
    stage: 'SCORED',
    addCompleted: `Scored ${scored.length} opportunities across 9 criteria (top ID: ${bestId || 'none'})`,
    nextExecutableAction: 'Generate client-ready deliverable prototype & run independent QA',
  });

  recordAuditEvent(options?.actor || 'business_intelligence_agent', 'PHASE7', 'OPPORTUNITIES_SCORED', {
    missionId,
    candidatesCount: scored.length,
    selectedOpportunityId: bestId,
  });

  return getPhase7MissionDetails(missionId, db);
}

export function selectPhase7Opportunity(missionId: string, opportunityId: string, dbOverride?: DatabaseSync) {
  const db = resolveTargetDb(dbOverride);
  const row = db
    .prepare('SELECT id FROM phase7_opportunity_scores WHERE id = ? AND mission_id = ?')
    .get(opportunityId, missionId) as { id: string } | undefined;
  if (!row) throw new Error(`Opportunity ${opportunityId} does not belong to mission ${missionId}.`);

  db.prepare('UPDATE phase7_opportunity_scores SET is_selected = 0 WHERE mission_id = ?').run(missionId);
  db.prepare('UPDATE phase7_opportunity_scores SET is_selected = 1 WHERE id = ?').run(opportunityId);
  db.prepare('UPDATE phase7_validation_missions SET selected_opportunity_id = ?, updated_at = ? WHERE id = ?').run(
    opportunityId,
    nowIso(),
    missionId
  );
  return getPhase7MissionDetails(missionId, db);
}

const AiDeliverableCopySchema = z.object({
  headline: z.string().min(10).max(200),
  executiveSummary: z.string().min(20).max(650),
  positioningStatement: z.string().min(15).max(650),
  cardTitles: z.tuple([z.string().min(4).max(90), z.string().min(4).max(90), z.string().min(4).max(90)]).optional(),
  cardDescriptions: z.tuple([z.string().min(12).max(320), z.string().min(12).max(320), z.string().min(12).max(320)]).optional(),
});

export interface AiDeliverableEnrichment {
  headline: string;
  executiveSummary: string;
  positioningStatement: string;
  cardTitles?: [string, string, string];
  cardDescriptions?: [string, string, string];
  providerUsed: string;
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number;
}

function normalizeVerifiedPhone(rawPhone?: string | null): { display: string; telHref: string } | null {
  const cleaned = String(rawPhone || '').trim();
  if (!cleaned) return null;
  const digitsOnly = cleaned.replace(/[^0-9]/g, '');
  if (digitsOnly.length < 7 || /^0+$/.test(digitsOnly) || /000000/.test(digitsOnly) || /123456/.test(digitsOnly)) {
    return null;
  }
  const telDigits = cleaned.startsWith('+')
    ? `+${digitsOnly}`
    : digitsOnly.startsWith('39') && digitsOnly.length >= 10
      ? `+${digitsOnly}`
      : `+39${digitsOnly}`;
  return { display: cleaned, telHref: `tel:${telDigits}` };
}

interface VerifiedAuditSummary {
  prospectName: string | null;
  targetUrl: string | null;
  verifiedPhone: { display: string; telHref: string } | null;
  address: string | null;
  hours: string | null;
  httpsPresent: boolean;
  metaDescPresent: boolean;
  missingViewport: boolean;
  missingH1: boolean;
  missingForm: boolean;
  missingTelLink: boolean;
}

function extractVerifiedAuditSummary(params: {
  targetUrl: string | null;
  sources: Array<Record<string, unknown>>;
  verifiedContact?: VerifiedTargetContact | null;
}): VerifiedAuditSummary {
  const httpAudit = params.sources.find((s) => String(s.source_provider || s.sourceProvider) === 'live_http_audit');
  const evidence = String(httpAudit?.relevant_evidence || httpAudit?.relevantEvidence || '');
  const titleStr = String(httpAudit?.source_title || httpAudit?.sourceTitle || '');

  let parsedName: string | null = params.verifiedContact?.clinicName?.trim() || null;
  if (!parsedName && titleStr.includes('—')) {
    const afterDash = titleStr.split('—').slice(1).join('—').trim();
    const firstPart = afterDash.split('|')[0]?.trim();
    if (firstPart) parsedName = firstPart;
  }

  let rawPhone = params.verifiedContact?.phone || null;
  if (!rawPhone) {
    const m = evidence.match(/Public phone observed:\s*([^.;]+)/i);
    if (m?.[1]) rawPhone = m[1].trim();
  }

  return {
    prospectName: parsedName,
    targetUrl: params.targetUrl,
    verifiedPhone: normalizeVerifiedPhone(rawPhone),
    address: params.verifiedContact?.address?.trim() || null,
    hours: params.verifiedContact?.hours?.trim() || null,
    httpsPresent: /HTTPS:\s*yes/i.test(evidence),
    metaDescPresent: /Meta desc:\s*present/i.test(evidence),
    missingViewport: /Mobile viewport:\s*missing/i.test(evidence),
    missingH1: /Primary <h1>:\s*missing/i.test(evidence),
    missingForm: /Booking form:\s*missing/i.test(evidence),
    missingTelLink: /Clickable tel:\s*link:\s*missing/i.test(evidence),
  };
}

function buildValidatedDeliverableHtml(params: {
  niche: string;
  market: string;
  segment: string;
  problemStatement: string;
  proposedSolution: string;
  language: 'en' | 'it' | 'ar' | 'fr';
  isSimulated: boolean;
  defectInjection?: 'MISSING_VIEWPORT' | 'UNSUPPORTED_CLAIM' | 'UNSAFE_SCRIPT' | null;
  aiEnrichment?: AiDeliverableEnrichment | null;
  auditSummary?: VerifiedAuditSummary | null;
}): string {
  const displayNiche = params.niche ? params.niche.charAt(0).toUpperCase() + params.niche.slice(1) : params.niche;
  const safeNiche = escapeHtml(displayNiche);
  const safeMarket = escapeHtml(params.market);
  const isIt = params.language === 'it';
  const audit = params.auditSummary;
  const brandLabel = audit?.prospectName || displayNiche;
  const safeBrand = escapeHtml(brandLabel);
  const safeSegment = escapeHtml(
    isIt
      ? audit?.prospectName
        ? `${audit.prospectName} — ${displayNiche} a ${params.market}`
        : `Studi e attività di ${displayNiche} a ${params.market}`
      : params.segment
  );

  const verifiedGapItemsIt: string[] = [];
  if (audit?.missingViewport) verifiedGapItemsIt.push('tag viewport per smartphone');
  if (audit?.missingH1) verifiedGapItemsIt.push('titolo principale semantico <h1>');
  if (audit?.missingForm) verifiedGapItemsIt.push('modulo diretto di richiesta appuntamento');
  if (audit?.missingTelLink) verifiedGapItemsIt.push('pulsante telefonico cliccabile (tel:)');

  const fallbackProblemIt =
    verifiedGapItemsIt.length > 0
      ? `Dalla verifica tecnica pubblica su ${audit?.targetUrl || brandLabel}, HTTPS e meta description risultano già attivi; il prototipo risolve esclusivamente le quattro criticità riscontrate in pagina: ${verifiedGapItemsIt.join(', ')}.`
      : `Prototipo dimostrativo per ${brandLabel} (${params.market}) progettato per offrire lettura chiara da smartphone, contatto diretto immediato e richiesta appuntamento guidata.`;

  const fallbackSolutionIt = `Bozza HTML5 mobile-first realizzata per ${brandLabel} (${params.market}) con struttura accessibile, modulo richiesta appuntamento con consenso privacy GDPR${audit?.verifiedPhone ? ` e collegamento telefonico diretto al numero pubblico ${audit.verifiedPhone.display}` : ' e pulsante di ricontatto rapido'}.`;

  const safeProblem = escapeHtml(params.aiEnrichment?.executiveSummary || (isIt ? fallbackProblemIt : params.problemStatement));
  const safeSolution = escapeHtml(isIt ? fallbackSolutionIt : params.proposedSolution);
  const safeHeadline = escapeHtml(
    params.aiEnrichment?.headline ||
      (isIt
        ? `${brandLabel} — Prototipo Mobile-First e Prenotazioni (${displayNiche} ${params.market})`
        : `Focused Digital Presence & Booking Experience for ${params.segment}`)
  );
  const cardTitles = params.aiEnrichment?.cardTitles || (isIt
    ? ['Navigazione Smartphone', 'Richiesta Appuntamento', 'Contatto Diretto Immediato']
    : ['Mobile First Layout', 'Transparent Scope', 'Zero Hosting Overhead']);
  const cardDescriptions = params.aiEnrichment?.cardDescriptions || (isIt
    ? [
        'Meta viewport dedicato, gerarchia semantica con <h1> e leggibilità ottimizzata su smartphone e desktop.',
        'Modulo chiaro per la richiesta visita con consenso privacy GDPR, senza recensioni o dati inventati.',
        audit?.verifiedPhone
          ? `Collegamento diretto verificato al numero pubblico ${audit.verifiedPhone.display} senza attese di navigazione.`
          : 'Percorso di ricontatto immediato e struttura HTML5 autonoma pronta per revisione tecnica.',
      ]
    : [
        'Accessible typography, viewport scaling, and >=44px touch targets on phones and desktop.',
        'Zero fabricated reviews or synthetic success percentages; factual service positioning only.',
        'Clean self-contained HTML5 deliverable ready for standard HTTPS static hosting after approval.',
      ]);

  const verifiedMetaLineIt = [
    audit?.address ? `Sede: ${audit.address}` : null,
    audit?.hours ? `Orari: ${audit.hours}` : null,
    audit?.verifiedPhone ? `Tel: ${audit.verifiedPhone.display}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const viewportTag =
    params.defectInjection === 'MISSING_VIEWPORT'
      ? ''
      : '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />';

  const exaggeratedClaimBlock =
    params.defectInjection === 'UNSUPPORTED_CLAIM'
      ? '<p class="claim-test">Guaranteed 300% ROI and #1 rated by 500+ happy clients with client approved testimonials.</p>'
      : '';

  const unsafeScriptBlock =
    params.defectInjection === 'UNSAFE_SCRIPT'
      ? '<script>function badTest(){ return eval("1+1"); }</script>'
      : '';

  const responsiveStyles =
    params.defectInjection === 'MISSING_VIEWPORT'
      ? 'body { margin:0; font-family: Arial, sans-serif; min-width: 1100px; }'
      : `
    :root { --bg:#F8FAFC; --surface:#FFFFFF; --border:#DCE3EB; --ink:#0F172A; --muted:#475569; --accent:#0F6B6E; --accent-dark:#0A4F52; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); line-height:1.65; }
    .notice { background:#FEF9E7; border-bottom:1px solid #E2CE86; color:#5C4813; font-size:12px; padding:10px 16px; text-align:center; font-weight:600; }
    .wrap { max-width:1020px; margin:0 auto; padding:24px 18px 48px; }
    header { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px; border-bottom:1px solid var(--border); padding-bottom:16px; }
    nav { display:flex; gap:18px; font-size:14px; }
    nav a { color:var(--ink); text-decoration:none; font-weight:600; }
    nav a:hover { color:var(--accent); }
    .hero { display:grid; grid-template-columns:1.25fr 1fr; gap:28px; padding:32px 0; align-items:start; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:22px; box-shadow:0 2px 10px rgba(15,23,42,0.04); }
    .eyebrow { display:inline-block; font-size:11px; letter-spacing:0.08em; text-transform:uppercase; font-weight:700; color:var(--accent); margin-bottom:10px; }
    .clinic-meta { font-size:13px; color:var(--accent-dark); font-weight:600; margin-bottom:14px; }
    h1 { font-size:clamp(1.65rem, 3.1vw, 2.35rem); line-height:1.18; margin-bottom:14px; color:var(--ink); }
    h2 { font-size:1.15rem; margin-bottom:10px; color:var(--ink); }
    p { color:var(--muted); margin-bottom:12px; font-size:15px; }
    label { display:block; font-size:12px; font-weight:600; margin-bottom:4px; color:var(--ink); }
    input[type="text"], input[type="tel"], input[type="email"], textarea { width:100%; min-height:44px; padding:10px 12px; border:1px solid var(--border); border-radius:8px; margin-bottom:12px; font-size:14px; color:var(--ink); background:#FFFFFF; }
    .consent-row { display:flex; align-items:flex-start; gap:8px; margin:4px 0 14px; font-size:12px; color:var(--muted); }
    .consent-row input { width:18px; height:18px; margin-top:2px; flex-shrink:0; }
    .btn { display:inline-flex; align-items:center; justify-content:center; min-height:46px; padding:10px 20px; background:var(--accent); color:#FFFFFF; border:none; border-radius:8px; font-weight:600; cursor:pointer; text-decoration:none; font-size:14px; }
    .btn:hover { background:var(--accent-dark); }
    .btn-outline { background:#FFFFFF; color:var(--accent); border:1px solid var(--accent); margin-left:8px; }
    .cta-row { display:flex; flex-wrap:wrap; gap:10px; margin-top:16px; }
    .grid-3 { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-top:16px; }
    footer { border-top:1px solid var(--border); margin-top:36px; padding-top:16px; font-size:12px; color:var(--muted); }
    @media (max-width: 760px) { .hero, .grid-3 { grid-template-columns:1fr; } .btn-outline { margin-left:0; } }`;

  const navOverview = isIt ? 'Panoramica' : 'Overview';
  const navServices = isIt ? 'Interventi' : 'Scope';
  const navBooking = isIt ? 'Prenotazione' : 'Inquiry Preview';
  const bannerTxt = params.isSimulated
    ? isIt
      ? 'ANTEPRIMA SIMULATA — NON PUBBLICATA — SOLO VALIDAZIONE INTERNA'
      : 'SIMULATED FIXTURE PREVIEW — NOT PUBLISHED — FOR INTERNAL VALIDATION ONLY'
    : isIt
      ? 'ANTEPRIMA PROTOTIPO CLIENTE — BOZZA NON PUBBLICATA — NESSUN INVIO ESTERNO ATTIVO'
      : 'CLIENT CONCEPT PREVIEW — NOT PUBLISHED — NO EXTERNAL DATA TRANSMISSION';

  const secondaryCtaHtml = audit?.verifiedPhone
    ? `<a href="${escapeHtml(audit.verifiedPhone.telHref)}" class="btn btn-outline">${isIt ? `Chiama ${escapeHtml(audit.verifiedPhone.display)}` : `Call ${escapeHtml(audit.verifiedPhone.display)}`}</a>`
    : `<a href="#booking" class="btn btn-outline">${isIt ? 'Richiedi Ricontatto' : 'Request Callback'}</a>`;

  return `<!doctype html>
<html lang="${params.language}">
<head>
  <meta charset="utf-8" />
  ${viewportTag}
  <meta name="robots" content="noindex,nofollow" />
  <meta name="description" content="${isIt ? `Prototipo web responsive per ${safeBrand} (${safeNiche}, ${safeMarket}).` : `Review-only responsive service website concept for ${safeSegment}.`}" />
  <title>${safeBrand} — ${isIt ? `Prototipo Web ${safeNiche}` : 'Concept Prototype'} (${safeMarket})</title>
  <style>${responsiveStyles}</style>
</head>
<body>
  <div class="notice">${bannerTxt}</div>
  <div class="wrap">
    <header>
      <strong>${safeBrand} · ${safeMarket}</strong>
      <nav aria-label="${isIt ? 'Navigazione principale anteprima' : 'Primary preview navigation'}">
        <a href="#overview">${navOverview}</a>
        <a href="#services">${navServices}</a>
        <a href="#booking">${navBooking}</a>
      </nav>
    </header>
    <main>
      <section id="overview" class="hero">
        <div>
          <span class="eyebrow">${isIt ? `${safeNiche} · ${safeMarket} · Prototipo Dimostrativo` : `${safeMarket} · Digital Presence Prototype`}</span>
          <h1>${safeHeadline}</h1>
          ${verifiedMetaLineIt && isIt ? `<div class="clinic-meta">${escapeHtml(verifiedMetaLineIt)}</div>` : ''}
          <p>${safeProblem}</p>
          <p>${safeSolution}</p>
          ${exaggeratedClaimBlock}
          <div class="cta-row">
            <a href="#booking" class="btn">${isIt ? 'Richiedi Appuntamento' : 'Preview Booking Flow'}</a>
            ${secondaryCtaHtml}
          </div>
        </div>
        <aside id="booking" class="card">
          <h2>${isIt ? 'Richiesta Appuntamento e Ricontatto (Anteprima)' : 'Appointment & Callback Request (Preview)'}</h2>
          <p>${isIt ? 'Modulo dimostrativo statico — inattivo fino alla revisione del titolare e approvazione dominio.' : 'Static demonstration form — inactive until customer review and explicit domain approval.'}</p>
          <form action="#booking" method="get" aria-label="${isIt ? 'Modulo richiesta appuntamento' : 'Concept inquiry form'}">
            <label for="p7-name">${isIt ? 'Nome e Cognome' : 'Full Name'}</label>
            <input id="p7-name" name="name" type="text" placeholder="${isIt ? 'Es. Luca Bianchi' : 'Example Contact'}" required />
            <label for="p7-phone">${isIt ? 'Telefono o Email' : 'Phone or Email'}</label>
            <input id="p7-phone" name="contact" type="text" placeholder="${isIt ? 'Es. recapito telefonico o email' : 'contact@example.invalid'}" required />
            <label for="p7-note">${isIt ? 'Trattamento o Fascia Oraria Preferita' : 'Requested Service'}</label>
            <textarea id="p7-note" name="note" rows="2" placeholder="${isIt ? 'Es. prima valutazione fisioterapica o osteopatica' : 'Preferred day/time or service inquiry'}"></textarea>
            <div class="consent-row">
              <input id="p7-consent" name="consent" type="checkbox" required />
              <label for="p7-consent">${isIt ? 'Consenso privacy GDPR (bozza da collegare all’informativa del titolare).' : 'GDPR privacy acknowledgment placeholder (wired cleanly prior to launch).'}</label>
            </div>
            <button type="submit" class="btn">${isIt ? 'Anteprima Invio Richiesta (Solo Locale)' : 'Preview Request Submission (Local Only)'}</button>
          </form>
        </aside>
      </section>
      <section id="services" class="grid-3">
        <div class="card"><h2>${escapeHtml(cardTitles[0])}</h2><p>${escapeHtml(cardDescriptions[0])}</p></div>
        <div class="card"><h2>${escapeHtml(cardTitles[1])}</h2><p>${escapeHtml(cardDescriptions[1])}</p></div>
        <div class="card"><h2>${escapeHtml(cardTitles[2])}</h2><p>${escapeHtml(cardDescriptions[2])}</p></div>
      </section>
    </main>
    <footer>
      <p>${isIt ? `Bozza prototipo digitale preparata per ${safeSegment}. Pubblicazione esterna, invii email e pagamenti restano disabilitati fino ad approvazione umana.` : `Prepared as a draft digital prototype for ${safeSegment}. External publishing, email outreach, and payment processing remain disabled pending human approval.`}</p>
    </footer>
  </div>
  ${unsafeScriptBlock}
</body>
</html>`;
}

export function evaluateDeliverableQuality(params: {
  deliverableHtml: string;
  packageBundle: ClientPackageBundle;
  niche: string;
  market: string;
  validSourceIds: Set<string>;
  generatorAgentId: AgentId;
  reviewerAgentId?: AgentId;
}): DeliverableQaReport {
  const reviewerAgentId: AgentId = params.reviewerAgentId || 'quality_assurance_agent';
  if (reviewerAgentId === params.generatorAgentId) {
    throw new Error(`Independent QA violation: generator '${params.generatorAgentId}' cannot self-approve its own deliverable.`);
  }
  getAgentById(reviewerAgentId);

  const html = params.deliverableHtml || '';
  const bundleWithoutEvidence = { ...params.packageBundle, researchEvidence: [] };
  const generatedCopyText = `${html}\n${JSON.stringify(bundleWithoutEvidence)}`;
  const combinedText = `${html}\n${JSON.stringify(params.packageBundle)}`;

  const criteria: QaCriterionResult[] = [];
  const findings: string[] = [];
  const blockingIssues: string[] = [];

  // 1. Accuracy (traceability + zero contradiction with live_http_audit verified evidence)
  const citedSourcesValid = params.packageBundle.researchEvidence.every((e) => params.validSourceIds.has(e.id));
  const httpAudit = params.packageBundle.researchEvidence.find((e) => e.sourceProvider === 'live_http_audit');
  const httpsVerifiedPresent = httpAudit ? /HTTPS:\s*yes/i.test(httpAudit.relevantEvidence) : false;
  const metaVerifiedPresent = httpAudit ? /Meta desc:\s*present/i.test(httpAudit.relevantEvidence) : false;
  const contradictsVerifiedSiteState =
    (httpsVerifiedPresent && /(privi di[^.]{0,80}(?:certificati?\s+SSL|HTTPS)|certificati?\s+SSL\s+assenti|sicurezza\s+SSL|SSL\s+hygiene|HTTPS\/SEO Fix|missing\s+HTTPS|missing\s+SSL)/i.test(generatedCopyText)) ||
    (metaVerifiedPresent && /(privi di[^.]{0,80}meta\s+description|miss\s+SEO\s+<meta>\s+descriptions|meta\s+description\s+mancanti|missing\s+meta\s+description)/i.test(generatedCopyText));

  const accuracyScore = !citedSourcesValid
    ? 3
    : contradictsVerifiedSiteState
      ? 4
      : params.packageBundle.researchEvidence.length > 0
        ? 9
        : 6;
  criteria.push({
    criterion: 'accuracy',
    label: 'Accuracy & Source Traceability',
    score: accuracyScore,
    maxScore: 10,
    passed: accuracyScore >= 7,
    finding: !citedSourcesValid
      ? 'Package references invalid or missing research source IDs.'
      : contradictsVerifiedSiteState
        ? 'Deliverable or package copy contradicts verified live HTTP inspection (HTTPS and/or meta description already present on target URL).'
        : `All ${params.packageBundle.researchEvidence.length} cited evidence record(s) trace cleanly to validated mission sources without contradiction.`,
  });
  if (!citedSourcesValid) findings.push('Verify all research citations link to valid mission source records.');
  if (contradictsVerifiedSiteState) {
    findings.push('Remove false claims about missing HTTPS, SSL, or meta description where live HTTP audit verified they are present.');
  }

  // 2. Completeness
  const hasAllSections =
    Boolean(params.packageBundle.opportunityReport?.title) &&
    Boolean(params.packageBundle.problemStatement) &&
    Boolean(params.packageBundle.proposedSolution) &&
    Boolean(params.packageBundle.websiteOrProductPreview?.title) &&
    Boolean(params.packageBundle.marketingStrategy?.positioningStatement) &&
    params.packageBundle.scopeOfWork.includedDeliverables.length > 0 &&
    params.packageBundle.estimatedDeliveryTimeline.length > 0 &&
    params.packageBundle.pricingProposal.setupPriceEurEstimate > 0 &&
    params.packageBundle.risksAndAssumptions.assumptions.length > 0 &&
    params.packageBundle.risksAndAssumptions.risks.length > 0;
  const completenessScore = hasAllSections ? 9 : 4;
  criteria.push({
    criterion: 'completeness',
    label: 'Package Section Completeness',
    score: completenessScore,
    maxScore: 10,
    passed: completenessScore >= 7,
    finding: hasAllSections
      ? 'All required commercial, technical, pricing-estimate, scope, risk, and assumption sections present.'
      : 'Client package is missing required sections.',
  });
  if (completenessScore < 7) findings.push('Complete all missing sections of the client package.');

  // 3. Design quality
  const hasSemanticLayout = /<header[\s>]/i.test(html) && /<main[\s>]/i.test(html) && /<footer[\s>]/i.test(html) && /<style[\s>]/i.test(html);
  const designScore = hasSemanticLayout ? 9 : 5;
  criteria.push({
    criterion: 'designQuality',
    label: 'Visual & Semantic Design Quality',
    score: designScore,
    maxScore: 10,
    passed: designScore >= 7,
    finding: hasSemanticLayout
      ? 'Uses semantic HTML5 landmarks (<header>, <main>, <footer>) and structured CSS design tokens.'
      : 'Missing semantic landmarks or structured styling in deliverable HTML.',
  });
  if (designScore < 7) findings.push('Add semantic <header>, <main>, <footer> landmarks and clean CSS tokens.');

  // 4. Functionality (checks form controls, valid links, and rejects fabricated placeholder tel: numbers)
  const hasFormControls = /<form[\s>]/i.test(html) && /<button[^>]*type=["']submit["']/i.test(html);
  const brokenLinks = /href=["']\s*["']|href=["']#["']/i.test(html);
  const placeholderPhone = /href=["']tel:\+?39?0{6,}["']|tel:\+?0{6,}/i.test(html);
  const functionalityScore = hasFormControls && !brokenLinks && !placeholderPhone ? 9 : placeholderPhone ? 4 : brokenLinks ? 5 : 4;
  criteria.push({
    criterion: 'functionality',
    label: 'Interactive Control Functionality',
    score: functionalityScore,
    maxScore: 10,
    passed: functionalityScore >= 7,
    finding: placeholderPhone
      ? 'Detected fabricated placeholder tel: link (+390000000000); replace with verified clinic phone or contact-request CTA.'
      : hasFormControls && !brokenLinks
        ? 'Contains functional preview form controls and valid internal/verified anchors.'
        : 'Detected missing inquiry form controls or dead empty/# href anchors.',
  });
  if (placeholderPhone) findings.push('Remove placeholder telephone URI and use verified public contact number or #booking CTA.');
  else if (functionalityScore < 7) findings.push('Repair empty/broken anchors and ensure working preview form controls.');

  // 5. Customer relevance
  const relevantToSegment =
    html.toLowerCase().includes(params.niche.toLowerCase()) &&
    html.toLowerCase().includes(params.market.toLowerCase());
  const relevanceScore = relevantToSegment ? 9 : 4;
  criteria.push({
    criterion: 'customerRelevance',
    label: 'Target Customer Relevance',
    score: relevanceScore,
    maxScore: 10,
    passed: relevanceScore >= 7,
    finding: relevantToSegment
      ? `Deliverable explicitly reflects "${params.niche}" in "${params.market}".`
      : 'Deliverable fails to reference the target niche or market.',
  });
  if (relevanceScore < 7) findings.push('Tailor deliverable copy directly to the researched niche and target market.');

  // 6. Usability
  const hasLabelsAndH1 = /<h1[\s>]/i.test(html) && /<label[^>]+for=/i.test(html);
  const usabilityScore = hasLabelsAndH1 ? 9 : 5;
  criteria.push({
    criterion: 'usability',
    label: 'Accessibility & Form Usability',
    score: usabilityScore,
    maxScore: 10,
    passed: usabilityScore >= 7,
    finding: hasLabelsAndH1
      ? 'Primary <h1> hierarchy and explicit <label for="..."> accessibility bindings verified.'
      : 'Missing <h1> heading or explicit form input <label> bindings.',
  });
  if (usabilityScore < 7) findings.push('Add accessible <label for="..."> attributes and primary <h1> structure.');

  // 7. Mobile responsiveness
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const hasResponsiveCss = /@media\s*\(\s*max-width/i.test(html);
  const hasFixedOverflowWidth = /min-width:\s*9\d\d|min-width:\s*1\d\d\dpx/i.test(html);
  const mobileScore = hasViewport && hasResponsiveCss && !hasFixedOverflowWidth ? 9 : hasViewport ? 6 : 2;
  criteria.push({
    criterion: 'mobileResponsiveness',
    label: 'Mobile Viewport & Responsive CSS',
    score: mobileScore,
    maxScore: 10,
    passed: mobileScore >= 7,
    finding:
      mobileScore >= 7
        ? 'Verified <meta name="viewport"> and @media mobile breakpoint rules without fixed desktop overflow.'
        : 'Mobile responsiveness failed: missing <meta name="viewport"> or @media responsive breakpoint, or fixed wide min-width detected.',
  });
  if (mobileScore < 7) {
    findings.push('Inject <meta name="viewport"> and responsive @media (max-width: 760px) grid stacking.');
  }

  // 8. Technical consistency
  const hasDoctype = /<!doctype html>/i.test(html) && /<meta[^>]+name=["']robots["'][^>]+noindex,nofollow/i.test(html) && /<title>[\s\S]+<\/title>/i.test(html);
  const techScore = hasDoctype ? 9 : 4;
  criteria.push({
    criterion: 'technicalConsistency',
    label: 'Technical & Preview Isolation Consistency',
    score: techScore,
    maxScore: 10,
    passed: techScore >= 7,
    finding: hasDoctype
      ? 'Valid HTML5 doctype, <title>, and noindex,nofollow preview isolation directive present.'
      : 'Missing valid HTML5 doctype, <title>, or noindex preview protection.',
  });
  if (techScore < 7) findings.push('Ensure HTML5 doctype, <title>, and noindex,nofollow meta directives are present.');

  // 9. Unsupported claims detection (ROI, fake reviews, unverified page load timings)
  const unsupportedPatterns: Array<{ rx: RegExp; label: string; isBlocking: boolean }> = [
    { rx: /guaranteed\s+\d+%?\s*roi|guaranteed\s+revenue/i, label: 'Fabricated ROI/revenue guarantee', isBlocking: true },
    { rx: /#1\s+rated|500\+\s+happy\s+clients/i, label: 'Fabricated customer count/ranking', isBlocking: true },
    { rx: /client\s+approved\s+testimonial|verified\s+5-star\s+review/i, label: 'Fabricated testimonial or fake client approval', isBlocking: true },
    { rx: /boosts\s+revenue\s+by\s+\d+%/i, label: 'Unsupported performance uplift percentage', isBlocking: true },
    { rx: /inferiori\s+a\s+2[\s\u00a0]*secondi|under\s+2\s+seconds|fast\s+page\s+load|tempi\s+di\s+caricamento\s+rapidi/i, label: 'Unverified page-speed / load-time performance claim', isBlocking: false },
  ];
  const matchedUnsupported = unsupportedPatterns.filter((p) => p.rx.test(generatedCopyText));
  const unsupportedScore = matchedUnsupported.length === 0 ? 10 : Math.max(2, 10 - matchedUnsupported.length * 4);
  criteria.push({
    criterion: 'unsupportedClaims',
    label: 'Zero Unsupported / Fabricated Claims',
    score: unsupportedScore,
    maxScore: 10,
    passed: unsupportedScore >= 8,
    finding:
      matchedUnsupported.length === 0
        ? 'No fabricated testimonials, unverified ROI guarantees, or synthetic performance claims detected.'
        : `Flagged unsupported claim(s): ${matchedUnsupported.map((m) => m.label).join('; ')}.`,
  });
  if (matchedUnsupported.length > 0) {
    const labels = matchedUnsupported.map((m) => m.label).join(', ');
    const msg = `Remove fabricated/unsupported claims: ${labels}.`;
    findings.push(msg);
    if (matchedUnsupported.some((m) => m.isBlocking)) {
      blockingIssues.push(msg);
    }
  }

  // 10. Security risks scan
  const secPatterns: Array<{ rx: RegExp; label: string }> = [
    { rx: /\beval\s*\(|document\.write\s*\(/i, label: 'Dangerous eval()/document.write() execution' },
    { rx: /javascript:|onerror\s*=|onload\s*=/i, label: 'Inline DOM XSS script handler' },
    { rx: /(sk-[a-zA-Z0-9]{16,}|AIza[0-9A-Za-z-_]{20,}|gsk_[0-9A-Za-z]{16,})/, label: 'Exposed API key pattern' },
  ];
  const matchedSec = secPatterns.filter((p) => p.rx.test(html)).map((p) => p.label);
  const secScore = matchedSec.length === 0 ? 10 : 1;
  criteria.push({
    criterion: 'securityRisks',
    label: 'Deliverable Security Hygiene',
    score: secScore,
    maxScore: 10,
    passed: secScore >= 9,
    finding:
      matchedSec.length === 0
        ? 'Passed static security scan (zero eval/document.write/inline XSS/leaked keys; outbound automation disabled).'
        : `CRITICAL SECURITY RISK detected: ${matchedSec.join('; ')}.`,
  });
  if (matchedSec.length > 0) {
    const msg = `Critical security issue: ${matchedSec.join(', ')}.`;
    findings.push(msg);
    blockingIssues.push(msg);
  }

  const totalScore = criteria.reduce((sum, c) => sum + c.score, 0);
  const allPassed = criteria.every((c) => c.passed);

  let status: 'READY' | 'NEEDS_REVISION' | 'BLOCKED' = 'READY';
  if (blockingIssues.length > 0 || secScore < 8 || totalScore < 50) {
    status = 'BLOCKED';
  } else if (!allPassed || totalScore < 80) {
    status = 'NEEDS_REVISION';
  }

  return {
    reviewerAgentId,
    generatorAgentId: params.generatorAgentId,
    independentReviewVerified: true,
    status,
    totalScore,
    findings,
    blockingIssues,
    criteria,
    reviewedAt: nowIso(),
  };
}

function buildClientPackageBundle(params: {
  mission: Record<string, unknown>;
  opportunity: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
  html: string;
  language: 'en' | 'it' | 'ar' | 'fr';
  aiEnrichment?: AiDeliverableEnrichment | null;
  auditSummary?: VerifiedAuditSummary | null;
}): { packageBundle: ClientPackageBundle; markdown: string } {
  const niche = String(params.mission.niche);
  const market = String(params.mission.market);
  const displayNiche = niche ? niche.charAt(0).toUpperCase() + niche.slice(1) : niche;
  const isIt = params.language === 'it';
  const isSim = String(params.mission.research_status) === 'SIMULATED_FIXTURE';
  const audit = params.auditSummary;
  const brandName = audit?.prospectName || displayNiche;
  const criteria = JSON.parse(String(params.opportunity.criteria_json || '[]')) as OpportunityCriterionScore[];
  const rawAssumptions = JSON.parse(String(params.opportunity.assumptions_json || '[]')) as string[];
  const rawRisks = JSON.parse(String(params.opportunity.risks_json || '[]')) as string[];

  const assumptions = isIt
    ? [
        'Il titolare dello studio mantiene la piena proprietà di dominio, DNS e contenuti pubblicati.',
        'Il preventivo indicativo (EUR 450 una tantum [STIMA]) è subordinato a conferma dei testi e dei dati fiscali prima di qualsiasi impegno contrattuale.',
        ...(audit?.verifiedPhone
          ? [`Numero telefonico pubblico verificato direttamente sul sito attuale dello studio: ${audit.verifiedPhone.display}.`]
          : ['Nessun numero telefonico verificato automaticamente: prima della pubblicazione va confermato il recapito ufficiale dello studio.']),
      ]
    : [...rawAssumptions];

  if (params.aiEnrichment) {
    assumptions.push(
      isIt
        ? `Testi rifiniti tramite inferenza AI gratuita (${params.aiEnrichment.providerUsed}/${params.aiEnrichment.modelUsed}, $${params.aiEnrichment.costUsd.toFixed(6)}) e verificati dal controllo qualità indipendente.`
        : `Copy tailored via live free-tier AI inference (${params.aiEnrichment.providerUsed}/${params.aiEnrichment.modelUsed}, ${params.aiEnrichment.latencyMs}ms, $${params.aiEnrichment.costUsd.toFixed(6)}) and vetted by independent QA.`
    );
  }

  const risks = isIt
    ? [
        'La sola ottimizzazione tecnica non produce appuntamenti se le richieste ricevute non vengono gestite tempestivamente dallo studio.',
        'Informativa privacy GDPR e dati fiscali/legali del fornitore devono essere finalizzati prima della pubblicazione definitiva.',
      ]
    : [...rawRisks];

  const setupEstimate = 450;
  const retainerEstimate = 99;
  const terms = buildCommercialTermsBreakdown(setupEstimate, retainerEstimate, params.language);

  const researchEvidence = params.sources.map((s) => ({
    id: String(s.id),
    sourceTitle: String(s.source_title),
    sourceUrl: s.source_url ? String(s.source_url) : null,
    sourceProvider: String(s.source_provider),
    retrievedAt: String(s.retrieved_at),
    relevantEvidence: String(s.relevant_evidence),
    evidenceClassification: String(s.evidence_classification) as EpistemicClassification,
    confidence: Number(s.confidence),
    limitations: String(s.limitations),
  }));

  const verifiedGapsIt: string[] = [];
  if (audit?.missingViewport) verifiedGapsIt.push('assenza del tag <meta name="viewport"> per smartphone');
  if (audit?.missingH1) verifiedGapsIt.push('assenza dell’intestazione primaria <h1> in homepage');
  if (audit?.missingForm) verifiedGapsIt.push('assenza di un modulo inline di richiesta appuntamento');
  if (audit?.missingTelLink) {
    verifiedGapsIt.push(
      audit.verifiedPhone
        ? `assenza di un link cliccabile tel: sul numero pubblico ${audit.verifiedPhone.display}`
        : 'assenza di un link telefonico cliccabile tel:'
    );
  }
  const alreadyPresentIt =
    audit && (audit.httpsPresent || audit.metaDescPresent)
      ? `Elementi già presenti sul sito attuale (${audit.targetUrl || brandName}): ${[
          audit.httpsPresent ? 'protocollo HTTPS attivo' : null,
          audit.metaDescPresent ? '<meta name="description"> presente' : null,
        ]
          .filter(Boolean)
          .join(' e ')}.`
      : '';

  const cleanOppTitle = isIt
    ? `${brandName} — Adeguamento Mobile-First, Struttura Semantica e Richiesta Appuntamenti (${market})`
    : `${displayNiche} — Mobile UX, Semantic Structure & Conversion Prototype (${market})`;

  const problemStatementIt =
    verifiedGapsIt.length > 0
      ? `${alreadyPresentIt} L’ispezione HTML della homepage pubblica ha rilevato esclusivamente le seguenti carenze tecniche verificabili: ${verifiedGapsIt.join('; ')}.`
      : `Analisi tecnica della presenza digitale per ${brandName} (${market}) focalizzata su fruibilità da smartphone e semplificazione della richiesta appuntamento.`;

  const proposedSolutionIt =
    `Fornitura di un prototipo web HTML5 responsive (anteprima locale non pubblicata) con tag <meta name="viewport">, gerarchia semantica con <h1>, modulo richiesta appuntamento con consenso privacy GDPR${audit?.verifiedPhone ? ` e collegamento diretto tel: al numero pubblico verificato ${audit.verifiedPhone.display}` : ' e pulsante di ricontatto rapido'}.`;

  const valueThesisIt =
    `Dimostrazione concreta e verificabile su prototipo reale, concentrata esclusivamente sulle carenze HTML osservate senza sovrascrivere ciò che già funziona (HTTPS e meta description restano preservati).`;

  const outreachLinesIt = audit?.verifiedPhone
    ? [
        `Buongiorno,`,
        `ho consultato il sito pubblico di ${brandName} (${audit.targetUrl || market}) e ho preparato una breve anteprima dimostrativa gratuita, senza alcun impegno:`,
        `- Adattamento mobile-first con viewport dedicato e gerarchia chiara dei contenuti su smartphone;`,
        `- Modulo diretto di richiesta appuntamento con consenso GDPR e pulsante di chiamata rapida cliccabile verso il vostro numero ${audit.verifiedPhone.display}.`,
        `Sul vostro sito attuale HTTPS e descrizione meta risultano già impostati correttamente; il prototipo interviene solo sulla resa da cellulare e sull'immediatezza del contatto.`,
        `Se Le fa piacere visionare la bozza in anteprima privata, resto a disposizione.`,
        `Cordiali saluti.`,
      ]
    : [
        `Buongiorno,`,
        `ho consultato la presenza web pubblica di ${brandName} (${audit?.targetUrl || market}) e ho preparato un prototipo dimostrativo gratuito, senza alcun impegno:`,
        `- Ottimizzazione completa per smartphone (viewport responsive, titolo principale <h1> e lettura immediata);`,
        `- Modulo chiaro per richiesta appuntamento e ricontatto con consenso privacy GDPR.`,
        `Se Le fa piacere visionarlo senza impegno, posso condividere l'anteprima dedicata.`,
        `Cordiali saluti.`,
      ];

  const packageBundle: ClientPackageBundle = {
    environmentPolicy: PHASE7_SAFETY_LOCKS,
    isSimulatedFixture: isSim,
    opportunityReport: {
      opportunityId: String(params.opportunity.id),
      title: cleanOppTitle,
      customerSegment: isIt ? `${brandName} (${displayNiche}, ${market})` : String(params.opportunity.customer_segment),
      serviceCategory: isIt
        ? 'Adeguamento Web Mobile-First e Acquisizione Appuntamenti'
        : 'Website Redesign Concept & Mobile Conversion Hygiene',
      totalScore: Number(params.opportunity.total_score),
      evidenceConfidence: Number(params.opportunity.evidence_confidence),
      criteriaBreakdown: criteria,
    },
    researchEvidence,
    problemStatement: isIt
      ? problemStatementIt
      : params.aiEnrichment?.executiveSummary || String(params.opportunity.problem_statement),
    proposedSolution: isIt ? proposedSolutionIt : String(params.opportunity.proposed_solution),
    valueThesis: isIt ? valueThesisIt : String(params.opportunity.value_thesis),
    websiteOrProductPreview: {
      previewType: 'RESPONSIVE_HTML5_CONCEPT',
      publishedExternally: false,
      title: isIt ? `${brandName} — Prototipo Web Responsive (${market})` : `${displayNiche} — Concept Prototype (${market})`,
      htmlByteLength: Buffer.byteLength(params.html, 'utf-8'),
    },
    marketingStrategy: {
      positioningStatement: isIt
        ? `Intervento tecnico mirato per ${brandName} (${market}): prototipo dimostrativo statico pronto all'uso che risolve esclusivamente le carenze mobile e di conversione osservate nell'HTML pubblico.`
        : params.aiEnrichment?.positioningStatement ||
          `Fixed-scope responsive digital presence & inquiry-capture upgrade tailored for ${params.opportunity.customer_segment}.`,
      outboundAutomationEnabled: false,
      recommendedHumanReviewedChannels: isIt
        ? [
            'Invio manuale 1-a-1 del link di anteprima solo dopo revisione e approvazione umana dell’operatore',
            'Verifica manuale dei recapiti pubblici dello studio prima di qualunque contatto',
          ]
        : [
            '1-to-1 human-reviewed consultation preview link (manual operator send only after review)',
            'Local directory profile metadata hygiene checklist',
          ],
      objectionHandlingNotes: isIt
        ? [
            'Nessun vincolo contrattuale plurimensile; il supporto mensile opzionale è separato dall’installazione una tantum.',
            'Tutti gli importi e i tempi indicati sono stime pre-contrattuali soggette a conferma.',
          ]
        : [
            'Zero multi-month lock-in; optional support retainer clearly separated from one-time setup estimate.',
            'All pricing & timeline figures labeled explicitly as pre-contract estimates.',
          ],
    },
    scopeOfWork: {
      includedDeliverables: isIt
        ? [
            'Prototipo HTML5 responsive mobile-first (<meta name="viewport"> e layout adattivo)',
            'Struttura semantica con intestazione primaria <h1> e metadati coerenti',
            'Modulo richiesta appuntamento con consenso privacy GDPR esplicito',
            audit?.verifiedPhone
              ? `Pulsante di chiamata diretta verificato (tel: -> ${audit.verifiedPhone.display})`
              : 'Pulsante di ricontatto rapido ancorato al modulo richieste',
          ]
        : [
            'Responsive HTML5 storefront & booking preview concept',
            'Mobile viewport & semantic heading structure',
            'Lead capture form markup with explicit privacy consent notice',
            'Deployment-ready standalone HTML package & documentation',
          ],
      explicitExclusions: isIt
        ? [
            'Nessuna spesa pubblicitaria (Google Ads/Meta Ads) né invii automatizzati di email, SMS o WhatsApp',
            'Nessun trasferimento DNS/dominio, nessun contratto di hosting né attivazione pagamenti senza consenso scritto',
            'Nessuna recensione inventata, nessun claim clinico o garanzia non verificata',
          ]
        : [
            'No custom paid ad spend or autonomous outbound email/SMS/WhatsApp campaigns',
            'No live domain DNS transfer, hosting contract, or payment gateway wiring without written sign-off',
            'No fabricated customer testimonials or unverified clinical/ROI guarantees',
          ],
      estimatedEffortHours: Number(params.opportunity.estimated_effort_hours),
      estimatedInitialOperatingCostEur: Number(params.opportunity.estimated_operating_cost_eur),
    },
    estimatedDeliveryTimeline: isIt
      ? [
          { phase: 'Giorni 1–2 [STIMA]', durationDays: '2 giorni', output: 'Conferma testi, orari, trattamenti e recapiti ufficiali con lo studio' },
          { phase: 'Giorni 3–5 [STIMA]', durationDays: '3 giorni', output: 'Implementazione HTML5 responsive, test su smartphone iOS/Android e accessibilità' },
          { phase: 'Giorni 6–7 [STIMA]', durationDays: '2 giorni', output: 'Revisione finale con il titolare e pubblicazione previa autorizzazione scritta' },
        ]
      : [
          { phase: 'Day 1–2 [ESTIMATE]', durationDays: '2 days', output: 'Discovery verification & copy confirmation with client' },
          { phase: 'Day 3–5 [ESTIMATE]', durationDays: '3 days', output: 'Responsive HTML5 build, accessibility & mobile testing' },
          { phase: 'Day 6–7 [ESTIMATE]', durationDays: '2 days', output: 'Operator review, revisions & domain cutover checklist' },
        ],
    pricingProposal: {
      label: isIt
        ? 'STIMA COMMERCIALE NON VINCOLANTE (RICHIEDE COMPLETAMENTO DATI LEGALI/FISCALI DEL FORNITORE)'
        : 'NON-BINDING COMMERCIAL ESTIMATE (REQUIRES OPERATOR LEGAL/TAX COMPLETION)',
      setupPriceEurEstimate: setupEstimate,
      optionalMonthlySupportEurEstimate: retainerEstimate,
      realizedRevenueEur: 0,
      commercialTerms: terms,
    },
    risksAndAssumptions: { assumptions, risks },
    outreachDraftIt: {
      sendStatus: 'UNSENT_REQUIRES_HUMAN_APPROVAL',
      targetProspectUrl: params.mission.target_url ? String(params.mission.target_url) : null,
      subject: `Prototipo mobile e prenotazioni — ${brandName} (${market})`,
      message: outreachLinesIt.join('\n'),
    },
    finalQualityReview: null,
  };

  const markdown = buildClientPackageMarkdown(packageBundle, params.language);
  return { packageBundle, markdown };
}

function buildClientPackageMarkdown(pkg: ClientPackageBundle, language: 'en' | 'it' | 'ar' | 'fr' = 'en'): string {
  const isIt = language === 'it';
  return [
    `# ${isIt ? 'Pacchetto Cliente Verificato' : 'Client-Ready Validation Package'} — ${pkg.opportunityReport.title}`,
    isIt
      ? `**Stato:** ${pkg.isSimulatedFixture ? 'MODALITÀ SIMULATA — NON REALE' : 'PACCHETTO PER REVISIONE UMANA'} · **Invio Esterno:** DISABILITATO · **Ricavi Reali Verificati:** EUR 0.00`
      : `**Status Disclosure:** ${pkg.isSimulatedFixture ? 'SIMULATED FIXTURE MODE — NOT REAL MARKET PROOF' : 'HUMAN REVIEW PACKAGE'} · **External Outreach:** DISABLED · **Verified Real Revenue:** EUR 0.00`,
    '',
    `## 1. ${isIt ? 'Analisi Opportunità' : 'Opportunity Report'}`,
    `- **${isIt ? 'Destinatario / Segmento' : 'Segment'}:** ${pkg.opportunityReport.customerSegment}`,
    `- **${isIt ? 'Categoria Servizio' : 'Service Category'}:** ${pkg.opportunityReport.serviceCategory}`,
    `- **${isIt ? 'Punteggio' : 'Explainable Score'}:** ${pkg.opportunityReport.totalScore}/100 · **${isIt ? 'Affidabilità Evidenze' : 'Evidence Confidence'}:** ${pkg.opportunityReport.evidenceConfidence}/100`,
    '',
    `## 2. ${isIt ? 'Evidenze Verificate' : 'Research Evidence'}`,
    ...pkg.researchEvidence.map(
      (r) =>
        `- **[${r.evidenceClassification}]** ${r.sourceTitle} (${r.sourceProvider}, ${r.retrievedAt})${r.sourceUrl ? ` — ${r.sourceUrl}` : ''}\n  - *${isIt ? 'Evidenza' : 'Evidence'}:* ${r.relevantEvidence}\n  - *${isIt ? 'Limiti' : 'Limitations'}:* ${r.limitations}`
    ),
    '',
    `## 3. ${isIt ? 'Analisi Tecnica Verificata' : 'Problem Statement'}`,
    pkg.problemStatement,
    '',
    `## 4. ${isIt ? 'Soluzione Proposta e Valore' : 'Proposed Solution & Value Thesis'}`,
    pkg.proposedSolution,
    '',
    pkg.valueThesis,
    '',
    `## 5. ${isIt ? 'Anteprima Prototipo Web' : 'Website / Product Preview'}`,
    `- **${isIt ? 'Titolo Anteprima' : 'Preview Title'}:** ${pkg.websiteOrProductPreview.title} (${pkg.websiteOrProductPreview.htmlByteLength} bytes HTML5, ${isIt ? 'bozza non pubblicata' : 'unpublished draft'})`,
    '',
    `## 6. ${isIt ? 'Strategia e Posizionamento (Solo Revisione Umana)' : 'Marketing Strategy (Human-Reviewed Only)'}`,
    `- **${isIt ? 'Posizionamento' : 'Positioning'}:** ${pkg.marketingStrategy.positioningStatement}`,
    `- **${isIt ? 'Automazione Invii' : 'Automated Outbound'}:** ${isIt ? 'DISABILITATA' : 'DISABLED'}`,
    '',
    `## 7. ${isIt ? 'Ambito dell’Intervento (Scope of Work)' : 'Scope of Work'}`,
    ...pkg.scopeOfWork.includedDeliverables.map((d) => `- ${isIt ? 'Incluso' : 'Included'}: ${d}`),
    ...pkg.scopeOfWork.explicitExclusions.map((e) => `- ${isIt ? 'Escluso' : 'Excluded'}: ${e}`),
    '',
    `## 8. ${isIt ? 'Tempistiche Indicative [STIME]' : 'Estimated Delivery Timeline'}`,
    ...pkg.estimatedDeliveryTimeline.map((t) => `- **${t.phase}:** ${t.output}`),
    '',
    `## 9. ${isIt ? 'Proposta Economica [SOLO STIME NON VINCOLANTI]' : 'Pricing Proposal [ESTIMATES ONLY]'}`,
    `- **${isIt ? 'Setup una tantum stimato' : 'Estimated Setup Fee'}:** EUR ${pkg.pricingProposal.setupPriceEurEstimate} [${isIt ? 'STIMA' : 'ESTIMATE'}]`,
    `- **${isIt ? 'Supporto mensile opzionale' : 'Optional Monthly Support'}:** EUR ${pkg.pricingProposal.optionalMonthlySupportEurEstimate}/${isIt ? 'mese' : 'mo'} [${isIt ? 'STIMA' : 'ESTIMATE'}]`,
    `- **${isIt ? 'Note legali/fiscali' : 'Legal/Tax Note'}:** ${pkg.pricingProposal.commercialTerms.paymentTermsDraft}`,
    '',
    `## 10. ${isIt ? 'Assunzioni e Rischi' : 'Risks & Assumptions'}`,
    ...pkg.risksAndAssumptions.assumptions.map((a) => `- ${isIt ? 'Assunzione' : 'Assumption'}: ${a}`),
    ...pkg.risksAndAssumptions.risks.map((r) => `- ${isIt ? 'Rischio' : 'Risk'}: ${r}`),
    '',
    `## 11. ${isIt ? 'Bozza Messaggio di Contatto in Italiano' : 'Concise Italian Outreach Draft'} [${pkg.outreachDraftIt.sendStatus}]`,
    `- **URL Destinatario:** ${pkg.outreachDraftIt.targetProspectUrl || 'Non specificato'}`,
    `- **Oggetto:** ${pkg.outreachDraftIt.subject}`,
    '',
    '```text',
    pkg.outreachDraftIt.message,
    '```',
    '',
    `## 12. ${isIt ? 'Controllo Qualità Indipendente (QA)' : 'Independent Quality Review'}`,
    pkg.finalQualityReview
      ? `- **${isIt ? 'Esito QA' : 'QA Status'}:** ${pkg.finalQualityReview.status} (${pkg.finalQualityReview.totalScore}/100) — \`${pkg.finalQualityReview.reviewerAgentId}\`\n${
          pkg.finalQualityReview.findings.length > 0
            ? pkg.finalQualityReview.findings.map((f) => `- ${isIt ? 'Rilievo' : 'Finding'}: ${f}`).join('\n')
            : isIt
              ? '- Tutti i 10 controlli indipendenti QA superati senza rilievi.'
              : '- All 10 independent QA checks passed cleanly.'
        }`
      : isIt
        ? '- In attesa di valutazione QA indipendente.'
        : '- Pending independent QA evaluation.',
  ].join('\n');
}

export function generatePhase7DeliverablePackage(params: {
  missionId: string;
  opportunityId?: string;
  language?: 'en' | 'it' | 'ar' | 'fr';
  defectInjection?: 'MISSING_VIEWPORT' | 'UNSUPPORTED_CLAIM' | 'UNSAFE_SCRIPT' | null;
  aiEnrichment?: AiDeliverableEnrichment | null;
  verifiedContact?: VerifiedTargetContact | null;
  actor?: string;
  dbOverride?: DatabaseSync;
}) {
  const db = resolveTargetDb(params.dbOverride);
  const mission = db.prepare('SELECT * FROM phase7_validation_missions WHERE id = ?').get(params.missionId) as
    | Record<string, unknown>
    | undefined;
  if (!mission) throw new Error(`Phase 7 mission not found: ${params.missionId}`);
  if (mission.status === 'BLOCKED' || mission.status === 'FAILED') {
    throw new Error(`Cannot generate deliverable while mission status is ${mission.status}.`);
  }

  const targetOppId = params.opportunityId || String(mission.selected_opportunity_id || '');
  const opportunity = db
    .prepare('SELECT * FROM phase7_opportunity_scores WHERE id = ? AND mission_id = ?')
    .get(targetOppId, params.missionId) as Record<string, unknown> | undefined;
  if (!opportunity) {
    throw new Error('Select a scored opportunity before generating a deliverable package.');
  }

  const sources = db
    .prepare('SELECT * FROM phase7_research_sources WHERE mission_id = ? AND is_valid = 1')
    .all(params.missionId) as Array<Record<string, unknown>>;

  const auditSummary = extractVerifiedAuditSummary({
    targetUrl: mission.target_url ? String(mission.target_url) : null,
    sources,
    verifiedContact: params.verifiedContact || null,
  });

  const generatorAgentId: AgentId = getAgentById('commerce_operations_agent').id;
  const language = params.language || 'en';
  const html = buildValidatedDeliverableHtml({
    niche: String(mission.niche),
    market: String(mission.market),
    segment: String(opportunity.customer_segment),
    problemStatement: String(opportunity.problem_statement),
    proposedSolution: String(opportunity.proposed_solution),
    language,
    isSimulated: String(mission.research_status) === 'SIMULATED_FIXTURE',
    defectInjection: params.defectInjection || null,
    aiEnrichment: params.aiEnrichment || null,
    auditSummary,
  });

  const { packageBundle } = buildClientPackageBundle({
    mission,
    opportunity,
    sources,
    html,
    language,
    aiEnrichment: params.aiEnrichment || null,
    auditSummary,
  });

  const qaReport = evaluateDeliverableQuality({
    deliverableHtml: html,
    packageBundle,
    niche: String(mission.niche),
    market: String(mission.market),
    validSourceIds: new Set(sources.map((s) => String(s.id))),
    generatorAgentId,
    reviewerAgentId: 'quality_assurance_agent',
  });
  packageBundle.finalQualityReview = qaReport;
  const markdown = buildClientPackageMarkdown(packageBundle, language);

  const delivId = `p7_pkg_${crypto.randomUUID().slice(0, 10)}`;
  const ts = nowIso();
  db.prepare(
    `INSERT INTO phase7_deliverable_packages
     (id, mission_id, opportunity_id, revision_number, generator_agent_id, qa_reviewer_agent_id,
      qa_status, qa_score, qa_report_json, package_json, deliverable_html, presentation_markdown, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    delivId,
    params.missionId,
    String(opportunity.id),
    generatorAgentId,
    qaReport.reviewerAgentId,
    qaReport.status,
    qaReport.totalScore,
    JSON.stringify(qaReport),
    JSON.stringify(packageBundle),
    html,
    markdown,
    ts,
    ts
  );

  const nextMissionStatus: Phase7MissionStatus =
    qaReport.status === 'READY'
      ? 'READY_FOR_REVIEW'
      : qaReport.status === 'BLOCKED'
        ? 'QA_REJECTED'
        : 'QA_REJECTED';

  db.prepare(
    `UPDATE phase7_validation_missions SET selected_opportunity_id = ?, selected_deliverable_id = ?, status = ?, updated_at = ? WHERE id = ?`
  ).run(String(opportunity.id), delivId, nextMissionStatus, ts, params.missionId);

  updateMissionCheckpoint(db, params.missionId, {
    stage: qaReport.status === 'READY' ? 'QA_READY' : 'QA_REVISION_NEEDED',
    addCompleted: `Generated deliverable ${delivId} & completed independent QA (${qaReport.status} ${qaReport.totalScore}/100)`,
    ...(qaReport.status !== 'READY' ? { addFailed: `QA flagged defects: ${qaReport.findings.slice(0, 2).join('; ')}` } : {}),
    nextExecutableAction:
      qaReport.status === 'READY'
        ? 'Export verified bundle to ./data/exports/ and conduct human pre-outreach review'
        : 'Apply revision guidance and re-run independent QA gate',
  });

  recordAuditEvent(params.actor || 'operator', 'PHASE7', 'DELIVERABLE_AND_QA_COMPLETED', {
    missionId: params.missionId,
    deliverableId: delivId,
    qaStatus: qaReport.status,
    qaScore: qaReport.totalScore,
  });

  return getPhase7MissionDetails(params.missionId, db);
}

export function revisePhase7Deliverable(params: {
  deliverableId: string;
  revisionNotes?: string;
  language?: 'en' | 'it' | 'ar' | 'fr';
  verifiedContact?: VerifiedTargetContact | null;
  actor?: string;
  dbOverride?: DatabaseSync;
}) {
  const db = resolveTargetDb(params.dbOverride);
  const existing = db.prepare('SELECT * FROM phase7_deliverable_packages WHERE id = ?').get(params.deliverableId) as
    | Record<string, unknown>
    | undefined;
  if (!existing) throw new Error(`Deliverable package not found: ${params.deliverableId}`);

  const missionId = String(existing.mission_id);
  const mission = db.prepare('SELECT * FROM phase7_validation_missions WHERE id = ?').get(missionId) as
    | Record<string, unknown>
    | undefined;
  const opportunity = db
    .prepare('SELECT * FROM phase7_opportunity_scores WHERE id = ?')
    .get(String(existing.opportunity_id)) as Record<string, unknown> | undefined;
  if (!mission || !opportunity) throw new Error('Associated mission or opportunity missing for revision.');

  const sources = db
    .prepare('SELECT * FROM phase7_research_sources WHERE mission_id = ? AND is_valid = 1')
    .all(missionId) as Array<Record<string, unknown>>;

  const auditSummary = extractVerifiedAuditSummary({
    targetUrl: mission.target_url ? String(mission.target_url) : null,
    sources,
    verifiedContact: params.verifiedContact || null,
  });

  const language = params.language || 'en';
  const generatorAgentId = String(existing.generator_agent_id) as AgentId;
  const nextRevision = Number(existing.revision_number || 1) + 1;
  const cleanHtml = buildValidatedDeliverableHtml({
    niche: String(mission.niche),
    market: String(mission.market),
    segment: String(opportunity.customer_segment),
    problemStatement: String(opportunity.problem_statement),
    proposedSolution: String(opportunity.proposed_solution),
    language,
    isSimulated: String(mission.research_status) === 'SIMULATED_FIXTURE',
    defectInjection: null,
    auditSummary,
  });

  const { packageBundle } = buildClientPackageBundle({
    mission,
    opportunity,
    sources,
    html: cleanHtml,
    language,
    auditSummary,
  });

  // Sync opportunity row in SQLite cleanly if it previously held contradictory template wording
  if (auditSummary.httpsPresent && /HTTPS\/SEO Fix|SSL hygiene|miss SEO <meta>/i.test(`${opportunity.title} ${opportunity.problem_statement}`)) {
    db.prepare(
      `UPDATE phase7_opportunity_scores SET title = ?, problem_statement = ?, proposed_solution = ? WHERE id = ?`
    ).run(
      packageBundle.opportunityReport.title,
      packageBundle.problemStatement,
      packageBundle.proposedSolution,
      String(opportunity.id)
    );
  }

  const note = (params.revisionNotes || 'Remediated independent QA findings cleanly.').trim();
  if (note) {
    packageBundle.risksAndAssumptions.assumptions.push(
      language === 'it'
        ? `Revisione #${nextRevision} applicata su indicazioni di controllo accuratezza: ${note}`
        : `Revision #${nextRevision} operator guidance applied: ${note}`
    );
  }

  const qaReport = evaluateDeliverableQuality({
    deliverableHtml: cleanHtml,
    packageBundle,
    niche: String(mission.niche),
    market: String(mission.market),
    validSourceIds: new Set(sources.map((s) => String(s.id))),
    generatorAgentId,
    reviewerAgentId: 'quality_assurance_agent',
  });
  packageBundle.finalQualityReview = qaReport;
  const markdown = buildClientPackageMarkdown(packageBundle, language);
  const ts = nowIso();

  db.prepare(
    `UPDATE phase7_deliverable_packages
     SET revision_number = ?, qa_status = ?, qa_score = ?, qa_report_json = ?, package_json = ?,
         deliverable_html = ?, presentation_markdown = ?, revision_notes = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    nextRevision,
    qaReport.status,
    qaReport.totalScore,
    JSON.stringify(qaReport),
    JSON.stringify(packageBundle),
    cleanHtml,
    markdown,
    note,
    ts,
    params.deliverableId
  );

  db.prepare(`UPDATE phase7_validation_missions SET selected_deliverable_id = ?, status = ?, updated_at = ? WHERE id = ?`).run(
    params.deliverableId,
    qaReport.status === 'READY' ? 'READY_FOR_REVIEW' : 'QA_REJECTED',
    ts,
    missionId
  );

  updateMissionCheckpoint(db, missionId, {
    stage: qaReport.status === 'READY' ? 'QA_READY' : 'QA_REVISION_NEEDED',
    addCompleted: `Applied revision #${nextRevision} & verified independent QA (${qaReport.status} ${qaReport.totalScore}/100)`,
    nextExecutableAction:
      qaReport.status === 'READY'
        ? 'Export verified bundle to ./data/exports/ and conduct human pre-outreach review'
        : 'Fix remaining QA defects',
  });

  recordAuditEvent(params.actor || 'operator', 'PHASE7', 'DELIVERABLE_REVISED_AND_RETESTED', {
    missionId,
    deliverableId: params.deliverableId,
    revisionNumber: nextRevision,
    qaStatus: qaReport.status,
    qaScore: qaReport.totalScore,
  });

  return getPhase7MissionDetails(missionId, db);
}

export function listPhase7Missions(dbOverride?: DatabaseSync) {
  const db = resolveTargetDb(dbOverride);
  const rows = db
    .prepare('SELECT * FROM phase7_validation_missions ORDER BY created_at DESC, rowid DESC LIMIT 40')
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    niche: String(r.niche),
    market: String(r.market),
    targetUrl: r.target_url ? String(r.target_url) : null,
    mode: String(r.mode) as Phase7ResearchMode,
    researchStatus: String(r.research_status) as Phase7ResearchStatus,
    status: String(r.status) as Phase7MissionStatus,
    maxCostUsd: Number(r.max_cost_usd),
    totalCostUsd: Number(r.total_cost_usd),
    totalRequests: Number(r.total_requests),
    retriesUsed: Number(r.retries_used),
    selectedOpportunityId: r.selected_opportunity_id ? String(r.selected_opportunity_id) : null,
    selectedDeliverableId: r.selected_deliverable_id ? String(r.selected_deliverable_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function getPhase7MissionDetails(missionId: string, dbOverride?: DatabaseSync) {
  const db = resolveTargetDb(dbOverride);
  const m = db.prepare('SELECT * FROM phase7_validation_missions WHERE id = ?').get(missionId) as
    | Record<string, unknown>
    | undefined;
  if (!m) return null;

  const sources = (
    db.prepare('SELECT * FROM phase7_research_sources WHERE mission_id = ? ORDER BY retrieved_at DESC').all(missionId) as Array<
      Record<string, unknown>
    >
  ).map((s) => ({
    id: String(s.id),
    missionId: String(s.mission_id),
    sourceUrl: s.source_url ? String(s.source_url) : null,
    sourceTitle: String(s.source_title),
    sourceProvider: String(s.source_provider),
    retrievedAt: String(s.retrieved_at),
    relevantEvidence: String(s.relevant_evidence),
    evidenceClassification: String(s.evidence_classification) as EpistemicClassification,
    confidence: Number(s.confidence),
    limitations: String(s.limitations),
    isValid: Number(s.is_valid) === 1,
  }));

  const opportunities: Phase7OpportunityCandidate[] = (
    db
      .prepare('SELECT * FROM phase7_opportunity_scores WHERE mission_id = ? ORDER BY total_score DESC')
      .all(missionId) as Array<Record<string, unknown>>
  ).map((o) => ({
    id: String(o.id),
    missionId: String(o.mission_id),
    title: String(o.title),
    customerSegment: String(o.customer_segment),
    serviceCategory: String(o.service_category),
    problemStatement: String(o.problem_statement),
    proposedSolution: String(o.proposed_solution),
    valueThesis: String(o.value_thesis),
    criteria: JSON.parse(String(o.criteria_json || '[]')) as OpportunityCriterionScore[],
    totalScore: Number(o.total_score),
    evidenceConfidence: Number(o.evidence_confidence),
    supportingSourceIds: JSON.parse(String(o.supporting_source_ids_json || '[]')) as string[],
    assumptions: JSON.parse(String(o.assumptions_json || '[]')) as string[],
    risks: JSON.parse(String(o.risks_json || '[]')) as string[],
    estimatedEffortHours: Number(o.estimated_effort_hours),
    estimatedOperatingCostEur: Number(o.estimated_operating_cost_eur),
    isSelected: Number(o.is_selected) === 1,
    createdAt: String(o.created_at),
  }));

  const deliverables = (
    db
      .prepare(
        'SELECT * FROM phase7_deliverable_packages WHERE mission_id = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC, rowid DESC'
      )
      .all(missionId, String(m.selected_deliverable_id || '')) as Array<Record<string, unknown>>
  ).map((d) => ({
    id: String(d.id),
    missionId: String(d.mission_id),
    opportunityId: String(d.opportunity_id),
    revisionNumber: Number(d.revision_number),
    generatorAgentId: String(d.generator_agent_id) as AgentId,
    qaReviewerAgentId: d.qa_reviewer_agent_id ? (String(d.qa_reviewer_agent_id) as AgentId) : null,
    qaStatus: String(d.qa_status) as 'PENDING' | 'READY' | 'NEEDS_REVISION' | 'BLOCKED',
    qaScore: Number(d.qa_score),
    qaReport: d.qa_report_json ? (JSON.parse(String(d.qa_report_json)) as DeliverableQaReport) : null,
    packageBundle: JSON.parse(String(d.package_json)) as ClientPackageBundle,
    deliverableHtml: String(d.deliverable_html),
    presentationMarkdown: String(d.presentation_markdown),
    revisionNotes: d.revision_notes ? String(d.revision_notes) : null,
    createdAt: String(d.created_at),
    updatedAt: String(d.updated_at),
  }));

  return {
    safetyLocks: PHASE7_SAFETY_LOCKS,
    mission: {
      id: String(m.id),
      niche: String(m.niche),
      market: String(m.market),
      targetUrl: m.target_url ? String(m.target_url) : null,
      mode: String(m.mode) as Phase7ResearchMode,
      researchStatus: String(m.research_status) as Phase7ResearchStatus,
      status: String(m.status) as Phase7MissionStatus,
      selectedOpportunityId: m.selected_opportunity_id ? String(m.selected_opportunity_id) : null,
      selectedDeliverableId: m.selected_deliverable_id ? String(m.selected_deliverable_id) : null,
      maxCostUsd: Number(m.max_cost_usd),
      totalCostUsd: Number(m.total_cost_usd),
      totalRequests: Number(m.total_requests),
      retriesUsed: Number(m.retries_used),
      providerUsed: m.provider_used ? String(m.provider_used) : null,
      limitations: JSON.parse(String(m.limitations_json || '[]')) as string[],
      checkpoint: m.checkpoint_json ? (JSON.parse(String(m.checkpoint_json)) as ResumableMissionCheckpoint) : null,
      errorMessage: m.error_message ? String(m.error_message) : null,
      createdBy: m.created_by ? String(m.created_by) : null,
      createdAt: String(m.created_at),
      updatedAt: String(m.updated_at),
    },
    sources,
    opportunities,
    deliverables,
  };
}

export function deletePhase7Mission(missionId: string, dbOverride?: DatabaseSync): { deleted: boolean } {
  const db = resolveTargetDb(dbOverride);
  const res = db.prepare('DELETE FROM phase7_validation_missions WHERE id = ?').run(missionId);
  return { deleted: Number(res.changes) > 0 };
}

function extractFirstJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('No valid JSON object returned by AI model.');
  }
}

export async function generatePhase7DeliverableWithLiveAi(params: {
  missionId: string;
  opportunityId?: string;
  language?: 'en' | 'it' | 'ar' | 'fr';
  defectInjection?: 'MISSING_VIEWPORT' | 'UNSUPPORTED_CLAIM' | 'UNSAFE_SCRIPT' | null;
  useLiveAi?: boolean;
  actor?: string;
  dbOverride?: DatabaseSync;
}) {
  const db = resolveTargetDb(params.dbOverride);
  const mission = db.prepare('SELECT * FROM phase7_validation_missions WHERE id = ?').get(params.missionId) as
    | Record<string, unknown>
    | undefined;
  if (!mission) throw new Error(`Phase 7 mission not found: ${params.missionId}`);

  let aiEnrichment: AiDeliverableEnrichment | null = null;
  const shouldUseAi =
    params.useLiveAi !== false &&
    !params.defectInjection &&
    String(mission.mode) === 'LIVE_RESEARCH' &&
    Number(mission.total_cost_usd || 0) < Number(mission.max_cost_usd || 0);

  if (shouldUseAi) {
    const targetOppId = params.opportunityId || String(mission.selected_opportunity_id || '');
    const opportunity = db
      .prepare('SELECT * FROM phase7_opportunity_scores WHERE id = ? AND mission_id = ?')
      .get(targetOppId, params.missionId) as Record<string, unknown> | undefined;
    const sources = db
      .prepare('SELECT source_title, source_provider, source_url, relevant_evidence FROM phase7_research_sources WHERE mission_id = ? AND is_valid = 1 LIMIT 5')
      .all(params.missionId) as Array<Record<string, unknown>>;

    if (opportunity && sources.length > 0) {
      const langLabel =
        params.language === 'it'
          ? 'Italian'
          : params.language === 'fr'
            ? 'French'
            : params.language === 'ar'
              ? 'Arabic'
              : 'English';
      const evidenceSummary = sources
        .map((s, idx) => `${idx + 1}. [${s.source_provider}] ${s.source_title}: ${String(s.relevant_evidence).slice(0, 160)}`)
        .join('\n');

      try {
        const res = await routeInference({
          taskClass: 'commerce_operations',
          maxTokens: 1800,
          temperature: 0.25,
          paidFallbackAllowed: false,
          allowMockFallback: false,
          systemPrompt:
            'You are a commercial product copywriter. Output STRICT JSON only with keys: headline (<=140 chars), executiveSummary (<=420 chars), positioningStatement (<=380 chars), cardTitles (array of 3 concise titles <=60 chars each), cardDescriptions (array of 3 concise descriptions <=220 chars each). Write naturally in the requested Language. Ground copy ONLY in supplied facts. NEVER include testimonials, ROI guarantees, star ratings, fake statistics, HTML tags, or script tags.',
          userPrompt: `Language: ${langLabel}\nTarget Niche: ${String(mission.niche)}\nMarket: ${String(mission.market)}\nSegment: ${String(opportunity.customer_segment)}\nProblem: ${String(opportunity.problem_statement)}\nProposed Solution: ${String(opportunity.proposed_solution)}\nRetrieved Public Evidence:\n${evidenceSummary}\nReturn valid JSON object only.`,
        });

        const parsedRaw = extractFirstJsonObject(res.content);
        const validated = AiDeliverableCopySchema.parse(parsedRaw);
        const combinedAiText = JSON.stringify(validated);
        const containsForbiddenPattern =
          /<script|onerror=|onload=|javascript:|guaranteed\s+\d+%?\s*roi|#1\s+rated|500\+\s+happy|approved\s+testimonial/i.test(
            combinedAiText
          );
        const preservesTargetContext =
          combinedAiText.toLowerCase().includes(String(mission.market).toLowerCase()) ||
          combinedAiText.toLowerCase().includes(String(mission.niche).toLowerCase().slice(0, 5));

        if (!containsForbiddenPattern && preservesTargetContext && res.verifiedGeneration) {
          aiEnrichment = {
            ...validated,
            providerUsed: res.providerId,
            modelUsed: res.modelId,
            tokensIn: res.tokensIn,
            tokensOut: res.tokensOut,
            latencyMs: res.latencyMs,
            costUsd: res.costUsd,
          };
          const newCost = Number((Number(mission.total_cost_usd || 0) + res.costUsd).toFixed(6));
          db.prepare('UPDATE phase7_validation_missions SET total_cost_usd = ?, provider_used = ?, updated_at = ? WHERE id = ?').run(
            newCost,
            `${res.providerId}:${res.modelId}`,
            nowIso(),
            params.missionId
          );
        }
      } catch (err) {
        const limitations = JSON.parse(String(mission.limitations_json || '[]')) as string[];
        limitations.push(
          `Optional live AI copy enrichment skipped safely (deterministic template used): ${err instanceof Error ? err.message.slice(0, 140) : 'unavailable'}`
        );
        db.prepare('UPDATE phase7_validation_missions SET limitations_json = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(limitations.slice(-8)),
          nowIso(),
          params.missionId
        );
      }
    }
  }

  return generatePhase7DeliverablePackage({
    ...params,
    aiEnrichment,
  });
}

export function exportPhase7MissionPackageToDisk(
  missionId: string,
  options?: { baseExportsDir?: string; dbOverride?: DatabaseSync }
): {
  exportDir: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  manifestPath: string;
} {
  const details = getPhase7MissionDetails(missionId, options?.dbOverride);
  if (!details) throw new Error(`Phase 7 mission not found: ${missionId}`);
  const pkg = details.deliverables[0];
  if (!pkg) throw new Error(`Mission ${missionId} has no generated deliverable package to export.`);
  if (pkg.qaStatus !== 'READY') {
    throw new Error(`Cannot finalize disk export while QA status is '${pkg.qaStatus}'. Revise deliverable until QA passes READY.`);
  }

  const safeId = path.basename(missionId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId || safeId !== missionId) {
    throw new Error('Invalid Phase 7 mission ID for export path.');
  }

  const rootExportsDir = path.resolve(options?.baseExportsDir || path.join(resolvePersistentDataDir(), 'exports'));
  const targetDir = path.resolve(rootExportsDir, safeId);
  if (!targetDir.startsWith(`${rootExportsDir}${path.sep}`)) {
    throw new Error('Blocked unsafe export path traversal outside data/exports.');
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const filePayloads: Array<{ name: string; content: string }> = [
    { name: 'deliverable-preview.html', content: pkg.deliverableHtml },
    { name: 'client-package.md', content: pkg.presentationMarkdown },
    { name: 'client-package.json', content: JSON.stringify(pkg.packageBundle, null, 2) },
    { name: 'qa-report.json', content: JSON.stringify(pkg.qaReport, null, 2) },
    {
      name: 'outreach-it.txt',
      content: `SEND STATUS: ${pkg.packageBundle.outreachDraftIt.sendStatus}\nPROSPECT URL: ${pkg.packageBundle.outreachDraftIt.targetProspectUrl || 'N/A'}\nOGGETTO: ${pkg.packageBundle.outreachDraftIt.subject}\n\n${pkg.packageBundle.outreachDraftIt.message}\n`,
    },
  ];

  const files = filePayloads.map((item) => {
    const dest = path.resolve(targetDir, item.name);
    fs.writeFileSync(dest, item.content, 'utf-8');
    const sha256 = crypto.createHash('sha256').update(item.content, 'utf-8').digest('hex');
    return { name: item.name, bytes: Buffer.byteLength(item.content, 'utf-8'), sha256 };
  });

  const manifest = {
    exportedAt: nowIso(),
    missionId: details.mission.id,
    niche: details.mission.niche,
    market: details.mission.market,
    researchStatus: details.mission.researchStatus,
    deliverableId: pkg.id,
    revisionNumber: pkg.revisionNumber,
    qaStatus: pkg.qaStatus,
    qaScore: pkg.qaScore,
    qaReviewerAgentId: pkg.qaReviewerAgentId,
    localPreviewRoute: `/preview/p7/${pkg.id}`,
    safetyLocks: details.safetyLocks,
    realizedRevenueEur: 0,
    files,
  };
  const manifestPath = path.resolve(targetDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  const db = resolveTargetDb(options?.dbOverride);
  updateMissionCheckpoint(db, missionId, {
    stage: 'EXPORTED',
    exportedDir: targetDir,
    addCompleted: `Exported verified bundle (${files.length + 1} files) to ${targetDir}`,
    nextExecutableAction: 'Human review of Italian outreach draft & local preview /preview/p7/' + pkg.id,
  });

  recordAuditEvent('operator', 'PHASE7', 'PACKAGE_EXPORTED_TO_DISK', {
    missionId: details.mission.id,
    deliverableId: pkg.id,
    fileCount: files.length + 1,
  });

  return {
    exportDir: targetDir,
    files,
    manifestPath,
  };
}
