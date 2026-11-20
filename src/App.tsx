import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  Brain,
  Code2,
  Cpu,
  FlaskConical,
  Grid,
  Languages,
  LineChart,
  Orbit,
  RefreshCw,
  Settings,
  Shield,
  ShoppingBag,
  Terminal,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NexaLivingUniverse, type UniverseAgentNode } from './components/NexaCoreCanvas';
import { apiFetch, setStoredSessionToken } from './lib/api';
import { I18N } from './lib/i18n';
import { ENVIRONMENTS } from './types/ui';
import type { CoreState, EnvironmentId, HealthSnapshot, UiLang } from './types/ui';
import { CommandView, GenesisView } from './views/GenesisAndCommandViews';

// Route-level code splitting for domain & governance laboratories (extreme mobile performance)
const NetworkView = lazy(() => import('./views/NetworkAndModelsViews').then((m) => ({ default: m.NetworkView })));
const ModelsView = lazy(() => import('./views/NetworkAndModelsViews').then((m) => ({ default: m.ModelsView })));
const ResearchView = lazy(() => import('./views/DomainLabViews').then((m) => ({ default: m.ResearchView })));
const QuantLabView = lazy(() => import('./views/DomainLabViews').then((m) => ({ default: m.QuantLabView })));
const CommerceView = lazy(() => import('./views/DomainLabViews').then((m) => ({ default: m.CommerceView })));
const EngineeringView = lazy(() => import('./views/DomainLabViews').then((m) => ({ default: m.EngineeringView })));
const MemoryView = lazy(() => import('./views/GovernanceViews').then((m) => ({ default: m.MemoryView })));
const AnalyticsView = lazy(() => import('./views/GovernanceViews').then((m) => ({ default: m.AnalyticsView })));
const SecurityView = lazy(() => import('./views/GovernanceViews').then((m) => ({ default: m.SecurityView })));
const SystemControlView = lazy(() => import('./views/GovernanceViews').then((m) => ({ default: m.SystemControlView })));

const ENV_ICONS: Record<EnvironmentId, LucideIcon> = {
  genesis: Orbit,
  command: Terminal,
  network: Bot,
  models: Cpu,
  research: FlaskConical,
  memory: Brain,
  quant: LineChart,
  commerce: ShoppingBag,
  engineering: Code2,
  analytics: Activity,
  security: Shield,
  control: Settings,
};

const CLUSTERS: Array<'PORTAL' | 'INTELLIGENCE' | 'DOMAINS' | 'GOVERNANCE'> = [
  'PORTAL',
  'INTELLIGENCE',
  'DOMAINS',
  'GOVERNANCE',
];

const DESKTOP_MERIDIAN_TABS: EnvironmentId[] = [
  'genesis',
  'command',
  'network',
  'models',
  'research',
  'memory',
  'quant',
  'engineering',
];

const MOBILE_QUICK_TABS: EnvironmentId[] = ['genesis', 'command', 'quant', 'network'];

function SpaceLoadingFallback() {
  return (
    <div className="nexa-plane rounded-lg p-8 flex items-center justify-center min-h-[260px]">
      <div className="font-mono text-xs text-sky-300 tracking-wider uppercase">Synchronizing laboratory instruments...</div>
    </div>
  );
}

