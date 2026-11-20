import { useEffect, useState } from 'react';
import { Check, Download, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { apiFetch, getStoredSessionToken, setStoredSessionToken } from '../lib/api';

// ---------------- ENVIRONMENT 06: MEMORY ARCHITECTURE ----------------
export function MemoryView() {
  const [entries, setEntries] = useState<
    Array<{ id: string; scope: string; title: string; content: string; provenance: string; version: number; updatedAt: string }>
  >([]);
  const [scopeFilter, setScopeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [newScope, setNewScope] = useState('project_knowledge');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  function load() {
    const params = new URLSearchParams();
    if (scopeFilter) params.set('scope', scopeFilter);
    if (search.trim()) params.set('q', search.trim());
    apiFetch<{ entries: typeof entries }>(`/api/memory?${params.toString()}`).then((d) => setEntries(d.entries || [])).catch(() => {});
  }
  useEffect(() => {
    load();
  }, [scopeFilter]);

  async function saveEntry(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || content.trim().length < 3) return;
    await apiFetch('/api/memory', {
      method: 'POST',
      body: JSON.stringify({ scope: newScope, title, content, provenance: 'operator_manual' }),
    });
    setTitle('');
    setContent('');
    setStatusMsg('Memory entry stored (SHA-256 deduplicated).');
    load();
  }

  async function removeEntry(id: string) {
    await apiFetch(`/api/memory/${id}`, { method: 'DELETE' });
    load();
  }

  async function purgeExpired() {
    const res = await apiFetch<{ purged: number }>('/api/memory/purge-expired', { method: 'POST' });
    setStatusMsg(`Purged ${res.purged} expired memory record(s).`);
    load();
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <form onSubmit={saveEntry} className="lg:col-span-4 nexa-plane rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold text-slate-100">Segmented 7-Scope Memory</h2>
        <select
          value={newScope}
          onChange={(e) => setNewScope(e.target.value)}
          className="w-full min-h-[42px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-200"
        >
          <option value="user_preferences">USER PREFERENCES</option>
          <option value="project_knowledge">PROJECT KNOWLEDGE</option>
          <option value="mission_history">MISSION HISTORY</option>
          <option value="technical_docs">TECHNICAL DOCS</option>
          <option value="verified_facts">VERIFIED FACTS</option>
          <option value="temporary_context">TEMPORARY CONTEXT</option>
          <option value="agent_working">AGENT WORKING</option>
        </select>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Memory entry title"
          className="w-full min-h-[42px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          placeholder="Structured knowledge content (SHA-256 deduplicated)..."
          className="w-full bg-[#06080E] border border-[#1E2534] rounded px-3 py-2 text-xs text-slate-100"
        />
        <div className="flex gap-2">
          <button type="submit" className="flex-1 min-h-[44px] bg-cyan-500 text-slate-950 font-semibold text-xs uppercase rounded cursor-pointer">
            Save Memory
          </button>
          <button
            type="button"
            onClick={purgeExpired}
            className="min-h-[44px] px-3 bg-[#111726] border border-[#2A344B] text-xs font-mono text-[#94A3B8] hover:text-slate-100 rounded cursor-pointer"
          >
            Purge TTL
          </button>
        </div>
        {statusMsg && <div className="text-xs font-mono text-cyan-300">{statusMsg}</div>}
      </form>

      <div className="lg:col-span-8 nexa-plane rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap gap-2 pb-3 border-b border-[#1E2534]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memory..."
            className="flex-1 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
          />
          <button type="button" onClick={load} className="min-h-[40px] px-3 bg-[#111726] border border-[#2A344B] text-xs font-mono text-slate-200 rounded cursor-pointer">
            Search
          </button>
          <select
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value)}
            className="min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-xs font-mono text-slate-200"
          >
            <option value="">ALL SCOPES</option>
            <option value="user_preferences">user_preferences</option>
            <option value="project_knowledge">project_knowledge</option>
            <option value="mission_history">mission_history</option>
            <option value="technical_docs">technical_docs</option>
            <option value="verified_facts">verified_facts</option>
            <option value="temporary_context">temporary_context</option>
            <option value="agent_working">agent_working</option>
          </select>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[
            'user_preferences',
            'project_knowledge',
            'mission_history',
            'technical_docs',
            'verified_facts',
            'temporary_context',
            'agent_working',
          ].map((scopeId) => {
            const count = entries.filter((item) => item.scope === scopeId).length;
            const active = scopeFilter === scopeId;
            return (
              <button
                key={scopeId}
                type="button"
                onClick={() => setScopeFilter(active ? '' : scopeId)}
                className={`min-h-[30px] px-2.5 text-[10px] font-mono uppercase rounded border transition-colors cursor-pointer ${
                  active
                    ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                    : 'border-[#1E2534] bg-[#06080E] text-[#64748B] hover:text-slate-200'
                }`}
              >
                {scopeId.replace('_', ' ')} ({count})
              </button>
            );
          })}
        </div>

        <div className="space-y-2 max-h-[460px] overflow-y-auto">
          {entries.length === 0 ? (
            <p className="text-xs text-[#64748B] py-8 text-center">No memory entries in this filter.</p>
          ) : (
            entries.map((m) => (
              <div key={m.id} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-cyan-400">
                    {m.scope} · v{m.version} · {m.provenance}
                  </span>
                  <button type="button" onClick={() => removeEntry(m.id)} className="text-rose-400 hover:text-rose-300 cursor-pointer" title="Delete memory">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="font-semibold text-slate-100">{m.title}</div>
                <p className="text-[#94A3B8] whitespace-pre-wrap">{m.content}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------- ENVIRONMENT 10: SYSTEM ANALYTICS & SHA-256 ARTIFACTS ----------------
export function AnalyticsView() {
  const [analytics, setAnalytics] = useState<{
    missionsByStatus: Array<{ status: string; count: number }>;
    callsByProvider: Array<{
      provider_id: string;
      status: string;
      calls: number;
      avg_latency_ms: number;
      total_tokens: number;
      total_cost_usd?: number;
    }>;
    evidenceByType: Array<{ evidence_type: string; count: number }>;
    recentTests: Array<Record<string, unknown>>;
  } | null>(null);
  const [artifacts, setArtifacts] = useState<Array<Record<string, unknown>>>([]);
  const [preview, setPreview] = useState<{ name: string; content: string; integrityVerified: boolean; sha256: string } | null>(null);

  function loadAnalytics() {
    Promise.all([
      apiFetch<NonNullable<typeof analytics>>('/api/reports/analytics'),
      apiFetch<{ artifacts: Array<Record<string, unknown>> }>('/api/artifacts'),
    ])
      .then(([rep, art]) => {
        setAnalytics(rep);
        setArtifacts(art.artifacts || []);
      })
      .catch(() => {});
  }

  useEffect(() => {
    loadAnalytics();
  }, []);

  async function inspectArtifact(id: string) {
    const res = await apiFetch<{ artifact: { name: string; sha256: string }; content: string; integrityVerified: boolean }>(
      `/api/artifacts/${id}/content`
    );
    setPreview({
      name: res.artifact.name,
      sha256: res.artifact.sha256,
      content: res.content,
      integrityVerified: res.integrityVerified,
    });
  }

  const maxMissionCount = Math.max(...(analytics?.missionsByStatus || []).map((r) => r.count), 1);
  const maxEvidenceCount = Math.max(...(analytics?.evidenceByType || []).map((r) => r.count), 1);
  const maxCalls = Math.max(...(analytics?.callsByProvider || []).map((r) => r.calls), 1);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-mono text-[#94A3B8] uppercase">System Analytics, Cost Telemetry &amp; SHA-256 Artifacts</div>
        <button
          type="button"
          onClick={loadAnalytics}
          className="min-h-[34px] px-3 bg-[#111726] border border-[#2A344B] rounded text-xs font-mono text-slate-200 cursor-pointer"
        >
          Refresh Telemetry
        </button>
      </div>
      {/* Telemetry Visual Bar Charts */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="nexa-plane rounded-lg p-4 space-y-2.5">
          <div className="text-xs font-mono text-[#94A3B8]">MISSIONS BY STATE</div>
          {(analytics?.missionsByStatus || []).length === 0 ? (
            <div className="text-xs text-[#64748B]">No mission data.</div>
          ) : (
            analytics!.missionsByStatus.map((r) => (
              <div key={r.status} className="space-y-1 text-xs font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-300">{r.status}</span>
                  <span className="text-cyan-400 tabular-nums">{r.count}</span>
                </div>
                <div className="h-1.5 bg-[#06080E] rounded overflow-hidden">
                  <div className="h-full bg-cyan-400" style={{ width: `${(r.count / maxMissionCount) * 100}%` }} />
                </div>
              </div>
            ))
          )}
        </div>

        <div className="nexa-plane rounded-lg p-4 space-y-2.5">
          <div className="text-xs font-mono text-[#94A3B8]">EPISTEMIC EVIDENCE BREAKDOWN</div>
          {(analytics?.evidenceByType || []).length === 0 ? (
            <div className="text-xs text-[#64748B]">No evidence records.</div>
          ) : (
            analytics!.evidenceByType.map((r) => (
              <div key={r.evidence_type} className="space-y-1 text-xs font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-300 uppercase">{r.evidence_type}</span>
                  <span className="text-emerald-400 tabular-nums">{r.count}</span>
                </div>
                <div className="h-1.5 bg-[#06080E] rounded overflow-hidden">
                  <div className="h-full bg-emerald-400" style={{ width: `${(r.count / maxEvidenceCount) * 100}%` }} />
                </div>
              </div>
            ))
          )}
        </div>

        <div className="nexa-plane rounded-lg p-4 space-y-2.5">
          <div className="text-xs font-mono text-[#94A3B8]">MODEL ROUTING TELEMETRY</div>
          {(analytics?.callsByProvider || []).length === 0 ? (
            <div className="text-xs text-[#64748B]">No model call telemetry.</div>
          ) : (
            analytics!.callsByProvider.map((r, i) => (
              <div key={i} className="space-y-1 text-xs font-mono">
                <div className="flex justify-between gap-2">
                  <span className="text-slate-300">{r.provider_id} ({r.status})</span>
                  <span className="text-violet-400 tabular-nums">
                    {r.calls} · {Math.round(r.avg_latency_ms || 0)}ms · {Number(r.total_tokens || 0).toLocaleString()}t · ${Number(r.total_cost_usd || 0).toFixed(4)}
                  </span>
                </div>
                <div className="h-1.5 bg-[#06080E] rounded overflow-hidden">
                  <div className="h-full bg-violet-400" style={{ width: `${(r.calls / maxCalls) * 100}%` }} />
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Engineering Test Runs */}
      <div className="nexa-plane rounded-lg p-4">
        <div className="text-xs font-mono text-[#94A3B8] pb-2 border-b border-[#1E2534]">ENGINEERING SANDBOX TEST RUNS</div>
        {(analytics?.recentTests || []).length === 0 ? (
          <p className="text-xs text-[#64748B] py-4">No engineering sandbox test runs recorded yet.</p>
        ) : (
          <div className="divide-y divide-[#1E2534]/60 mt-2 font-mono text-xs">
            {analytics!.recentTests.map((t) => (
              <div key={String(t.id)} className="py-2 flex justify-between">
                <span className="text-slate-200">{String(t.suite)} ({String(t.id)})</span>
                <span className={Number(t.failed) === 0 ? 'text-emerald-400 tabular-nums' : 'text-rose-400 tabular-nums'}>
                  {String(t.passed)}/{String(t.total)} PASSED · {String(t.duration_ms)}ms
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* SHA-256 Verified Artifacts Ledger */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-5 nexa-plane rounded-lg p-4 space-y-2 max-h-[420px] overflow-y-auto">
          <div className="text-xs font-mono text-[#94A3B8] uppercase pb-2 border-b border-[#1E2534]">
            SHA-256 Verified Artifacts ({artifacts.length})
          </div>
          {artifacts.length === 0 ? (
            <p className="text-xs text-[#64748B] py-8">No generated artifacts yet.</p>
          ) : (
            artifacts.map((a) => (
              <button
                key={String(a.id)}
                type="button"
                onClick={() => inspectArtifact(String(a.id))}
                className="w-full text-start bg-[#06080E] border border-[#1E2534] hover:border-cyan-400 rounded p-3 text-xs cursor-pointer"
              >
                <div className="font-semibold text-slate-100 truncate">{String(a.name)}</div>
                <div className="font-mono text-[10px] text-[#94A3B8] mt-0.5 tabular-nums">
                  {String(a.subsystem)} · {String(a.size_bytes)}B · {String(a.sha256).slice(0, 14)}…
                </div>
              </button>
            ))
          )}
        </div>

        <div className="lg:col-span-7 nexa-plane rounded-lg p-4">
          {!preview ? (
            <div className="text-xs text-[#64748B] py-16 text-center">
              Select an artifact to verify its cryptographic SHA-256 digest and inspect contents.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#1E2534]">
                <div className="text-sm font-semibold text-slate-100">{preview.name}</div>
                <span className={`font-mono text-xs ${preview.integrityVerified ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {preview.integrityVerified ? 'SHA-256 VERIFIED' : 'CHECKSUM MISMATCH'}
                </span>
              </div>
              <div className="text-[11px] font-mono text-[#64748B] break-all">SHA-256: {preview.sha256}</div>
              <pre className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap max-h-[320px] overflow-y-auto">
                {preview.content}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------- ENVIRONMENT 11: SECURITY VAULT ----------------
interface MissionExecutionLog {
  id: number;
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
    missionTotalCostUsd: number;
  };
  error_message: string | null;
  mission_domain: string | null;
  mission_objective: string | null;
}

interface MissionExecutionSummary {
  totalRows: number;
  filteredRows: number;
  failedRuns: number;
  totalCostUsd: number;
  totalTokens: number;
}

export function SecurityView({ onSessionChange, onRefreshHealth }: { onSessionChange: () => void; onRefreshHealth: () => void }) {
  const [securityTab, setSecurityTab] = useState<'vault' | 'mission_logs'>('vault');
  const [approvals, setApprovals] = useState<Array<Record<string, unknown>>>([]);
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [securityAlerts, setSecurityAlerts] = useState<Array<Record<string, unknown>>>([]);
  const [failedMissions, setFailedMissions] = useState<Array<Record<string, unknown>>>([]);
  const [failedAgentRuns, setFailedAgentRuns] = useState<Array<Record<string, unknown>>>([]);
  const [failedSchedules, setFailedSchedules] = useState<Array<Record<string, unknown>>>([]);
  const [currentUser, setCurrentUser] = useState<{ username: string; role: string } | null>(null);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const [authErr, setAuthErr] = useState<string | null>(null);

  const [execLogs, setExecLogs] = useState<MissionExecutionLog[]>([]);
  const [execSummary, setExecSummary] = useState<MissionExecutionSummary>({
    totalRows: 0,
    filteredRows: 0,
    failedRuns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
  });
  const [execSearch, setExecSearch] = useState('');
  const [execStatus, setExecStatus] = useState<'ALL' | 'SUCCESS' | 'FAILED'>('ALL');
  const [execLoading, setExecLoading] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);

  function load() {
    Promise.all([
      apiFetch<{ approvals: Array<Record<string, unknown>> }>('/api/approvals'),
      apiFetch<{
        events: Array<Record<string, unknown>>;
        securityAlerts?: Array<Record<string, unknown>>;
        failedMissions?: Array<Record<string, unknown>>;
        failedAgentRuns?: Array<Record<string, unknown>>;
        failedSchedules?: Array<Record<string, unknown>>;
      }>('/api/audit'),
      apiFetch<{ user: { username: string; role: string } | null }>('/api/auth/session'),
    ])
      .then(([a, ev, s]) => {
        setApprovals(a.approvals || []);
        setEvents(ev.events || []);
        setSecurityAlerts(ev.securityAlerts || []);
        setFailedMissions(ev.failedMissions || []);
        setFailedAgentRuns(ev.failedAgentRuns || []);
        setFailedSchedules(ev.failedSchedules || []);
        setCurrentUser(s.user);
      })
      .catch(() => {});
  }

  async function loadMissionExecLogs(queryText = execSearch, statusVal = execStatus) {
    setExecLoading(true);
    setExecError(null);
    try {
      const params = new URLSearchParams();
      if (queryText.trim()) params.set('q', queryText.trim());
      if (statusVal !== 'ALL') params.set('status', statusVal);
      params.set('limit', '200');
      const data = await apiFetch<{ logs: MissionExecutionLog[]; summary: MissionExecutionSummary }>(
        `/api/audit/mission-executions?${params.toString()}`
      );
      setExecLogs(data.logs || []);
      setExecSummary(
        data.summary || {
          totalRows: 0,
          filteredRows: 0,
          failedRuns: 0,
          totalCostUsd: 0,
          totalTokens: 0,
        }
      );
    } catch (err) {
      setExecError(err instanceof Error ? err.message : 'Unable to load mission execution audit logs');
    } finally {
      setExecLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (securityTab === 'mission_logs') {
      loadMissionExecLogs(execSearch, execStatus);
    }
  }, [securityTab, execStatus]);

  async function decide(id: number, decision: 'approved' | 'rejected') {
    setAuthErr(null);
    try {
      await apiFetch(`/api/approvals/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, note: `Decided in Security Vault by ${currentUser?.username || 'operator'}` }),
      });
      load();
      onRefreshHealth();
    } catch (err) {
      setAuthErr(err instanceof Error ? err.message : 'Unable to submit approval decision');
    }
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setAuthErr(null);
    setAuthMsg(null);
    if (!username.trim() || !password) {
      setAuthErr('Enter username and password.');
      return;
    }
    try {
      const res = await apiFetch<{ token: string; user: { username: string; role: string } }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password }),
      });
      setStoredSessionToken(res.token);
      setPassword('');
      setAuthMsg(`Authenticated as ${res.user.username} (${res.user.role}).`);
      load();
      onSessionChange();
    } catch (err) {
      setAuthErr(err instanceof Error ? err.message : 'Authentication failed');
    }
  }

  async function signOut() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore logout transport failures
    }
    setStoredSessionToken(null);
    setAuthErr(null);
    setAuthMsg('Session revoked and cleared from browser.');
    load();
    onSessionChange();
  }

  async function switchRole(role: 'admin' | 'operator' | 'researcher' | 'viewer') {
    setAuthErr(null);
    setAuthMsg(null);
    try {
      const res = await apiFetch<{ token: string }>('/api/auth/switch-role', {
        method: 'POST',
        body: JSON.stringify({ role }),
      });
      setStoredSessionToken(res.token);
      setAuthMsg(`Switched workspace session role to ${role}.`);
      load();
      onSessionChange();
    } catch (err) {
      setAuthErr(err instanceof Error ? err.message : 'Role switch rejected');
    }
  }

  async function retryFailedMission(missionId: string) {
    setAuthErr(null);
    setAuthMsg(null);
    try {
      const res = await apiFetch<{ mission: { id: string; status: string } }>(`/api/missions/${missionId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ allowMockFallback: true }),
      });
      setAuthMsg(`Retried mission ${res.mission.id} -> ${res.mission.status}.`);
      load();
      onRefreshHealth();
    } catch (err) {
      setAuthErr(err instanceof Error ? err.message : 'Unable to retry mission');
    }
  }

  function exportMissionExecCsv() {
    const header = ['timestamp', 'mission_id', 'agent_id', 'status', 'cost_usd', 'tokens_in', 'tokens_out', 'provider_id', 'model_id', 'latency_ms', 'mode', 'error_message'];
    const escapeCell = (val: string | number | boolean | null) => {
      const s = String(val ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const rows = execLogs.map((row) =>
      [
        row.timestamp,
        row.mission_id,
        row.agent_id,
        row.status,
        row.cost_metadata.costUsd.toFixed(6),
        row.cost_metadata.tokensIn,
        row.cost_metadata.tokensOut,
        row.cost_metadata.providerId,
        row.cost_metadata.modelId,
        row.cost_metadata.latencyMs,
        row.cost_metadata.isMock ? 'MOCK' : 'LIVE',
        row.error_message || '',
      ]
        .map(escapeCell)
        .join(',')
    );
    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexa_mission_execution_audit_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div className="nexa-plane rounded-lg p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSecurityTab('vault')}
            className={`min-h-[38px] px-3.5 text-xs font-mono uppercase rounded border cursor-pointer ${
              securityTab === 'vault'
                ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                : 'border-[#1E2534] bg-[#06080E] text-[#94A3B8] hover:text-slate-200'
            }`}
          >
            Vault, Gates &amp; Alerts
          </button>
          <button
            type="button"
            onClick={() => setSecurityTab('mission_logs')}
            className={`min-h-[38px] px-3.5 text-xs font-mono uppercase rounded border cursor-pointer ${
              securityTab === 'mission_logs'
                ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                : 'border-[#1E2534] bg-[#06080E] text-[#94A3B8] hover:text-slate-200'
            }`}
          >
            Mission Execution Audit Logs
          </button>
        </div>
        <div className="text-[11px] font-mono text-[#64748B]">
          SECURITY SUB-VIEW · {securityTab === 'vault' ? 'RBAC & APPROVALS' : 'EXECUTION TELEMETRY LEDGER'}
        </div>
      </div>

      {securityTab === 'mission_logs' ? (
        <div className="space-y-4">
          <div className="nexa-plane rounded-lg p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">Mission Execution Audit Logs</h3>
                <p className="text-xs text-[#94A3B8] mt-0.5">
                  Database-backed ledger of persisted agent execution runs joined with mission scope, runtime status, and cost_metadata.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => loadMissionExecLogs(execSearch, execStatus)}
                  className="min-h-[38px] px-3 text-xs font-mono uppercase rounded border border-[#2A344B] bg-[#06080E] text-cyan-300 cursor-pointer"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={exportMissionExecCsv}
                  disabled={execLogs.length === 0}
                  className="min-h-[38px] px-3 text-xs font-mono uppercase rounded border border-[#2A344B] bg-[#06080E] text-slate-200 hover:border-cyan-400 disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                loadMissionExecLogs(execSearch, execStatus);
              }}
              className="grid grid-cols-1 md:grid-cols-12 gap-2.5 pt-2 border-t border-[#1E2534]"
            >
              <div className="md:col-span-6 relative">
                <Search className="w-3.5 h-3.5 text-[#64748B] absolute start-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={execSearch}
                  onChange={(e) => setExecSearch(e.target.value)}
                  placeholder="Search by mission_id, agent_id, provider, model, timestamp, or error..."
                  aria-label="Search mission execution audit logs"
                  className="w-full min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded ps-9 pe-3 text-xs font-mono text-slate-100 focus:border-cyan-400 focus:outline-none"
                />
              </div>
              <div className="md:col-span-4 flex items-center gap-1.5">
                {(['ALL', 'SUCCESS', 'FAILED'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setExecStatus(st)}
                    className={`flex-1 min-h-[40px] px-2.5 text-xs font-mono uppercase rounded border cursor-pointer ${
                      execStatus === st
                        ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                        : 'border-[#1E2534] bg-[#06080E] text-[#94A3B8]'
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
              <button
                type="submit"
                className="md:col-span-2 min-h-[40px] bg-cyan-500 text-slate-950 font-semibold text-xs uppercase rounded cursor-pointer"
              >
                Query DB
              </button>
            </form>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-[#1E2534]">
              <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">Matched Runs</div>
                <div className="text-sm font-mono tabular-nums text-slate-100 mt-0.5">
                  {execSummary.filteredRows} <span className="text-[#64748B] text-xs">/ {execSummary.totalRows}</span>
                </div>
              </div>
              <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">Failed Runs</div>
                <div className={`text-sm font-mono tabular-nums mt-0.5 ${execSummary.failedRuns > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {execSummary.failedRuns}
                </div>
              </div>
              <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">Cost Aggregate (USD)</div>
                <div className="text-sm font-mono tabular-nums text-cyan-300 mt-0.5">${execSummary.totalCostUsd.toFixed(6)}</div>
              </div>
              <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">Total Tokens</div>
                <div className="text-sm font-mono tabular-nums text-slate-100 mt-0.5">{execSummary.totalTokens.toLocaleString()}</div>
              </div>
            </div>
          </div>

          <div className="nexa-plane rounded-lg p-4">
            {execError && (
              <div className="bg-rose-950/30 border border-rose-500/40 rounded px-3 py-2.5 text-xs font-mono text-rose-300 mb-3">
                {execError}
              </div>
            )}

            {execLoading ? (
              <div className="py-10 text-center text-xs font-mono text-[#94A3B8]">Loading mission execution audit logs...</div>
            ) : execLogs.length === 0 ? (
              <div className="py-10 text-center space-y-2">
                <p className="text-xs font-mono text-[#94A3B8]">No mission execution logs match the current query filters.</p>
                {(execSearch.trim() !== '' || execStatus !== 'ALL') && (
                  <button
                    type="button"
                    onClick={() => {
                      setExecSearch('');
                      setExecStatus('ALL');
                      loadMissionExecLogs('', 'ALL');
                    }}
                    className="min-h-[36px] px-3 text-xs font-mono uppercase rounded border border-cyan-500/40 bg-[#06080E] text-cyan-300 cursor-pointer"
                  >
                    Reset Filters
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-start font-mono">
                  <thead className="text-[10px] uppercase tracking-wider text-[#94A3B8] border-b border-[#1E2534]">
                    <tr>
                      <th className="py-2 pe-3">timestamp</th>
                      <th className="py-2 pe-3">mission_id</th>
                      <th className="py-2 pe-3">agent_id</th>
                      <th className="py-2 pe-3">status</th>
                      <th className="py-2">cost_metadata</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E2534]/60 text-[11px]">
                    {execLogs.map((row) => (
                      <tr key={row.id} className="hover:bg-[#111726]/60">
                        <td className="py-2.5 pe-3 text-[#94A3B8] tabular-nums whitespace-nowrap align-top">
                          {row.timestamp.replace('T', ' ').slice(0, 19)}Z
                        </td>
                        <td className="py-2.5 pe-3 align-top">
                          <div className="text-cyan-300 font-semibold">{row.mission_id}</div>
                          {row.mission_domain && (
                            <div className="text-[10px] text-[#64748B] truncate max-w-[240px]">
                              {row.mission_domain}
                              {row.mission_objective ? ` · ${row.mission_objective}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 pe-3 text-slate-200 align-top whitespace-nowrap">{row.agent_id}</td>
                        <td className="py-2.5 pe-3 align-top whitespace-nowrap">
                          <div className={row.status === 'SUCCESS' ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                            {row.status}
                          </div>
                          {row.error_message && (
                            <div className="text-[10px] text-rose-300/80 truncate max-w-[180px]" title={row.error_message}>
                              {row.error_message}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 align-top tabular-nums">
                          <div className="text-slate-100">
                            ${row.cost_metadata.costUsd.toFixed(6)}{' '}
                            <span className="text-[#94A3B8]">
                              · {row.cost_metadata.tokensIn}/{row.cost_metadata.tokensOut} tok · {row.cost_metadata.latencyMs}ms
                            </span>
                          </div>
                          <div className="text-[10px] text-[#64748B]">
                            {row.cost_metadata.providerId}/{row.cost_metadata.modelId} ·{' '}
                            <span className={row.cost_metadata.isMock ? 'text-amber-400' : 'text-emerald-400'}>
                              {row.cost_metadata.isMock ? 'MOCK' : 'LIVE'}
                            </span>{' '}
                            · mission total ${row.cost_metadata.missionTotalCostUsd.toFixed(4)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="nexa-plane rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <ShieldCheck className="w-4 h-4 text-cyan-400" /> Active RBAC Session:{' '}
              {currentUser ? `${currentUser.username} (${currentUser.role})` : 'Unauthenticated (Sign in required for mutations)'}
            </div>
            <div className="text-xs text-[#94A3B8] mt-0.5">Role-based access control gates mission execution, settings mutations, and approvals.</div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(['admin', 'operator', 'researcher', 'viewer'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => switchRole(r)}
                className={`min-h-[40px] px-3 text-xs font-mono uppercase rounded border cursor-pointer ${
                  currentUser?.role === r ? 'border-cyan-400 bg-cyan-500/15 text-cyan-300' : 'border-[#2A344B] bg-[#06080E] text-[#94A3B8]'
                }`}
              >
                {r}
              </button>
            ))}
            <button
              type="button"
              onClick={signOut}
              className="min-h-[40px] px-3 text-xs font-mono uppercase rounded border border-[#2A344B] bg-[#06080E] text-slate-300 hover:border-rose-500/50 cursor-pointer"
            >
              Clear Token
            </button>
            <button
              type="button"
              onClick={load}
              className="min-h-[40px] px-3 text-xs font-mono uppercase rounded border border-[#2A344B] bg-[#06080E] text-cyan-300 cursor-pointer"
            >
              Refresh
            </button>
          </div>
        </div>

        <form onSubmit={signIn} className="grid grid-cols-1 sm:grid-cols-12 gap-2 pt-3 border-t border-[#1E2534]">
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username (e.g. admin)"
            className="sm:col-span-4 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-100"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Server account password"
            className="sm:col-span-5 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-100"
          />
          <button
            type="submit"
            className="sm:col-span-3 min-h-[40px] bg-cyan-500 text-slate-950 font-semibold text-xs uppercase rounded cursor-pointer"
          >
            Sign In (PBKDF2)
          </button>
        </form>
        {authMsg && <div className="text-xs font-mono text-emerald-400">{authMsg}</div>}
        {authErr && <div className="text-xs font-mono text-rose-400">{authErr}</div>}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-3 border-t border-[#1E2534]">
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[9px] font-mono uppercase tracking-wider text-[#64748B]">Password KDF</div>
            <div className="text-xs font-mono text-slate-200 mt-0.5">PBKDF2-SHA256</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[9px] font-mono uppercase tracking-wider text-[#64748B]">Active Clearance</div>
            <div className="text-xs font-mono text-cyan-300 mt-0.5">{currentUser ? currentUser.role.toUpperCase() : 'UNAUTHENTICATED'}</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[9px] font-mono uppercase tracking-wider text-[#64748B]">Pending Gates</div>
            <div className="text-xs font-mono text-amber-300 mt-0.5">
              {approvals.filter((ap) => ap.status === 'pending').length} REQUEST(S)
            </div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-3 py-2">
            <div className="text-[9px] font-mono uppercase tracking-wider text-[#64748B]">Hard Safety Locks</div>
            <div className="text-xs font-mono text-emerald-400 mt-0.5">PAPER · NO-PAID</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-6 nexa-plane rounded-lg p-4 space-y-2">
          <div className="text-xs font-mono text-[#94A3B8] uppercase pb-2 border-b border-[#1E2534]">Human Approval Gate Inbox ({approvals.length})</div>
          {approvals.length === 0 ? (
            <p className="text-xs text-[#64748B] py-6">No pending or historical approval requests.</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {approvals.map((ap) => (
                <div key={String(ap.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-2">
                  <div className="flex justify-between font-mono text-[11px]">
                    <span className="text-cyan-400">
                      {String(ap.category)} · #{String(ap.id)}
                    </span>
                    <span className={ap.status === 'pending' ? 'text-amber-400' : ap.status === 'approved' ? 'text-emerald-400' : 'text-rose-400'}>
                      {String(ap.status).toUpperCase()}
                    </span>
                  </div>
                  <div className="text-slate-100 font-medium">{String(ap.action)}</div>
                  {Boolean(ap.payload_json) && (
                    <div className="text-[11px] font-mono text-[#94A3B8] break-words bg-[#0B111E] border border-[#1E2534] rounded px-2 py-1">
                      {String(ap.payload_json).slice(0, 240)}
                    </div>
                  )}
                  {ap.status !== 'pending' && Boolean(ap.decided_by || ap.decided_at) && (
                    <div className="text-[10.5px] font-mono text-[#64748B]">
                      Decided by {String(ap.decided_by || 'operator')} · {String(ap.decided_at || '').slice(0, 19)}
                      {ap.decision_note ? ` · ${String(ap.decision_note)}` : ''}
                    </div>
                  )}
                  {ap.status === 'pending' && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => decide(Number(ap.id), 'approved')}
                        className="min-h-[36px] px-3 bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 font-mono text-xs rounded flex items-center gap-1 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" /> Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(Number(ap.id), 'rejected')}
                        className="min-h-[36px] px-3 bg-rose-600/20 border border-rose-500/40 text-rose-300 font-mono text-xs rounded flex items-center gap-1 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" /> Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-6 nexa-plane rounded-lg p-4 space-y-2">
          <div className="text-xs font-mono text-[#94A3B8] uppercase pb-2 border-b border-[#1E2534]">Immutable Audit Log</div>
          <div className="divide-y divide-[#1E2534]/60 max-h-96 overflow-y-auto font-mono text-[11px]">
            {events.map((ev) => (
              <div key={String(ev.id)} className="py-2">
                <div className="flex justify-between">
                  <span className="text-cyan-400">
                    {String(ev.category)} · {String(ev.event)}
                  </span>
                  <span className="text-[#64748B]">{String(ev.actor)}</span>
                </div>
                <div className="text-[#64748B] mt-0.5 truncate">{String(ev.details_json || '')}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Security Alerts & Failed Tasks Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="nexa-plane rounded-lg p-4 space-y-2">
          <div className="text-xs font-mono text-amber-300 uppercase pb-2 border-b border-[#1E2534]">
            Security Alerts ({securityAlerts.length})
          </div>
          {securityAlerts.length === 0 ? (
            <p className="text-xs text-[#64748B] py-4">No security blocks or RBAC violations recorded.</p>
          ) : (
            <div className="divide-y divide-[#1E2534]/60 max-h-56 overflow-y-auto font-mono text-[11px]">
              {securityAlerts.map((ev) => (
                <div key={String(ev.id)} className="py-2">
                  <div className="flex justify-between text-rose-300">
                    <span>{String(ev.event)}</span>
                    <span className="text-[#94A3B8]">{String(ev.actor)}</span>
                  </div>
                  <div className="text-[#64748B] mt-0.5 truncate">{String(ev.details_json || '')}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="nexa-plane rounded-lg p-4 space-y-2">
          <div className="text-xs font-mono text-rose-300 uppercase pb-2 border-b border-[#1E2534]">
            Failed Tasks &amp; Recovery Queue ({failedMissions.length + failedAgentRuns.length + failedSchedules.length})
          </div>
          {failedMissions.length + failedAgentRuns.length + failedSchedules.length === 0 ? (
            <p className="text-xs text-[#64748B] py-4">No failed missions, agent runs, or scheduled jobs.</p>
          ) : (
            <div className="divide-y divide-[#1E2534]/60 max-h-56 overflow-y-auto font-mono text-[11px]">
              {failedMissions.map((fm) => (
                <div key={`m_${String(fm.id)}`} className="py-2 space-y-1">
                  <div className="flex justify-between items-center gap-2 text-rose-300">
                    <span>MISSION {String(fm.id)} [{String(fm.failure_classification || 'internal_error')}]</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[#94A3B8]">retries {String(fm.retry_count ?? 0)}</span>
                      <button
                        type="button"
                        onClick={() => retryFailedMission(String(fm.id))}
                        className="px-2 py-0.5 bg-[#111726] border border-cyan-500/40 text-cyan-300 rounded text-[10px] cursor-pointer"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                  <div className="text-[#94A3B8] truncate">{String(fm.last_error || fm.objective)}</div>
                </div>
              ))}
              {failedAgentRuns.map((fa) => (
                <div key={`a_${String(fa.id)}`} className="py-2">
                  <div className="flex justify-between text-amber-300">
                    <span>AGENT {String(fa.agent_id)} ({String(fa.mission_id)})</span>
                    <span className="text-[#94A3B8]">{String(fa.provider_id)}</span>
                  </div>
                  <div className="text-[#64748B] truncate">{String(fa.error_message || '')}</div>
                </div>
              ))}
              {failedSchedules.map((fsRow) => (
                <div key={`s_${String(fsRow.id)}`} className="py-2">
                  <div className="text-rose-300">SCHEDULE {String(fsRow.schedule_id)}</div>
                  <div className="text-[#64748B] truncate">{String(fsRow.error_message || '')}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
        </>
      )}
    </div>
  );
}

// ---------------- ENVIRONMENT 12: SYSTEM CONTROL & READINESS ----------------
export function SystemControlView({ onRefreshHealth }: { onRefreshHealth: () => void }) {
  const [settings, setSettings] = useState<{
    default_language: 'en' | 'ar' | 'it' | 'fr';
    human_approval_required: boolean;
    automatic_paid_fallback: boolean;
    max_cost_per_mission_usd: number;
  }>({
    default_language: 'en',
    human_approval_required: true,
    automatic_paid_fallback: false,
    max_cost_per_mission_usd: 0,
  });
  const [readiness, setReadiness] = useState<{
    sessionSecret: { configured: boolean; valid: boolean; mode: string; message: string };
    database: {
      persistentFile: boolean;
      exists: boolean;
      sizeBytes: number;
      walMode: boolean;
      persistence?: { mode: string; gistConfigured: boolean; lastSyncAt: string | null; lastSyncError: string | null };
    };
    safety: { paidFallbackAllowed: boolean; liveTradingEnabled: boolean; externalCommerceEnabled: boolean };
    envStatus: Array<{ name: string; set: boolean; scope: string; required: string }>;
  } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [backupResult, setBackupResult] = useState<{
    backupPath: string;
    sha256: string;
    sizeBytes: number;
    remoteSync?: { synced: boolean; error?: string };
  } | null>(null);
  const [backups, setBackups] = useState<Array<{ filename: string; sizeBytes: number; sha256: string; modifiedAt: string }>>([]);
  const [verifyReport, setVerifyReport] = useState<{
    filename: string;
    valid: boolean;
    integrityCheck: string;
    tableCount: number;
    sha256: string;
  } | null>(null);

  function loadSystem() {
    Promise.all([
      apiFetch<{ settings: typeof settings }>('/api/settings'),
      apiFetch<{ readiness?: NonNullable<typeof readiness> }>('/api/providers'),
      apiFetch<{ backups: typeof backups }>('/api/backups'),
    ])
      .then(([s, p, b]) => {
        setSettings((prev) => ({ ...prev, ...s.settings }));
        if (p.readiness) setReadiness(p.readiness);
        setBackups(b.backups || []);
      })
      .catch(() => {});
  }

  useEffect(() => {
    loadSystem();
  }, []);

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
      setMsg('Governance settings persisted to SQLite.');
      onRefreshHealth();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Admin role required to update global settings.');
    }
  }

  async function runBackup() {
    const res = await apiFetch<NonNullable<typeof backupResult>>('/api/backup', { method: 'POST' });
    setBackupResult(res);
    loadSystem();
  }

  async function verifyBackupFile(filename: string) {
    const res = await apiFetch<NonNullable<typeof verifyReport>>('/api/backups/verify', {
      method: 'POST',
      body: JSON.stringify({ filename }),
    });
    setVerifyReport(res);
  }

  async function downloadBackupFile(filename: string) {
    try {
      const token = getStoredSessionToken();
      const headers: Record<string, string> = {};
      if (token) headers['x-nexa-session'] = token;
      const resp = await fetch(`/api/backups/${encodeURIComponent(filename)}/download`, { headers });
      if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to download backup.');
    }
  }

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const base64Sqlite = btoa(binary);
      const res = await apiFetch<{ restored: boolean; tableCount: number; sha256: string }>('/api/backups/restore', {
        method: 'POST',
        body: JSON.stringify({ base64Sqlite }),
      });
      setMsg(`Snapshot restored safely (${res.tableCount} tables · SHA-256 ${res.sha256.slice(0, 12)}...).`);
      loadSystem();
      onRefreshHealth();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Restore failed: admin role & valid .sqlite3 required.');
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <form onSubmit={saveSettings} className="lg:col-span-7 nexa-plane rounded-lg p-5 space-y-4">
          <h2 className="text-base font-semibold text-slate-100 pb-3 border-b border-[#1E2534]">Platform Governance & Safety Ceilings</h2>
          <label className="block space-y-1 text-xs">
            <span className="font-mono text-[#94A3B8]">DEFAULT LANGUAGE</span>
            <select
              value={settings.default_language}
              onChange={(e) => setSettings({ ...settings, default_language: e.target.value as 'en' | 'ar' | 'it' | 'fr' })}
              className="w-full min-h-[44px] bg-[#06080E] border border-[#1E2534] rounded px-3 font-mono text-slate-200"
            >
              <option value="en">English (en)</option>
              <option value="ar">Arabic (ar)</option>
              <option value="it">Italian (it)</option>
              <option value="fr">French (fr)</option>
            </select>
          </label>

          <label className="block space-y-1 text-xs">
            <span className="font-mono text-[#94A3B8]">MAX COST PER MISSION CEILING (USD · 0.00 = STRICT FREE ONLY)</span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={settings.max_cost_per_mission_usd}
              onChange={(e) => setSettings({ ...settings, max_cost_per_mission_usd: Number(e.target.value) })}
              className="w-full min-h-[44px] bg-[#06080E] border border-[#1E2534] rounded px-3 font-mono text-slate-200"
            />
          </label>

          <label className="flex items-center justify-between bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs cursor-pointer">
            <span>Require Human Approval Gate for Sensitive Actions</span>
            <input
              type="checkbox"
              checked={settings.human_approval_required}
              onChange={(e) => setSettings({ ...settings, human_approval_required: e.target.checked })}
              className="accent-cyan-400"
            />
          </label>

          <label className="flex items-center justify-between bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs cursor-pointer">
            <span>Allow Paid Provider Fallback (Admin required; false recommended)</span>
            <input
              type="checkbox"
              checked={settings.automatic_paid_fallback}
              onChange={(e) => setSettings({ ...settings, automatic_paid_fallback: e.target.checked })}
              className="accent-cyan-400"
            />
          </label>

          <button type="submit" className="min-h-[44px] px-5 bg-cyan-500 text-slate-950 font-semibold text-xs uppercase rounded cursor-pointer">
            Save Governance Settings
          </button>
          {msg && <div className="text-xs font-mono text-cyan-300">{msg}</div>}
        </form>

        <div className="lg:col-span-5 nexa-plane rounded-lg p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">Database Persistence & Disaster Recovery</h3>
          {readiness && (
            <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-1.5 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-[#94A3B8]">DATABASE WAL</span>
                <span className={readiness.database.walMode ? 'text-emerald-400' : 'text-amber-400'}>
                  {readiness.database.persistentFile ? 'PERSISTENT SQLITE' : 'MEMORY'} · {Math.round(readiness.database.sizeBytes / 1024)} KB
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#94A3B8]">SESSION SECRET</span>
                <span className={readiness.sessionSecret.valid ? 'text-cyan-300' : 'text-rose-400'}>
                  {readiness.sessionSecret.mode}
                </span>
              </div>
              {readiness.database.persistence && (
                <div className="flex justify-between gap-2">
                  <span className="text-[#94A3B8]">SNAPSHOT SYNC</span>
                  <span className={readiness.database.persistence.gistConfigured ? 'text-emerald-400 text-right' : 'text-amber-300 text-right'}>
                    {readiness.database.persistence.gistConfigured ? 'REMOTE GIST ACTIVE ($0)' : 'SEEDED + MANUAL EXPORT'}
                  </span>
                </div>
              )}
            </div>
          )}
          <p className="text-xs text-[#94A3B8]">Creates an atomic SQLite snapshot via `VACUUM INTO`, verifies integrity read-only, and supports iPhone Safari download/restore.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={runBackup}
              className="min-h-[44px] px-4 bg-[#111726] border border-cyan-500/40 text-cyan-300 text-xs font-mono rounded flex items-center gap-2 cursor-pointer"
            >
              <Download className="w-4 h-4" /> Export Verified Backup
            </button>
            <label className="min-h-[44px] px-4 bg-[#06080E] border border-[#1E2534] hover:border-cyan-500/40 text-slate-300 text-xs font-mono rounded flex items-center gap-2 cursor-pointer">
              <Upload className="w-4 h-4" /> Restore `.sqlite3`
              <input type="file" accept=".sqlite3,.sqlite,.db" onChange={handleRestoreFile} className="hidden" />
            </label>
          </div>
          {backupResult && (
            <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-[11px] font-mono space-y-1 text-slate-300 break-all">
              <div className="text-emerald-400">
                BACKUP CREATED ({backupResult.sizeBytes.toLocaleString()} bytes)
                {backupResult.remoteSync?.synced ? ' · SYNCED TO GIST' : ''}
              </div>
              <div>Path: {backupResult.backupPath}</div>
              <div>SHA-256: {backupResult.sha256}</div>
            </div>
          )}
          {verifyReport && (
            <div className="bg-[#06080E] border border-emerald-500/40 rounded p-3 text-[11px] font-mono space-y-1 text-slate-300 break-all">
              <div className={verifyReport.valid ? 'text-emerald-400' : 'text-rose-400'}>
                VERIFY {verifyReport.valid ? 'PASSED' : 'FAILED'}: {verifyReport.filename}
              </div>
              <div>Integrity: {verifyReport.integrityCheck} · Tables: {verifyReport.tableCount}</div>
              <div>SHA-256: {verifyReport.sha256}</div>
            </div>
          )}
          {backups.length > 0 && (
            <div className="space-y-1.5 max-h-40 overflow-y-auto pt-2 border-t border-[#1E2534] text-[11px] font-mono">
              <div className="text-[#64748B] uppercase text-[10px]">Verified Backup Archive ({backups.length})</div>
              {backups.slice(0, 6).map((bk) => (
                <div key={bk.filename} className="flex items-center justify-between gap-2 bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-1.5">
                  <div className="min-w-0 truncate text-slate-300" title={bk.sha256}>
                    {bk.filename} ({Math.round(bk.sizeBytes / 1024)} KB)
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => downloadBackupFile(bk.filename)}
                      className="px-2 py-0.5 bg-[#0B0E17] border border-emerald-500/40 text-emerald-300 rounded text-[10px] cursor-pointer"
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      onClick={() => verifyBackupFile(bk.filename)}
                      className="px-2 py-0.5 bg-[#111726] border border-cyan-500/40 text-cyan-300 rounded text-[10px] cursor-pointer"
                    >
                      Verify
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {readiness?.envStatus && (
        <div className="nexa-plane rounded-lg p-4 space-y-3">
          <div className="text-xs font-mono text-[#94A3B8] uppercase pb-2 border-b border-[#1E2534]">
            Server Environment Checklist (Presence Only — Secret Values Never Exposed)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 text-xs font-mono">
            {readiness.envStatus.map((item) => (
              <div key={item.name} className="bg-[#06080E] border border-[#1E2534] rounded p-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">{item.name}</div>
                  <div className="text-[10px] text-[#64748B] truncate">
                    {item.scope} · {item.required}
                  </div>
                </div>
                <span className={item.set ? 'text-emerald-400 shrink-0' : 'text-[#64748B] shrink-0'}>
                  {item.set ? 'SET' : 'UNSET'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
