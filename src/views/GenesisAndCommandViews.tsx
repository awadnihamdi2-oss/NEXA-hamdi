import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Ban,
  CheckCircle2,
  Eye,
  EyeOff,
  Mic,
  MicOff,
  Play,
  Send,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { NexaCoreCanvas } from '../components/NexaCoreCanvas';
import { apiFetch } from '../lib/api';
import { I18N } from '../lib/i18n';
import type { CoreState, EnvironmentId, HealthSnapshot, LangCode, UiLang } from '../types/ui';

interface GenesisProps {
  lang: UiLang;
  lowPowerMode: boolean;
  health: HealthSnapshot | null;
  coreState: CoreState;
  setCoreState: (s: CoreState) => void;
  zenInspect: boolean;
  setZenInspect: (z: boolean) => void;
  onNavigate: (id: EnvironmentId) => void;
  onRefreshHealth: () => void;
}

interface ModelPreviewRow {
  agentId: string;
  agentName: string;
  taskClass: string;
  providerId: string | null;
  modelId: string | null;
  mode: string;
}

interface InterpretResult {
  objective: string;
  domain: string;
  targetEnvironment: EnvironmentId;
  agents: string[];
  waves: string[][];
  freeProvidersConfigured: string[];
  requiresHumanApproval: boolean;
  estimatedStages: number;
  ambiguityFlags?: string[];
  clarificationPrompt?: string | null;
  selectedModelPreviews?: ModelPreviewRow[];
}

const CALIBRATED_STATES: CoreState[] = [
  'dormant',
  'aware',
  'listening',
  'reasoning',
  'collaborating',
  'executing',
  'speaking',
  'completed',
  'failed',
];

const LIFECYCLE_STAGES = [
  { key: 'PROPOSED', label: 'Proposed' },
  { key: 'AWAITING_APPROVAL', label: 'Approval Gate' },
  { key: 'PLANNED', label: 'Scheduled' },
  { key: 'RUNNING', label: 'Running' },
  { key: 'COMPLETED', label: 'Completed' },
] as const;