export default function App() {
  const [activeEnv, setActiveEnv] = useState<EnvironmentId>('genesis');
  const [coreState, setCoreState] = useState<CoreState>('aware');
  const [lang, setLang] = useState<UiLang>('en');
  const [lowPowerMode, setLowPowerMode] = useState(false);
  const [zenInspect, setZenInspect] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [sessionUser, setSessionUser] = useState<{ username: string; role: string } | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [agentsRaw, setAgentsRaw] = useState<Array<{ id: string; dependsOn: string[]; requiredByDefault: boolean }>>([]);
  const [agentRunsRaw, setAgentRunsRaw] = useState<
    Array<{ id?: number; mission_id?: string; agent_id: string; status: string; created_at?: string }>
  >([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const sessionUserRef = useRef<{ username: string; role: string } | null>(null);
  sessionUserRef.current = sessionUser;

  const t = I18N[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  const refreshHealth = useCallback(async (authenticatedOverride?: boolean) => {
    setRefreshing(true);
    try {
      const h = await apiFetch<HealthSnapshot>('/api/health');
      if (h && Array.isArray(h.configuredProviders) && h.counts) {
        setHealth(h);
      }
      if (authenticatedOverride ?? Boolean(sessionUserRef.current)) {
        const a = await apiFetch<{
          agents: Array<{ id: string; dependsOn: string[]; requiredByDefault: boolean }>;
          recentRuns: Array<{ id?: number; mission_id?: string; agent_id: string; status: string; created_at?: string }>;
        }>('/api/agents');
        setAgentsRaw(Array.isArray(a?.agents) ? a.agents : []);
        setAgentRunsRaw(Array.isArray(a?.recentRuns) ? a.recentRuns : []);
      }
    } catch {
      // ignore transient poll errors
    } finally {
      setRefreshing(false);
    }
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const s = await apiFetch<{ user: { username: string; role: string } | null }>('/api/auth/session');
      const userObj = s && typeof s === 'object' && 'user' in s ? s.user : null;
      sessionUserRef.current = userObj;
      setSessionUser(userObj);
      setSessionChecked(true);
      return Boolean(userObj);
    } catch {
      sessionUserRef.current = null;
      setSessionUser(null);
      setSessionChecked(true);
      return false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const authed = await refreshSession();
      if (active) {
        await refreshHealth(authed);
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshSession, refreshHealth]);

  async function handleOperatorLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    if (!loginUsername.trim() || !loginPassword) {
      setLoginError('Enter your operator username and password.');
      return;
    }
    setLoggingIn(true);
    try {
      const res = await apiFetch<{ token: string; user: { username: string; role: string } }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: loginUsername.trim(), password: loginPassword }),
      });
      setStoredSessionToken(res.token);
      setLoginPassword('');
      setSessionUser(res.user);
      setSessionChecked(true);
      await refreshHealth(true);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleOperatorLogout() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore network error on logout
    }
    setStoredSessionToken(null);
    setAgentsRaw([]);
    setAgentRunsRaw([]);
    await refreshSession();
    setDrawerOpen(false);
  }

  // Live agent_runs telemetry sync during active execution/reasoning/collaboration states
  useEffect(() => {
    if (coreState !== 'executing' && coreState !== 'collaborating' && coreState !== 'reasoning') return;
    let cancelled = false;
    const interval = window.setInterval(async () => {
      if (cancelled || document.hidden) return;
      try {
        const a = await apiFetch<{
          recentRuns: Array<{ id?: number; mission_id?: string; agent_id: string; status: string; created_at?: string }>;
        }>('/api/agents');
        if (!cancelled && a.recentRuns) setAgentRunsRaw(a.recentRuns);
      } catch {
        // ignore transient poll errors
      }
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [coreState]);

  // Real database execution state fed directly to the 3D Living Intelligence sculpture
  const universeAgents: UniverseAgentNode[] = useMemo(() => {
    const executedIds = new Set(agentRunsRaw.filter((r) => r.status === 'SUCCESS').map((r) => r.agent_id));
    const failedIds = new Set(agentRunsRaw.filter((r) => r.status === 'FAILED').map((r) => r.agent_id));
    return agentsRaw.map((a) => ({
      id: a.id,
      dependsOn: a.dependsOn || [],
      requiredByDefault: a.requiredByDefault,
      executed: executedIds.has(a.id),
      failed: failedIds.has(a.id),
    }));
  }, [agentsRaw, agentRunsRaw]);

  function navigateTo(id: EnvironmentId) {
    setActiveEnv(id);
    if (id !== 'genesis') setZenInspect(false);
    setDrawerOpen(false);
  }

  function cycleLanguage() {
    setLang((prev) => (prev === 'en' ? 'ar' : prev === 'ar' ? 'fr' : 'en'));
  }

  const activeMeta = ENVIRONMENTS.find((e) => e.id === activeEnv) || ENVIRONMENTS[0];
  const activeCopy = t.envs[activeEnv];

  function renderEnvironment() {
    switch (activeEnv) {
      case 'genesis':
        return (
          <GenesisView
            lang={lang}
            lowPowerMode={lowPowerMode}
            health={health}
            coreState={coreState}
            setCoreState={setCoreState}
            zenInspect={zenInspect}
            setZenInspect={setZenInspect}
            onNavigate={navigateTo}
            onRefreshHealth={refreshHealth}
          />
        );
      case 'command':
        return (
          <CommandView
            lang={lang}
            lowPowerMode={lowPowerMode}
            coreState={coreState}
            setCoreState={setCoreState}
            audioLevel={audioLevel}
            setAudioLevel={setAudioLevel}
            onRefreshHealth={refreshHealth}
          />
        );
      case 'network':
        return <NetworkView />;
      case 'models':
        return <ModelsView />;
      case 'research':
        return <ResearchView />;
      case 'memory':
        return <MemoryView />;
      case 'quant':
        return <QuantLabView onRefreshHealth={refreshHealth} />;
      case 'commerce':
        return <CommerceView onRefreshHealth={refreshHealth} />;
      case 'engineering':
        return <EngineeringView onRefreshHealth={refreshHealth} />;
      case 'analytics':
        return <AnalyticsView />;
      case 'security':
        return <SecurityView onSessionChange={refreshSession} onRefreshHealth={refreshHealth} />;
      case 'control':
        return <SystemControlView onRefreshHealth={refreshHealth} />;
      default:
        return null;
    }
  }

  return (
    <div className="min-h-screen bg-[#030508] text-[#F4F6FA] relative flex flex-col">
      {/* Continuous Living Intelligence Monument (Permanent Full-Viewport Spatial Anchor) */}
      <NexaLivingUniverse
        coreState={coreState}
        activeEnv={activeEnv}
        lang={lang}
        lowPowerMode={lowPowerMode}
        agents={universeAgents}
        agentRunsRaw={agentRunsRaw}
        zenInspect={zenInspect && activeEnv === 'genesis'}
        audioLevel={audioLevel}
      />

      {/* Top Horizon Meridian (Opaque surface — zero backdrop-filter over WebGL) */}
      <header className="sticky top-0 z-30 h-12 bg-[#060911] border-b border-[#1E2534] px-3 sm:px-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => navigateTo('genesis')}
            className="flex items-center gap-2.5 text-start cursor-pointer shrink-0 min-h-[40px] whitespace-nowrap"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 text-sky-400" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polygon points="12,2 21,12 12,22 3,12" />
              <circle cx="12" cy="12" r="2.75" />
            </svg>
            <span className="font-mono text-xs tracking-[0.24em] font-semibold text-[#F4F6FA]">{t.brandTitle}</span>
          </button>

          <span className="hidden sm:inline text-[#1E2534]" aria-hidden="true">/</span>

          <div className="hidden sm:flex items-baseline gap-2 min-w-0">
            <span className="font-mono text-[11px] text-sky-300 tracking-wider shrink-0">
              {activeMeta.index}. {activeCopy.shortLabel}
            </span>
            <span className="text-xs text-[#94A3B8] truncate hidden md:inline">{activeCopy.subtitle}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0 font-mono text-[11px]">
          <span className="hidden lg:inline text-[#94A3B8] tabular-nums whitespace-nowrap">
            Keys <strong className="text-[#F4F6FA]">{health && Array.isArray(health.configuredProviders) ? `${health.configuredProviders.length}/${health.totalProviders ?? 0}` : '—'}</strong>
          </span>
          <span className="hidden lg:inline text-[#1E2534]" aria-hidden="true">·</span>
          <span className="hidden lg:inline text-[#94A3B8] tabular-nums whitespace-nowrap">
            Gates <strong className="text-amber-300">{health?.counts?.pendingApprovals ?? 0}</strong>
          </span>
          <span className="hidden xl:inline text-violet-300 uppercase whitespace-nowrap">{sessionUser?.role || 'operator'}</span>

          <button
            type="button"
            onClick={() => setLowPowerMode((p) => !p)}
            className="hidden sm:inline-flex min-h-[34px] px-2.5 items-center bg-[#030508] border border-[#1E2534] hover:border-sky-400 text-[#94A3B8] hover:text-[#F4F6FA] rounded cursor-pointer whitespace-nowrap shrink-0"
          >
            {lowPowerMode ? t.common.lowPowerMode : t.common.webglMode}
          </button>

          <button
            type="button"
            onClick={cycleLanguage}
            aria-label="Switch UI language"
            className="min-h-[36px] min-w-[44px] px-2.5 flex items-center justify-center gap-1 bg-[#030508] border border-[#1E2534] hover:border-sky-400 text-sky-300 rounded uppercase cursor-pointer whitespace-nowrap shrink-0"
          >
            <Languages className="w-3.5 h-3.5" />
            <span>{lang}</span>
          </button>

          <button
            type="button"
            onClick={() => refreshHealth()}
            aria-label="Synchronize telemetry"
            className="min-h-[36px] min-w-[40px] px-2 flex items-center justify-center bg-[#030508] border border-[#1E2534] hover:border-sky-400 text-slate-200 rounded cursor-pointer shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>

          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open all 12 spatial environments"
            className="min-h-[36px] min-w-[44px] px-2.5 flex items-center justify-center gap-1.5 bg-[#0B111E] border border-[#2A344B] hover:border-sky-400 text-[#F4F6FA] rounded cursor-pointer whitespace-nowrap shrink-0"
          >
            <Grid className="w-3.5 h-3.5 text-sky-400" />
            <span className="hidden sm:inline">12 Spaces</span>
          </button>
        </div>
      </header>

      {/* Spatial Architectural Index Drawer (All 12 Environments + Mobile Controls) */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button
            type="button"
            aria-label="Close spatial index"
            onClick={() => setDrawerOpen(false)}
            className="flex-1 bg-black/80 cursor-pointer"
          />
          <div className="w-80 max-w-[88vw] bg-[#060911] border-s border-[#1E2534] h-full flex flex-col">
            <div className="px-4 py-3.5 border-b border-[#1E2534] flex items-center justify-between">
              <div>
                <div className="font-mono text-xs font-semibold tracking-[0.2em] text-sky-400">{t.brandTitle}</div>
                <div className="text-[11px] font-mono text-[#94A3B8]">Spatial Observatory · 12 Environments</div>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close spatial index"
                className="min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-300 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
              {CLUSTERS.map((cluster) => (
                <div key={cluster} className="space-y-1">
                  <div className="px-2 text-[11px] font-mono text-[#64748B]">
                    {t.clusters[cluster]}
                  </div>
                  {ENVIRONMENTS.filter((item) => item.cluster === cluster).map((item) => {
                    const Icon = ENV_ICONS[item.id];
                    const isActive = activeEnv === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => navigateTo(item.id)}
                        className={`w-full min-h-[44px] px-3 rounded flex items-center gap-3 text-xs text-start cursor-pointer border ${
                          isActive
                            ? 'bg-sky-500/15 border-sky-400/50 text-sky-200 font-medium'
                            : 'border-transparent text-slate-300 hover:bg-[#0C111E]'
                        }`}
                      >
                        <Icon className="w-4 h-4 shrink-0 text-sky-400" />
                        <span className="font-mono text-[10px] text-[#64748B] tabular-nums">{item.index}.</span>
                        <span className="truncate">{t.envs[item.id].label}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="p-3 border-t border-[#1E2534] space-y-2">
              <div className="flex justify-between font-mono text-[11px] text-[#94A3B8]">
                <span>Role: {sessionUser?.role || 'signed out'}</span>
                <span>State: {t.coreStates[coreState].shortLabel}</span>
              </div>
              <button
                type="button"
                onClick={() => setLowPowerMode((p) => !p)}
                className="w-full min-h-[42px] px-3 bg-[#030508] border border-[#1E2534] rounded text-xs font-mono text-slate-200 cursor-pointer"
              >
                {lowPowerMode ? t.common.lowPowerMode : t.common.webglMode}
              </button>
              {sessionUser && (
                <button
                  type="button"
                  onClick={handleOperatorLogout}
                  className="w-full min-h-[42px] px-3 bg-[#030508] border border-rose-500/40 hover:border-rose-400 rounded text-xs font-mono text-rose-300 cursor-pointer"
                >
                  Sign Out ({sessionUser.username})
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Spatial Workspace Stage */}
      <main
        key={activeEnv}
        className={`relative z-10 flex-1 w-full mx-auto pb-20 ${
          activeEnv === 'genesis' ? 'max-w-[1380px] px-4 sm:px-6 pt-2' : 'max-w-[1460px] px-4 sm:px-6 pt-5'
        } nexa-stage-enter`}
      >
        {sessionChecked && !sessionUser ? (
          <div className="min-h-[72vh] flex items-center justify-center px-2 py-8">
            <div className="w-full max-w-md bg-[#060911]/95 border border-[#1E2534] rounded-xl p-6 sm:p-7 shadow-2xl">
              <div className="flex items-center gap-2.5 mb-2">
                <Shield className="w-5 h-5 text-sky-400 shrink-0" />
                <span className="font-mono text-xs tracking-[0.2em] text-sky-400 uppercase">{t.brandTitle}</span>
              </div>
              <h1 className="text-xl font-semibold text-[#F4F6FA] mb-1">Production Operator Sign-In</h1>
              <p className="text-xs text-[#94A3B8] mb-5">
                Authenticate with your NEXA operator or admin credentials to access missions, Phase 7 deliverables, and governance controls.
              </p>
              <form onSubmit={handleOperatorLogin} className="space-y-4">
                <div>
                  <label htmlFor="nexa-login-user" className="block text-xs font-mono text-slate-300 mb-1.5">
                    Username
                  </label>
                  <input
                    id="nexa-login-user"
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    className="w-full min-h-[46px] px-3.5 bg-[#030508] border border-[#2A344B] focus:border-sky-400 rounded-lg text-sm text-[#F4F6FA] outline-none"
                    placeholder="admin"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="nexa-login-pass" className="block text-xs font-mono text-slate-300 mb-1.5">
                    Password
                  </label>
                  <input
                    id="nexa-login-pass"
                    type="password"
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    className="w-full min-h-[46px] px-3.5 bg-[#030508] border border-[#2A344B] focus:border-sky-400 rounded-lg text-sm text-[#F4F6FA] outline-none"
                    placeholder="Enter configured password"
                    required
                  />
                </div>
                {loginError && (
                  <div role="alert" className="p-3 rounded-lg bg-rose-950/60 border border-rose-500/40 text-xs text-rose-200">
                    {loginError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={loggingIn}
                  className="w-full min-h-[48px] bg-sky-500 hover:bg-sky-400 disabled:opacity-60 text-[#030508] font-semibold text-sm rounded-lg cursor-pointer transition-colors"
                >
                  {loggingIn ? 'Authenticating...' : 'Sign In to NEXA'}
                </button>
              </form>
            </div>
          </div>
        ) : (
          <>
            {activeEnv !== 'genesis' && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1E2534]">
                <div>
                  <div className="text-[11px] font-mono tracking-wider text-sky-400">
                    {activeMeta.index}. {t.clusters[activeMeta.cluster]}
                  </div>
                  <h1 className="text-lg sm:text-xl font-semibold text-[#F4F6FA]">{activeCopy.label}</h1>
                </div>
                <button
                  type="button"
                  onClick={() => navigateTo('genesis')}
                  className="min-h-[38px] px-3.5 bg-[#060911] border border-[#1E2534] hover:border-sky-400 text-xs font-mono text-sky-300 rounded cursor-pointer whitespace-nowrap"
                >
                  01. {t.envs.genesis.shortLabel}
                </button>
              </div>
            )}

            <Suspense fallback={<SpaceLoadingFallback />}>{renderEnvironment()}</Suspense>
          </>
        )}
      </main>

      {/* Bottom Spatial Meridian Navigation Bar */}
      <nav
        className="fixed bottom-0 inset-x-0 z-30 h-14 pb-safe bg-[#060911] border-t border-[#1E2534]"
        aria-label="Spatial Meridian Navigation"
      >
        {/* Mobile Thumb Dock */}
        <div className="lg:hidden grid grid-cols-5 h-full">
          {MOBILE_QUICK_TABS.map((envId) => {
            const Icon = ENV_ICONS[envId];
            const isActive = activeEnv === envId;
            return (
              <button
                key={envId}
                type="button"
                onClick={() => navigateTo(envId)}
                className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-mono cursor-pointer ${
                  isActive ? 'text-sky-300 bg-sky-500/10' : 'text-[#94A3B8]'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="truncate max-w-full px-1">{t.envs[envId].shortLabel}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-mono text-[#94A3B8] hover:text-sky-300 cursor-pointer"
          >
            <Grid className="w-4 h-4" />
            <span>12</span>
          </button>
        </div>

        {/* Desktop Spatial Meridian Instrument Bar */}
        <div className="hidden lg:flex items-center justify-center gap-1 h-full px-4 max-w-[1440px] mx-auto">
          {DESKTOP_MERIDIAN_TABS.map((envId) => {
            const meta = ENVIRONMENTS.find((e) => e.id === envId)!;
            const Icon = ENV_ICONS[envId];
            const isActive = activeEnv === envId;
            return (
              <button
                key={envId}
                type="button"
                onClick={() => navigateTo(envId)}
                className={`min-h-[40px] px-3 rounded flex items-center gap-2 text-xs font-mono transition-colors cursor-pointer border whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-sky-500/12 border-sky-400/50 text-sky-200'
                    : 'border-transparent text-[#94A3B8] hover:text-[#F4F6FA] hover:bg-[#0B111E]'
                }`}
              >
                <Icon className="w-3.5 h-3.5 text-sky-400" />
                <span className="text-[10px] text-[#64748B] tabular-nums">{meta.index}</span>
                <span>{t.envs[envId].shortLabel}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="min-h-[40px] px-3 ms-2 rounded border border-[#1E2534] hover:border-sky-400 text-xs font-mono text-amber-300 flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
          >
            <Grid className="w-3.5 h-3.5" />
            <span>+4</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
