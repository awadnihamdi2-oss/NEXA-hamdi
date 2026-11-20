import { useEffect, useState } from 'react';
import { Download, ExternalLink, Play, RefreshCw, ShieldCheck, Trash2, Wrench } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface Phase7MissionSummary {
  id: string;
  niche: string;
  market: string;
  targetUrl: string | null;
  mode: 'LIVE_RESEARCH' | 'FIXTURE_SIMULATION';
  researchStatus: 'VERIFIED_LIVE' | 'PARTIAL_LIVE' | 'BLOCKED' | 'UNVERIFIED' | 'SIMULATED_FIXTURE';
  status: string;
  maxCostUsd: number;
  totalCostUsd: number;
  totalRequests: number;
  retriesUsed: number;
  selectedOpportunityId: string | null;
  selectedDeliverableId: string | null;
  createdAt: string;
}

interface Phase7Source {
  id: string;
  sourceUrl: string | null;
  sourceTitle: string;
  sourceProvider: string;
  retrievedAt: string;
  relevantEvidence: string;
  evidenceClassification: 'VERIFIED_SOURCE_DATA' | 'AI_INFERENCE' | 'UNVERIFIED_CLAIM' | 'SIMULATED_DATA';
  confidence: number;
  limitations: string;
  isValid: boolean;
}

interface Phase7Criterion {
  key: string;
  label: string;
  weight: number;
  score: number;
  rationale: string;
}

interface Phase7Opportunity {
  id: string;
  title: string;
  customerSegment: string;
  serviceCategory: string;
  problemStatement: string;
  proposedSolution: string;
  valueThesis: string;
  criteria: Phase7Criterion[];
  totalScore: number;
  evidenceConfidence: number;
  supportingSourceIds: string[];
  assumptions: string[];
  risks: string[];
  estimatedEffortHours: number;
  estimatedOperatingCostEur: number;
  isSelected: boolean;
}

interface Phase7QaCriterion {
  criterion: string;
  label: string;
  score: number;
  maxScore: number;
  passed: boolean;
  finding: string;
}

interface Phase7Deliverable {
  id: string;
  opportunityId: string;
  revisionNumber: number;
  generatorAgentId: string;
  qaReviewerAgentId: string | null;
  qaStatus: 'PENDING' | 'READY' | 'NEEDS_REVISION' | 'BLOCKED';
  qaScore: number;
  qaReport: {
    reviewerAgentId: string;
    generatorAgentId: string;
    independentReviewVerified: boolean;
    status: 'READY' | 'NEEDS_REVISION' | 'BLOCKED';
    totalScore: number;
    findings: string[];
    blockingIssues: string[];
    criteria: Phase7QaCriterion[];
    reviewedAt: string;
  } | null;
  packageBundle: {
    isSimulatedFixture: boolean;
    opportunityReport: { title: string; customerSegment: string; totalScore: number; evidenceConfidence: number };
    problemStatement: string;
    proposedSolution: string;
    valueThesis: string;
    marketingStrategy: { positioningStatement: string; recommendedHumanReviewedChannels: string[]; objectionHandlingNotes: string[] };
    scopeOfWork: { includedDeliverables: string[]; explicitExclusions: string[]; estimatedEffortHours: number; estimatedInitialOperatingCostEur: number };
    estimatedDeliveryTimeline: Array<{ phase: string; durationDays: string; output: string }>;
    pricingProposal: { label: string; setupPriceEurEstimate: number; optionalMonthlySupportEurEstimate: number; realizedRevenueEur: number };
    risksAndAssumptions: { assumptions: string[]; risks: string[] };
  };
  deliverableHtml: string;
  presentationMarkdown: string;
  revisionNotes: string | null;
}

interface Phase7MissionDetails {
  mission: Phase7MissionSummary & {
    limitations: string[];
    providerUsed: string | null;
    errorMessage: string | null;
    checkpoint?: {
      stage: string;
      objective: string;
      completedActions: string[];
      failedActions: string[];
      nextExecutableAction: string;
      exportedDir: string | null;
    } | null;
  };
  sources: Phase7Source[];
  opportunities: Phase7Opportunity[];
  deliverables: Phase7Deliverable[];
}