export function GenesisView({
  lang,
  health,
  coreState,
  setCoreState,
  zenInspect,
  setZenInspect,
  onNavigate,
  onRefreshHealth,
}: GenesisProps) {
  const t = I18N[lang];
  const [objective, setObjective] = useState('');
  const [domain, setDomain] = useState('general');
  const [allowMock, setAllowMock] = useState(true);
  const [useLiveResearch, setUseLiveResearch] = useState(false);
  const [preferredProvider, setPreferredProvider] = useState('');
  const [preferredModel, setPreferredModel] = useState('');
  const [providers, setProviders] = useState<Array<{ id: string; displayName: string; configured: boolean; enabled: boolean; isPaidByDefault: boolean }>>([]);
  const [models, setModels] = useState<Array<{ id: string; providerId: string; freeVerified: boolean; enabled: boolean }>>([]);
  const [interpreting, setInterpreting] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [plan, setPlan] = useState<InterpretResult | null>(null);
  const [executedMission, setExecutedMission] = useState<{
    id: string;
    status: string;
    finalSynthesis: string | null;
    wavesCount: number;
  } | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ providers: typeof providers }>('/api/providers'),
      apiFetch<{ models: typeof models }>('/api/models?freeOnly=true'),
    ])
      .then(([p, m]) => {
        setProviders(p.providers || []);
        setModels(m.models || []);
      })
      .catch(() => {});
  }, []);

  async function handleInterpret() {
    if (objective.trim().length < 3) {
      setStatusMsg('Provide at least 3 characters to map execution waves.');
      return;
    }
    setInterpreting(true);
    setCoreState('reasoning');
    setStatusMsg(null);
    setExecutedMission(null);
    try {
      const res = await apiFetch<InterpretResult>('/api/genesis/interpret', {
        method: 'POST',
        body: JSON.stringify({ objective }),
      });
      setPlan(res);
      setDomain(res.domain);
      setCoreState('collaborating');
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Interpretation error');
      setCoreState('failed');
    } finally {
      setInterpreting(false);
    }
  }

  async function handleExecute(e: React.FormEvent) {
    e.preventDefault();
    if (objective.trim().length < 10) {
      setStatusMsg('Mission pipeline requires at least 10 characters.');
      return;
    }
    setLaunching(true);
    setCoreState('executing');
    setStatusMsg(null);
    try {
      const res = await apiFetch<{
        mission: {
          id: string;
          status: string;
          finalSynthesis: string | null;
          verificationSummary?: { executionWaves?: string[][] };
        };
      }>('/api/missions', {
        method: 'POST',
        body: JSON.stringify({
          objective,
          domain,
          autoExecute: true,
          allowMockFallback: allowMock,
          useLiveResearch,
          preferredProvider: preferredProvider || undefined,
          preferredModel: preferredModel || undefined,
        }),
      });
      setCoreState(res.mission.status === 'COMPLETED' ? 'completed' : 'failed');
      setExecutedMission({
        id: res.mission.id,
        status: res.mission.status,
        finalSynthesis: res.mission.finalSynthesis,
        wavesCount: res.mission.verificationSummary?.executionWaves?.length || 0,
      });
      setStatusMsg(`Mission ${res.mission.id} sealed (${res.mission.status}).`);
      setObjective('');
      onRefreshHealth();
    } catch (err) {
      setCoreState('failed');
      setStatusMsg(err instanceof Error ? err.message : 'Execution halted');
    } finally {
      setLaunching(false);
    }
  }

  const stateCopy = t.coreStates[coreState];
  const currentStageKey = executedMission
    ? executedMission.status
    : launching
      ? 'RUNNING'
      : plan
        ? 'PLANNED'
        : objective.trim().length >= 3
          ? 'PROPOSED'
          : null;

  return (
    <div className="min-h-[calc(100vh-140px)] flex flex-col justify-between gap-6">
      {/* 01. Monumental Open Header + Zen Sculpture Inspection Trigger */}
      <div className="pt-2 sm:pt-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="space-y-1 max-w-2xl">
          <div className="text-xs font-mono tracking-wider text-sky-400">
            {t.genesis.kicker}
          </div>
          {!zenInspect && (
            <h1 className="text-xl sm:text-3xl font-semibold tracking-tight text-[#F4F6FA] leading-snug">
              {t.genesis.headline}
            </h1>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 self-stretch sm:self-auto">
          <div className="nexa-plane rounded px-3 py-2 flex items-center gap-3 text-xs font-mono">
            <span className="text-[#94A3B8]">Resonance</span>
            <span className="text-[#F4F6FA] font-medium">{stateCopy.label}</span>
          </div>
          <button
            type="button"
            onClick={() => setZenInspect(!zenInspect)}
            className="min-h-[38px] px-3.5 nexa-plane hover:border-sky-400 text-xs font-mono text-sky-300 rounded flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            {zenInspect ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            <span>{zenInspect ? t.common.restoreHud : t.common.inspectCore}</span>
          </button>
        </div>
      </div>

      {/* Deliberate Unobstructed Spatial Aperture exposing the Procedural Sculpture */}
      <div className={zenInspect ? 'flex-1' : 'h-[19vh] sm:h-[26vh] lg:h-[31vh] pointer-events-none'} aria-hidden="true" />

      {/* 02. Lower Focal Anchor (Hidden cleanly when Inspect Monument / Zen mode is active) */}
      {!zenInspect && (
        <div className="max-w-4xl w-full mx-auto space-y-3">
          {/* Clean full-word 9-state resonance calibration bar */}
          <div className="flex flex-wrap items-center justify-center gap-1 px-2">
            {CALIBRATED_STATES.map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setCoreState(st)}
                className={`min-h-[32px] px-2.5 text-[11px] font-mono rounded transition-colors cursor-pointer border whitespace-nowrap ${
                  coreState === st
                    ? 'bg-sky-500/18 border-sky-400 text-[#F4F6FA]'
                    : 'bg-[#060911]/90 border-[#1E2534] text-[#94A3B8] hover:text-[#F4F6FA]'
                }`}
              >
                {t.coreStates[st].shortLabel}
              </button>
            ))}
          </div>

          {/* Spatial Command Plane */}
          <div className="nexa-plane rounded-lg p-4 sm:p-5 space-y-4">
            <form onSubmit={handleExecute} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#94A3B8]">
                <span className="font-mono">{t.common.freeOnlyLock}</span>
                <span className="font-mono text-amber-300">{t.common.paperOnlyLock}</span>
              </div>

              <textarea
                value={objective}
                onChange={(e) => {
                  setObjective(e.target.value);
                  if (coreState === 'dormant') setCoreState('aware');
                }}
                rows={2}
                placeholder={t.genesis.commandPlaceholder}
                className="w-full bg-[#030508] border border-[#1E2534] rounded-md px-3.5 py-2.5 text-sm text-[#F4F6FA] placeholder-slate-500 focus:outline-none focus:border-sky-400"
              />

              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <select
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    className="min-h-[44px] bg-[#030508] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-400"
                  >
                    <option value="general">General Orchestration</option>
                    <option value="quant">Quant Research</option>
                    <option value="software">Engineering</option>
                    <option value="commerce">Commerce</option>
                    <option value="research">Research Observatory</option>
                  </select>

                  <select
                    value={preferredProvider}
                    onChange={(e) => {
                      setPreferredProvider(e.target.value);
                      setPreferredModel('');
                    }}
                    aria-label="Preferred AI provider"
                    className="min-h-[44px] bg-[#030508] border border-[#1E2534] rounded px-2.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-400"
                  >
                    <option value="">Router: Auto Free-First</option>
                    {providers
                      .filter((p) => p.enabled && (!p.isPaidByDefault || p.configured))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id}{p.configured ? '' : ' (unconfigured)'}
                        </option>
                      ))}
                  </select>

                  <select
                    value={preferredModel}
                    onChange={(e) => setPreferredModel(e.target.value)}
                    aria-label="Preferred model"
                    className="min-h-[44px] max-w-[190px] bg-[#030508] border border-[#1E2534] rounded px-2.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-400"
                  >
                    <option value="">Model: Auto</option>
                    {models
                      .filter((m) => m.enabled && (!preferredProvider || m.providerId === preferredProvider))
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                  </select>

                  <label className="flex items-center gap-1.5 text-xs text-[#94A3B8] cursor-pointer min-h-[44px]">
                    <input
                      type="checkbox"
                      checked={useLiveResearch}
                      onChange={(e) => setUseLiveResearch(e.target.checked)}
                      className="accent-sky-400"
                    />
                    Live research
                  </label>

                  <label className="flex items-center gap-1.5 text-xs text-[#94A3B8] cursor-pointer min-h-[44px]">
                    <input
                      type="checkbox"
                      checked={allowMock}
                      onChange={(e) => setAllowMock(e.target.checked)}
                      className="accent-sky-400"
                    />
                    Offline fallback
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={interpreting}
                    onClick={handleInterpret}
                    className="min-h-[44px] px-4 bg-[#0B111E] border border-[#2A344B] hover:border-sky-400 text-[#F4F6FA] font-mono text-xs rounded flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                    {interpreting ? 'Mapping...' : t.common.interpretObjective}
                  </button>
                  <button
                    type="submit"
                    disabled={launching}
                    className="min-h-[44px] px-5 bg-sky-400 hover:bg-sky-300 disabled:opacity-50 text-slate-950 font-semibold text-xs rounded flex items-center gap-2 cursor-pointer whitespace-nowrap"
                  >
                    <Play className="w-3.5 h-3.5" />
                    {launching ? 'Executing...' : t.common.launchMission}
                  </button>
                </div>
              </div>
            </form>

            {/* Transparent Execution Lifecycle Rail */}
            {currentStageKey && (
              <div className="pt-2 border-t border-[#1E2534] flex flex-wrap items-center gap-2 text-[11px] font-mono">
                <span className="text-[#64748B]">Lifecycle:</span>
                {LIFECYCLE_STAGES.map((st, i) => {
                  const active = currentStageKey === st.key;
                  const halted = executedMission?.status === 'FAILED' || executedMission?.status === 'CANCELLED';
                  return (
                    <span key={st.key} className="inline-flex items-center gap-2">
                      <span className={active ? 'text-sky-300 font-semibold' : 'text-[#64748B]'}>
                        {st.label}
                      </span>
                      {i < LIFECYCLE_STAGES.length - 1 && (
                        <span className="text-[#334155]" aria-hidden="true">→</span>
                      )}
                      {i === LIFECYCLE_STAGES.length - 1 && halted && (
                        <span className="text-rose-400">({executedMission?.status})</span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Calibrated Example Directives */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-2 border-t border-[#1E2534]">
              {t.genesis.quickPrompts.map((qp) => (
                <button
                  key={qp.label}
                  type="button"
                  onClick={() => {
                    setObjective(qp.prompt);
                    setDomain(qp.domain);
                    setCoreState('aware');
                  }}
                  className="text-start py-2 px-3 bg-[#030508]/85 border border-[#1E2534] hover:border-sky-400/60 rounded transition-colors cursor-pointer"
                >
                  <div className="text-xs font-medium text-sky-300 truncate">{qp.label}</div>
                  <div className="text-[11px] text-[#64748B] truncate mt-0.5">{qp.prompt}</div>
                </button>
              ))}
            </div>

            {/* Real Intention + Ambiguity Analysis + Wave Plan + Model Selection */}
            {plan && (
              <div className="bg-[#030508] border border-sky-500/35 rounded p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                  <span className="text-sky-300">
                    Understood: {plan.domain} · {plan.waves.length} waves · {plan.estimatedStages} specialists
                    {plan.requiresHumanApproval ? ' · Human approval required' : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => onNavigate(plan.targetEnvironment)}
                    className="text-sky-300 hover:text-sky-200 underline flex items-center gap-1 cursor-pointer"
                  >
                    {t.common.openWorkspace}: {t.envs[plan.targetEnvironment].shortLabel}
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </div>

                {plan.ambiguityFlags && plan.ambiguityFlags.length > 0 && (
                  <div className="border border-amber-500/30 bg-amber-950/15 rounded p-2.5 space-y-1 text-xs">
                    <div className="flex items-center gap-1.5 font-mono text-amber-300">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>Ambiguity & Scope Check</span>
                    </div>
                    {plan.ambiguityFlags.map((flag, i) => (
                      <div key={i} className="text-[#CBD5E1] text-[11px]">· {flag}</div>
                    ))}
                    {plan.clarificationPrompt && (
                      <div className="text-[#94A3B8] text-[11px]">{plan.clarificationPrompt}</div>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  {plan.waves.map((wave, idx) => (
                    <div key={idx} className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                      <span className="text-[#64748B] w-14">Wave {idx + 1}</span>
                      <span className="text-slate-200">{wave.join(' · ')}</span>
                    </div>
                  ))}
                </div>

                {plan.selectedModelPreviews && plan.selectedModelPreviews.length > 0 && (
                  <div className="pt-2 border-t border-[#1E2534] text-[11px] font-mono text-[#94A3B8] space-y-1">
                    <div className="text-[#64748B]">Model Allocation (Strict Free-First Policy):</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                      {plan.selectedModelPreviews.slice(0, 6).map((mp) => (
                        <div key={mp.agentId} className="truncate">
                          <span className="text-slate-300">{mp.agentId}</span>
                          <span className="text-[#64748B]"> → </span>
                          <span className={mp.providerId ? 'text-sky-300' : 'text-amber-300'}>
                            {mp.providerId ? `${mp.providerId}/${mp.modelId}` : 'Offline simulation fallback'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {executedMission && (
              <div className="bg-[#030508] border border-emerald-500/35 rounded p-3.5 space-y-1.5">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Verified Completion · {executedMission.id} ({executedMission.wavesCount} waves)
                  </span>
                  <button
                    type="button"
                    onClick={() => onNavigate('command')}
                    className="text-sky-300 underline cursor-pointer"
                  >
                    Inspect Pipeline
                  </button>
                </div>
                {executedMission.finalSynthesis && (
                  <p className="text-xs text-[#94A3B8] line-clamp-3">{executedMission.finalSynthesis}</p>
                )}
              </div>
            )}

            {statusMsg && !executedMission && (
              <div className="text-xs font-mono text-sky-300">{statusMsg}</div>
            )}
          </div>

          {/* 03. Open Horizon Meridian Metrics */}
          <div className="nexa-plane rounded-lg px-4 py-3 grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-[#1E2534] gap-3 sm:gap-0 text-xs">
            {[
              { label: 'Missions', value: health?.counts?.missions ?? 0, target: 'command' as EnvironmentId },
              { label: 'Agent Runs', value: health?.counts?.agentRuns ?? 0, target: 'network' as EnvironmentId },
              { label: 'Sources', value: health?.counts?.sources ?? 0, target: 'research' as EnvironmentId },
              { label: 'Backtests', value: health?.counts?.backtests ?? 0, target: 'quant' as EnvironmentId },
            ].map((m) => (
              <button
                key={m.label}
                type="button"
                onClick={() => onNavigate(m.target)}
                className="text-start sm:px-4 first:ps-0 last:pe-0 hover:text-sky-300 transition-colors cursor-pointer"
              >
                <div className="text-[11px] font-mono text-[#64748B]">{m.label}</div>
                <div className="text-lg font-mono font-semibold text-[#F4F6FA] tabular-nums mt-0.5 flex items-center justify-between">
                  <span>{m.value}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-sky-400" />
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- ENVIRONMENT 02: COMMAND CENTER (MISSIONS + DIALOGUE + LIVE AUDIO VOICE) ----------------
interface ChatMsg {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  language: LangCode;
  provider_id?: string;
  model_id?: string;
}

interface MissionDetail {
  id: string;
  objective: string;
  status: string;
  finalSynthesis: string | null;
  retryCount?: number;
  maxRetries?: number;
  failureClassification?: string | null;
  lastError?: string | null;
  totalCostUsd?: number;
  verificationSummary?: { executionWaves?: string[][]; contradictionsDetected?: string[]; verifiedFactsCount?: number; hypothesesCount?: number };
  steps: Array<{ stepOrder: number; title: string; status: string; required: boolean; failureClassification?: string | null; lastError?: string | null }>;
  agentRuns: Array<{ id: number; agentId: string; providerId: string; modelId: string; status: string; isMock: boolean; output: { summary?: string } | null }>;
}

const COMMAND_LIFECYCLE = ['PLANNED', 'AWAITING_APPROVAL', 'RUNNING', 'PAUSED', 'RETRYING', 'REVIEWING', 'COMPLETED', 'FAILED', 'CANCELLED'];

export function CommandView({
  lang,
  lowPowerMode,
  coreState,
  setCoreState,
  audioLevel,
  setAudioLevel,
  onRefreshHealth,
}: {
  lang: UiLang;
  lowPowerMode: boolean;
  coreState: CoreState;
  setCoreState: (s: CoreState) => void;
  audioLevel: number;
  setAudioLevel: (lvl: number) => void;
  onRefreshHealth: () => void;
}) {
  const [mode, setMode] = useState<'missions' | 'dialogue' | 'voice'>('missions');

  const [missions, setMissions] = useState<Array<{ id: string; objective: string; domain: string; status: string; createdAt: string; totalTokens: number }>>([]);
  const [selected, setSelected] = useState<MissionDetail | null>(null);
  const [objective, setObjective] = useState('');
  const [domain, setDomain] = useState('general');
  const [preferredProvider, setPreferredProvider] = useState('');
  const [useLiveResearch, setUseLiveResearch] = useState(false);
  const [providers, setProviders] = useState<Array<{ id: string; configured: boolean; enabled: boolean }>>([]);
  const [bridgeLinks, setBridgeLinks] = useState<
    Array<{ id: number; mission_id: string; commerce_task_id: string; objective: string; state: string; created_at: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [bridgeMsg, setBridgeMsg] = useState<string | null>(null);

  const [chatLang, setChatLang] = useState<LangCode>(lang === 'ar' ? 'ar' : lang === 'fr' ? 'fr' : 'en');
  const [conversations, setConversations] = useState<Array<{ id: string; title: string; language: string }>>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [allowMock, setAllowMock] = useState(true);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [voiceLang, setVoiceLang] = useState<LangCode>('ar');
  const [transcript, setTranscript] = useState('');
  const [voiceReply, setVoiceReply] = useState('');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceRate, setVoiceRate] = useState(1.0);
  const [browserSupport, setBrowserSupport] = useState({ stt: false, tts: false });
  const [matchedVoiceName, setMatchedVoiceName] = useState<string>('System Default');

  const audioCleanupRef = useRef<(() => void) | null>(null);

  function loadMissions() {
    apiFetch<{ missions: typeof missions }>('/api/missions').then((d) => setMissions(d.missions || [])).catch(() => {});
  }

  function loadBridgeLinks(missionId?: string) {
    const q = missionId ? `?missionId=${encodeURIComponent(missionId)}` : '';
    apiFetch<{ links: typeof bridgeLinks }>(`/api/bridge/links${q}`)
      .then((d) => setBridgeLinks(d.links || []))
      .catch(() => {});
  }

  useEffect(() => {
    loadMissions();
    loadBridgeLinks();
    apiFetch<{ providers: typeof providers }>('/api/providers')
      .then((d) => setProviders(d.providers || []))
      .catch(() => {});
    apiFetch<{ conversations: Array<{ id: string; title: string; language: string }> }>('/api/conversations')
      .then((d) => setConversations(d.conversations || []))
      .catch(() => {});
    const win = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    setBrowserSupport({
      stt: Boolean(win.SpeechRecognition || win.webkitSpeechRecognition),
      tts: typeof window !== 'undefined' && 'speechSynthesis' in window,
    });
    return () => {
      audioCleanupRef.current?.();
      setAudioLevel(0);
    };
  }, [setAudioLevel]);

  async function inspectMission(id: string) {
    const res = await apiFetch<{ mission: MissionDetail }>(`/api/missions/${id}`);
    setSelected(res.mission);
    loadBridgeLinks(id);
  }

  async function createAndRun(e: React.FormEvent) {
    e.preventDefault();
    if (objective.trim().length < 10) return;
    setBusy(true);
    setCoreState('executing');
    try {
      const res = await apiFetch<{ mission: MissionDetail }>('/api/missions', {
        method: 'POST',
        body: JSON.stringify({
          objective,
          domain,
          autoExecute: true,
          allowMockFallback: allowMock,
          useLiveResearch,
          preferredProvider: preferredProvider || undefined,
        }),
      });
      setObjective('');
      setSelected(res.mission);
      setCoreState(res.mission.status === 'COMPLETED' ? 'completed' : 'failed');
      loadMissions();
      loadBridgeLinks(res.mission.id);
      onRefreshHealth();
    } catch {
      setCoreState('failed');
    } finally {
      setBusy(false);
    }
  }

  async function cancelSelected() {
    if (!selected) return;
    await apiFetch(`/api/missions/${selected.id}/cancel`, { method: 'POST' });
    inspectMission(selected.id);
    loadMissions();
  }

  async function pauseSelected() {
    if (!selected) return;
    await apiFetch(`/api/missions/${selected.id}/pause`, { method: 'POST' });
    inspectMission(selected.id);
    loadMissions();
  }

  async function resumeSelected() {
    if (!selected) return;
    setBusy(true);
    setCoreState('executing');
    try {
      const res = await apiFetch<{ mission: MissionDetail }>(`/api/missions/${selected.id}/resume`, {
        method: 'POST',
        body: JSON.stringify({
          allowMockFallback: allowMock,
          useLiveResearch,
          preferredProvider: preferredProvider || undefined,
        }),
      });
      setSelected(res.mission);
      setCoreState(res.mission.status === 'COMPLETED' ? 'completed' : 'failed');
      loadMissions();
      onRefreshHealth();
    } finally {
      setBusy(false);
    }
  }

  async function retrySelected() {
    if (!selected) return;
    setBusy(true);
    setCoreState('executing');
    try {
      const res = await apiFetch<{ mission: MissionDetail }>(`/api/missions/${selected.id}/retry`, {
        method: 'POST',
        body: JSON.stringify({
          allowMockFallback: allowMock,
          useLiveResearch,
          preferredProvider: preferredProvider || undefined,
        }),
      });
      setSelected(res.mission);
      setCoreState(res.mission.status === 'COMPLETED' ? 'completed' : 'failed');
      loadMissions();
      onRefreshHealth();
    } catch (err) {
      setBridgeMsg(err instanceof Error ? err.message : 'Retry limit reached');
      setCoreState('failed');
    } finally {
      setBusy(false);
    }
  }

  async function testBridgeLink(execute: boolean) {
    if (!selected) return;
    const res = await apiFetch<{ executed: boolean; commerceTaskId?: string }>('/api/bridge/link', {
      method: 'POST',
      body: JSON.stringify({
        missionId: selected.id,
        commerceTaskId: `tsk_${selected.id.slice(4)}`,
        objective: selected.objective,
        execute,
      }),
    });
    setBridgeMsg(res.executed ? `Bridge linked transactionally (task ${res.commerceTaskId})` : 'Dry-run preview validated (no DB write).');
    if (res.executed) {
      loadBridgeLinks(selected.id);
    }
  }

  async function loadConversation(id: string) {
    setActiveConvId(id);
    const res = await apiFetch<{ messages: ChatMsg[] }>(`/api/conversations/${id}/messages`);
    setMessages(res.messages || []);
  }

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    const prompt = chatInput.trim();
    setChatInput('');
    setSending(true);
    setChatError(null);
    setCoreState('reasoning');
    setMessages((prev) => [...prev, { role: 'user', content: prompt, language: chatLang }]);
    try {
      const res = await apiFetch<{ conversationId: string; reply: string; providerId: string; modelId: string }>('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          conversationId: activeConvId || undefined,
          message: prompt,
          language: chatLang,
          preferredProvider: preferredProvider || undefined,
          allowMockFallback: allowMock,
        }),
      });
      setActiveConvId(res.conversationId);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: res.reply, language: chatLang, provider_id: res.providerId, model_id: res.modelId },
      ]);
      setCoreState('completed');
      const listRes = await apiFetch<{ conversations: Array<{ id: string; title: string; language: string }> }>('/api/conversations');
      setConversations(listRes.conversations || []);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Chat routing error');
      setCoreState('failed');
    } finally {
      setSending(false);
    }
  }

  const LANG_BCP: Record<LangCode, string> = { ar: 'ar-SA', it: 'it-IT', en: 'en-US', fr: 'fr-FR' };

  function speakText(text: string, targetLang: LangCode) {
    if (!('speechSynthesis' in window) || !text.trim()) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const matched =
      voices.find((v) => v.lang.toLowerCase().startsWith(targetLang)) ||
      voices.find((v) => v.lang.toLowerCase().includes(targetLang));
    if (matched) {
      utter.voice = matched;
      setMatchedVoiceName(`${matched.name} (${matched.lang})`);
    } else {
      setMatchedVoiceName('No native voice for language — text fallback active');
    }
    utter.lang = LANG_BCP[targetLang];
    utter.rate = voiceRate;

    let speakTimer = 0;
    utter.onstart = () => {
      setSpeaking(true);
      setCoreState('speaking');
      speakTimer = window.setInterval(() => {
        setAudioLevel(0.28 + Math.random() * 0.35);
      }, 90);
    };
    const cleanupSpeak = () => {
      clearInterval(speakTimer);
      setAudioLevel(0);
      setSpeaking(false);
      setCoreState('aware');
    };
    utter.onend = cleanupSpeak;
    utter.onerror = cleanupSpeak;
    window.speechSynthesis.speak(utter);
  }

  async function processVoiceCommand(text: string) {
    setCoreState('reasoning');
    try {
      const res = await apiFetch<{ reply: string }>('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ message: text, language: voiceLang, allowMockFallback: true }),
      });
      setVoiceReply(res.reply);
      speakText(res.reply, voiceLang);
    } catch (err) {
      setVoiceReply(err instanceof Error ? err.message : 'Voice processing error');
      setCoreState('failed');
    }
  }

  async function startMicMeter() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let raf = 0;
      let stopped = false;

      const sample = () => {
        if (stopped) return;
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const norm = Math.min(1, sum / (data.length * 140));
        setAudioLevel(norm);
        raf = requestAnimationFrame(sample);
      };
      raf = requestAnimationFrame(sample);

      audioCleanupRef.current = () => {
        stopped = true;
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((tr) => tr.stop());
        ctx.close().catch(() => {});
        setAudioLevel(0);
      };
    } catch {
      // Permission declined or unavailable in container — graceful fallback without error
    }
  }

  function startListening() {
    const win = window as unknown as {
      SpeechRecognition?: new () => {
        lang: string;
        interimResults: boolean;
        onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
        onerror: () => void;
        onend: () => void;
        start: () => void;
      };
      webkitSpeechRecognition?: new () => {
        lang: string;
        interimResults: boolean;
        onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
        onerror: () => void;
        onend: () => void;
        start: () => void;
      };
    };
    const Rec = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!Rec) return;

    const recognition = new Rec();
    recognition.lang = LANG_BCP[voiceLang];
    recognition.interimResults = false;
    setListening(true);
    setCoreState('listening');
    void startMicMeter();

    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript || '';
      setTranscript(text);
      audioCleanupRef.current?.();
      setListening(false);
      if (text) processVoiceCommand(text);
    };
    recognition.onerror = () => {
      audioCleanupRef.current?.();
      setListening(false);
      setCoreState('aware');
    };
    recognition.onend = () => {
      audioCleanupRef.current?.();
      setListening(false);
    };
    recognition.start();
  }

  return (
    <div className="space-y-5">
      <div className="nexa-plane rounded-lg p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              { id: 'missions', label: '01. Mission Kernel' },
              { id: 'dialogue', label: '02. Multilingual Dialogue' },
              { id: 'voice', label: '03. Acoustic Voice' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMode(tab.id)}
              className={`min-h-[42px] px-4 text-xs font-mono rounded border cursor-pointer whitespace-nowrap ${
                mode === tab.id
                  ? 'bg-sky-500/15 border-sky-400 text-sky-300'
                  : 'bg-[#030508] border-[#1E2534] text-[#94A3B8] hover:text-[#F4F6FA]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <span className="font-mono text-xs text-[#94A3B8]">Resonance: {I18N[lang].coreStates[coreState].label}</span>
      </div>

      {mode === 'missions' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-5 space-y-4">
            <form onSubmit={createAndRun} className="nexa-plane rounded-lg p-4 space-y-3">
              <h2 className="text-sm font-semibold text-[#F4F6FA]">Execute Multi-Wave Mission</h2>
              <textarea
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                rows={3}
                placeholder="Objective (min 10 characters)..."
                className="w-full bg-[#030508] border border-[#1E2534] rounded px-3 py-2 text-xs text-[#F4F6FA]"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    className="min-h-[44px] bg-[#030508] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-200"
                  >
                    <option value="general">General</option>
                    <option value="quant">Quant</option>
                    <option value="software">Software</option>
                    <option value="commerce">Commerce</option>
                    <option value="research">Research</option>
                  </select>
                  <select
                    value={preferredProvider}
                    onChange={(e) => setPreferredProvider(e.target.value)}
                    aria-label="Command preferred provider"
                    className="min-h-[44px] bg-[#030508] border border-[#1E2534] rounded px-2.5 text-xs font-mono text-slate-200"
                  >
                    <option value="">Auto Free-First</option>
                    {providers
                      .filter((p) => p.enabled)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id}
                        </option>
                      ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-[11px] font-mono text-[#94A3B8] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useLiveResearch}
                      onChange={(e) => setUseLiveResearch(e.target.checked)}
                      className="accent-sky-400"
                    />
                    Live research
                  </label>
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[44px] px-4 bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-xs rounded flex items-center gap-1.5 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" /> {busy ? 'Running...' : 'Execute Pipeline'}
                </button>
              </div>
            </form>

            <div className="nexa-plane rounded-lg p-4 space-y-2 max-h-[480px] overflow-y-auto">
              <div className="text-xs font-mono text-[#94A3B8] pb-2 border-b border-[#1E2534]">Missions ({missions.length})</div>
              {missions.length === 0 ? (
                <p className="text-xs text-[#64748B] py-4">No missions recorded yet.</p>
              ) : (
                missions.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => inspectMission(m.id)}
                    className={`w-full text-start p-3 rounded border cursor-pointer ${
                      selected?.id === m.id ? 'bg-sky-500/10 border-sky-500/40' : 'bg-[#030508] border-[#1E2534] hover:border-slate-600'
                    }`}
                  >
                    <div className="flex justify-between text-[11px] font-mono">
                      <span className="text-sky-400">{m.id}</span>
                      <span className="text-slate-300">{m.status}</span>
                    </div>
                    <div className="text-xs text-slate-200 mt-1 line-clamp-2">{m.objective}</div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="lg:col-span-7 nexa-plane rounded-lg p-5">
            {!selected ? (
              <div className="text-xs text-[#64748B] py-16 text-center">
                Select a mission to inspect its lifecycle status, topological waves, specialist council outputs, contradiction flags, and signed synthesis.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-2 pb-3 border-b border-[#1E2534]">
                  <div>
                    <div className="text-xs font-mono text-sky-400">
                      {selected.id} · {selected.status}
                    </div>
                    <h3 className="text-sm font-semibold text-[#F4F6FA] mt-1">{selected.objective}</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => testBridgeLink(false)}
                      className="min-h-[38px] px-3 border border-[#2A344B] text-xs font-mono text-slate-300 rounded cursor-pointer"
                    >
                      Bridge Dry-Run
                    </button>
                    <button
                      type="button"
                      onClick={() => testBridgeLink(true)}
                      className="min-h-[38px] px-3 border border-sky-500/40 text-xs font-mono text-sky-300 rounded cursor-pointer"
                    >
                      Link Commerce Bridge
                    </button>
                    {(selected.status === 'PLANNED' || selected.status === 'RUNNING') && (
                      <button
                        type="button"
                        onClick={pauseSelected}
                        className="min-h-[38px] px-3 border border-amber-500/40 text-xs font-mono text-amber-300 rounded cursor-pointer"
                      >
                        Pause
                      </button>
                    )}
                    {selected.status === 'PAUSED' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={resumeSelected}
                        className="min-h-[38px] px-3 border border-emerald-500/40 text-xs font-mono text-emerald-300 rounded cursor-pointer"
                      >
                        Resume
                      </button>
                    )}
                    {(selected.status === 'FAILED' || selected.status === 'BLOCKED') &&
                      (selected.retryCount ?? 0) < (selected.maxRetries ?? 2) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={retrySelected}
                          className="min-h-[38px] px-3 border border-sky-400/50 text-xs font-mono text-sky-300 rounded cursor-pointer"
                        >
                          Retry ({selected.retryCount ?? 0}/{selected.maxRetries ?? 2})
                        </button>
                      )}
                    {selected.status !== 'COMPLETED' && selected.status !== 'CANCELLED' && (
                      <button
                        type="button"
                        onClick={cancelSelected}
                        className="min-h-[38px] px-3 border border-rose-500/40 text-xs font-mono text-rose-300 rounded flex items-center gap-1 cursor-pointer"
                      >
                        <Ban className="w-3.5 h-3.5" /> Cancel
                      </button>
                    )}
                  </div>
                </div>

                {/* Transparent Lifecycle Bar */}
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono bg-[#030508] border border-[#1E2534] rounded px-3 py-2">
                  {COMMAND_LIFECYCLE.map((state) => (
                    <span
                      key={state}
                      className={
                        selected.status === state
                          ? state === 'FAILED' || state === 'CANCELLED'
                            ? 'text-rose-400 font-semibold'
                            : state === 'PAUSED' || state === 'RETRYING'
                              ? 'text-amber-300 font-semibold'
                              : 'text-emerald-300 font-semibold'
                          : 'text-[#475569]'
                      }
                    >
                      {state}
                    </span>
                  ))}
                  <span className="ms-auto text-[#64748B] tabular-nums">
                    Retries: {selected.retryCount ?? 0}/{selected.maxRetries ?? 2}
                    {typeof selected.totalCostUsd === 'number' && selected.totalCostUsd > 0
                      ? ` · Cost: $${selected.totalCostUsd.toFixed(4)}`
                      : ''}
                  </span>
                </div>

                {selected.lastError && (
                  <div className="bg-rose-950/20 border border-rose-500/35 rounded p-2.5 text-xs font-mono text-rose-300">
                    Failure [{selected.failureClassification || 'internal_error'}]: {selected.lastError}
                  </div>
                )}

                {bridgeMsg && <div className="text-xs font-mono text-sky-300">{bridgeMsg}</div>}

                {bridgeLinks.length > 0 && (
                  <div className="bg-[#030508] border border-[#1E2534] rounded p-3 space-y-1.5">
                    <div className="text-[11px] font-mono text-[#94A3B8]">
                      Persisted Commerce Bridge Links ({bridgeLinks.length})
                    </div>
                    {bridgeLinks.slice(0, 5).map((bl) => (
                      <div key={bl.id} className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
                        <span className="text-cyan-300">{bl.commerce_task_id}</span>
                        <span className="text-[#94A3B8] truncate max-w-[55%]">{bl.objective}</span>
                        <span className="text-emerald-400">{bl.state}</span>
                      </div>
                    ))}
                  </div>
                )}

                {selected.verificationSummary?.executionWaves && (
                  <div className="bg-[#030508] border border-[#1E2534] rounded p-3 space-y-1.5">
                    <div className="text-[11px] font-mono text-[#94A3B8]">
                      Topological Parallel Execution Waves ({selected.verificationSummary.executionWaves.length})
                    </div>
                    {selected.verificationSummary.executionWaves.map((w, idx) => (
                      <div key={idx} className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-sky-400 w-10">W{idx + 1}</span>
                        {w.map((a) => (
                          <span key={a} className="px-2 py-0.5 bg-[#0B0F19] border border-[#1E2534] text-slate-300 rounded">
                            {a}
                          </span>
                        ))}
                      </div>
                    ))}
                    {selected.verificationSummary.contradictionsDetected &&
                      selected.verificationSummary.contradictionsDetected.length > 0 && (
                        <div className="text-[11px] font-mono text-amber-400 pt-1">
                          Contradictions flagged: {selected.verificationSummary.contradictionsDetected.join(' | ')}
                        </div>
                      )}
                  </div>
                )}

                <div>
                  <div className="text-[11px] font-mono text-[#94A3B8] mb-2">Pipeline Steps</div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {selected.steps.map((s) => (
                      <div key={s.stepOrder} className="bg-[#030508] border border-[#1E2534] rounded p-2.5 text-xs">
                        <div className="font-mono text-[10px] text-[#64748B]">
                          Step {s.stepOrder} · {s.required ? 'Required' : 'Optional'}
                        </div>
                        <div className="text-slate-200 font-medium truncate">{s.title}</div>
                        <div className={`font-mono text-[10px] mt-1 ${s.status === 'COMPLETED' ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {s.status}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {selected.finalSynthesis && (
                  <div className="bg-[#030508] border border-[#1E2534] rounded p-4">
                    <div className="text-[11px] font-mono text-sky-400 mb-1.5">Final Synthesis</div>
                    <p className="text-xs text-slate-200 whitespace-pre-wrap leading-relaxed">{selected.finalSynthesis}</p>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="text-[11px] font-mono text-[#94A3B8]">Specialist Council Outputs</div>
                  {selected.agentRuns.map((ar) => (
                    <div key={ar.id} className="bg-[#030508] border border-[#1E2534] rounded p-3 text-xs space-y-1">
                      <div className="flex justify-between font-mono text-[11px]">
                        <span className="text-slate-200">{ar.agentId}</span>
                        <span className="text-sky-400">
                          {ar.providerId}/{ar.modelId} · {ar.isMock ? 'Simulation' : 'Live'}
                        </span>
                      </div>
                      <p className="text-[#94A3B8]">{ar.output?.summary || 'No structured summary'}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {mode === 'dialogue' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-3 nexa-plane rounded-lg p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-[#94A3B8]">Threads</span>
              <button
                type="button"
                onClick={() => {
                  setActiveConvId(null);
                  setMessages([]);
                }}
                className="text-xs font-mono text-sky-400 hover:text-sky-300 cursor-pointer"
              >
                + New
              </button>
            </div>
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {conversations.length === 0 ? (
                <div className="text-xs text-[#64748B] py-4">No persisted threads yet.</div>
              ) : (
                conversations.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => loadConversation(c.id)}
                    className={`w-full text-start px-3 py-2 rounded text-xs truncate cursor-pointer border ${
                      activeConvId === c.id ? 'bg-sky-500/10 border-sky-500/50 text-sky-200' : 'bg-[#030508] border-[#1E2534] text-slate-300'
                    }`}
                  >
                    {c.title}
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="lg:col-span-9 nexa-plane rounded-lg p-4 flex flex-col min-h-[500px]">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#1E2534]">
              <div>
                <h2 className="text-base font-semibold text-[#F4F6FA]">NEXA Multilingual Intelligence</h2>
                <div className="text-xs text-[#94A3B8]">Persistent SQLite memory · PII redacted before model transmission</div>
              </div>
              <div className="flex items-center gap-2">
                {(['en', 'ar', 'it', 'fr'] as LangCode[]).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setChatLang(l)}
                    className={`min-h-[44px] px-3 text-xs font-mono uppercase rounded border cursor-pointer ${
                      chatLang === l ? 'bg-sky-500/15 border-sky-400 text-sky-300' : 'bg-[#030508] border-[#1E2534] text-[#94A3B8]'
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto py-4 space-y-3 max-h-[400px]">
              {messages.length === 0 ? (
                <div className="text-xs text-[#64748B] py-12 text-center">
                  Start a conversation in English, Arabic (العربية), Italian, or French.
                </div>
              ) : (
                messages.map((m, idx) => (
                  <div
                    key={idx}
                    dir={m.language === 'ar' || /[\u0600-\u06FF]/.test(m.content) ? 'rtl' : 'ltr'}
                    className={`p-3.5 rounded-lg border text-sm whitespace-pre-wrap ${
                      m.role === 'user' ? 'bg-[#0D1322] border-[#2A344B] text-[#F4F6FA] ms-6' : 'bg-[#030508] border-[#1E2534] text-slate-200 me-6'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[11px] font-mono text-[#64748B] mb-1.5" dir="ltr">
                      <span>{m.role === 'user' ? 'Operator' : 'NEXA Core'}</span>
                      {m.provider_id && (
                        <span className="text-sky-400">
                          {m.provider_id} / {m.model_id}
                        </span>
                      )}
                    </div>
                    {m.content}
                  </div>
                ))
              )}
            </div>

            {chatError && <div className="text-xs font-mono text-rose-400 mb-2">{chatError}</div>}

            <form onSubmit={sendMessage} className="pt-3 border-t border-[#1E2534] space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  dir={chatLang === 'ar' ? 'rtl' : 'ltr'}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={
                    chatLang === 'ar'
                      ? 'اكتب رسالتك إلى NEXA...'
                      : chatLang === 'it'
                        ? 'Scrivi un messaggio a NEXA...'
                        : chatLang === 'fr'
                          ? 'Écrivez un message à NEXA...'
                          : 'Ask NEXA to analyze, research, or plan...'
                  }
                  className="flex-1 min-h-[44px] bg-[#030508] border border-[#1E2534] rounded-md px-3.5 text-sm text-[#F4F6FA] focus:outline-none focus:border-sky-400"
                />
                <button
                  type="submit"
                  disabled={sending}
                  className="min-h-[44px] px-4 bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-xs rounded-md flex items-center gap-1.5 cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  {sending ? 'Routing...' : 'Send'}
                </button>
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-[#94A3B8] cursor-pointer">
                <input type="checkbox" checked={allowMock} onChange={(e) => setAllowMock(e.target.checked)} className="accent-sky-400" />
                Allow offline simulation if no live API key is active
              </label>
            </form>
          </div>
        </div>
      )}

      {mode === 'voice' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-5 space-y-4">
            <NexaCoreCanvas coreState={coreState} lang={lang} lowPowerMode={lowPowerMode} audioLevel={audioLevel} />
            <div className="nexa-plane rounded-lg p-4 space-y-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-[#94A3B8]">Browser STT</span>
                <span className={browserSupport.stt ? 'text-emerald-400' : 'text-amber-400'}>
                  {browserSupport.stt ? 'Supported' : 'Text Fallback'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#94A3B8]">Browser TTS</span>
                <span className={browserSupport.tts ? 'text-emerald-400' : 'text-amber-400'}>
                  {browserSupport.tts ? 'Supported' : 'Unavailable'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#94A3B8]">Acoustic Amplitude</span>
                <span className="text-sky-300 tabular-nums">{Math.round(audioLevel * 100)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#94A3B8]">Matched Voice</span>
                <span className="text-slate-200 truncate max-w-[200px]">{matchedVoiceName}</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7 nexa-plane rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#1E2534]">
              <div>
                <h2 className="text-base font-semibold text-[#F4F6FA]">Acoustic Voice & Speech Intelligence</h2>
                <p className="text-xs text-[#94A3B8]">Arabic (العربية) · Italian · English · French with live microphone telemetry</p>
              </div>
              <div className="flex items-center gap-2">
                {(['ar', 'it', 'en', 'fr'] as LangCode[]).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setVoiceLang(l)}
                    className={`min-h-[44px] px-3 text-xs font-mono uppercase rounded border cursor-pointer ${
                      voiceLang === l ? 'bg-sky-500/15 border-sky-400 text-sky-300' : 'bg-[#030508] border-[#1E2534] text-[#94A3B8]'
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!browserSupport.stt || listening}
                onClick={startListening}
                className="min-h-[44px] px-4 bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 text-xs font-semibold rounded-md flex items-center gap-2 cursor-pointer"
              >
                {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                {listening ? 'Listening...' : 'Start Microphone STT'}
              </button>

              <button
                type="button"
                disabled={!browserSupport.tts || !voiceReply}
                onClick={() => speakText(voiceReply, voiceLang)}
                className="min-h-[44px] px-4 bg-[#0B111E] border border-[#2A344B] hover:border-sky-400 text-[#F4F6FA] text-xs font-semibold rounded-md flex items-center gap-2 cursor-pointer"
              >
                <Volume2 className="w-4 h-4 text-sky-400" />
                Speak Reply
              </button>

              {speaking && (
                <button
                  type="button"
                  onClick={() => {
                    window.speechSynthesis.cancel();
                    setAudioLevel(0);
                    setSpeaking(false);
                    setCoreState('aware');
                  }}
                  className="min-h-[44px] px-3 bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs font-mono rounded-md flex items-center gap-1.5 cursor-pointer"
                >
                  <VolumeX className="w-3.5 h-3.5" /> Stop Audio
                </button>
              )}

              <label className="text-xs font-mono text-[#94A3B8] flex items-center gap-2 ms-auto">
                Speed {voiceRate.toFixed(1)}x
                <input
                  type="range"
                  min="0.7"
                  max="1.4"
                  step="0.1"
                  value={voiceRate}
                  onChange={(e) => setVoiceRate(Number(e.target.value))}
                  className="accent-sky-400"
                />
              </label>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-mono text-[#94A3B8] mb-1">Transcript / Text Fallback Input</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    dir={voiceLang === 'ar' ? 'rtl' : 'ltr'}
                    value={transcript}
                    onChange={(e) => setTranscript(e.target.value)}
                    placeholder="Speak via microphone or enter command directly..."
                    className="flex-1 min-h-[44px] bg-[#030508] border border-[#1E2534] rounded-md px-3.5 text-sm text-[#F4F6FA]"
                  />
                  <button
                    type="button"
                    onClick={() => transcript.trim() && processVoiceCommand(transcript)}
                    className="min-h-[44px] px-4 bg-sky-400 hover:bg-sky-300 text-slate-950 text-xs font-semibold rounded-md cursor-pointer"
                  >
                    Execute
                  </button>
                </div>
              </div>

              <div className="bg-[#030508] border border-[#1E2534] rounded-lg p-4 min-h-[160px]" dir={voiceLang === 'ar' ? 'rtl' : 'ltr'}>
                <div className="text-[11px] font-mono text-[#64748B] mb-2" dir="ltr">
                  NEXA Acoustic Response
                </div>
                <p className="text-sm text-slate-200 whitespace-pre-wrap">{voiceReply || 'Awaiting spoken or text input.'}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
