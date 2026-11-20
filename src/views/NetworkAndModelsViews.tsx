import { useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface AgentContractRow {
  id: string;
  name: string;
  role: string;
  domainGroup: string;
  requiredByDefault: boolean;
  taskClass: string;
  allowedTools: string[];
  memoryPolicy: string;
  executionLimit: { maxTokens: number; timeoutMs: number; maxRetries: number };
  dependsOn: string[];
  inputSchemaSummary: string;
  outputSchemaSummary: string;
}

const DOMAIN_GROUPS: Array<{ key: string; label: string; color: string }> = [
  { key: 'core', label: 'Core Kernel', color: '#22D3EE' },
  { key: 'research', label: 'Research & Context', color: '#3B82F6' },
  { key: 'reasoning', label: 'Deep Reasoning', color: '#8B5CF6' },
  { key: 'quant', label: 'Quantitative & Math', color: '#10B981' },
  { key: 'engineering', label: 'Software Engineering', color: '#38BDF8' },
  { key: 'commerce', label: 'Autonomous Commerce', color: '#F59E0B' },
  { key: 'verification', label: 'Verification & Critic', color: '#F43F5E' },
];

export function NetworkView() {
  const [agents, setAgents] = useState<AgentContractRow[]>([]);
  const [runs, setRuns] = useState<Array<Record<string, unknown>>>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentContractRow | null>(null);
  const [domainFilter, setDomainFilter] = useState<string>('all');

  function loadAgents() {
    apiFetch<{ agents: AgentContractRow[]; recentRuns: Array<Record<string, unknown>> }>('/api/agents')
      .then((d) => {
        setAgents(d.agents || []);
        setRuns(d.recentRuns || []);
        if (d.agents?.length && !selectedAgent) setSelectedAgent(d.agents[0]);
      })
      .catch(() => {});
  }

  useEffect(() => {
    loadAgents();
  }, []);

  const filtered = agents.filter((a) => domainFilter === 'all' || a.domainGroup === domainFilter);
  const runsByAgent = new Map<string, Array<Record<string, unknown>>>();
  for (const r of runs) {
    const id = String(r.agent_id || '');
    const arr = runsByAgent.get(id) || [];
    arr.push(r);
    runsByAgent.set(id, arr);
  }
  const selectedAgentRuns = selectedAgent ? (runsByAgent.get(selectedAgent.id) || []).slice(0, 4) : [];

  // Arrange all 15 agents into SVG spatial constellation coordinates
  const svgNodes = agents.map((a, idx) => {
    const angle = (idx / Math.max(agents.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = a.requiredByDefault ? 115 : 175;
    return {
      agent: a,
      x: 260 + Math.cos(angle) * radius,
      y: 210 + Math.sin(angle) * radius,
    };
  });
  const nodeMap = new Map(svgNodes.map((n) => [n.agent.id, n]));

  return (
    <div className="space-y-5">
      {/* Interactive 15-Agent Constellation + Contract Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-7 nexa-plane rounded-lg p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1E2534]">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">15-Agent Living Ecosystem & Real Execution Topology</h2>
              <p className="text-xs text-[#94A3B8]">
                Edges reflect actual agent dependencies. Node illumination reflects persisted SQLite execution runs.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-sky-400 tabular-nums">
                {agents.length} AGENTS · {runs.length} RUNS
              </span>
              <button
                type="button"
                onClick={loadAgents}
                className="min-h-[32px] px-2.5 bg-[#111726] border border-[#2A344B] rounded text-[11px] font-mono text-slate-200 flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
          </div>

          <svg viewBox="0 0 520 420" className="w-full h-[360px] bg-[#030508] border border-[#1E2534] rounded mt-3">
            {/* Concentric orbital meridians */}
            <circle cx="260" cy="210" r="115" fill="none" stroke="#1E2534" strokeDasharray="4 4" />
            <circle cx="260" cy="210" r="175" fill="none" stroke="#1E2534" />
            <circle cx="260" cy="210" r="24" fill="#060911" stroke="#38BDF8" strokeWidth="1.5" />
            <text x="260" y="213" textAnchor="middle" fill="#38BDF8" fontSize="9" fontFamily="monospace">
              KERNEL
            </text>

            {/* Real Dependency Edges */}
            {svgNodes.map((node) =>
              node.agent.dependsOn.map((depId) => {
                const target = nodeMap.get(depId);
                if (!target) return null;
                const isHighlighted = selectedAgent?.id === node.agent.id || selectedAgent?.id === depId;
                return (
                  <line
                    key={`${node.agent.id}->${depId}`}
                    x1={target.x}
                    y1={target.y}
                    x2={node.x}
                    y2={node.y}
                    stroke={isHighlighted ? '#38BDF8' : '#334155'}
                    strokeOpacity={isHighlighted ? 0.88 : 0.35}
                    strokeWidth={isHighlighted ? 1.5 : 0.8}
                  />
                );
              })
            )}

            {/* Agent Nodes */}
            {svgNodes.map(({ agent, x, y }) => {
              const isSelected = selectedAgent?.id === agent.id;
              const agentHistory = runsByAgent.get(agent.id) || [];
              const latest = agentHistory[0];
              const statusColor =
                latest?.status === 'FAILED'
                  ? '#FB7185'
                  : latest?.status === 'SUCCESS'
                    ? '#34D399'
                    : DOMAIN_GROUPS.find((g) => g.key === agent.domainGroup)?.color || '#38BDF8';
              return (
                <g key={agent.id} className="cursor-pointer" onClick={() => setSelectedAgent(agent)}>
                  <circle
                    cx={x}
                    cy={y}
                    r={isSelected ? 11 : agent.requiredByDefault ? 9 : 7}
                    fill="#060911"
                    stroke={isSelected ? '#38BDF8' : statusColor}
                    strokeWidth={isSelected ? 2.2 : latest ? 1.8 : 1.1}
                  />
                  {latest && (
                    <circle cx={x} cy={y} r={3} fill={latest.status === 'FAILED' ? '#FB7185' : '#34D399'} />
                  )}
                  <text
                    x={x}
                    y={y + 20}
                    textAnchor="middle"
                    fill={isSelected ? '#F1F5F9' : '#94A3B8'}
                    fontSize="8.5"
                    fontFamily="monospace"
                  >
                    {agent.name.replace(' Agent', '')}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Selected Agent Contract & Execution Inspector */}
        <div className="lg:col-span-5 nexa-plane rounded-lg p-4 space-y-3">
          <div className="text-[11px] font-mono uppercase tracking-wider text-sky-400">Formal Agent Specification & Provenance</div>
          {!selectedAgent ? (
            <div className="text-xs text-[#64748B] py-12">Select a node on the topology map.</div>
          ) : (
            <div className="space-y-3 text-xs">
              <div className="pb-2.5 border-b border-[#1E2534]">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-slate-100">{selectedAgent.name}</h3>
                  <span className="font-mono text-[10px] text-sky-300 uppercase">
                    {selectedAgent.requiredByDefault ? 'CORE STAGE' : 'SPECIALIST'}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-[#64748B] mt-0.5">
                  ID: {selectedAgent.id} · GROUP: {selectedAgent.domainGroup}
                </div>
                <p className="text-[#94A3B8] mt-2 leading-relaxed">{selectedAgent.role}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                <div className="bg-[#030508] border border-[#1E2534] rounded p-2">
                  <div className="text-[#64748B] text-[10px]">MEMORY POLICY</div>
                  <div className="text-slate-200 mt-0.5 uppercase">{selectedAgent.memoryPolicy}</div>
                </div>
                <div className="bg-[#030508] border border-[#1E2534] rounded p-2">
                  <div className="text-[#64748B] text-[10px]">EXECUTION LIMITS</div>
                  <div className="text-slate-200 mt-0.5 tabular-nums">
                    {selectedAgent.executionLimit.maxTokens}t · {Math.round(selectedAgent.executionLimit.timeoutMs / 1000)}s ·{' '}
                    {selectedAgent.executionLimit.maxRetries} retry
                  </div>
                </div>
              </div>

              <div className="bg-[#030508] border border-[#1E2534] rounded p-2.5 font-mono text-[11px] space-y-1">
                <div className="text-[#64748B] text-[10px]">DEPENDS ON</div>
                <div className="text-sky-300">
                  {selectedAgent.dependsOn.length > 0 ? selectedAgent.dependsOn.join(' → ') : 'Root stage (Wave 1)'}
                </div>
              </div>

              <div className="bg-[#030508] border border-[#1E2534] rounded p-2.5 font-mono text-[11px] space-y-1">
                <div className="text-[#64748B] text-[10px]">INPUT / OUTPUT SCHEMA</div>
                <div className="text-slate-300 break-words">IN: {selectedAgent.inputSchemaSummary}</div>
                <div className="text-sky-400 break-words">OUT: {selectedAgent.outputSchemaSummary}</div>
              </div>

              <div className="bg-[#030508] border border-[#1E2534] rounded p-2.5 font-mono text-[11px] space-y-1">
                <div className="text-[#64748B] text-[10px]">REAL PERSISTED RUNS ({selectedAgentRuns.length})</div>
                {selectedAgentRuns.length === 0 ? (
                  <div className="text-[#64748B]">No mission runs recorded for this agent yet.</div>
                ) : (
                  selectedAgentRuns.map((sr) => (
                    <div key={String(sr.id)} className="flex justify-between gap-2 text-[10px]">
                      <span className="text-slate-300 truncate">{String(sr.mission_id)}</span>
                      <span className={sr.status === 'SUCCESS' ? 'text-emerald-400' : 'text-rose-400'}>
                        {String(sr.status)} · {String(sr.latency_ms)}ms
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Filter & Agent Roster */}
      <div className="nexa-plane rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#1E2534]">
          <div className="text-xs font-mono uppercase text-[#94A3B8]">Specialist Agents Directory ({filtered.length})</div>
          <select
            value={domainFilter}
            onChange={(e) => setDomainFilter(e.target.value)}
            className="min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-200"
          >
            <option value="all">ALL GROUPS</option>
            {DOMAIN_GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setSelectedAgent(a)}
              className={`text-start bg-[#06080E] border rounded-lg p-3.5 space-y-1.5 cursor-pointer ${
                selectedAgent?.id === a.id ? 'border-cyan-400' : 'border-[#1E2534] hover:border-slate-600'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-100">{a.name}</span>
                <span className={`font-mono text-[10px] ${a.requiredByDefault ? 'text-cyan-400' : 'text-[#64748B]'}`}>
                  {a.requiredByDefault ? 'CORE' : a.domainGroup.toUpperCase()}
                </span>
              </div>
              <p className="text-xs text-[#94A3B8] line-clamp-2">{a.role}</p>
              <div className="text-[10px] font-mono text-[#64748B]">
                TASK: {a.taskClass} · MEM: {a.memoryPolicy}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Recent Execution Provenance */}
      <div className="nexa-plane rounded-lg p-4">
        <h3 className="text-sm font-semibold text-slate-100 pb-3 border-b border-[#1E2534]">Recent Specialist Execution Provenance</h3>
        {runs.length === 0 ? (
          <p className="text-xs text-[#64748B] py-4">No agent executions yet. Launch a mission to inspect specialist provenance.</p>
        ) : (
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-xs text-start font-mono">
              <thead className="text-[11px] text-[#94A3B8] border-b border-[#1E2534]">
                <tr>
                  <th className="py-2 pe-3">Mission</th>
                  <th className="py-2 pe-3">Agent</th>
                  <th className="py-2 pe-3">Provider / Model</th>
                  <th className="py-2 pe-3">Status</th>
                  <th className="py-2 text-end">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E2534]/60">
                {runs.map((r) => (
                  <tr key={String(r.id)}>
                    <td className="py-2 pe-3 text-[#94A3B8]">{String(r.mission_id)}</td>
                    <td className="py-2 pe-3 text-slate-100">{String(r.agent_id)}</td>
                    <td className="py-2 pe-3 text-cyan-400">
                      {String(r.provider_id)} / {String(r.model_id)}
                    </td>
                    <td className={`py-2 pe-3 ${r.status === 'SUCCESS' ? 'text-emerald-400' : 'text-rose-400'}`}>{String(r.status)}</td>
                    <td className="py-2 text-end tabular-nums text-slate-300">{String(r.latency_ms)}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- ENVIRONMENT 04: MODEL LABORATORY (PROVIDERS + REGISTRY + LATENCY) ----------------
interface ProviderRow {
  id: string;
  displayName: string;
  baseUrl: string;
  envVar: string;
  protocol: string;
  isPaidByDefault: boolean;
  enabled: boolean;
  configured: boolean;
  keyValueExposed: boolean;
  cooldownUntil?: number;
  failureCount: number;
  lastError: string | null;
  lastVerifiedAt: string | null;
  availabilityStatus?: 'UNCONFIGURED' | 'CONFIGURED' | 'AUTHENTICATED' | 'OPERATIONAL' | 'RATE_LIMITED' | 'UNAVAILABLE';
}

interface ModelRow {
  id: string;
  providerId: string;
  displayName: string;
  contextWindow: number;
  inputModalities: string[];
  outputModalities: string[];
  promptPricePerMillion: number;
  completionPricePerMillion: number;
  freeVerified: boolean;
  enabled: boolean;
  recommendedTasks: string[];
}

interface ReadinessSummary {
  configuredCount: number;
  unconfiguredCount: number;
  liveVerifiedCount: number;
}

export function ModelsView() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [calls, setCalls] = useState<Array<Record<string, unknown>>>([]);
  const [readiness, setReadiness] = useState<ReadinessSummary | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { connected: boolean; liveVerified?: boolean; message: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [providerFilter, setProviderFilter] = useState('ALL');
  const [error, setError] = useState<string | null>(null);

  function load() {
    Promise.all([
      apiFetch<{ providers: ProviderRow[]; recentCalls: Array<Record<string, unknown>>; readiness?: ReadinessSummary }>('/api/providers'),
      apiFetch<{ models: ModelRow[] }>('/api/models'),
    ])
      .then(([p, m]) => {
        setProviders(p.providers || []);
        setCalls(p.recentCalls || []);
        if (p.readiness) setReadiness(p.readiness);
        setModels(m.models || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Load error'));
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleProvider(id: string, enabled: boolean) {
    await apiFetch(`/api/providers/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
    load();
  }

  async function toggleModel(id: string, enabled: boolean) {
    await apiFetch(`/api/models/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
    load();
  }

  async function testConnectivity(id: string, runInferenceProbe = false) {
    setTestingId(id);
    try {
      const res = await apiFetch<{ connected: boolean; liveVerified?: boolean; message: string }>(`/api/providers/${id}/test`, {
        method: 'POST',
        body: JSON.stringify({ runInferenceProbe, paidInferenceApproved: false }),
      });
      setTestResults((prev) => ({ ...prev, [id]: res }));
      load();
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { connected: false, liveVerified: false, message: err instanceof Error ? err.message : 'Test error' },
      }));
    } finally {
      setTestingId(null);
    }
  }

  async function resetCooldown(id: string) {
    try {
      await apiFetch(`/api/providers/${id}/reset-cooldown`, { method: 'POST' });
      setTestResults((prev) => ({ ...prev, [id]: { connected: true, message: `Cooldown & failure counters cleared for ${id}.` } }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset cooldown');
    }
  }

  async function testAllConfigured() {
    setTestingAll(true);
    try {
      for (const p of providers.filter((item) => item.configured)) {
        await testConnectivity(p.id);
      }
    } finally {
      setTestingAll(false);
    }
  }

  const filteredModels = models.filter((m) => {
    if (freeOnly && !m.freeVerified) return false;
    if (providerFilter !== 'ALL' && m.providerId !== providerFilter) return false;
    return true;
  });

  return (
    <div className="space-y-5">
      {/* KPI Header */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="nexa-plane rounded-lg p-4">
          <div className="text-[10px] font-mono text-[#64748B]">ROUTING POLICY</div>
          <div className="text-base font-mono font-bold text-emerald-400 mt-1">STRICT FREE-FIRST</div>
          <div className="text-[11px] text-[#94A3B8] mt-0.5">Paid auto-fallback disabled</div>
        </div>
        <div className="nexa-plane rounded-lg p-4">
          <div className="text-[10px] font-mono text-[#64748B]">ENV KEYS CONFIGURED</div>
          <div className="text-2xl font-mono font-bold text-slate-100 tabular-nums mt-1">
            {readiness?.configuredCount ?? providers.filter((p) => p.configured).length} / {providers.length}
          </div>
          <div className="text-[11px] text-[#94A3B8] mt-0.5">Server env only (`keyValueExposed: false`)</div>
        </div>
        <div className="nexa-plane rounded-lg p-4">
          <div className="text-[10px] font-mono text-[#64748B]">LIVE AUTH VERIFIED</div>
          <div className="text-2xl font-mono font-bold text-cyan-400 tabular-nums mt-1">
            {readiness?.liveVerifiedCount ?? 0} / {providers.length}
          </div>
          <div className="text-[11px] text-[#94A3B8] mt-0.5">Updated only on HTTP 200 auth</div>
        </div>
        <div className="nexa-plane rounded-lg p-4">
          <div className="text-[10px] font-mono text-[#64748B]">FREE TEXT MODELS</div>
          <div className="text-2xl font-mono font-bold text-slate-100 tabular-nums mt-1">
            {models.filter((m) => m.freeVerified).length}
          </div>
          <div className="text-[11px] text-[#94A3B8] mt-0.5">Zero-cost verified registry</div>
        </div>
      </div>

      {/* Provider Grid */}
      <div className="nexa-plane rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#1E2534]">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">8-Provider AI Gateway & Safe Connectivity Verification</h2>
            <p className="text-xs text-[#94A3B8]">Tests authenticate only against metadata endpoints—never consuming paid completion quota.</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={testingAll || providers.every((p) => !p.configured)}
              onClick={testAllConfigured}
              className="min-h-[42px] px-3.5 bg-cyan-500/15 border border-cyan-500/40 disabled:opacity-40 rounded text-xs font-mono text-cyan-300 cursor-pointer"
            >
              {testingAll ? 'Probing...' : 'Test Configured (Zero Cost)'}
            </button>
            <button
              type="button"
              onClick={load}
              className="min-h-[42px] px-3 bg-[#111726] border border-[#2A344B] rounded text-xs font-mono text-slate-200 flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
          </div>
        </div>

        {error && <div className="text-xs font-mono text-rose-400">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {providers.map((p) => {
            const test = testResults[p.id];
            const isLiveVerified = p.configured && Boolean(p.lastVerifiedAt);
            const avail = p.availabilityStatus || (p.configured ? (isLiveVerified ? 'AUTHENTICATED' : 'CONFIGURED') : 'UNCONFIGURED');
            const availColor =
              avail === 'OPERATIONAL'
                ? 'text-emerald-400'
                : avail === 'AUTHENTICATED'
                  ? 'text-cyan-400'
                  : avail === 'RATE_LIMITED'
                    ? 'text-amber-300'
                    : avail === 'UNAVAILABLE'
                      ? 'text-rose-400'
                      : avail === 'CONFIGURED'
                        ? 'text-sky-300'
                        : 'text-amber-400';
            return (
              <div key={p.id} className="bg-[#06080E] border border-[#1E2534] rounded-lg p-3.5 space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-100">{p.displayName}</div>
                    <div className="text-[11px] font-mono text-[#64748B]">
                      {p.envVar} · {p.isPaidByDefault ? 'PAID / METERED' : 'FREE ELIGIBLE'}
                    </div>
                  </div>
                  <div className="text-end font-mono text-[11px]">
                    <div className={availColor}>{avail}</div>
                    <div className={`text-[10px] ${isLiveVerified ? 'text-cyan-400' : 'text-[#64748B]'}`}>
                      {isLiveVerified ? `VERIFIED ${p.lastVerifiedAt?.slice(0, 16)}Z` : 'NOT LIVE-VERIFIED'}
                    </div>
                  </div>
                </div>
                {p.lastError && (
                  <div className="text-[10.5px] font-mono text-rose-300/90 truncate" title={p.lastError}>
                    Last error ({p.failureCount} fails): {p.lastError}
                  </div>
                )}
                {(p.cooldownUntil ?? 0) > Date.now() && (
                  <div className="text-[10.5px] font-mono text-amber-300">
                    Cooldown active until {new Date(p.cooldownUntil!).toISOString().slice(11, 19)}Z
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#1E2534]">
                  <button
                    type="button"
                    onClick={() => toggleProvider(p.id, !p.enabled)}
                    className={`min-h-[38px] px-3 text-xs font-mono rounded border cursor-pointer ${
                      p.enabled ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300' : 'border-[#2A344B] text-[#64748B]'
                    }`}
                  >
                    {p.enabled ? 'ENABLED' : 'DISABLED'}
                  </button>
                  <div className="flex flex-wrap gap-1.5">
                    {(p.failureCount > 0 || (p.cooldownUntil ?? 0) > Date.now() || Boolean(p.lastError)) && (
                      <button
                        type="button"
                        onClick={() => resetCooldown(p.id)}
                        className="min-h-[38px] px-2.5 bg-[#111726] border border-amber-500/40 text-amber-300 text-xs font-mono rounded cursor-pointer"
                      >
                        Reset Cooldown
                      </button>
                    )}
                    {!p.isPaidByDefault && p.configured && (
                      <button
                        type="button"
                        disabled={testingId === p.id}
                        onClick={() => testConnectivity(p.id, true)}
                        className="min-h-[38px] px-2.5 bg-[#111726] border border-emerald-500/40 text-emerald-300 text-xs font-mono rounded cursor-pointer"
                      >
                        Free Inference Probe
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={testingId === p.id}
                      onClick={() => testConnectivity(p.id, false)}
                      className="min-h-[38px] px-3 bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-xs font-mono rounded cursor-pointer"
                    >
                      {testingId === p.id ? 'Testing...' : 'Safe Auth Probe'}
                    </button>
                  </div>
                </div>
                {test && (
                  <div className={`text-xs font-mono flex items-center gap-1.5 ${test.connected ? 'text-emerald-400' : 'text-amber-300'}`}>
                    {test.connected ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                    <span>{test.message}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Model Comparison Matrix */}
      <div className="nexa-plane rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#1E2534]">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Model Capability & Pricing Matrix</h3>
            <p className="text-xs text-[#94A3B8]">OpenRouter free routing requires `:free` suffix, zero pricing, and text-to-text modality.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              className="min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-200"
            >
              <option value="ALL">ALL PROVIDERS</option>
              <option value="GEMINI">GEMINI</option>
              <option value="OPENROUTER">OPENROUTER</option>
              <option value="GROQ">GROQ</option>
              <option value="NVIDIA">NVIDIA</option>
              <option value="DEEPSEEK">DEEPSEEK</option>
              <option value="QWEN">QWEN</option>
              <option value="OPENAI">OPENAI</option>
              <option value="ANTHROPIC">ANTHROPIC</option>
            </select>
            <label className="flex items-center gap-2 text-xs font-mono text-slate-300 cursor-pointer">
              <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} className="accent-cyan-400" />
              Free-Verified Only
            </label>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-start">
            <thead className="text-[11px] font-mono text-[#94A3B8] border-b border-[#1E2534]">
              <tr>
                <th className="py-2 pe-3">Model</th>
                <th className="py-2 pe-3">Provider</th>
                <th className="py-2 pe-3 text-end">Context</th>
                <th className="py-2 pe-3">Modalities</th>
                <th className="py-2 pe-3">Pricing</th>
                <th className="py-2 text-end">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1E2534]/60 font-mono">
              {filteredModels.map((m) => (
                <tr key={m.id}>
                  <td className="py-2.5 pe-3">
                    <div className="text-slate-100">{m.id}</div>
                    <div className="text-[11px] font-sans text-[#64748B]">{m.displayName}</div>
                  </td>
                  <td className="py-2.5 pe-3 text-cyan-400">{m.providerId}</td>
                  <td className="py-2.5 pe-3 text-end tabular-nums">{m.contextWindow.toLocaleString()}</td>
                  <td className="py-2.5 pe-3 text-[#94A3B8]">
                    {m.inputModalities.join('+')} → {m.outputModalities.join('+')}
                  </td>
                  <td className={`py-2.5 pe-3 ${m.freeVerified ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {m.freeVerified ? '$0.00 FREE' : `$${m.promptPricePerMillion}/$${m.completionPricePerMillion} 1M`}
                  </td>
                  <td className="py-2.5 text-end">
                    <button
                      type="button"
                      onClick={() => toggleModel(m.id, !m.enabled)}
                      className={`px-2.5 py-1 rounded border text-[11px] cursor-pointer ${
                        m.enabled ? 'border-cyan-500/40 text-cyan-300' : 'border-[#2A344B] text-[#64748B]'
                      }`}
                    >
                      {m.enabled ? 'ACTIVE' : 'OFF'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Model Gateway Telemetry */}
      <div className="nexa-plane rounded-lg p-4">
        <h3 className="text-sm font-semibold text-slate-100 pb-3 border-b border-[#1E2534]">Recent Gateway Calls & Latency</h3>
        {calls.length === 0 ? (
          <p className="text-xs text-[#64748B] py-4">No model calls executed yet.</p>
        ) : (
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-xs text-start font-mono">
              <thead className="text-[11px] text-[#94A3B8] border-b border-[#1E2534]">
                <tr>
                  <th className="py-2 pe-3">Provider</th>
                  <th className="py-2 pe-3">Model</th>
                  <th className="py-2 pe-3">Task Class</th>
                  <th className="py-2 pe-3">Status</th>
                  <th className="py-2 pe-3 text-end">Latency</th>
                  <th className="py-2 pe-3 text-end">Est. Cost</th>
                  <th className="py-2 text-end">Origin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E2534]/60">
                {calls.map((c) => (
                  <tr key={String(c.id)}>
                    <td className="py-2 pe-3 text-cyan-400">{String(c.provider_id)}</td>
                    <td className="py-2 pe-3 text-slate-200">{String(c.model_id)}</td>
                    <td className="py-2 pe-3 text-[#94A3B8]">{String(c.task_class)}</td>
                    <td className={`py-2 pe-3 ${c.status === 'SUCCESS' ? 'text-emerald-400' : 'text-rose-400'}`}>{String(c.status)}</td>
                    <td className="py-2 pe-3 text-end tabular-nums text-slate-300">{String(c.latency_ms)}ms</td>
                    <td className="py-2 pe-3 text-end tabular-nums text-slate-300">${Number(c.cost_usd || 0).toFixed(5)}</td>
                    <td className="py-2 text-end text-[#94A3B8]">{Number(c.is_mock) === 1 ? 'MOCK' : 'LIVE'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