export function Phase7ValidationWorkspace() {
  const [missions, setMissions] = useState<Phase7MissionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [details, setDetails] = useState<Phase7MissionDetails | null>(null);
  const [capabilities, setCapabilities] = useState<{
    providers: Array<{ id: string; configured: boolean; availabilityStatus: string; isPaidByDefault: boolean; lastVerifiedAt: string | null }>;
  } | null>(null);

  const [niche, setNiche] = useState('Physiotherapy Clinics');
  const [market, setMarket] = useState('Milan');
  const [targetUrl, setTargetUrl] = useState('');
  const [mode, setMode] = useState<'LIVE_RESEARCH' | 'FIXTURE_SIMULATION'>('LIVE_RESEARCH');
  const [language, setLanguage] = useState<'en' | 'it' | 'ar' | 'fr'>('en');
  const [maxCostUsd, setMaxCostUsd] = useState(0.25);
  const [allowFixtureFallback, setAllowFixtureFallback] = useState(false);

  const [subTab, setSubTab] = useState<'sources' | 'opportunities' | 'deliverable' | 'qa' | 'package'>('sources');
  const [previewWidth, setPreviewWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [revisionNote, setRevisionNote] = useState('Ensure responsive mobile layout, verified evidence traceability, and zero unsupported ROI claims.');
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function loadAll(selectId?: string | null) {
    setLoading(true);
    try {
      const [mRes, cRes] = await Promise.all([
        apiFetch<{ missions: Phase7MissionSummary[] }>('/api/phase7/missions'),
        apiFetch<{ providers: Array<{ id: string; configured: boolean; availabilityStatus: string; isPaidByDefault: boolean; lastVerifiedAt: string | null }> }>(
          '/api/phase7/capabilities'
        ),
      ]);
      const list = mRes.missions || [];
      setMissions(list);
      setCapabilities(cRes);
      const nextId = selectId === undefined ? activeId || list[0]?.id || null : selectId;
      setActiveId(nextId);
      if (nextId) {
        const d = await apiFetch<Phase7MissionDetails>(`/api/phase7/missions/${encodeURIComponent(nextId)}`);
        setDetails(d);
      } else {
        setDetails(null);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed loading Phase 7 validation data');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectMission(id: string) {
    setActiveId(id);
    setErrorMsg(null);
    try {
      const d = await apiFetch<Phase7MissionDetails>(`/api/phase7/missions/${encodeURIComponent(id)}`);
      setDetails(d);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to load mission details');
    }
  }

  async function handleStartMission(e: React.FormEvent) {
    e.preventDefault();
    setRunning(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const d = await apiFetch<Phase7MissionDetails>('/api/phase7/missions/start', {
        method: 'POST',
        body: JSON.stringify({
          niche,
          market,
          targetUrl: targetUrl.trim() || null,
          mode,
          language,
          maxCostUsd,
          allowFixtureFallback,
        }),
      });
      setDetails(d);
      setActiveId(d.mission.id);
      setStatusMsg(
        `Research mission ${d.mission.id} completed (${d.mission.researchStatus}). ${d.sources.length} source record(s), ${d.opportunities.length} scored opportunities.`
      );
      setSubTab('sources');
      await loadAll(d.mission.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start Phase 7 research mission');
    } finally {
      setRunning(false);
    }
  }

  async function handleSelectOpportunity(oppId: string) {
    if (!details) return;
    setErrorMsg(null);
    try {
      const d = await apiFetch<Phase7MissionDetails>(
        `/api/phase7/missions/${encodeURIComponent(details.mission.id)}/opportunities/${encodeURIComponent(oppId)}/select`,
        { method: 'POST' }
      );
      setDetails(d);
      setStatusMsg(`Selected opportunity ${oppId} for first product validation.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to select opportunity');
    }
  }

  async function handleGenerateDeliverable(defectInjection: 'MISSING_VIEWPORT' | 'UNSUPPORTED_CLAIM' | 'UNSAFE_SCRIPT' | null = null) {
    if (!details) return;
    setRunning(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const d = await apiFetch<Phase7MissionDetails>(`/api/phase7/missions/${encodeURIComponent(details.mission.id)}/deliverable`, {
        method: 'POST',
        body: JSON.stringify({
          opportunityId: details.mission.selectedOpportunityId || undefined,
          language,
          defectInjection,
        }),
      });
      setDetails(d);
      const latest = d.deliverables[0];
      setStatusMsg(
        latest
          ? `Deliverable ${latest.id} generated and independently reviewed (${latest.qaStatus} · ${latest.qaScore}/100).`
          : 'Deliverable generated.'
      );
      setSubTab(latest?.qaStatus === 'READY' ? 'deliverable' : 'qa');
      await loadAll(details.mission.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to generate deliverable package');
    } finally {
      setRunning(false);
    }
  }

  async function handleReviseDeliverable(deliverableId: string) {
    setRunning(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const d = await apiFetch<Phase7MissionDetails>(`/api/phase7/deliverables/${encodeURIComponent(deliverableId)}/revise`, {
        method: 'POST',
        body: JSON.stringify({ revisionNotes: revisionNote, language }),
      });
      setDetails(d);
      const latest = d.deliverables[0];
      setStatusMsg(`Revision #${latest?.revisionNumber} evaluated by independent QA: ${latest?.qaStatus} (${latest?.qaScore}/100).`);
      await loadAll(d.mission.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to revise deliverable');
    } finally {
      setRunning(false);
    }
  }

  async function handleDeleteMission(missionId: string) {
    setErrorMsg(null);
    try {
      await apiFetch(`/api/phase7/missions/${encodeURIComponent(missionId)}`, { method: 'DELETE' });
      setStatusMsg(`Deleted Phase 7 validation mission ${missionId}.`);
      await loadAll(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to delete mission');
    }
  }

  function downloadBlob(filename: string, content: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleVerifyFreeAiProviders() {
    setRunning(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const results: string[] = [];
      for (const pid of ['OPENROUTER', 'GEMINI', 'GROQ']) {
        try {
          const r = await apiFetch<{ providerId: string; connected: boolean; availabilityStatus: string; message: string }>(
            `/api/providers/${pid}/test`,
            { method: 'POST', body: JSON.stringify({ runInferenceProbe: true }) }
          );
          results.push(`${r.providerId}: ${r.availabilityStatus}`);
        } catch (err) {
          results.push(`${pid}: ERROR`);
        }
      }
      setStatusMsg(`Live free-tier inference probe completed -> ${results.join(' | ')}`);
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to probe free AI providers');
    } finally {
      setRunning(false);
    }
  }

  async function handleExportToDisk(missionId: string) {
    setRunning(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch<{ exportDir: string; files: Array<{ name: string; bytes: number }> }>(
        `/api/phase7/missions/${encodeURIComponent(missionId)}/export`,
        { method: 'POST' }
      );
      setStatusMsg(
        `Saved ${res.files.length + 1} verified assets persistently to ${res.exportDir} (${res.files.map((f) => f.name).join(', ')}, manifest.json).`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to export package to server disk');
    } finally {
      setRunning(false);
    }
  }

  const latestDeliverable = details?.deliverables[0] || null;
  const authProvidersCount = capabilities?.providers.filter((p) => p.availabilityStatus === 'AUTHENTICATED' || p.availabilityStatus === 'OPERATIONAL').length ?? 0;
  const operationalProvidersCount = capabilities?.providers.filter((p) => p.availabilityStatus === 'OPERATIONAL').length ?? 0;

  return (
    <div className="space-y-5">
      {/* External Action Safety & Provider Reality Bar */}
      <div className="nexa-plane rounded-lg p-4 border border-[#1E2534] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-xs font-mono uppercase text-slate-100 font-semibold">
              Phase 7 — Real-World Research &amp; Deliverable Validation (Read-Only External Safety)
            </span>
          </div>
          <div className="text-xs font-mono text-amber-300">
            OUTREACH / EMAIL / WHATSAPP / PUBLISHING / ADS / PAYMENTS: DISABLED BY DEFAULT
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px]">
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[10px] text-[#64748B] uppercase">Research Feeds</div>
            <div className="text-slate-100 mt-0.5">OpenAlex · Wikipedia · OSM · HTTP</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] text-[#64748B] uppercase">Verified AI Providers</div>
              <div className="text-cyan-300 tabular-nums mt-0.5">
                {operationalProvidersCount} Operational · {authProvidersCount} Auth
              </div>
            </div>
            <button
              type="button"
              disabled={running}
              onClick={handleVerifyFreeAiProviders}
              className="min-h-[30px] px-2 py-1 bg-[#0B111E] border border-cyan-500/40 text-cyan-200 text-[10px] rounded cursor-pointer disabled:opacity-50"
            >
              Verify Live AI
            </button>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[10px] text-[#64748B] uppercase">Validation Missions</div>
            <div className="text-slate-100 tabular-nums mt-0.5">{missions.length} Stored</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[10px] text-[#64748B] uppercase">Realized Revenue</div>
            <div className="text-slate-100 tabular-nums mt-0.5">EUR 0.00 (Pre-Review)</div>
          </div>
        </div>
      </div>

      {/* Start Real-World Research Mission Form */}
      <form onSubmit={handleStartMission} className="nexa-plane rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">01. Real-World Research &amp; Opportunity Scoring</h3>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              Collects traceable public sources or runs strictly labeled offline fixture tests, then evaluates low-cost service opportunities using 9 transparent criteria.
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadAll()}
            className="min-h-[38px] px-3 bg-[#06080E] border border-[#2A344B] text-xs font-mono text-cyan-300 rounded flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 text-xs">
          <input
            type="text"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="Business niche (e.g. Physiotherapy Clinics)"
            aria-label="Business niche"
            className="sm:col-span-3 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-slate-100"
          />
          <input
            type="text"
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            placeholder="City or target market"
            aria-label="Target city or market"
            className="sm:col-span-2 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-slate-100"
          />
          <input
            type="url"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="Optional public URL to audit (https://...)"
            aria-label="Optional business website URL"
            className="sm:col-span-3 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-slate-100"
          />
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            aria-label="Research mode"
            className="sm:col-span-2 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 font-mono text-slate-100"
          >
            <option value="LIVE_RESEARCH">Live Public Research</option>
            <option value="FIXTURE_SIMULATION">Fixture Simulation (Offline)</option>
          </select>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as typeof language)}
            aria-label="Deliverable language"
            className="sm:col-span-1 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 font-mono text-slate-100"
          >
            <option value="en">EN</option>
            <option value="it">IT</option>
            <option value="fr">FR</option>
            <option value="ar">AR</option>
          </select>
          <input
            type="number"
            step="0.05"
            min="0"
            max="20"
            value={maxCostUsd}
            onChange={(e) => setMaxCostUsd(Number(e.target.value))}
            aria-label="Mission max cost cap USD"
            title="Mission cost cap (USD)"
            className="sm:col-span-1 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 font-mono text-slate-100"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-[#94A3B8] cursor-pointer">
            <input
              type="checkbox"
              checked={allowFixtureFallback}
              onChange={(e) => setAllowFixtureFallback(e.target.checked)}
              className="rounded border-[#2A344B] bg-[#06080E]"
            />
            Preserve ability to proceed with clearly labeled FIXTURE fallback if live sources are offline
          </label>
          <button
            type="submit"
            disabled={running}
            className="min-h-[40px] px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs uppercase rounded flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" /> {running ? 'Researching...' : 'Start Validation Mission'}
          </button>
        </div>

        {statusMsg && <div className="text-xs font-mono text-cyan-300">{statusMsg}</div>}
        {errorMsg && <div className="text-xs font-mono text-rose-400">{errorMsg}</div>}
      </form>

      {/* Main Split Workspace: Stored Missions vs Detailed Evaluation */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left column: Stored Validation Missions */}
        <div className="lg:col-span-4 nexa-plane rounded-lg p-4 space-y-3">
          <div className="text-xs font-mono uppercase text-[#94A3B8]">Validation Missions ({missions.length})</div>
          {loading && missions.length === 0 ? (
            <div className="text-xs font-mono text-[#64748B] py-4">Loading validation missions...</div>
          ) : missions.length === 0 ? (
            <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs text-[#94A3B8] space-y-1">
              <p>No Phase 7 validation missions recorded yet.</p>
              <p className="text-[#64748B]">Start a live public research mission or offline fixture above to verify evidence, opportunity scoring, and QA.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[540px] overflow-y-auto">
              {missions.map((m) => (
                <div
                  key={m.id}
                  className={`p-3 rounded border text-xs transition-colors ${
                    activeId === m.id ? 'border-cyan-400 bg-cyan-500/10' : 'border-[#1E2534] bg-[#06080E]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => selectMission(m.id)}
                      className="text-left font-semibold text-slate-100 hover:text-cyan-300 cursor-pointer flex-1"
                    >
                      {m.niche} · {m.market}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteMission(m.id)}
                      title="Delete mission"
                      aria-label={`Delete mission ${m.id}`}
                      className="text-[#64748B] hover:text-rose-400 cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="font-mono text-[11px] text-[#94A3B8] mt-1 tabular-nums">
                    {m.researchStatus} · {m.status} · {m.totalRequests} req · ${m.totalCostUsd.toFixed(4)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right column: Active Mission Inspection & Deliverables */}
        <div className="lg:col-span-8 nexa-plane rounded-lg p-4 space-y-4">
          {!details ? (
            <div className="text-xs text-[#94A3B8] py-8 text-center">
              Select or run a Phase 7 validation mission to inspect verified sources, opportunity scoring, deliverables, and independent QA.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1E2534]">
                <div>
                  <div className="text-sm font-semibold text-slate-100">
                    {details.mission.niche} ({details.mission.market})
                  </div>
                  <div className="font-mono text-[11px] text-[#94A3B8] tabular-nums">
                    Mode: {details.mission.mode} · Research: {details.mission.researchStatus} · Mission: {details.mission.status} · Cost Cap: $
                    {details.mission.maxCostUsd.toFixed(2)}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      { id: 'sources', label: `Sources (${details.sources.length})` },
                      { id: 'opportunities', label: `Opportunities (${details.opportunities.length})` },
                      { id: 'deliverable', label: 'Deliverable Preview' },
                      { id: 'qa', label: `Independent QA (${latestDeliverable?.qaStatus || 'NONE'})` },
                      { id: 'package', label: 'Client Package & Export' },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSubTab(t.id)}
                      className={`min-h-[34px] px-2.5 rounded text-xs font-mono border whitespace-nowrap shrink-0 cursor-pointer ${
                        subTab === t.id
                          ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                          : 'border-[#1E2534] bg-[#06080E] text-[#94A3B8]'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {details.mission.limitations.length > 0 && (
                <div className="bg-[#06080E] border border-amber-500/30 rounded p-3 text-xs space-y-1">
                  <div className="font-mono text-[11px] uppercase text-amber-300">Observed Limitations &amp; Notices</div>
                  {details.mission.limitations.map((lim, i) => (
                    <div key={i} className="text-[#CBD5E1]">
                      · {lim}
                    </div>
                  ))}
                </div>
              )}

              {details.mission.checkpoint && (
                <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1.5 font-mono">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] uppercase text-cyan-300">
                      Resumable Checkpoint · Stage: {details.mission.checkpoint.stage}
                    </span>
                    {details.mission.checkpoint.exportedDir && (
                      <span className="text-[11px] text-emerald-400">
                        Exported: {details.mission.checkpoint.exportedDir}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-[#CBD5E1]">
                    Completed: {details.mission.checkpoint.completedActions.join(' -> ')}
                  </div>
                  <div className="text-[11px] text-[#94A3B8]">
                    Next Action: {details.mission.checkpoint.nextExecutableAction}
                  </div>
                </div>
              )}

              {/* SUBTAB 1: SOURCES */}
              {subTab === 'sources' && (
                <div className="space-y-2.5 max-h-[520px] overflow-y-auto">
                  {details.sources.length === 0 ? (
                    <p className="text-xs text-[#94A3B8]">
                      Zero verifiable sources retrieved ({details.mission.researchStatus}). No synthetic facts invented.
                    </p>
                  ) : (
                    details.sources.map((src) => (
                      <div key={src.id} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-slate-100">{src.sourceTitle}</span>
                          <span
                            className={`font-mono text-[11px] ${
                              src.evidenceClassification === 'VERIFIED_SOURCE_DATA'
                                ? 'text-emerald-400'
                                : src.evidenceClassification === 'SIMULATED_DATA'
                                  ? 'text-amber-300'
                                  : 'text-rose-300'
                            }`}
                          >
                            {src.evidenceClassification} · {Math.round(src.confidence * 100)}% conf
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-[#64748B] flex flex-wrap items-center gap-2">
                          <span>Provider: {src.sourceProvider}</span>
                          <span aria-hidden="true">·</span>
                          <span>Retrieved: {src.retrievedAt.slice(0, 19).replace('T', ' ')}Z</span>
                          {src.sourceUrl && (
                            <>
                              <span aria-hidden="true">·</span>
                              <a
                                href={src.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-cyan-300 hover:underline inline-flex items-center gap-1"
                              >
                                Open Source <ExternalLink className="w-3 h-3" />
                              </a>
                            </>
                          )}
                        </div>
                        <p className="text-[#CBD5E1]">{src.relevantEvidence}</p>
                        <p className="text-[11px] text-[#94A3B8]">Limitation: {src.limitations}</p>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* SUBTAB 2: OPPORTUNITY COMPARISON & SCORING */}
              {subTab === 'opportunities' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-[#94A3B8]">
                      Compare scored digital service options. Evidence confidence strictly tracks verified vs simulated sources.
                    </div>
                    <button
                      type="button"
                      disabled={running || !details.mission.selectedOpportunityId}
                      onClick={() => handleGenerateDeliverable(null)}
                      className="min-h-[38px] px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs uppercase rounded whitespace-nowrap cursor-pointer disabled:opacity-50"
                    >
                      Generate Deliverable for Selected
                    </button>
                  </div>

                  {details.opportunities.map((opp) => (
                    <div
                      key={opp.id}
                      className={`p-4 rounded border space-y-3 text-xs ${
                        opp.isSelected ? 'border-cyan-400 bg-cyan-500/5' : 'border-[#1E2534] bg-[#06080E]'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-slate-100">{opp.title}</div>
                          <div className="font-mono text-[11px] text-[#94A3B8] mt-0.5 tabular-nums">
                            {opp.serviceCategory} · Effort: {opp.estimatedEffortHours}h [ESTIMATE] · Initial Infra: EUR {opp.estimatedOperatingCostEur}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <div className="text-right font-mono tabular-nums">
                            <div className="text-sm font-semibold text-cyan-300">{opp.totalScore}/100</div>
                            <div className="text-[10px] text-[#94A3B8]">Evidence Conf: {opp.evidenceConfidence}/100</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleSelectOpportunity(opp.id)}
                            className={`min-h-[34px] px-3 rounded font-mono text-xs border whitespace-nowrap cursor-pointer ${
                              opp.isSelected
                                ? 'border-emerald-400 text-emerald-300 bg-emerald-500/10'
                                : 'border-[#2A344B] text-slate-200 hover:border-cyan-400'
                            }`}
                          >
                            {opp.isSelected ? 'Selected' : 'Select Opportunity'}
                          </button>
                        </div>
                      </div>

                      <p className="text-[#CBD5E1]">{opp.problemStatement}</p>
                      <p className="text-[#94A3B8]">Solution: {opp.proposedSolution}</p>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-[#1E2534]">
                        {opp.criteria.map((c) => (
                          <div key={c.key} className="bg-[#0B111E] border border-[#1E2534] rounded p-2">
                            <div className="flex justify-between font-mono text-[11px] tabular-nums">
                              <span className="text-slate-200">{c.label}</span>
                              <span className="text-cyan-300">{c.score}/100</span>
                            </div>
                            <div className="text-[10px] text-[#94A3B8] mt-1">{c.rationale}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* SUBTAB 3: DELIVERABLE PREVIEW */}
              {subTab === 'deliverable' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={running || !details.mission.selectedOpportunityId}
                        onClick={() => handleGenerateDeliverable(null)}
                        className="min-h-[38px] px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs uppercase rounded whitespace-nowrap cursor-pointer disabled:opacity-50"
                      >
                        {latestDeliverable ? 'Generate Fresh Deliverable' : 'Generate Deliverable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewWidth((w) => (w === 'desktop' ? 'mobile' : 'desktop'))}
                        className="min-h-[38px] px-3 bg-[#06080E] border border-[#2A344B] text-xs font-mono text-slate-200 rounded whitespace-nowrap cursor-pointer"
                      >
                        Viewport: {previewWidth === 'desktop' ? 'Desktop' : 'Mobile (390px)'}
                      </button>
                    </div>
                    {latestDeliverable && (
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-mono text-xs tabular-nums text-slate-200">
                          Rev #{latestDeliverable.revisionNumber} · QA: {latestDeliverable.qaStatus} ({latestDeliverable.qaScore}/100)
                        </div>
                        {latestDeliverable.qaStatus === 'READY' && (
                          <a
                            href={`/preview/p7/${encodeURIComponent(latestDeliverable.id)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="min-h-[34px] px-3 bg-[#06080E] border border-emerald-500/40 text-emerald-300 text-xs font-mono rounded inline-flex items-center gap-1.5 whitespace-nowrap"
                          >
                            Open Isolated Preview <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>

                  {!latestDeliverable ? (
                    <div className="bg-[#06080E] border border-[#1E2534] rounded p-6 text-center text-xs text-[#94A3B8]">
                      No deliverable generated yet. Click "Generate Deliverable" to produce the responsive HTML5 prototype and run Independent QA.
                    </div>
                  ) : (
                    <div className="border border-[#1E2534] rounded bg-[#06080E] p-3 flex justify-center">
                      <iframe
                        title="Phase 7 Sandboxed Deliverable Preview"
                        sandbox=""
                        srcDoc={latestDeliverable.deliverableHtml}
                        className={`bg-white rounded border border-[#1E2534] h-[480px] transition-all ${
                          previewWidth === 'mobile' ? 'w-[390px]' : 'w-full'
                        }`}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* SUBTAB 4: INDEPENDENT QA & REVISIONS */}
              {subTab === 'qa' && (
                <div className="space-y-4">
                  {!latestDeliverable?.qaReport ? (
                    <div className="text-xs text-[#94A3B8] py-4">Generate a deliverable first to inspect the independent QA scorecard.</div>
                  ) : (
                    <>
                      <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div>
                          <div className="font-semibold text-slate-100">
                            Independent Reviewer: {latestDeliverable.qaReport.reviewerAgentId} (Generator: {latestDeliverable.qaReport.generatorAgentId})
                          </div>
                          <div className="font-mono text-[11px] text-[#94A3B8] tabular-nums mt-0.5">
                            Revision #{latestDeliverable.revisionNumber} · Total Score: {latestDeliverable.qaReport.totalScore}/100 · Self-Approval Blocked:{' '}
                            {latestDeliverable.qaReport.independentReviewVerified ? 'YES' : 'NO'}
                          </div>
                        </div>
                        <div
                          className={`font-mono text-xs font-semibold ${
                            latestDeliverable.qaReport.status === 'READY'
                              ? 'text-emerald-400'
                              : latestDeliverable.qaReport.status === 'BLOCKED'
                                ? 'text-rose-400'
                                : 'text-amber-300'
                          }`}
                        >
                          QA STATUS: {latestDeliverable.qaReport.status}
                        </div>
                      </div>

                      {latestDeliverable.qaReport.findings.length > 0 && (
                        <div className="bg-[#06080E] border border-rose-500/40 rounded p-3 text-xs space-y-1">
                          <div className="font-mono text-[11px] uppercase text-rose-300">Required Revision Findings</div>
                          {latestDeliverable.qaReport.findings.map((f, idx) => (
                            <div key={idx} className="text-slate-200">
                              · {f}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                        {latestDeliverable.qaReport.criteria.map((c) => (
                          <div key={c.criterion} className="bg-[#06080E] border border-[#1E2534] rounded p-3">
                            <div className="flex justify-between font-mono text-[11px] tabular-nums">
                              <span className="text-slate-100 font-semibold">{c.label}</span>
                              <span className={c.passed ? 'text-emerald-400' : 'text-rose-400'}>
                                {c.score}/{c.maxScore} · {c.passed ? 'PASS' : 'FAIL'}
                              </span>
                            </div>
                            <p className="text-[#94A3B8] text-[11px] mt-1">{c.finding}</p>
                          </div>
                        ))}
                      </div>

                      <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-2.5">
                        <div className="text-xs font-mono uppercase text-cyan-300">Request Deliverable Revision &amp; Re-Run QA</div>
                        <textarea
                          value={revisionNote}
                          onChange={(e) => setRevisionNote(e.target.value)}
                          rows={2}
                          className="w-full bg-[#0B111E] border border-[#1E2534] rounded px-3 py-2 text-xs text-slate-100"
                          aria-label="Revision guidance notes"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            disabled={running}
                            onClick={() => handleGenerateDeliverable('MISSING_VIEWPORT')}
                            className="min-h-[34px] px-3 bg-[#0B111E] border border-[#2A344B] text-[11px] font-mono text-amber-300 rounded cursor-pointer"
                          >
                            Test QA Gate (Missing Viewport Defect)
                          </button>
                          <button
                            type="button"
                            disabled={running}
                            onClick={() => handleReviseDeliverable(latestDeliverable.id)}
                            className="min-h-[38px] px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs uppercase rounded flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                          >
                            <Wrench className="w-3.5 h-3.5" /> Apply Revision &amp; Re-Verify QA
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* SUBTAB 5: ORGANIZED CLIENT PACKAGE & EXPORT */}
              {subTab === 'package' && (
                <div className="space-y-3">
                  {!latestDeliverable ? (
                    <div className="text-xs text-[#94A3B8] py-4">Generate a deliverable first to inspect and export the client-ready package.</div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-mono text-[#94A3B8]">
                          QA Status: <span className="text-slate-100">{latestDeliverable.qaStatus}</span>
                          {details.mission.providerUsed ? ` · AI: ${details.mission.providerUsed}` : ' · Deterministic template'} · Zero external transmit
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={running || latestDeliverable.qaStatus !== 'READY'}
                            onClick={() => handleExportToDisk(details.mission.id)}
                            className="min-h-[36px] px-3 bg-emerald-500/20 border border-emerald-400/50 text-emerald-200 text-xs font-mono rounded flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                          >
                            <Download className="w-3.5 h-3.5" /> Persist Bundle to Disk
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              downloadBlob(`nexa-package-${details.mission.id}.md`, latestDeliverable.presentationMarkdown, 'text/markdown;charset=utf-8')
                            }
                            className="min-h-[36px] px-3 bg-[#06080E] border border-cyan-500/40 text-cyan-300 text-xs font-mono rounded flex items-center gap-1.5 cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5" /> Export .MD
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              downloadBlob(`nexa-deliverable-${details.mission.id}.html`, latestDeliverable.deliverableHtml, 'text/html;charset=utf-8')
                            }
                            className="min-h-[36px] px-3 bg-[#06080E] border border-cyan-500/40 text-cyan-300 text-xs font-mono rounded flex items-center gap-1.5 cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5" /> Export .HTML
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              downloadBlob(
                                `nexa-bundle-${details.mission.id}.json`,
                                JSON.stringify(latestDeliverable.packageBundle, null, 2),
                                'application/json;charset=utf-8'
                              )
                            }
                            className="min-h-[36px] px-3 bg-[#06080E] border border-[#2A344B] text-slate-200 text-xs font-mono rounded flex items-center gap-1.5 cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5" /> Export .JSON
                          </button>
                        </div>
                      </div>

                      <pre className="bg-[#06080E] border border-[#1E2534] rounded p-4 text-xs font-mono text-[#CBD5E1] whitespace-pre-wrap max-h-[460px] overflow-y-auto">
                        {latestDeliverable.presentationMarkdown}
                      </pre>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
