import { useEffect, useState } from 'react';
import { Check, Play, RefreshCw, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface SandboxStageState {
  order: number;
  id: string;
  title: string;
  agentId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'AWAITING_APPROVAL' | 'FAILED' | 'BLOCKED' | 'CANCELLED';
  attempts: number;
  costUsd: number;
  tokensUsed: number;
  latencyMs: number;
  summary: string | null;
  error: string | null;
  failureClassification: string | null;
}

interface SandboxRunSummary {
  runId: string;
  missionId: string;
  environmentMode: 'SANDBOX';
  niche: string;
  cityOrMarket: string;
  language: string;
  status: string;
  completedStages: number;
  totalStages: number;
  totalCostUsd: number;
  totalTokens: number;
  blockedExternalActionsCount: number;
  approvalId: number | null;
  createdAt: string;
  lastError: string | null;
}

interface SandboxRunDetails {
  policy: {
    environmentMode: 'SANDBOX';
    storageIsolation: string;
    writesToProductionDb: boolean;
    externalPayments: string;
    customerOutreach: string;
    messaging: string;
    publishing: string;
    liveTrading: string;
    approvalBypass: string;
  };
  run: {
    runId: string;
    missionId: string;
    environmentMode: 'SANDBOX';
    niche: string;
    cityOrMarket: string;
    language: string;
    status: string;
    maxCostUsd: number;
    maxRetries: number;
    totalCostUsd: number;
    totalTokens: number;
    approvalId: number | null;
    lastError: string | null;
    failureClassification: string | null;
    createdAt: string;
    completedAt: string | null;
  };
  stages: SandboxStageState[];
  opportunities: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  businessPlans: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
  sites: Array<Record<string, unknown>>;
  contentAssets: Array<Record<string, unknown>>;
  riskEvaluations: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  agentExecutions: Array<Record<string, unknown>>;
  auditEvents: Array<Record<string, unknown>>;
  blockedExternalActions: Array<{
    id: string;
    stageId: string;
    actionType: string;
    target: string;
    policyResult: string;
    reason: string;
    timestamp: string;
  }>;
  simulatedMetrics: Record<string, unknown>;
  finalReportMarkdown: string | null;
}

export function CommerceSandboxWorkspace() {
  const [runs, setRuns] = useState<SandboxRunSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [details, setDetails] = useState<SandboxRunDetails | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [niche, setNiche] = useState('Physiotherapy Clinics');
  const [cityOrMarket, setCityOrMarket] = useState('Milan');
  const [language, setLanguage] = useState<'en' | 'it' | 'ar' | 'fr'>('en');
  const [maxCostUsd, setMaxCostUsd] = useState(0.25);
  const [simulationMode, setSimulationMode] = useState<
    'NONE' | 'AGENT_FAILURE' | 'RETRY_EXHAUSTION' | 'TIMEOUT' | 'INVALID_AI_OUTPUT' | 'COST_CEILING_EXCEEDED'
  >('NONE');
  const [approvalNote, setApprovalNote] = useState('Verified SANDBOX deliverables and zero external side-effects.');
  const [inspectTab, setInspectTab] = useState<
    'opportunities' | 'evidence' | 'plan' | 'proposal_demo' | 'marketing_risk' | 'agents_audit' | 'report'
  >('opportunities');

  async function loadRuns(selectId?: string | null) {
    setLoadingList(true);
    try {
      const data = await apiFetch<{ runs: SandboxRunSummary[] }>('/api/commerce/sandbox');
      setRuns(data.runs || []);
      const targetId = selectId !== undefined ? selectId : activeRunId || data.runs?.[0]?.runId || null;
      if (targetId && data.runs.some((r) => r.runId === targetId)) {
        setActiveRunId(targetId);
        await loadDetails(targetId);
      } else if (!data.runs.length) {
        setActiveRunId(null);
        setDetails(null);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to load sandbox runs');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadDetails(runId: string) {
    setLoadingDetails(true);
    try {
      const data = await apiFetch<SandboxRunDetails>(`/api/commerce/sandbox/${encodeURIComponent(runId)}`);
      setDetails(data);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to inspect sandbox run');
    } finally {
      setLoadingDetails(false);
    }
  }

  useEffect(() => {
    loadRuns();
  }, []);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const created = await apiFetch<SandboxRunDetails>('/api/commerce/sandbox/start', {
        method: 'POST',
        body: JSON.stringify({
          niche,
          cityOrMarket,
          language,
          maxCostUsd: Number(maxCostUsd),
          maxRetries: 1,
          stageTimeoutMs: 4000,
          simulationMode,
        }),
      });
      setActiveRunId(created.run.runId);
      setDetails(created);
      setStatusMsg(
        created.run.status === 'AWAITING_APPROVAL'
          ? `Sandbox run ${created.run.runId} paused cleanly at Stage 10 Human Approval Gate (#${created.run.approvalId}). Zero production DB writes.`
          : `Sandbox run ${created.run.runId} finished initial pass with status ${created.run.status}.`
      );
      await loadRuns(created.run.runId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start sandbox mission');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprovalDecision(decision: 'approved' | 'rejected') {
    if (!details) return;
    setDeciding(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const updated = await apiFetch<SandboxRunDetails>(`/api/commerce/sandbox/${encodeURIComponent(details.run.runId)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ decision, note: approvalNote }),
      });
      setDetails(updated);
      setStatusMsg(
        decision === 'approved'
          ? `Approval granted: Stages 11–14 completed in SANDBOX (${updated.blockedExternalActions.length} external actions denied). Verified real revenue remains €0.00.`
          : `Approval rejected: Stages 11–14 cleanly blocked.`
      );
      await loadRuns(updated.run.runId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to record approval decision');
    } finally {
      setDeciding(false);
    }
  }

  async function handleCancelRun(runId: string) {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const updated = await apiFetch<SandboxRunDetails>(`/api/commerce/sandbox/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
      });
      setDetails(updated);
      setStatusMsg(`Sandbox run ${runId} cancelled cleanly; downstream stages halted.`);
      await loadRuns(runId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to cancel sandbox mission');
    }
  }

  async function handleDeleteRun(runId: string) {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await apiFetch(`/api/commerce/sandbox/${encodeURIComponent(runId)}`, { method: 'DELETE' });
      setStatusMsg(`Isolated sandbox fixture ${runId} discarded from memory (real DB untouched).`);
      await loadRuns(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to discard sandbox mission');
    }
  }

  const stageStatusColor = (st: SandboxStageState['status']) => {
    if (st === 'COMPLETED') return 'text-emerald-400';
    if (st === 'AWAITING_APPROVAL') return 'text-amber-300';
    if (st === 'RUNNING') return 'text-cyan-300';
    if (st === 'FAILED') return 'text-rose-400';
    if (st === 'BLOCKED' || st === 'CANCELLED') return 'text-rose-300/80';
    return 'text-[#64748B]';
  };

  return (
    <div className="space-y-5">
      {/* Strict SANDBOX Policy & Isolation Header */}
      <div className="nexa-plane rounded-lg p-4 border border-amber-500/40 bg-[#0B111E]/90 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-amber-300 shrink-0" />
            <span className="text-xs font-mono font-semibold uppercase tracking-wider text-amber-200">
              SANDBOX MODE — ISOLATED IN-MEMORY SQLITE FIXTURE
            </span>
          </div>
          <div className="font-mono text-[11px] text-emerald-300">
            REAL DB WRITES: NONE · EXTERNAL PAYMENTS / OUTREACH / SMS / EMAIL / ADS / PUBLISHING: DENIED
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px]">
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Environment Lock</div>
            <div className="text-amber-300 mt-0.5">SANDBOX ONLY</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Verified Real Revenue</div>
            <div className="text-slate-100 tabular-nums mt-0.5">€0.00 (SEPARATED)</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Active Sandbox Runs</div>
            <div className="text-cyan-300 tabular-nums mt-0.5">{runs.length} FIXTURE(S)</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Blocked External Calls</div>
            <div className="text-emerald-400 tabular-nums mt-0.5">{details?.blockedExternalActions.length ?? 0} INTERCEPTED</div>
          </div>
        </div>
      </div>

      {/* Mission Launch Controls */}
      <form onSubmit={handleStart} className="nexa-plane rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-mono uppercase text-cyan-300">Launch 14-Stage Autonomous Commerce Sandbox Pipeline</div>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              Executes dependency-gated synthetic discovery, scoring, evidence, feasibility, planning, proposal, landing page draft, risk review &amp; human approval gate inside an isolated in-memory fixture.
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadRuns()}
            className="min-h-[36px] px-3 bg-[#06080E] border border-[#2A344B] text-xs font-mono text-cyan-300 rounded flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 text-xs">
          <input
            type="text"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="Simulated SMB niche (min 3 chars)"
            aria-label="Sandbox niche"
            className="sm:col-span-3 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-slate-100"
          />
          <input
            type="text"
            value={cityOrMarket}
            onChange={(e) => setCityOrMarket(e.target.value)}
            placeholder="Simulated city/market"
            aria-label="Sandbox market"
            className="sm:col-span-2 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-slate-100"
          />
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as 'en' | 'it' | 'ar' | 'fr')}
            aria-label="Sandbox language"
            className="sm:col-span-1 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 font-mono text-slate-100"
          >
            <option value="en">EN</option>
            <option value="it">IT</option>
            <option value="fr">FR</option>
            <option value="ar">AR</option>
          </select>
          <input
            type="number"
            step="0.01"
            min="0"
            max="50"
            value={maxCostUsd}
            onChange={(e) => setMaxCostUsd(Number(e.target.value))}
            aria-label="Sandbox cost cap USD"
            title="Max telemetry cost ceiling (USD)"
            className="sm:col-span-2 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 font-mono text-slate-100"
          />
          <select
            value={simulationMode}
            onChange={(e) => setSimulationMode(e.target.value as typeof simulationMode)}
            aria-label="Sandbox fault scenario"
            className="sm:col-span-2 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 font-mono text-slate-100"
          >
            <option value="NONE">Standard E2E Run</option>
            <option value="AGENT_FAILURE">Test Transient Retry</option>
            <option value="RETRY_EXHAUSTION">Test Retry Exhaustion</option>
            <option value="TIMEOUT">Test Stage Timeout</option>
            <option value="INVALID_AI_OUTPUT">Test Invalid AI Output</option>
            <option value="COST_CEILING_EXCEEDED">Test Cost Ceiling Block</option>
          </select>
          <button
            type="submit"
            disabled={submitting}
            className="sm:col-span-2 min-h-[40px] bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold uppercase text-xs rounded flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" /> {submitting ? 'Running...' : 'Start Sandbox'}
          </button>
        </div>

        {statusMsg && <div className="text-xs font-mono text-cyan-300">{statusMsg}</div>}
        {errorMsg && <div className="text-xs font-mono text-rose-400">{errorMsg}</div>}
      </form>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left: Sandbox Run History & 14-Stage Pipeline */}
        <div className="lg:col-span-5 space-y-4">
          <div className="nexa-plane rounded-lg p-4 space-y-2.5">
            <div className="text-xs font-mono text-[#94A3B8] uppercase">Isolated Sandbox Missions ({runs.length})</div>
            {loadingList ? (
              <p className="text-xs font-mono text-[#94A3B8] py-4">Loading sandbox fixtures...</p>
            ) : runs.length === 0 ? (
              <p className="text-xs text-[#64748B] py-4">
                No sandbox missions active. Start a deterministic 14-stage commerce sandbox above.
              </p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {runs.map((r) => (
                  <div
                    key={r.runId}
                    onClick={() => {
                      setActiveRunId(r.runId);
                      loadDetails(r.runId);
                    }}
                    className={`bg-[#06080E] border rounded p-2.5 text-xs cursor-pointer flex items-center justify-between gap-2 ${
                      activeRunId === r.runId ? 'border-cyan-400' : 'border-[#1E2534] hover:border-[#2A344B]'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-cyan-300 truncate">
                        [SANDBOX] {r.niche} · {r.cityOrMarket}
                      </div>
                      <div className="font-mono text-[10px] text-[#94A3B8] tabular-nums">
                        {r.runId} · {r.status} · {r.completedStages}/{r.totalStages} stages
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {(r.status === 'RUNNING' || r.status === 'AWAITING_APPROVAL') && (
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handleCancelRun(r.runId);
                          }}
                          className="min-h-[28px] px-2 bg-[#111726] border border-rose-500/40 text-rose-300 font-mono text-[10px] rounded cursor-pointer"
                        >
                          Cancel
                        </button>
                      )}
                      {r.status !== 'RUNNING' && (
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handleDeleteRun(r.runId);
                          }}
                          title="Discard sandbox fixture"
                          className="min-h-[28px] px-2 bg-[#111726] border border-[#2A344B] text-[#94A3B8] hover:text-rose-300 rounded cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {details && (
            <div className="nexa-plane rounded-lg p-4 space-y-2.5">
              <div className="flex items-center justify-between border-b border-[#1E2534] pb-2">
                <div className="text-xs font-mono text-[#94A3B8] uppercase">14-Stage Dependency Pipeline</div>
                <span className="text-[11px] font-mono text-cyan-300 tabular-nums">
                  ${details.run.totalCostUsd.toFixed(5)} / {details.run.totalTokens} tok
                </span>
              </div>
              <div className="space-y-1.5 max-h-[520px] overflow-y-auto font-mono text-[11px]">
                {details.stages.map((st) => (
                  <div key={st.id} className="bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-2 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-100 font-medium">{st.title}</span>
                      <span className={`font-semibold shrink-0 ${stageStatusColor(st.status)}`}>{st.status}</span>
                    </div>
                    <div className="text-[10px] text-[#64748B] flex flex-wrap justify-between gap-2">
                      <span>agent: {st.agentId}</span>
                      <span className="tabular-nums">
                        tries {st.attempts} · {st.latencyMs}ms · ${st.costUsd.toFixed(5)}
                      </span>
                    </div>
                    {st.summary && <div className="text-[10.5px] text-[#94A3B8] font-sans">{st.summary}</div>}
                    {st.error && (
                      <div className="text-[10.5px] text-rose-300">
                        {st.failureClassification ? `[${st.failureClassification}] ` : ''}
                        {st.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Stage 10 Human Approval Gate + Detailed Sandbox Deliverables & Audit */}
        <div className="lg:col-span-7 space-y-4">
          {!details ? (
            <div className="nexa-plane rounded-lg p-8 text-center space-y-2">
              <ShieldAlert className="w-6 h-6 text-amber-300 mx-auto" />
              <div className="text-sm font-semibold text-slate-200">Isolated Sandbox Inspector Ready</div>
              <p className="text-xs text-[#94A3B8] max-w-md mx-auto">
                Start or select a sandbox run to follow all 14 stages, inspect synthetic opportunities/evidence/proposals/landing previews, decide Stage 10 human approval gates, and audit blocked external side effects.
              </p>
            </div>
          ) : loadingDetails ? (
            <div className="nexa-plane rounded-lg p-8 text-center text-xs font-mono text-[#94A3B8]">Loading sandbox inspection payload...</div>
          ) : (
            <>
              {details.run.status === 'AWAITING_APPROVAL' && (
                <div className="nexa-plane rounded-lg p-4 border border-amber-400/50 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-mono text-amber-300 uppercase font-semibold">
                      Stage 10 Human Approval Gate (#{details.run.approvalId}) — Execution Paused
                    </div>
                    <span className="text-[11px] font-mono text-[#94A3B8]">Stages 11–14 locked until explicit decision</span>
                  </div>
                  <p className="text-xs text-slate-200">
                    Review discovered [SANDBOX] opportunities, feasibility metrics, proposal exclusions, risk score (14/100), and verify that real payments, customer outreach, emails, SMS, and web publishing remain DENIED.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="text"
                      value={approvalNote}
                      onChange={(e) => setApprovalNote(e.target.value)}
                      placeholder="Approval / rejection audit note..."
                      className="flex-1 min-w-[200px] min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
                    />
                    <button
                      type="button"
                      disabled={deciding}
                      onClick={() => handleApprovalDecision('approved')}
                      className="min-h-[38px] px-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs font-mono rounded flex items-center gap-1 cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" /> Approve Stages 11–14
                    </button>
                    <button
                      type="button"
                      disabled={deciding}
                      onClick={() => handleApprovalDecision('rejected')}
                      className="min-h-[38px] px-3.5 bg-rose-600/20 border border-rose-500/50 text-rose-200 font-semibold text-xs font-mono rounded flex items-center gap-1 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" /> Reject &amp; Block
                    </button>
                  </div>
                </div>
              )}

              <div className="nexa-plane rounded-lg p-4 space-y-4">
                <div className="flex flex-wrap gap-1.5 border-b border-[#1E2534] pb-3">
                  {(
                    [
                      { id: 'opportunities', label: `Opportunities (${details.opportunities.length})` },
                      { id: 'evidence', label: `Research Evidence (${details.evidence.length})` },
                      { id: 'plan', label: 'Feasibility & Plan' },
                      { id: 'proposal_demo', label: 'Proposal & Demo Site' },
                      { id: 'marketing_risk', label: `Risk & Blocked (${details.blockedExternalActions.length})` },
                      { id: 'agents_audit', label: `Agent Runs & Audit (${details.agentExecutions.length})` },
                      { id: 'report', label: 'Final Report' },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setInspectTab(t.id)}
                      className={`min-h-[34px] px-2.5 text-[11px] font-mono rounded border cursor-pointer ${
                        inspectTab === t.id
                          ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                          : 'border-[#1E2534] bg-[#06080E] text-[#94A3B8]'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {inspectTab === 'opportunities' && (
                  <div className="space-y-2">
                    {details.opportunities.map((opp) => (
                      <div key={String(opp.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1">
                        <div className="flex flex-wrap justify-between gap-2 font-mono">
                          <span className="text-slate-100 font-semibold">{String(opp.title)}</span>
                          <span className="text-cyan-300 tabular-nums">
                            Priority {String(opp.priority_score)} · Confidence {String(opp.confidence_score)} · {String(opp.priority_tier)}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-amber-300">
                          Decision: {String(opp.qualification_decision)} · {String(opp.revenue_model)} · SIMULATED FIXTURE
                        </div>
                        <p className="text-[11px] text-[#94A3B8]">{String(opp.problem_statement)}</p>
                      </div>
                    ))}
                  </div>
                )}

                {inspectTab === 'evidence' && (
                  <div className="space-y-2.5">
                    {details.sources.map((src) => (
                      <div key={String(src.id)} className="bg-[#06080E] border border-cyan-500/30 rounded p-2.5 text-xs font-mono">
                        <div className="text-cyan-300">{String(src.title)}</div>
                        <div className="text-[10.5px] text-[#64748B]">
                          Mode: {String(src.retrieval_status)} · URI: {String(src.url)}
                        </div>
                      </div>
                    ))}
                    <div className="space-y-1.5 max-h-64 overflow-y-auto">
                      {details.evidence.map((ev) => (
                        <div key={String(ev.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-2.5 text-xs flex justify-between gap-3">
                          <span className="text-slate-200">{String(ev.claim)}</span>
                          <span className="font-mono text-[10px] uppercase text-cyan-300 shrink-0">
                            {String(ev.evidence_type)} ({Number(ev.confidence || 0).toFixed(2)})
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {inspectTab === 'plan' && (
                  <div className="space-y-3 text-xs">
                    {details.businessPlans.length === 0 ? (
                      <p className="text-[#64748B]">Stage 5 Business Plan not reached yet.</p>
                    ) : (
                      details.businessPlans.map((bp) => {
                        const econ = JSON.parse(String(bp.unit_economics_json || '{}')) as Record<string, unknown>;
                        const milestones = JSON.parse(String(bp.strategic_milestones_json || '[]')) as Array<{
                          phase: string;
                          title: string;
                          targetDays: number;
                        }>;
                        return (
                          <div key={String(bp.id)} className="space-y-3">
                            <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-1">
                              <div className="font-mono text-[11px] text-amber-300">
                                {String(bp.id)} · SANDBOX FEASIBILITY SCORE: {String(bp.feasibility_score)}/100 (SIMULATED)
                              </div>
                              <p className="text-slate-200">{String(bp.executive_summary)}</p>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px]">
                              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                                <div className="text-[#64748B] text-[9px]">SIMULATED SETUP</div>
                                <div className="text-slate-100">€{String(econ.setupPriceEur)}</div>
                              </div>
                              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                                <div className="text-[#64748B] text-[9px]">EST. COST</div>
                                <div className="text-amber-300">€{String(econ.estimatedDeliveryCostEur)}</div>
                              </div>
                              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                                <div className="text-[#64748B] text-[9px]">SIMULATED MARGIN</div>
                                <div className="text-emerald-400">€{String(econ.estimatedFirstMonthMarginEur)}</div>
                              </div>
                              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                                <div className="text-[#64748B] text-[9px]">HOURS EST.</div>
                                <div className="text-cyan-300">{String(econ.estimatedHours)}h</div>
                              </div>
                            </div>
                            <div className="space-y-1.5">
                              {milestones.map((m) => (
                                <div key={m.phase} className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2 font-mono text-[11px] flex justify-between">
                                  <span className="text-slate-200">
                                    {m.phase}: {m.title}
                                  </span>
                                  <span className="text-[#94A3B8]">Day {m.targetDays}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {inspectTab === 'proposal_demo' && (
                  <div className="space-y-3 text-xs">
                    {details.proposals.map((p) => (
                      <div key={String(p.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-1.5">
                        <div className="flex justify-between font-mono text-[11px]">
                          <span className="text-cyan-300">{String(p.title)}</span>
                          <span className="text-amber-300">{String(p.status)} · SANDBOX</span>
                        </div>
                        <pre className="text-[11px] text-[#94A3B8] whitespace-pre-wrap">{String(p.outreach_body)}</pre>
                      </div>
                    ))}
                    {details.sites.map((s) => (
                      <div key={String(s.id)} className="space-y-2">
                        <div className="font-mono text-[11px] text-amber-300">
                          UNPUBLISHED SANDBOX HTML DRAFT: {String(s.id)} ({String(s.status)})
                        </div>
                        <iframe
                          title="Isolated Sandbox Storefront Preview"
                          sandbox=""
                          srcDoc={String(s.html_content || '')}
                          className="w-full h-72 rounded border border-[#1E2534] bg-[#06080E]"
                        />
                      </div>
                    ))}
                    {details.proposals.length === 0 && details.sites.length === 0 && (
                      <p className="text-[#64748B]">Proposal and landing page draft have not completed yet.</p>
                    )}
                  </div>
                )}

                {inspectTab === 'marketing_risk' && (
                  <div className="space-y-4 text-xs">
                    {details.riskEvaluations.map((rk) => {
                      const findings = JSON.parse(String(rk.findings_json || '[]')) as Array<{
                        control: string;
                        status: string;
                        detail: string;
                      }>;
                      return (
                        <div key={String(rk.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-2">
                          <div className="flex justify-between font-mono text-[11px]">
                            <span className="text-emerald-400">RISK AUDIT: {String(rk.compliance_status)}</span>
                            <span className="text-cyan-300">Score {String(rk.risk_score)}/100</span>
                          </div>
                          {findings.map((f, i) => (
                            <div key={i} className="font-mono text-[10.5px] text-slate-200">
                              [{f.status}] {f.control} — <span className="text-[#94A3B8]">{f.detail}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })}

                    <div className="space-y-1.5">
                      <div className="font-mono text-[11px] text-amber-300 uppercase">
                        Blocked External Side Effects ({details.blockedExternalActions.length})
                      </div>
                      {details.blockedExternalActions.length === 0 ? (
                        <p className="text-[#64748B]">Blocked side-effect log populates once Stage 11 Sandbox Execution runs after human approval.</p>
                      ) : (
                        details.blockedExternalActions.map((b) => (
                          <div key={b.id} className="bg-[#06080E] border border-emerald-500/30 rounded px-3 py-2 font-mono text-[11px]">
                            <div className="flex justify-between text-emerald-300">
                              <span>{b.actionType}</span>
                              <span>{b.policyResult}</span>
                            </div>
                            <div className="text-[#94A3B8] text-[10px]">
                              target: {b.target} · {b.reason}
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    {details.contentAssets.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="font-mono text-[11px] text-[#94A3B8] uppercase">
                          Draft Marketing Assets (Outbound Send Denied)
                        </div>
                        {details.contentAssets.map((ca) => (
                          <div key={String(ca.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-2.5 text-[11px]">
                            <div className="font-mono text-cyan-300">{String(ca.title)}</div>
                            <pre className="text-[#94A3B8] whitespace-pre-wrap mt-1">{String(ca.body)}</pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {inspectTab === 'agents_audit' && (
                  <div className="space-y-3 text-xs font-mono">
                    <div className="overflow-x-auto max-h-56">
                      <table className="w-full text-start">
                        <thead className="text-[10px] text-[#94A3B8] border-b border-[#1E2534]">
                          <tr>
                            <th className="py-1.5 pe-2">Agent</th>
                            <th className="py-1.5 pe-2">Status</th>
                            <th className="py-1.5 pe-2 text-end">Latency</th>
                            <th className="py-1.5 pe-2 text-end">Tokens</th>
                            <th className="py-1.5 text-end">Cost USD</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1E2534]/50 text-[11px]">
                          {details.agentExecutions.map((ar) => (
                            <tr key={String(ar.id)}>
                              <td className="py-1.5 pe-2 text-slate-200">{String(ar.agent_id)}</td>
                              <td className={`py-1.5 pe-2 ${ar.status === 'SUCCESS' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {String(ar.status)}
                              </td>
                              <td className="py-1.5 pe-2 text-end tabular-nums text-[#94A3B8]">{String(ar.latency_ms)}ms</td>
                              <td className="py-1.5 pe-2 text-end tabular-nums text-slate-200">
                                {Number(ar.tokens_in || 0) + Number(ar.tokens_out || 0)}
                              </td>
                              <td className="py-1.5 text-end tabular-nums text-cyan-300">${Number(ar.cost_usd || 0).toFixed(5)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="divide-y divide-[#1E2534]/60 max-h-44 overflow-y-auto text-[10.5px]">
                      {details.auditEvents.map((ev) => (
                        <div key={String(ev.id)} className="py-1.5 flex justify-between gap-2">
                          <span className="text-cyan-300">
                            {String(ev.category)} · {String(ev.event)}
                          </span>
                          <span className="text-[#64748B]">{String(ev.created_at).slice(0, 19)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {inspectTab === 'report' && (
                  <div className="space-y-3 text-xs">
                    <div className="bg-[#06080E] border border-amber-500/30 rounded p-3 font-mono text-[11px] flex flex-wrap justify-between gap-2">
                      <span className="text-amber-300">
                        SIMULATED DATA ONLY · IS_SIMULATED={String(details.simulatedMetrics.isSimulated ?? true)}
                      </span>
                      <span className="text-emerald-300">VERIFIED REAL REVENUE: €0.00</span>
                    </div>
                    <pre className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-[11px] font-mono text-slate-200 whitespace-pre-wrap max-h-80 overflow-y-auto">
                      {details.finalReportMarkdown || 'Final Mission Report generates cleanly at Stage 14 after Stage 10 approval.'}
                    </pre>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
