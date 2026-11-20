import { useEffect, useState } from 'react';
import { AlertTriangle, Code2, Globe, Play, RotateCcw, Search } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { CommerceSandboxWorkspace } from './CommerceSandboxWorkspace';
import { Phase7ValidationWorkspace } from './Phase7ValidationWorkspace';

// ---------------- ENVIRONMENT 05: RESEARCH OBSERVATORY ----------------
export function ResearchView() {
  const [query, setQuery] = useState('quantitative gold mean reversion backtest');
  const [arxivResult, setArxivResult] = useState<{
    status: string;
    extractedKeywords: string;
    errorMessage?: string;
    papers: Array<{ id: string; title: string; url: string; authors: string[]; publishedAt: string; summary: string }>;
  } | null>(null);
  const [webResult, setWebResult] = useState<{
    status: string;
    signals: Array<{ source: string; title: string; url: string; snippet: string }>;
  } | null>(null);
  const [knowledge, setKnowledge] = useState<{
    sources: Array<{ id: string; title: string; url: string | null; retrievalStatus: string; retrievedAt: string }>;
    evidence: Array<{ id: number; claim: string; evidenceType: string; confidence: number | null; contradictionFlag: boolean; sourceLabel: string | null }>;
  }>({ sources: [], evidence: [] });
  const [claimText, setClaimText] = useState('');
  const [evidenceType, setEvidenceType] = useState<'verified' | 'hypothesis' | 'assumption' | 'unknown'>('hypothesis');
  const [claimFilter, setClaimFilter] = useState<'all' | 'verified' | 'hypothesis' | 'contradictions'>('all');
  const [searching, setSearching] = useState(false);
  const [searchingWeb, setSearchingWeb] = useState(false);
  const [memoryMsg, setMemoryMsg] = useState<string | null>(null);

  function loadKnowledge(q = '') {
    apiFetch<typeof knowledge>(`/api/research/knowledge?q=${encodeURIComponent(q)}`).then(setKnowledge).catch(() => {});
  }
  useEffect(() => {
    loadKnowledge();
  }, []);

  async function runArxivSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    try {
      const res = await apiFetch<NonNullable<typeof arxivResult>>('/api/research/arxiv', {
        method: 'POST',
        body: JSON.stringify({ query, maxResults: 5 }),
      });
      setArxivResult(res);
      loadKnowledge();
    } finally {
      setSearching(false);
    }
  }

  async function runWebSignalSearch() {
    if (query.trim().length < 3) return;
    setSearchingWeb(true);
    try {
      const res = await apiFetch<NonNullable<typeof webResult>>('/api/research/web', {
        method: 'POST',
        body: JSON.stringify({ query, maxResults: 5 }),
      });
      setWebResult(res);
      loadKnowledge();
    } finally {
      setSearchingWeb(false);
    }
  }

  async function promoteToMemory(claim: string, sourceLabel: string | null) {
    await apiFetch('/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'verified_facts',
        title: `Research Claim: ${claim.slice(0, 60)}`,
        content: claim,
        provenance: sourceLabel || 'research_observatory',
        tags: ['promoted_evidence'],
      }),
    });
    setMemoryMsg('Claim promoted to 7-scope verified_facts memory (SHA-256 deduplicated).');
  }

  async function submitClaim(e: React.FormEvent) {
    e.preventDefault();
    if (claimText.trim().length < 5) return;
    await apiFetch('/api/research/evidence', {
      method: 'POST',
      body: JSON.stringify({ claim: claimText, evidenceType, confidence: 0.75, sourceLabel: 'Operator Research Observatory' }),
    });
    setClaimText('');
    loadKnowledge();
  }

  return (
    <div className="space-y-5">
      <div className="nexa-plane rounded-lg p-5 space-y-3">
        <h2 className="text-base font-semibold text-slate-100">Live arXiv &amp; Public Web Signal Observatory</h2>
        <form onSubmit={runArxivSearch} className="flex flex-wrap gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search topic (keywords automatically extracted)..."
            className="flex-1 min-w-[220px] min-h-[44px] bg-[#06080E] border border-[#1E2534] rounded px-3.5 text-sm text-slate-100"
          />
          <button
            type="submit"
            disabled={searching}
            className="min-h-[44px] px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs uppercase rounded flex items-center gap-2 whitespace-nowrap cursor-pointer"
          >
            <Search className="w-3.5 h-3.5" /> {searching ? 'Querying arXiv...' : 'Search arXiv Live'}
          </button>
          <button
            type="button"
            disabled={searchingWeb}
            onClick={runWebSignalSearch}
            className="min-h-[44px] px-4 bg-[#111726] border border-cyan-500/40 text-cyan-300 font-mono text-xs uppercase rounded flex items-center gap-2 whitespace-nowrap cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5" /> {searchingWeb ? 'Scanning Web...' : 'Search Web Signals'}
          </button>
        </form>

        {arxivResult && (
          <div className="pt-3 border-t border-[#1E2534] space-y-2">
            <div className="text-xs font-mono text-cyan-400">
              ARXIV STATUS: {arxivResult.status} · KEYWORDS: {arxivResult.extractedKeywords}
              {arxivResult.errorMessage ? ` · ${arxivResult.errorMessage}` : ''}
            </div>
            {arxivResult.papers.map((p) => (
              <div key={p.id} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1">
                <a href={p.url} target="_blank" rel="noreferrer" className="text-slate-100 font-semibold hover:text-cyan-300 block">
                  {p.title}
                </a>
                <div className="font-mono text-[11px] text-[#64748B]">
                  {p.authors.slice(0, 3).join(', ')} · {p.publishedAt.slice(0, 10)}
                </div>
                <p className="text-[#94A3B8] line-clamp-2">{p.summary}</p>
              </div>
            ))}
          </div>
        )}

        {webResult && (
          <div className="pt-3 border-t border-[#1E2534] space-y-2">
            <div className="text-xs font-mono text-emerald-400">
              WEB SIGNAL STATUS: {webResult.status} · {webResult.signals.length} signal(s)
            </div>
            {webResult.signals.map((sig, idx) => (
              <div key={idx} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1">
                <div className="flex justify-between gap-2 font-mono text-[11px]">
                  <a href={sig.url} target="_blank" rel="noreferrer" className="text-slate-100 font-semibold hover:text-cyan-300">
                    {sig.title}
                  </a>
                  <span className="text-sky-400 shrink-0">{sig.source}</span>
                </div>
                <p className="text-[#94A3B8] line-clamp-2">{sig.snippet}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-5 nexa-plane rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">Log Epistemic Claim & Contradiction Check</h3>
          <form onSubmit={submitClaim} className="space-y-3">
            <textarea
              value={claimText}
              onChange={(e) => setClaimText(e.target.value)}
              rows={3}
              placeholder="Record a verified fact, testable hypothesis, assumption, or unknown..."
              className="w-full bg-[#06080E] border border-[#1E2534] rounded px-3 py-2 text-xs text-slate-100"
            />
            <div className="flex justify-between gap-2">
              <select
                value={evidenceType}
                onChange={(e) => setEvidenceType(e.target.value as typeof evidenceType)}
                className="min-h-[44px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-200"
              >
                <option value="verified">VERIFIED</option>
                <option value="hypothesis">HYPOTHESIS</option>
                <option value="assumption">ASSUMPTION</option>
                <option value="unknown">UNKNOWN</option>
              </select>
              <button
                type="submit"
                className="min-h-[44px] px-4 bg-[#111726] border border-cyan-500/40 text-cyan-300 text-xs font-mono rounded cursor-pointer"
              >
                Store Claim
              </button>
            </div>
          </form>

          {knowledge.sources.length > 0 && (
            <div className="pt-3 border-t border-[#1E2534] space-y-1.5 max-h-48 overflow-y-auto">
              <div className="text-[10px] font-mono uppercase text-[#64748B]">Tracked Sources ({knowledge.sources.length})</div>
              {knowledge.sources.slice(0, 8).map((s) => (
                <div key={s.id} className="text-xs font-mono text-[#94A3B8] truncate">
                  {s.retrievalStatus} · {s.title}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-7 nexa-plane rounded-lg p-4 space-y-3 max-h-[460px] overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#1E2534]">
            <div className="text-xs font-mono text-[#94A3B8] uppercase">
              Stored Evidence ({knowledge.evidence.length}) · Sources ({knowledge.sources.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { id: 'all', label: `All (${knowledge.evidence.length})` },
                  { id: 'verified', label: `Verified (${knowledge.evidence.filter((x) => x.evidenceType === 'verified').length})` },
                  { id: 'hypothesis', label: `Hypothesis (${knowledge.evidence.filter((x) => x.evidenceType === 'hypothesis').length})` },
                  {
                    id: 'contradictions',
                    label: `Contradictions (${knowledge.evidence.filter((x) => x.contradictionFlag).length})`,
                  },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setClaimFilter(tab.id)}
                  className={`min-h-[32px] px-2.5 text-[10px] font-mono uppercase rounded border transition-colors cursor-pointer ${
                    claimFilter === tab.id
                      ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                      : 'border-[#1E2534] bg-[#06080E] text-[#64748B] hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          {memoryMsg && <div className="text-xs font-mono text-emerald-400">{memoryMsg}</div>}
          {(() => {
            const visibleEvidence = knowledge.evidence.filter((item) => {
              if (claimFilter === 'verified') return item.evidenceType === 'verified';
              if (claimFilter === 'hypothesis') return item.evidenceType === 'hypothesis';
              if (claimFilter === 'contradictions') return Boolean(item.contradictionFlag);
              return true;
            });
            return visibleEvidence.length === 0 ? (
              <p className="text-xs text-[#64748B] py-6">No evidence claims matching this epistemic filter.</p>
            ) : (
              visibleEvidence.map((e) => (
                <div key={e.id} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1">
                  <div className="flex justify-between font-mono text-[11px]">
                    <span className="text-cyan-400 uppercase">
                      {e.evidenceType}
                      {typeof e.confidence === 'number' ? ` · ${Math.round(e.confidence * 100)}%` : ''}
                    </span>
                    <div className="flex items-center gap-2">
                      {e.contradictionFlag && (
                        <span className="text-amber-400 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> CONTRADICTION FLAGGED
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => promoteToMemory(e.claim, e.sourceLabel)}
                        className="text-[10px] font-mono text-emerald-300 hover:text-emerald-200 underline cursor-pointer"
                      >
                        Save to Verified Memory
                      </button>
                    </div>
                  </div>
                  <p className="text-slate-200">{e.claim}</p>
                </div>
              ))
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// ---------------- ENVIRONMENT 07: QUANTITATIVE LABORATORY ----------------
interface BacktestRecord {
  id: string;
  datasetId?: string;
  symbol: string;
  strategyName: string;
  sourceType?: string;
  metrics: {
    totalReturnPct: number;
    sharpeRatio: number;
    sortinoRatio: number;
    maxDrawdownPct: number;
    winRatePct: number;
    profitFactor: number;
    tradeCount: number;
    finalEquity: number;
  };
  walkForward: {
    inSampleBars: number;
    outOfSampleBars: number;
    inSampleMetrics: { totalReturnPct: number; sharpeRatio: number; maxDrawdownPct: number };
    outOfSampleMetrics: { totalReturnPct: number; sharpeRatio: number; maxDrawdownPct: number };
  };
  monteCarlo: {
    iterations: number;
    p5ReturnPct: number;
    medianReturnPct: number;
    p95ReturnPct: number;
    p95MaxDrawdownPct: number;
  };
  sensitivity: Array<{ fastPeriod: number; slowPeriod: number; totalReturnPct: number; sharpeRatio: number; maxDrawdownPct: number }>;
  equityCurve: Array<{ timestamp: string; equity: number; drawdownPct: number }>;
  trades?: Array<{ entryTime: string; exitTime: string; side: string; entryPrice: number; exitPrice: number; pnlUsd: number; returnPct: number }>;
  reportMarkdown?: string;
}

export function QuantLabView({ onRefreshHealth }: { onRefreshHealth: () => void }) {
  const [datasets, setDatasets] = useState<
    Array<{
      id: string;
      symbol: string;
      timeframe: string;
      sourceType: string;
      barCount: number;
      quality: {
        passed: boolean;
        missingIntervals?: number;
        ohlcAnomalies?: number;
        nonMonotonicTimestamps?: number;
        outlierReturns?: number;
        notes?: string[];
      };
    }>
  >([]);
  const [backtests, setBacktests] = useState<BacktestRecord[]>([]);
  const [paperOrders, setPaperOrders] = useState<Array<Record<string, unknown>>>([]);
  const [activeBt, setActiveBt] = useState<BacktestRecord | null>(null);
  const [btTab, setBtTab] = useState<'trades' | 'compare' | 'report' | 'quality'>('trades');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [symbol, setSymbol] = useState('XAUUSD');
  const [strategy, setStrategy] = useState<'SMA_CROSSOVER' | 'RSI_MEAN_REVERSION' | 'EMA_ATR_TREND'>('SMA_CROSSOVER');
  const [fastPeriod, setFastPeriod] = useState(10);
  const [slowPeriod, setSlowPeriod] = useState(30);
  const [slippageBps, setSlippageBps] = useState(3);
  const [commissionBps, setCommissionBps] = useState(4);
  const [csvText, setCsvText] = useState('');
  const [running, setRunning] = useState(false);
  const [paperSide, setPaperSide] = useState<'BUY' | 'SELL'>('BUY');
  const [paperEquity, setPaperEquity] = useState(10000);
  const [paperRiskPct, setPaperRiskPct] = useState(1.0);
  const [paperEntry, setPaperEntry] = useState(2620);
  const [paperStopLoss, setPaperStopLoss] = useState(2595);
  const [paperTakeProfit, setPaperTakeProfit] = useState(2685);
  const [paperMaxDd, setPaperMaxDd] = useState(15.0);
  const [paperStatus, setPaperStatus] = useState<string | null>(null);

  function loadQuant() {
    Promise.all([
      apiFetch<{ datasets: typeof datasets }>('/api/quant/datasets'),
      apiFetch<{ backtests: BacktestRecord[]; paperOrders: Array<Record<string, unknown>> }>('/api/quant/backtests'),
    ])
      .then(([d, b]) => {
        setDatasets(d.datasets || []);
        setBacktests(b.backtests || []);
        setPaperOrders(b.paperOrders || []);
        if (!activeBt && b.backtests?.length) setActiveBt(b.backtests[0]);
      })
      .catch(() => {});
  }

  useEffect(() => {
    loadQuant();
  }, []);

  async function generateSampleDataset(targetSym: string) {
    await apiFetch('/api/quant/datasets', {
      method: 'POST',
      body: JSON.stringify({ symbol: targetSym, timeframe: '1H', sourceType: 'SYNTHETIC_SAMPLE' }),
    });
    loadQuant();
  }

  async function importCsvDataset() {
    if (!csvText.trim()) return;
    await apiFetch('/api/quant/datasets', {
      method: 'POST',
      body: JSON.stringify({ symbol, timeframe: '1H', sourceType: 'CSV_IMPORT', csvText }),
    });
    setCsvText('');
    loadQuant();
  }

  async function executeBacktest(datasetId: string) {
    setRunning(true);
    try {
      const bt = await apiFetch<BacktestRecord>('/api/quant/backtest', {
        method: 'POST',
        body: JSON.stringify({
          datasetId,
          strategyName: strategy,
          fastPeriod,
          slowPeriod,
          slippageBps,
          commissionBps,
        }),
      });
      setActiveBt(bt);
      setHoverIdx(null);
      loadQuant();
      onRefreshHealth();
    } finally {
      setRunning(false);
    }
  }

  async function placeRiskCheckedPaperOrder(e: React.FormEvent) {
    e.preventDefault();
    setPaperStatus(null);
    try {
      const res = await apiFetch<{ id: string; quantity: number; riskUsd: number; mode: string }>('/api/quant/paper-orders', {
        method: 'POST',
        body: JSON.stringify({
          symbol,
          side: paperSide,
          accountEquityUsd: Number(paperEquity),
          riskPct: Number(paperRiskPct),
          entryPrice: Number(paperEntry),
          stopLoss: Number(paperStopLoss),
          takeProfit: paperTakeProfit ? Number(paperTakeProfit) : null,
          currentDrawdownPct: activeBt?.metrics.maxDrawdownPct ?? 2.0,
          maxDrawdownLimitPct: Number(paperMaxDd),
        }),
      });
      setPaperStatus(`Paper order ${res.id} opened (${res.quantity} units, $${res.riskUsd} risk · ${res.mode}).`);
      loadQuant();
    } catch (err) {
      setPaperStatus(err instanceof Error ? err.message : 'Risk guard rejected order');
    }
  }

  // Interactive SVG Equity & Drawdown calculations
  const equityPoints = activeBt?.equityCurve || [];
  const chartW = 640;
  const chartH = 175;
  let equityPath = '';
  let drawdownPath = '';
  const coords: Array<{ x: number; yEq: number; yDd: number }> = [];

  if (equityPoints.length > 1) {
    const vals = equityPoints.map((p) => p.equity);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = Math.max(max - min, 1);
    const maxDd = Math.max(...equityPoints.map((p) => p.drawdownPct), 1);

    equityPoints.forEach((p, idx) => {
      const x = (idx / (equityPoints.length - 1)) * chartW;
      const yEq = chartH - 35 - ((p.equity - min) / span) * (chartH - 55);
      const yDd = chartH - (p.drawdownPct / maxDd) * 28;
      coords.push({ x, yEq, yDd });
    });

    equityPath = coords.map((c, idx) => `${idx === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.yEq.toFixed(1)}`).join(' ');
    drawdownPath = `M0,${chartH} ` + coords.map((c) => `L${c.x.toFixed(1)},${c.yDd.toFixed(1)}`).join(' ') + ` L${chartW},${chartH} Z`;
  }

  const inspectedPt = hoverIdx !== null && equityPoints[hoverIdx] ? equityPoints[hoverIdx] : equityPoints[equityPoints.length - 1];
  const inspectedCoord = hoverIdx !== null && coords[hoverIdx] ? coords[hoverIdx] : null;

  return (
    <div className="space-y-5">
      <div className="bg-[#0B0F19] border border-amber-500/30 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Quantitative Research & Validation Laboratory</h2>
          <p className="text-xs text-amber-300 font-mono mt-0.5">
            RESEARCH & PAPER SIMULATION ONLY · LIVE CAPITAL EXECUTION LOCKED
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => generateSampleDataset('XAUUSD')}
            className="min-h-[44px] px-3.5 bg-[#111726] border border-[#2A344B] hover:border-cyan-400 text-xs font-mono text-slate-200 rounded cursor-pointer"
          >
            + XAUUSD Sample (240 bars)
          </button>
          <button
            type="button"
            onClick={() => generateSampleDataset('BTCUSD')}
            className="min-h-[44px] px-3.5 bg-[#111726] border border-[#2A344B] hover:border-cyan-400 text-xs font-mono text-slate-200 rounded cursor-pointer"
          >
            + BTCUSD Sample (240 bars)
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-4 space-y-4">
          <div className="nexa-plane rounded-lg p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">Strategy & Friction Controls</h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="space-y-1">
                <span className="font-mono text-[11px] text-[#94A3B8]">STRATEGY</span>
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value as typeof strategy)}
                  className="w-full min-h-[44px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-slate-200 font-mono"
                >
                  <option value="SMA_CROSSOVER">SMA CROSSOVER</option>
                  <option value="RSI_MEAN_REVERSION">RSI REVERSION</option>
                  <option value="EMA_ATR_TREND">EMA + ATR TREND</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="font-mono text-[11px] text-[#94A3B8]">SYMBOL</span>
                <select
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  className="w-full min-h-[44px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-slate-200 font-mono"
                >
                  <option value="XAUUSD">XAUUSD</option>
                  <option value="BTCUSD">BTCUSD</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="font-mono text-[11px] text-[#94A3B8]">FAST / SLOW</span>
                <div className="flex gap-1">
                  <input
                    type="number"
                    value={fastPeriod}
                    onChange={(e) => setFastPeriod(Number(e.target.value))}
                    className="w-1/2 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 font-mono text-slate-200"
                  />
                  <input
                    type="number"
                    value={slowPeriod}
                    onChange={(e) => setSlowPeriod(Number(e.target.value))}
                    className="w-1/2 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 font-mono text-slate-200"
                  />
                </div>
              </label>
              <label className="space-y-1">
                <span className="font-mono text-[11px] text-[#94A3B8]">FEE / SLIP (BPS)</span>
                <div className="flex gap-1">
                  <input
                    type="number"
                    value={commissionBps}
                    onChange={(e) => setCommissionBps(Number(e.target.value))}
                    className="w-1/2 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 font-mono text-slate-200"
                  />
                  <input
                    type="number"
                    value={slippageBps}
                    onChange={(e) => setSlippageBps(Number(e.target.value))}
                    className="w-1/2 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 font-mono text-slate-200"
                  />
                </div>
              </label>
            </div>

            <div className="pt-2 border-t border-[#1E2534] space-y-2">
              <div className="text-[11px] font-mono text-[#94A3B8]">REGISTERED DATASETS ({datasets.length})</div>
              {datasets.length === 0 ? (
                <p className="text-xs text-[#64748B]">Click + XAUUSD Sample or import CSV below.</p>
              ) : (
                datasets.map((d) => (
                  <div key={d.id} className="bg-[#06080E] border border-[#1E2534] rounded p-2.5 flex items-center justify-between gap-2 text-xs">
                    <div>
                      <div className="font-mono text-slate-200">
                        {d.symbol} · {d.timeframe} ({d.barCount})
                      </div>
                      <div className="font-mono text-[10px] text-amber-400">{d.sourceType}</div>
                    </div>
                    <button
                      type="button"
                      disabled={running}
                      onClick={() => executeBacktest(d.id)}
                      className="min-h-[38px] px-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded flex items-center gap-1 cursor-pointer"
                    >
                      <Play className="w-3 h-3" /> Run
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="nexa-plane rounded-lg p-4 space-y-2">
            <div className="text-xs font-mono text-[#94A3B8]">CSV OHLCV IMPORT</div>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              rows={3}
              placeholder="timestamp,open,high,low,close,volume..."
              className="w-full bg-[#06080E] border border-[#1E2534] rounded p-2 text-xs font-mono text-slate-200"
            />
            <button
              type="button"
              onClick={importCsvDataset}
              className="w-full min-h-[40px] border border-[#2A344B] hover:border-cyan-400 text-xs font-mono text-slate-200 rounded cursor-pointer"
            >
              Validate & Import CSV
            </button>
          </div>

          {backtests.length > 1 && (
            <div className="nexa-plane rounded-lg p-3 space-y-1.5 max-h-40 overflow-y-auto">
              <div className="text-[10px] font-mono text-[#64748B] uppercase">Recent Runs ({backtests.length})</div>
              {backtests.slice(0, 6).map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => {
                    setActiveBt(b);
                    setHoverIdx(null);
                  }}
                  className={`w-full text-start px-2.5 py-1.5 rounded text-xs font-mono flex justify-between border cursor-pointer ${
                    activeBt?.id === b.id ? 'border-cyan-400 bg-cyan-500/10 text-cyan-300' : 'border-[#1E2534] bg-[#06080E] text-[#94A3B8]'
                  }`}
                >
                  <span>
                    {b.symbol} · {b.strategyName}
                  </span>
                  <span className="tabular-nums">{b.metrics.totalReturnPct}%</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-8 space-y-4">
          {!activeBt ? (
            <div className="nexa-plane rounded-lg p-12 text-center text-xs text-[#64748B]">
              Generate a sample XAUUSD/BTCUSD dataset or import CSV, then click Run to inspect the interactive Equity/Drawdown chart, Walk-Forward OOS, Monte Carlo, and 3×3 Sensitivity Heatmap.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="nexa-plane rounded-lg p-3">
                  <div className="text-[10px] font-mono text-[#94A3B8]">NET RETURN</div>
                  <div className={`text-xl font-mono font-bold tabular-nums mt-0.5 ${activeBt.metrics.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {activeBt.metrics.totalReturnPct}%
                  </div>
                </div>
                <div className="nexa-plane rounded-lg p-3">
                  <div className="text-[10px] font-mono text-[#94A3B8]">SHARPE / SORTINO</div>
                  <div className="text-xl font-mono font-bold tabular-nums text-cyan-400 mt-0.5">
                    {activeBt.metrics.sharpeRatio} / {activeBt.metrics.sortinoRatio}
                  </div>
                </div>
                <div className="nexa-plane rounded-lg p-3">
                  <div className="text-[10px] font-mono text-[#94A3B8]">MAX DRAWDOWN</div>
                  <div className="text-xl font-mono font-bold tabular-nums text-amber-400 mt-0.5">
                    {activeBt.metrics.maxDrawdownPct}%
                  </div>
                </div>
                <div className="nexa-plane rounded-lg p-3">
                  <div className="text-[10px] font-mono text-[#94A3B8]">TRADES · WIN RATE</div>
                  <div className="text-xl font-mono font-bold tabular-nums text-slate-100 mt-0.5">
                    {activeBt.metrics.tradeCount} · {activeBt.metrics.winRatePct}%
                  </div>
                </div>
              </div>

              {/* Interactive Crosshair Equity + Drawdown SVG Chart */}
              <div className="nexa-plane rounded-lg p-4">
                <div className="flex flex-wrap justify-between items-center text-xs font-mono text-[#94A3B8] mb-2 gap-2">
                  <span>
                    EQUITY & DRAWDOWN ({activeBt.symbol} · {activeBt.strategyName})
                  </span>
                  {inspectedPt && (
                    <span className="text-cyan-300 tabular-nums">
                      {inspectedPt.timestamp.slice(0, 16)} · EQ: ${inspectedPt.equity.toLocaleString()} · DD: {inspectedPt.drawdownPct}%
                    </span>
                  )}
                </div>
                <svg
                  viewBox={`0 0 ${chartW} ${chartH}`}
                  className="w-full h-48 bg-[#06080E] border border-[#1E2534] rounded cursor-crosshair"
                  onMouseMove={(e) => {
                    if (equityPoints.length < 2) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(rect.width, 1)));
                    setHoverIdx(Math.round(ratio * (equityPoints.length - 1)));
                  }}
                  onMouseLeave={() => setHoverIdx(null)}
                >
                  <line x1="0" y1="45" x2={chartW} y2="45" stroke="#1E2534" strokeDasharray="3 3" />
                  <line x1="0" y1="95" x2={chartW} y2="95" stroke="#1E2534" strokeDasharray="3 3" />
                  {drawdownPath && <path d={drawdownPath} fill="#F43F5E" fillOpacity="0.18" />}
                  {equityPath && <path d={equityPath} fill="none" stroke="#22D3EE" strokeWidth="2" />}
                  {inspectedCoord && (
                    <g>
                      <line x1={inspectedCoord.x} y1="0" x2={inspectedCoord.x} y2={chartH} stroke="#94A3B8" strokeDasharray="2 2" />
                      <circle cx={inspectedCoord.x} cy={inspectedCoord.yEq} r="4" fill="#22D3EE" stroke="#06080E" strokeWidth="1.5" />
                    </g>
                  )}
                </svg>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="nexa-plane rounded-lg p-4 space-y-2 text-xs font-mono">
                  <div className="text-[#94A3B8]">WALK-FORWARD VALIDATION (70% IS / 30% OOS)</div>
                  <div className="flex justify-between pt-1">
                    <span className="text-[#94A3B8]">In-Sample ({activeBt.walkForward.inSampleBars} bars)</span>
                    <span className="text-slate-100 tabular-nums">
                      {activeBt.walkForward.inSampleMetrics.totalReturnPct}% (Sharpe {activeBt.walkForward.inSampleMetrics.sharpeRatio})
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#94A3B8]">Out-of-Sample ({activeBt.walkForward.outOfSampleBars} bars)</span>
                    <span className="text-cyan-400 tabular-nums">
                      {activeBt.walkForward.outOfSampleMetrics.totalReturnPct}% (Sharpe {activeBt.walkForward.outOfSampleMetrics.sharpeRatio})
                    </span>
                  </div>
                </div>

                <div className="nexa-plane rounded-lg p-4 space-y-2 text-xs font-mono">
                  <div className="text-[#94A3B8]">MONTE CARLO BOOTSTRAP ({activeBt.monteCarlo.iterations} RUNS)</div>
                  <div className="flex justify-between pt-1">
                    <span className="text-[#94A3B8]">P5 / Median / P95 Return</span>
                    <span className="text-slate-100 tabular-nums">
                      {activeBt.monteCarlo.p5ReturnPct}% / {activeBt.monteCarlo.medianReturnPct}% / {activeBt.monteCarlo.p95ReturnPct}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#94A3B8]">P95 Tail Drawdown</span>
                    <span className="text-amber-400 tabular-nums">{activeBt.monteCarlo.p95MaxDrawdownPct}%</span>
                  </div>
                </div>
              </div>

              {/* 3x3 Parameter Sensitivity Matrix */}
              {activeBt.sensitivity?.length > 0 && (
                <div className="nexa-plane rounded-lg p-4 space-y-2.5">
                  <div className="text-xs font-mono text-[#94A3B8] uppercase">
                    3×3 Parameter Sensitivity Matrix (Fast / Slow Stability)
                  </div>
                  <div className="grid grid-cols-3 gap-2 font-mono text-xs">
                    {activeBt.sensitivity.map((cell, idx) => {
                      const positive = cell.totalReturnPct >= 0;
                      return (
                        <div
                          key={idx}
                          className={`rounded p-2.5 border ${
                            positive ? 'bg-emerald-950/20 border-emerald-500/30' : 'bg-rose-950/20 border-rose-500/30'
                          }`}
                        >
                          <div className="text-[10px] text-[#94A3B8]">
                            F{cell.fastPeriod} / S{cell.slowPeriod}
                          </div>
                          <div className={`text-sm font-bold tabular-nums mt-0.5 ${positive ? 'text-emerald-300' : 'text-rose-300'}`}>
                            {cell.totalReturnPct}%
                          </div>
                          <div className="text-[10px] text-[#64748B] tabular-nums">
                            Sh {cell.sharpeRatio} · DD {cell.maxDrawdownPct}%
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Trades Log / Markdown Report / Dataset Quality Tabs */}
              <div className="nexa-plane rounded-lg p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#1E2534]">
                  <div className="text-xs font-mono text-[#94A3B8] uppercase">Backtest Audit &amp; Report Inspector</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        { id: 'trades', label: `Trades (${activeBt.trades?.length ?? activeBt.metrics.tradeCount})` },
                        { id: 'compare', label: `Compare (${backtests.length})` },
                        { id: 'report', label: 'Markdown Report' },
                        { id: 'quality', label: 'Dataset Quality' },
                      ] as const
                    ).map((tItem) => (
                      <button
                        key={tItem.id}
                        type="button"
                        onClick={() => setBtTab(tItem.id)}
                        className={`min-h-[30px] px-2.5 text-[10px] font-mono uppercase rounded border cursor-pointer ${
                          btTab === tItem.id
                            ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                            : 'border-[#1E2534] bg-[#06080E] text-[#94A3B8]'
                        }`}
                      >
                        {tItem.label}
                      </button>
                    ))}
                  </div>
                </div>

                {btTab === 'trades' && (
                  <div className="overflow-x-auto max-h-52">
                    {!activeBt.trades || activeBt.trades.length === 0 ? (
                      <p className="text-xs text-[#64748B]">No closed trades generated under selected signal thresholds.</p>
                    ) : (
                      <table className="w-full text-xs text-start font-mono">
                        <thead className="text-[10px] text-[#94A3B8] border-b border-[#1E2534]">
                          <tr>
                            <th className="py-1.5 pe-2">Entry</th>
                            <th className="py-1.5 pe-2">Exit</th>
                            <th className="py-1.5 pe-2">Side</th>
                            <th className="py-1.5 pe-2 text-end">In / Out</th>
                            <th className="py-1.5 text-end">PnL (USD / %)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1E2534]/50 text-[11px]">
                          {activeBt.trades.slice(0, 30).map((tr, i) => (
                            <tr key={i}>
                              <td className="py-1.5 pe-2 text-[#94A3B8]">{tr.entryTime.slice(0, 16)}</td>
                              <td className="py-1.5 pe-2 text-[#94A3B8]">{tr.exitTime.slice(0, 16)}</td>
                              <td className="py-1.5 pe-2 text-cyan-300">{tr.side}</td>
                              <td className="py-1.5 pe-2 text-end tabular-nums">
                                {tr.entryPrice.toFixed(2)} → {tr.exitPrice.toFixed(2)}
                              </td>
                              <td className={`py-1.5 text-end tabular-nums ${tr.pnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                ${tr.pnlUsd.toFixed(2)} ({tr.returnPct.toFixed(2)}%)
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {btTab === 'compare' && (
                  <div className="overflow-x-auto max-h-56">
                    {backtests.length === 0 ? (
                      <p className="text-xs text-[#64748B]">Run at least one backtest to populate comparison metrics.</p>
                    ) : (
                      <table className="w-full text-xs text-start font-mono">
                        <thead className="text-[10px] text-[#94A3B8] border-b border-[#1E2534]">
                          <tr>
                            <th className="py-1.5 pe-2">Symbol / Strategy</th>
                            <th className="py-1.5 pe-2 text-end">Net Ret</th>
                            <th className="py-1.5 pe-2 text-end">OOS WF</th>
                            <th className="py-1.5 pe-2 text-end">Sharpe</th>
                            <th className="py-1.5 pe-2 text-end">Max DD</th>
                            <th className="py-1.5 pe-2 text-end">P95 MC DD</th>
                            <th className="py-1.5 pe-2 text-end">Win Rate</th>
                            <th className="py-1.5 text-end">PF</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1E2534]/50 text-[11px]">
                          {backtests.map((bt) => (
                            <tr
                              key={bt.id}
                              onClick={() => setActiveBt(bt)}
                              className={`cursor-pointer ${
                                activeBt.id === bt.id ? 'bg-cyan-950/30' : 'hover:bg-[#111726]/60'
                              }`}
                            >
                              <td className="py-1.5 pe-2 text-slate-200">
                                {bt.symbol} · <span className="text-cyan-300">{bt.strategyName}</span>
                              </td>
                              <td className={`py-1.5 pe-2 text-end tabular-nums ${bt.metrics.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {bt.metrics.totalReturnPct}%
                              </td>
                              <td className="py-1.5 pe-2 text-end tabular-nums text-[#94A3B8]">
                                {bt.walkForward ? `${bt.walkForward.outOfSampleMetrics.totalReturnPct}%` : '--'}
                              </td>
                              <td className="py-1.5 pe-2 text-end tabular-nums text-slate-200">{bt.metrics.sharpeRatio}</td>
                              <td className="py-1.5 pe-2 text-end tabular-nums text-amber-300">{bt.metrics.maxDrawdownPct}%</td>
                              <td className="py-1.5 pe-2 text-end tabular-nums text-[#94A3B8]">
                                {bt.monteCarlo ? `${bt.monteCarlo.p95MaxDrawdownPct}%` : '--'}
                              </td>
                              <td className="py-1.5 pe-2 text-end tabular-nums text-slate-200">{bt.metrics.winRatePct}%</td>
                              <td className="py-1.5 text-end tabular-nums text-cyan-300">{bt.metrics.profitFactor}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {btTab === 'report' && (
                  <pre className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap max-h-56 overflow-y-auto">
                    {activeBt.reportMarkdown || 'No Markdown report stored for this backtest.'}
                  </pre>
                )}

                {btTab === 'quality' && (() => {
                  const ds = datasets.find((d) => d.id === activeBt.datasetId) || datasets.find((d) => d.symbol === activeBt.symbol);
                  if (!ds) return <p className="text-xs text-[#64748B]">Dataset metadata unavailable.</p>;
                  return (
                    <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-1.5 text-xs font-mono">
                      <div className="flex justify-between">
                        <span className="text-slate-200">{ds.symbol} · {ds.timeframe} ({ds.barCount} bars)</span>
                        <span className={ds.quality.passed ? 'text-emerald-400' : 'text-amber-400'}>
                          {ds.quality.passed ? 'QUALITY PASSED' : 'QUALITY WARNING'}
                        </span>
                      </div>
                      <div className="text-[#94A3B8]">
                        Anomalies: {ds.quality.ohlcAnomalies ?? 0} · Non-monotonic: {ds.quality.nonMonotonicTimestamps ?? 0} · Missing intervals: {ds.quality.missingIntervals ?? 0} · Outliers: {ds.quality.outlierReturns ?? 0}
                      </div>
                      {(ds.quality.notes || []).map((note, idx) => (
                        <div key={idx} className="text-cyan-300 text-[11px]">· {note}</div>
                      ))}
                    </div>
                  );
                })()}
              </div>

              <form onSubmit={placeRiskCheckedPaperOrder} className="nexa-plane rounded-lg p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-mono text-slate-300">RISK-GATED PAPER EXECUTION DESK (PAPER_ONLY)</div>
                    <div className="text-[11px] text-[#64748B]">
                      Enforces 0.1%–2.5% risk sizing + max drawdown lock. Persisted paper orders: {paperOrders.length}
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="min-h-[40px] px-4 bg-[#111726] border border-cyan-500/40 hover:border-cyan-400 text-xs font-mono text-cyan-300 rounded cursor-pointer"
                  >
                    Submit Risk-Checked Paper Order
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-[11px] font-mono">
                  <label className="space-y-1">
                    <span className="text-[#64748B]">SIDE</span>
                    <select
                      value={paperSide}
                      onChange={(e) => setPaperSide(e.target.value as 'BUY' | 'SELL')}
                      className="w-full min-h-[34px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-slate-200"
                    >
                      <option value="BUY">BUY</option>
                      <option value="SELL">SELL</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[#64748B]">EQUITY ($)</span>
                    <input type="number" step="100" value={paperEquity} onChange={(e) => setPaperEquity(Number(e.target.value))} className="w-full min-h-[34px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-slate-200" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[#64748B]">RISK %</span>
                    <input type="number" step="0.1" min="0.1" max="2.5" value={paperRiskPct} onChange={(e) => setPaperRiskPct(Number(e.target.value))} className="w-full min-h-[34px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-slate-200" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[#64748B]">ENTRY</span>
                    <input type="number" step="0.01" value={paperEntry} onChange={(e) => setPaperEntry(Number(e.target.value))} className="w-full min-h-[34px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-slate-200" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[#64748B]">STOP LOSS</span>
                    <input type="number" step="0.01" value={paperStopLoss} onChange={(e) => setPaperStopLoss(Number(e.target.value))} className="w-full min-h-[34px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-slate-200" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[#64748B]">TAKE PROFIT / MAX DD%</span>
                    <div className="flex gap-1">
                      <input type="number" step="0.01" value={paperTakeProfit} onChange={(e) => setPaperTakeProfit(Number(e.target.value))} className="w-1/2 min-h-[34px] bg-[#06080E] border border-[#1E2534] rounded px-1.5 text-slate-200" />
                      <input type="number" step="0.5" value={paperMaxDd} onChange={(e) => setPaperMaxDd(Number(e.target.value))} className="w-1/2 min-h-[34px] bg-[#06080E] border border-[#1E2534] rounded px-1.5 text-slate-200" />
                    </div>
                  </label>
                </div>

                {paperStatus && <div className="text-xs font-mono text-cyan-400">{paperStatus}</div>}

                {paperOrders.length > 0 && (
                  <div className="pt-2 border-t border-[#1E2534] max-h-36 overflow-y-auto space-y-1 font-mono text-[11px]">
                    {paperOrders.slice(0, 8).map((po) => (
                      <div key={String(po.id)} className="flex flex-wrap justify-between gap-2 bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-1.5">
                        <span className="text-cyan-300">
                          {String(po.id)} · {String(po.symbol)} {String(po.side)} × {String(po.quantity)}
                        </span>
                        <span className="text-[#94A3B8]">
                          Entry {String(po.entry_price)} · SL {String(po.stop_loss)} · Risk ${String(po.risk_usd)}
                        </span>
                        <span className="text-emerald-400">{String(po.status)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------- ENVIRONMENT 08: COMMERCE INTELLIGENCE ----------------
interface CommerceTruthMetrics {
  opportunitiesDiscovered: number;
  auditsCompletedLive: number;
  totalLeads: number;
  qualifiedLeads: number;
  proposalsPrepared: number;
  proposalsApprovedOrSent: number;
  websitesGenerated: number;
  customersAcquired: number;
  verifiedPaymentsCount: number;
  realizedRevenueEur: number;
  verifiedPaymentsTotalEur?: number;
  actualOperatingCostsEur: number;
  estimatedExpensesEur?: number;
  pipelineProposalValueEur?: number;
  acceptedContractValueEur?: number;
  draftInvoicesTotalEur?: number;
  issuedInvoicesTotalEur?: number;
  outstandingBalanceEur?: number;
  expensesEur?: number;
  netProfitEur: number;
}

export function CommerceView({ onRefreshHealth }: { onRefreshHealth: () => void }) {
  const [data, setData] = useState<{
    externalActionsEnabled: boolean;
    humanApprovalRequired: boolean;
    metrics?: CommerceTruthMetrics;
    opportunities: Array<Record<string, unknown>>;
    audits?: Array<Record<string, unknown>>;
    customers: Array<Record<string, unknown>>;
    proposals?: Array<Record<string, unknown>>;
    contentAssets?: Array<Record<string, unknown>>;
    invoices: Array<Record<string, unknown>>;
    ledger?: Array<Record<string, unknown>>;
    sites: Array<Record<string, unknown>>;
  } | null>(null);
  const [schedulesData, setSchedulesData] = useState<{
    schedulerRunningInProcess: boolean;
    instanceId?: string;
    architectureEvaluation?: {
      recommendedPattern: string;
      cloudSchedulerHttpTrigger: { endpoint: string; method: string; authMode: string; tokenConfigured: boolean };
      cloudRunMinInstances: { inProcessIntervalMs: number };
    };
    schedules: Array<Record<string, unknown>>;
    recentRuns: Array<Record<string, unknown>>;
  } | null>(null);

  const [tab, setTab] = useState<'workflow' | 'sandbox' | 'validation' | 'discovery' | 'proposals' | 'factory' | 'finance'>('workflow');
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // First Revenue Workflow (Real SMB Discovery + Demo + Proposal + Outreach + Verified Payment)
  const [smbNiche, setSmbNiche] = useState('dentist');
  const [smbCity, setSmbCity] = useState('Milan');
  const [scanningBusinesses, setScanningBusinesses] = useState(false);
  const [packagingOppId, setPackagingOppId] = useState<string | null>(null);
  const [authorizingPropId, setAuthorizingPropId] = useState<string | null>(null);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [approvalTab, setApprovalTab] = useState<'email' | 'whatsapp' | 'terms' | 'presentation' | 'demo'>('email');
  const [demoViewportMode, setDemoViewportMode] = useState<'mobile' | 'desktop'>('mobile');
  const [presentationDoc, setPresentationDoc] = useState<{
    proposalId: string;
    content: string;
    integrityVerified: boolean;
    name: string;
  } | null>(null);
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);
  const [mailtoPreview, setMailtoPreview] = useState<string | null>(null);
  const [payCustomerId, setPayCustomerId] = useState('');
  const [payProposalId, setPayProposalId] = useState('');
  const [payAmountEur, setPayAmountEur] = useState(450);
  const [payReference, setPayReference] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});

  // Discovery & Live Audit
  const [auditUrl, setAuditUrl] = useState('https://example.com');
  const [auditing, setAuditing] = useState(false);
  const [niche, setNiche] = useState('Dental Clinics');
  const [market, setMarket] = useState('Milan & Lombardy');
  const [discovering, setDiscovering] = useState(false);
  const [oppTitle, setOppTitle] = useState('');

  // CRM & Proposals
  const [leadName, setLeadName] = useState('');
  const [leadEmail, setLeadEmail] = useState('');
  const [leadCompany, setLeadCompany] = useState('');
  const [propClient, setPropClient] = useState('');
  const [propTitle, setPropTitle] = useState('Digital Presence & Lead Capture Upgrade');
  const [propProblem, setPropProblem] = useState('Missing mobile responsive viewport, SEO description, and direct inquiry workflow.');
  const [propPrice, setPropPrice] = useState(450);
  const [propRetainer, setPropRetainer] = useState(120);

  // Website & Content Factory
  const [brandName, setBrandName] = useState('ImCaso Studio');
  const [tagline, setTagline] = useState('Local Business Automation & Digital Presence');
  const [lang, setLang] = useState<'en' | 'it' | 'ar' | 'fr'>('en');
  const [previewSiteId, setPreviewSiteId] = useState<string | null>(null);
  const [contentChannel, setContentChannel] = useState<'LANDING_COPY' | 'EMAIL_OUTREACH' | 'FOLLOW_UP_SEQ' | 'LINKEDIN_POST'>('EMAIL_OUTREACH');

  // Finance Ledger
  const [ledgerType, setLedgerType] = useState<'OPERATING_COST' | 'REVENUE'>('OPERATING_COST');
  const [ledgerCategory, setLedgerCategory] = useState('hosting_domain');
  const [ledgerAmount, setLedgerAmount] = useState(12);
  const [runningScheduleId, setRunningScheduleId] = useState<string | null>(null);

  function load() {
    apiFetch<NonNullable<typeof data>>('/api/commerce')
      .then((res) => {
        setData(res);
        if (!selectedProposalId && res.proposals?.length) {
          const activeFirst =
            res.proposals.find((p) => !(Boolean(p.proposal_note) && /DO NOT SEND|HISTORICAL_DRAFT/i.test(String(p.proposal_note)))) ||
            res.proposals[0];
          if (activeFirst?.id) setSelectedProposalId(String(activeFirst.id));
        }
      })
      .catch(() => {});
    apiFetch<NonNullable<typeof schedulesData>>('/api/commerce/schedules').then(setSchedulesData).catch(() => {});
  }
  useEffect(() => {
    load();
  }, []);

  async function runAudit(e: React.FormEvent) {
    e.preventDefault();
    setAuditing(true);
    setErrorBanner(null);
    setStatusBanner(null);
    try {
      const res = await apiFetch<{ sourceMode: string; digitalReadinessScore: number; detectedGaps: string[] }>('/api/commerce/audit-site', {
        method: 'POST',
        body: JSON.stringify({ url: auditUrl }),
      });
      setStatusBanner(`Audit completed (${res.sourceMode}): readiness ${res.digitalReadinessScore}/100 · ${res.detectedGaps.length} gap(s) logged.`);
      load();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Website audit error');
    } finally {
      setAuditing(false);
    }
  }

  async function runDiscover(e: React.FormEvent) {
    e.preventDefault();
    setDiscovering(true);
    setErrorBanner(null);
    setStatusBanner(null);
    try {
      const res = await apiFetch<{ webResearchStatus: string; verifiedSignalsCount: number }>('/api/commerce/discover', {
        method: 'POST',
        body: JSON.stringify({ niche, cityOrMarket: market }),
      });
      setStatusBanner(`Opportunity logged · Web Research: ${res.webResearchStatus} (${res.verifiedSignalsCount} verified sources).`);
      load();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  }

  async function addOpp() {
    if (oppTitle.trim().length < 4) return;
    setErrorBanner(null);
    try {
      await apiFetch('/api/commerce/opportunities', {
        method: 'POST',
        body: JSON.stringify({
          title: oppTitle,
          targetMarket: 'Local Service SMB',
          problemStatement: 'Manual WhatsApp and email lead triage causes delayed customer callbacks.',
          estimatedEffortHours: 24,
          revenueModel: 'Setup + Monthly Retainer',
        }),
      });
      setOppTitle('');
      load();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to create opportunity');
    }
  }

  async function addLead(e: React.FormEvent) {
    e.preventDefault();
    if (leadName.trim().length < 2) return;
    setErrorBanner(null);
    try {
      await apiFetch('/api/commerce/customers', {
        method: 'POST',
        body: JSON.stringify({
          name: leadName,
          email: leadEmail || undefined,
          company: leadCompany || undefined,
          channel: 'manual_discovery',
          stage: 'LEAD',
        }),
      });
      setLeadName('');
      setLeadEmail('');
      setLeadCompany('');
      load();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Lead creation failed');
    }
  }

  async function updateLeadStage(id: string, stage: string) {
    setErrorBanner(null);
    try {
      await apiFetch(`/api/commerce/customers/${id}/stage`, {
        method: 'PATCH',
        body: JSON.stringify({ stage }),
      });
      load();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Stage update rejected');
    }
  }

  async function submitProposal(e: React.FormEvent) {
    e.preventDefault();
    setErrorBanner(null);
    setStatusBanner(null);
    try {
      const res = await apiFetch<{ id: string; approval_id: number }>('/api/commerce/proposals', {
        method: 'POST',
        body: JSON.stringify({
          clientName: propClient,
          title: propTitle,
          problemSummary: propProblem,
          pricingTier: 'GROWTH',
          setupPriceEur: Number(propPrice),
          monthlyRetainerEur: Number(propRetainer),
          siteId: previewSiteId,
        }),
      });
      setPropClient('');
      setStatusBanner(`Proposal ${res.id} prepared (Approval Gate #${res.approval_id} required before sending).`);
      load();
      onRefreshHealth();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Proposal failed');
    }
  }

  async function buildSite(e: React.FormEvent) {
    e.preventDefault();
    setErrorBanner(null);
    try {
      const res = await apiFetch<{ id: string; approvalId: number }>('/api/commerce/sites', {
        method: 'POST',
        body: JSON.stringify({ brandName, tagline, language: lang, template: 'OMEGA_V5' }),
      });
      setPreviewSiteId(res.id);
      setStatusBanner(`Storefront MVP ${res.id} generated with live CRM inquiry capture (Approval Gate #${res.approvalId}).`);
      load();
      onRefreshHealth();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Site generation failed');
    }
  }

  async function createContentAsset() {
    setErrorBanner(null);
    try {
      await apiFetch('/api/commerce/content', {
        method: 'POST',
        body: JSON.stringify({
          channel: contentChannel,
          brandName,
          targetAudience: niche,
          offerSummary: tagline,
          language: lang,
        }),
      });
      setStatusBanner(`Marketing asset (${contentChannel}) drafted cleanly behind human approval gate.`);
      load();
      onRefreshHealth();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Content creation failed');
    }
  }

  async function addDraftInvoice() {
    setErrorBanner(null);
    try {
      await apiFetch('/api/commerce/invoices', {
        method: 'POST',
        body: JSON.stringify({ title: 'Discovery Pilot Setup Draft', currency: 'EUR', amount: 250 }),
      });
      load();
      onRefreshHealth();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Draft invoice failed');
    }
  }

  async function submitLedgerEntry(e: React.FormEvent) {
    e.preventDefault();
    setErrorBanner(null);
    try {
      await apiFetch('/api/commerce/ledger', {
        method: 'POST',
        body: JSON.stringify({
          entryType: ledgerType,
          category: ledgerCategory,
          amountEur: Number(ledgerAmount),
          verifiedPayment: ledgerType === 'REVENUE',
          notes: ledgerType === 'REVENUE' ? 'Operator verified received payment' : 'Recorded operating expense',
        }),
      });
      setStatusBanner(`Financial ledger entry (${ledgerType}: EUR ${ledgerAmount}) persisted.`);
      load();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Ledger entry failed');
    }
  }

  async function triggerSchedule(id: string) {
    setRunningScheduleId(id);
    setErrorBanner(null);
    try {
      const run = await apiFetch<{ status: string; summary: string }>(`/api/commerce/schedules/${id}/run`, { method: 'POST' });
      setStatusBanner(`Schedule run ${run.status}: ${run.summary}`);
      load();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Schedule run failed');
    } finally {
      setRunningScheduleId(null);
    }
  }

  async function toggleSchedule(id: string, enabled: boolean) {
    setErrorBanner(null);
    try {
      await apiFetch(`/api/commerce/schedules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      load();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Schedule update failed');
    }
  }

  async function runRealSmbDiscovery(e: React.FormEvent) {
    e.preventDefault();
    setScanningBusinesses(true);
    setErrorBanner(null);
    setStatusBanner(null);
    try {
      const res = await apiFetch<{ status: string; discoveredCount: number; errorMessage?: string }>('/api/commerce/discover-businesses', {
        method: 'POST',
        body: JSON.stringify({ niche: smbNiche, cityOrMarket: smbCity, limit: 6, auditWebsites: true }),
      });
      if (res.status === 'UNAVAILABLE_OFFLINE') {
        setErrorBanner(res.errorMessage || 'Public directory unreachable.');
      } else {
        setStatusBanner(`Live SMB Discovery (${res.status}): verified & scored ${res.discoveredCount} real businesses in ${smbCity}.`);
      }
      load();
      onRefreshHealth();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Live SMB discovery failed');
    } finally {
      setScanningBusinesses(false);
    }
  }

  async function buildCommercialPackage(opportunityId: string) {
    setPackagingOppId(opportunityId);
    setErrorBanner(null);
    setStatusBanner(null);
    try {
      const res = await apiFetch<{ site: { id: string }; proposal: { id: string; setup_price_eur: number; estimated_delivery_cost_eur: number; approval_id: number } }>(
        `/api/commerce/opportunities/${opportunityId}/package`,
        { method: 'POST', body: JSON.stringify({ language: lang }) }
      );
      setPreviewSiteId(res.site.id);
      setStatusBanner(
        `Demo ${res.site.id} + Proposal ${res.proposal.id} (€${res.proposal.setup_price_eur} vs €${res.proposal.estimated_delivery_cost_eur} est. cost) queued behind Approval Gate #${res.proposal.approval_id}.`
      );
      load();
      onRefreshHealth();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Commercial package generation failed');
    } finally {
      setPackagingOppId(null);
    }
  }

  async function reauditOpportunity(opportunityId: string) {
    setErrorBanner(null);
    setStatusBanner(null);
    try {
      const res = await apiFetch<{ opportunity: { title: string; website_status: string } }>(
        `/api/commerce/opportunities/${opportunityId}/reverify`,
        { method: 'POST', body: JSON.stringify({ runLiveAudit: true }) }
      );
      setStatusBanner(`Live re-audit completed for ${res.opportunity?.title || opportunityId}: ${res.opportunity?.website_status || 'UPDATED'}.`);
      load();
      onRefreshHealth();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Opportunity re-audit failed');
    }
  }

  async function handleAuthorizeOutreach(proposalId: string, markSent = false) {
    setAuthorizingPropId(proposalId);
    setErrorBanner(null);
    try {
      const res = await apiFetch<{ deliveryMode: string; mailtoUrl: string }>(
        `/api/commerce/proposals/${proposalId}/authorize-outreach`,
        { method: 'POST', body: JSON.stringify({ markSent }) }
      );
      setMailtoPreview(res.mailtoUrl);
      setStatusBanner(
        markSent
          ? `Proposal ${proposalId} authorized & logged as dispatched (${res.deliveryMode}).`
          : `Approval gate approved for ${proposalId} — communication remains UNSENT until operator manually sends.`
      );
      load();
      onRefreshHealth();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Outreach authorization failed');
    } finally {
      setAuthorizingPropId(null);
    }
  }

  async function loadPresentationArtifact(proposalId: string, artifactId: string) {
    setErrorBanner(null);
    try {
      const res = await apiFetch<{ artifact: { name: string }; integrityVerified: boolean; content: string }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}/content`
      );
      setPresentationDoc({
        proposalId,
        content: res.content,
        integrityVerified: res.integrityVerified,
        name: res.artifact?.name || 'presentation.md',
      });
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to load presentation artifact');
    }
  }

  async function createCustomerDraftInvoice(customerId: string, clientName: string, amountEur: number) {
    setErrorBanner(null);
    try {
      await apiFetch('/api/commerce/invoices', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          title: `${clientName} — Proposta Setup Mobile-First`,
          currency: 'EUR',
          amount: amountEur,
        }),
      });
      setStatusBanner(`Non-fiscal draft invoice (€${amountEur}) created for ${clientName}. Awaiting verified payment before marking revenue.`);
      load();
      onRefreshHealth();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Draft invoice failed');
    }
  }

  function copyDraftText(label: string, text: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopiedMsg(label);
    setTimeout(() => setCopiedMsg(null), 2500);
  }

  async function handleRecordReply(customerId: string, replyStatus: string) {
    setErrorBanner(null);
    try {
      await apiFetch(`/api/commerce/customers/${customerId}/reply`, {
        method: 'PATCH',
        body: JSON.stringify({ replyStatus, replyNotes: replyDrafts[customerId] || undefined }),
      });
      setStatusBanner(`CRM reply updated to ${replyStatus}.`);
      load();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to update customer reply');
    }
  }

  async function handleVerifyPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!payCustomerId || !payReference.trim()) return;
    setErrorBanner(null);
    try {
      await apiFetch('/api/commerce/payments/verify', {
        method: 'POST',
        body: JSON.stringify({
          customerId: payCustomerId,
          proposalId: payProposalId || null,
          amountEur: Number(payAmountEur),
          paymentReference: payReference,
          paymentMethod: 'verified_bank_or_card',
        }),
      });
      setPayReference('');
      setStatusBanner(`Verified payment €${payAmountEur} recorded — customer stage updated to CUSTOMER_WON.`);
      load();
      onRefreshHealth();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Payment verification failed');
    }
  }

  const m = data?.metrics;

  return (
    <div className="space-y-5">
      {/* Live Business Dashboard (8 Verified Metrics) */}
      <div className="nexa-plane rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Autonomous Commerce Engine — Live Business & Revenue Operations</h2>
            <p className="text-xs font-mono text-amber-300 mt-0.5">
              OUTBOUND COMMERCE: {data?.externalActionsEnabled ? 'AUTHORIZED' : 'APPROVAL-GATED'} · SCHEDULER:{' '}
              {schedulesData?.schedulerRunningInProcess ? '24/7 HYBRID ACTIVE' : 'IDLE'} · LIVE AUDITS: {m?.auditsCompletedLive ?? 0}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                { id: 'workflow', label: '00 First Revenue Workflow' },
                { id: 'discovery', label: '01 Audits & Signals' },
                { id: 'proposals', label: '02 CRM & Proposals' },
                { id: 'factory', label: '03 Demo & Content' },
                { id: 'finance', label: '04 Finance & 24/7 Scheduler' },
                { id: 'sandbox', label: '05 Sandbox E2E' },
                { id: 'validation', label: '06 Real-World Validation' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`min-h-[38px] px-3 rounded text-xs font-mono border cursor-pointer transition-colors ${
                  tab === item.id ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200' : 'border-[#1E2534] bg-[#06080E] text-[#94A3B8]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 pt-2 border-t border-[#1E2534] font-mono">
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Opportunities</div>
            <div className="text-sm font-semibold text-slate-100 tabular-nums">{m?.opportunitiesDiscovered ?? 0}</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Qualified Leads</div>
            <div className="text-sm font-semibold text-cyan-300 tabular-nums">
              {m?.qualifiedLeads ?? 0}/{m?.totalLeads ?? 0}
            </div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Demos Generated</div>
            <div className="text-sm font-semibold text-slate-100 tabular-nums">{m?.websitesGenerated ?? 0}</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Proposals Prepared</div>
            <div className="text-sm font-semibold text-violet-300 tabular-nums">{m?.proposalsPrepared ?? 0}</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Customers Won</div>
            <div className="text-sm font-semibold text-emerald-400 tabular-nums">{m?.customersAcquired ?? 0}</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Revenue Received</div>
            <div className="text-sm font-semibold text-emerald-300 tabular-nums">€{(m?.realizedRevenueEur ?? 0).toFixed(2)}</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Expenses</div>
            <div className="text-sm font-semibold text-amber-300 tabular-nums">€{(m?.expensesEur ?? m?.actualOperatingCostsEur ?? 0).toFixed(2)}</div>
          </div>
          <div className="bg-[#06080E] border border-[#1E2534] rounded px-2.5 py-2">
            <div className="text-[9px] text-[#64748B] uppercase">Net Profit</div>
            <div className={`text-sm font-semibold tabular-nums ${(m?.netProfitEur ?? 0) >= 0 ? 'text-cyan-300' : 'text-rose-400'}`}>
              €{(m?.netProfitEur ?? 0).toFixed(2)}
            </div>
          </div>
        </div>

        {statusBanner && <div className="text-xs font-mono text-cyan-300">{statusBanner}</div>}
        {errorBanner && <div className="text-xs font-mono text-rose-400">{errorBanner}</div>}
      </div>

      {/* TAB 00: FIRST COMPLETE REVENUE WORKFLOW */}
      {tab === 'workflow' && (
        <div className="space-y-5">
          <div className="nexa-plane rounded-lg p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-mono text-cyan-300 uppercase">Step 1–3 · Live Real-SMB Discovery, Website Audit & Prioritization</div>
                <p className="text-xs text-[#94A3B8]">
                  Queries live OpenStreetMap public business records, runs live HTTP presence audits, identifies weak/missing websites, scores opportunities, and saves CRM leads.
                </p>
              </div>
            </div>
            <form onSubmit={runRealSmbDiscovery} className="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <input
                type="text"
                value={smbNiche}
                onChange={(e) => setSmbNiche(e.target.value)}
                placeholder="Business type (e.g. dentist, bakery, architect)"
                className="sm:col-span-5 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
              />
              <input
                type="text"
                value={smbCity}
                onChange={(e) => setSmbCity(e.target.value)}
                placeholder="City / Market (e.g. Milan, Turin, Lyon)"
                className="sm:col-span-4 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
              />
              <button
                type="submit"
                disabled={scanningBusinesses}
                className="sm:col-span-3 min-h-[40px] bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs uppercase rounded cursor-pointer"
              >
                {scanningBusinesses ? 'Discovering & Auditing...' : 'Discover Real SMBs'}
              </button>
            </form>

            <div className="space-y-2 max-h-80 overflow-y-auto pt-1">
              {(data?.opportunities || []).length === 0 ? (
                <p className="text-xs text-[#64748B]">Run live SMB discovery above to populate prioritized real businesses.</p>
              ) : (
                (() => {
                  const activeFirstProposal = (data?.proposals || []).find(
                    (p) =>
                      !(Boolean(p.proposal_note) && /DO NOT SEND|HISTORICAL_DRAFT/i.test(String(p.proposal_note))) &&
                      ['DRAFT', 'APPROVED', 'SENT'].includes(String(p.status || 'DRAFT'))
                  );
                  return (data?.opportunities || []).map((o) => {
                    const hasPackage = Boolean(o.proposal_id && o.site_id);
                    const isExcluded = Boolean(o.is_chain_or_enterprise) || String(o.qualification_decision || '') === 'EXCLUDED_CHAIN';
                    const isArchived = String(o.qualification_decision || '') === 'ARCHIVED_HISTORICAL';
                    const lockedByFirstTarget = Boolean(activeFirstProposal) && !hasPackage;
                    return (
                      <div key={String(o.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="space-y-0.5">
                            <div className="font-semibold text-slate-100">{String(o.title)}</div>
                            <div className="font-mono text-[10px] text-[#94A3B8] flex flex-wrap gap-2">
                              <span className="text-cyan-300">Priority {String(o.priority_score || o.validation_score)} ({String(o.priority_tier || 'SCORED')})</span>
                              <span className="text-emerald-300">Confidence {String(o.confidence_score ?? 0)}/100</span>
                              <span>{String(o.verification_status || 'UNVERIFIED')} · {String(o.qualification_decision || 'REVIEW')}</span>
                              <span>Status: {String(o.website_status || 'EVALUATING')}</span>
                              <span>{String(o.revenue_model)}</span>
                              {Boolean(o.public_source_url) && (
                                <a href={String(o.public_source_url)} target="_blank" rel="noreferrer" className="text-sky-400 underline">
                                  Public OSM Record
                                </a>
                              )}
                              {Boolean(o.website_url) && (
                                <a href={String(o.website_url)} target="_blank" rel="noreferrer" className="text-amber-300 underline">
                                  Official Site
                                </a>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {Boolean(o.website_url) && (
                              <button
                                type="button"
                                onClick={() => reauditOpportunity(String(o.id))}
                                className="min-h-[32px] px-2.5 bg-[#111726] border border-[#2A344B] hover:border-cyan-400 text-slate-200 font-mono text-[11px] rounded cursor-pointer"
                              >
                                Re-audit Site
                              </button>
                            )}
                            {Boolean(o.site_id) && (
                              <a
                                href={
                                  String(o.site_id) === 'site_2e58dc5f-d'
                                    ? '/preview/fisioterapia-atlante'
                                    : `/preview/${String(o.site_id)}`
                                }
                                target="_blank"
                                rel="noreferrer"
                                className="min-h-[32px] px-2.5 flex items-center bg-[#111726] border border-cyan-500/40 text-cyan-300 font-mono text-[11px] rounded"
                              >
                                Open Demo
                              </a>
                            )}
                            {hasPackage ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedProposalId(String(o.proposal_id));
                                  setApprovalTab('email');
                                }}
                                className="min-h-[32px] px-3 font-semibold font-mono text-[11px] rounded bg-amber-500/20 border border-amber-400/50 text-amber-200 hover:bg-amber-500/30 cursor-pointer"
                              >
                                Open Approval Screen
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={packagingOppId === String(o.id) || isExcluded || isArchived || lockedByFirstTarget}
                                onClick={() => buildCommercialPackage(String(o.id))}
                                className={`min-h-[32px] px-3 font-semibold font-mono text-[11px] rounded ${
                                  isExcluded || isArchived || lockedByFirstTarget
                                    ? 'bg-[#111726] border border-[#2A344B] text-[#64748B] cursor-not-allowed'
                                    : 'bg-cyan-500 hover:bg-cyan-400 text-slate-950 cursor-pointer'
                                }`}
                              >
                                {isExcluded
                                  ? 'Excluded Chain'
                                  : isArchived
                                    ? 'Archived Historical'
                                    : lockedByFirstTarget
                                      ? '1st Customer Workflow Active'
                                      : packagingOppId === String(o.id)
                                        ? 'Generating...'
                                        : 'Generate Demo + Pricing + Proposal'}
                              </button>
                            )}
                          </div>
                        </div>
                        <p className="text-[11px] text-[#94A3B8]">{String(o.problem_statement)}</p>
                      </div>
                    );
                  });
                })()
              )}
            </div>
          </div>

          {/* OPERATOR PRE-SEND APPROVAL SCREEN */}
          {(() => {
            const proposals = data?.proposals || [];
            const activeProp =
              proposals.find((p) => String(p.id) === selectedProposalId) ||
              proposals.find((p) => !(Boolean(p.proposal_note) && /DO NOT SEND|HISTORICAL_DRAFT/i.test(String(p.proposal_note)))) ||
              proposals[0];
            if (!activeProp) return null;

            const isLocked = Boolean(activeProp.proposal_note) && /DO NOT SEND|HISTORICAL_DRAFT/i.test(String(activeProp.proposal_note));
            const linkedCus = (data?.customers || []).find((c) => String(c.id) === String(activeProp.customer_id || ''));
            const linkedOpp = (data?.opportunities || []).find((o) => String(o.id) === String(activeProp.opportunity_id || ''));
            const recipientEmail = linkedCus?.email ? String(linkedCus.email) : '';
            const recipientPhone = linkedCus?.phone ? String(linkedCus.phone) : '';
            const isLandlinePhone = /^\+?39\s*0\d/.test(recipientPhone) || /^0\d/.test(recipientPhone);
            const terms = (() => {
              try {
                return activeProp.commercial_terms_json ? JSON.parse(String(activeProp.commercial_terms_json)) : null;
              } catch {
                return null;
              }
            })() as {
              proposalVersion?: string;
              paymentTermsDraft?: string;
              missingOperatorLegalFields?: string[];
              domainAndHostingResponsibility?: string;
              taxAssumption?: string;
              deliveryTimeline?: string;
              setupScope?: string[];
              setupExclusions?: string[];
              monthlyObligations?: string[];
              monthlyExclusions?: string[];
            } | null;

            const proposalVersionLabel = terms?.proposalVersion || 'v2.0';
            const cleanDemoUrl =
              String(activeProp.site_id) === 'site_2e58dc5f-d'
                ? '/preview/fisioterapia-atlante'
                : activeProp.site_id
                  ? `/preview/${String(activeProp.site_id)}`
                  : null;

            return (
              <div className="nexa-plane rounded-lg p-4 space-y-4 border border-amber-500/30">
                <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-[#1E2534]">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-mono uppercase text-amber-300 font-semibold">
                        Operator Pre-Send Approval Screen
                      </span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono border border-[#2A344B] bg-[#06080E] text-cyan-300">
                        {proposalVersionLabel} · {String(activeProp.id)}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                          isLocked
                            ? 'border-rose-500/40 bg-rose-950/30 text-rose-300'
                            : String(activeProp.status) === 'DRAFT'
                              ? 'border-amber-500/40 bg-amber-950/30 text-amber-200'
                              : String(activeProp.status) === 'APPROVED'
                                ? 'border-cyan-500/40 bg-cyan-950/30 text-cyan-200'
                                : 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                        }`}
                      >
                        {isLocked
                          ? 'LOCKED HISTORICAL DRAFT — DO NOT SEND'
                          : String(activeProp.status) === 'DRAFT'
                            ? `UNSENT · GATE #${String(activeProp.approval_id)} PENDING`
                            : String(activeProp.status) === 'APPROVED'
                              ? `GATE #${String(activeProp.approval_id)} APPROVED (STILL UNSENT)`
                              : `${String(activeProp.status)} · GATE #${String(activeProp.approval_id)}`}
                      </span>
                    </div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      {String(activeProp.client_name)} — {String(activeProp.title)}
                    </h3>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        { id: 'email', label: 'Email Draft (IT)' },
                        { id: 'whatsapp', label: 'WhatsApp Draft' },
                        { id: 'terms', label: 'Scope, SLA & Exclusions' },
                        { id: 'presentation', label: 'Italian Presentation' },
                        { id: 'demo', label: 'Inspect Demo UI' },
                      ] as const
                    ).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setApprovalTab(t.id);
                          if (t.id === 'presentation' && activeProp.artifact_id) {
                            loadPresentationArtifact(String(activeProp.id), String(activeProp.artifact_id));
                          }
                        }}
                        className={`min-h-[34px] px-2.5 text-[11px] font-mono rounded border cursor-pointer ${
                          approvalTab === t.id
                            ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                            : 'border-[#1E2534] bg-[#06080E] text-[#94A3B8]'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Mandatory 7-Field Operator Pre-Send Verification Summary */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 bg-[#06080E] border border-[#1E2534] rounded p-3 text-[11px] font-mono">
                  <div>
                    <div className="text-[9px] text-[#64748B] uppercase">Recipient &amp; Contact</div>
                    <div className="text-cyan-300 break-all">{recipientEmail || 'NOT VERIFIED'}</div>
                    <div className="text-slate-300">
                      {recipientPhone || 'NO PHONE'}
                      {isLandlinePhone && <span className="text-amber-300"> (02 landline)</span>}
                    </div>
                    {Boolean(linkedOpp?.address) && <div className="text-[#64748B] text-[10px]">{String(linkedOpp?.address)}</div>}
                  </div>
                  <div>
                    <div className="text-[9px] text-[#64748B] uppercase">Commercial Price &amp; Recurring</div>
                    <div className="text-slate-100 font-semibold">Setup: EUR {Number(activeProp.setup_price_eur || 0).toFixed(2)}</div>
                    <div className="text-amber-300">Recurring SLA: EUR {Number(activeProp.monthly_retainer_eur || 0).toFixed(2)}/mo (Optional)</div>
                    <div className="text-[#94A3B8] text-[10px]">Est. cost €{String(activeProp.estimated_delivery_cost_eur)} · Est. margin €{String(activeProp.estimated_margin_eur)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] text-[#64748B] uppercase">Version &amp; Approval Status</div>
                    <div className="text-slate-100">{proposalVersionLabel} · Updated {String(activeProp.updated_at || '').slice(0, 10)}</div>
                    <div className={String(activeProp.status) === 'DRAFT' ? 'text-amber-300' : 'text-emerald-300'}>
                      {String(activeProp.status)} · Gate #{String(activeProp.approval_id)} ({String(activeProp.status) === 'DRAFT' ? 'PENDING / UNSENT' : 'RECORDED'})
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] text-[#64748B] uppercase">Verified Attachments</div>
                    <div className="text-cyan-300">Demo: {cleanDemoUrl || 'none'} ({String(activeProp.site_id || 'none')})</div>
                    <div className="text-slate-300">Doc: {String(activeProp.artifact_id || 'none')} (Markdown)</div>
                  </div>
                </div>

                {approvalTab === 'email' && (
                  <div className="bg-[#06080E] border border-[#1E2534] rounded p-3.5 space-y-2.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1E2534] pb-2">
                      <div className="font-mono text-[11px] text-cyan-300">
                        TO: {recipientEmail || 'No verified email'} · SUBJECT: {String(activeProp.outreach_subject)}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          copyDraftText(
                            'Email draft copied',
                            `Subject: ${String(activeProp.outreach_subject)}\n\n${String(activeProp.outreach_body)}`
                          )
                        }
                        className="min-h-[28px] px-2.5 bg-[#111726] border border-[#2A344B] text-[10px] font-mono text-slate-200 rounded cursor-pointer"
                      >
                        {copiedMsg === 'Email draft copied' ? 'Copied' : 'Copy Email'}
                      </button>
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-xs text-slate-200 leading-relaxed">
                      {String(activeProp.outreach_body)}
                    </pre>
                  </div>
                )}

                {approvalTab === 'whatsapp' && (
                  <div className="bg-[#06080E] border border-[#1E2534] rounded p-3.5 space-y-2.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1E2534] pb-2">
                      <div className="font-mono text-[11px] text-emerald-300">
                        WHATSAPP TARGET: {recipientPhone || 'None'} · STATUS: UNSENT
                      </div>
                      {Boolean(activeProp.whatsapp_message) && (
                        <button
                          type="button"
                          onClick={() => copyDraftText('WhatsApp draft copied', String(activeProp.whatsapp_message))}
                          className="min-h-[28px] px-2.5 bg-[#111726] border border-[#2A344B] text-[10px] font-mono text-slate-200 rounded cursor-pointer"
                        >
                          {copiedMsg === 'WhatsApp draft copied' ? 'Copied' : 'Copy WhatsApp'}
                        </button>
                      )}
                    </div>
                    {isLandlinePhone && (
                      <div className="bg-amber-950/30 border border-amber-500/30 rounded px-2.5 py-1.5 text-[11px] text-amber-200 font-mono">
                        Operator Check: {recipientPhone} is a Milan fixed landline (02 prefix). Confirm WhatsApp Business is active on this number before messaging, otherwise send via primary verified email ({recipientEmail}).
                      </div>
                    )}
                    <pre className="whitespace-pre-wrap font-sans text-xs text-slate-200 leading-relaxed">
                      {String(activeProp.whatsapp_message || 'No separate WhatsApp draft stored on this proposal.')}
                    </pre>
                  </div>
                )}

                {approvalTab === 'terms' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-2">
                      <div className="font-mono text-[11px] text-cyan-300 uppercase">
                        Setup €{String(activeProp.setup_price_eur)} One-Time — Scope &amp; Delivery
                      </div>
                      {terms?.deliveryTimeline && (
                        <p className="text-[11px] text-emerald-300 font-mono">{terms.deliveryTimeline}</p>
                      )}
                      <ul className="list-disc list-inside space-y-1 text-slate-200 text-[11.5px]">
                        {(terms?.setupScope || []).map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                      {terms?.setupExclusions && (
                        <>
                          <div className="font-mono text-[10px] text-rose-300 uppercase pt-1">Setup Exclusions</div>
                          <ul className="list-disc list-inside space-y-1 text-[#94A3B8] text-[11px]">
                            {terms.setupExclusions.map((ex, i) => (
                              <li key={i}>{ex}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                    <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-2">
                      <div className="font-mono text-[11px] text-amber-300 uppercase">
                        Optional €{String(activeProp.monthly_retainer_eur)}/mo SLA — Maintenance &amp; Exclusions
                      </div>
                      <ul className="list-disc list-inside space-y-1 text-slate-200 text-[11.5px]">
                        {(terms?.monthlyObligations || []).map((o, i) => (
                          <li key={i}>{o}</li>
                        ))}
                      </ul>
                      {terms?.monthlyExclusions && (
                        <>
                          <div className="font-mono text-[10px] text-rose-300 uppercase pt-1">Monthly SLA Exclusions</div>
                          <ul className="list-disc list-inside space-y-1 text-[#94A3B8] text-[11px]">
                            {terms.monthlyExclusions.map((ex, i) => (
                              <li key={i}>{ex}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {terms?.taxAssumption && (
                        <div className="pt-2 border-t border-[#1E2534] font-mono text-[10.5px] text-amber-200/90 space-y-1.5">
                          <div>Fiscal / VAT Note: {terms.taxAssumption}</div>
                          {terms?.paymentTermsDraft && (
                            <div className="text-cyan-200/90">Payment Schedule Draft: {terms.paymentTermsDraft}</div>
                          )}
                          {terms?.domainAndHostingResponsibility && (
                            <div className="text-slate-300">Domain Ownership: {terms.domainAndHostingResponsibility}</div>
                          )}
                          {Array.isArray(terms?.missingOperatorLegalFields) && terms.missingOperatorLegalFields.length > 0 && (
                            <div className="bg-rose-950/30 border border-rose-500/30 rounded p-2 text-rose-200 space-y-1">
                              <div className="font-semibold uppercase text-[10px]">
                                Missing Operator Legal/Fiscal Details (Required Before Binding Issue):
                              </div>
                              <ul className="list-disc list-inside space-y-0.5 text-[10.5px]">
                                {terms.missingOperatorLegalFields.map((fld, idx) => (
                                  <li key={idx}>{fld}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                      <div className="pt-2 border-t border-[#1E2534] font-mono text-[10.5px] text-[#94A3B8]">
                        Unit Economics: Delivery Cost €{String(activeProp.estimated_delivery_cost_eur)} · Est. 1st-Month Margin €
                        {String(activeProp.estimated_margin_eur)}
                      </div>
                    </div>
                  </div>
                )}

                {approvalTab === 'presentation' && (
                  <div className="bg-[#06080E] border border-[#1E2534] rounded p-3.5 space-y-2 text-xs">
                    <div className="flex flex-wrap justify-between gap-2 font-mono text-[11px] border-b border-[#1E2534] pb-2">
                      <span className="text-cyan-300">
                        Attachment Artifact: {String(activeProp.artifact_id || 'none')} ({presentationDoc?.name || 'proposal.md'})
                      </span>
                      <span className={presentationDoc?.integrityVerified ? 'text-emerald-300' : 'text-amber-300'}>
                        {presentationDoc?.integrityVerified ? 'SHA-256 INTEGRITY VERIFIED' : 'LOADING...'}
                      </span>
                    </div>
                    <pre className="whitespace-pre-wrap font-mono text-[11px] text-slate-200 max-h-80 overflow-y-auto leading-relaxed">
                      {presentationDoc?.proposalId === String(activeProp.id)
                        ? presentationDoc.content
                        : 'Click "Italian Presentation" to load verified Markdown artifact...'}
                    </pre>
                  </div>
                )}

                {approvalTab === 'demo' && Boolean(activeProp.site_id) && (() => {
                  const cleanPreviewUrl =
                    String(activeProp.site_id) === 'site_2e58dc5f-d'
                      ? '/preview/fisioterapia-atlante'
                      : `/preview/${String(activeProp.site_id)}`;
                  return (
                  <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                      <span className="text-cyan-300">
                        Customer Preview URL: {cleanPreviewUrl}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDemoViewportMode('mobile')}
                          className={`px-2.5 py-1 rounded border text-[10px] cursor-pointer ${
                            demoViewportMode === 'mobile' ? 'border-cyan-400 text-cyan-200' : 'border-[#2A344B] text-[#94A3B8]'
                          }`}
                        >
                          Mobile 390px
                        </button>
                        <button
                          type="button"
                          onClick={() => setDemoViewportMode('desktop')}
                          className={`px-2.5 py-1 rounded border text-[10px] cursor-pointer ${
                            demoViewportMode === 'desktop' ? 'border-cyan-400 text-cyan-200' : 'border-[#2A344B] text-[#94A3B8]'
                          }`}
                        >
                          Desktop
                        </button>
                        <a
                          href={cleanPreviewUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="px-2.5 py-1 bg-[#111726] border border-[#2A344B] text-slate-200 rounded text-[10px]"
                        >
                          Open Full Tab
                        </a>
                      </div>
                    </div>
                    <div className="flex justify-center bg-[#04060B] rounded p-2 border border-[#1E2534]">
                      <iframe
                        title="Customer Demo Inspection"
                        src={cleanPreviewUrl}
                        className={`h-[460px] bg-white rounded border border-[#2A344B] ${
                          demoViewportMode === 'mobile' ? 'w-[390px] max-w-full' : 'w-full'
                        }`}
                      />
                    </div>
                  </div>
                  );
                })()}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#1E2534]">
                  <div className="text-[11px] font-mono text-[#94A3B8]">
                    Attachments: Demo Site ({String(activeProp.site_id || 'none')}) + Presentation ({String(activeProp.artifact_id || 'none')})
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {Boolean(activeProp.site_id) && (
                      <a
                        href={
                          String(activeProp.site_id) === 'site_2e58dc5f-d'
                            ? '/preview/fisioterapia-atlante'
                            : `/preview/${String(activeProp.site_id)}`
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="min-h-[34px] px-3 flex items-center bg-[#111726] border border-[#2A344B] text-slate-200 font-mono text-[11px] rounded"
                      >
                        Open Demo Link
                      </a>
                    )}
                    {!isLocked && String(activeProp.status) === 'DRAFT' && (
                      <>
                        <button
                          type="button"
                          disabled={authorizingPropId === String(activeProp.id)}
                          onClick={() => handleAuthorizeOutreach(String(activeProp.id), false)}
                          className="min-h-[34px] px-3 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 font-semibold font-mono text-[11px] rounded cursor-pointer"
                        >
                          Approve Gate #{String(activeProp.approval_id)} (Keep Unsent)
                        </button>
                        <button
                          type="button"
                          disabled={authorizingPropId === String(activeProp.id)}
                          onClick={() => handleAuthorizeOutreach(String(activeProp.id), true)}
                          className="min-h-[34px] px-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold font-mono text-[11px] rounded cursor-pointer"
                        >
                          Approve &amp; Mark Dispatched
                        </button>
                      </>
                    )}
                    {!isLocked && String(activeProp.status) === 'APPROVED' && (
                      <button
                        type="button"
                        disabled={authorizingPropId === String(activeProp.id)}
                        onClick={() => handleAuthorizeOutreach(String(activeProp.id), true)}
                        className="min-h-[34px] px-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold font-mono text-[11px] rounded cursor-pointer"
                      >
                        Mark Contacted / Dispatched
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Step 4-8: Proposals & Human-Approved Outreach */}
            <div className="lg:col-span-6 nexa-plane rounded-lg p-4 space-y-3">
              <div className="text-xs font-mono text-amber-300 uppercase">Step 4–8 · Proposals, Margin &amp; Approval Queue</div>
              {mailtoPreview && (
                <div className="bg-[#06080E] border border-cyan-500/40 rounded p-2 text-xs font-mono flex items-center justify-between gap-2">
                  <span className="text-cyan-300">Operator mailto draft ready:</span>
                  <a href={mailtoPreview} className="underline text-emerald-300">Open in Operator Mail Client</a>
                </div>
              )}
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {(data?.proposals || []).length === 0 ? (
                  <p className="text-xs text-[#64748B]">Generate a Demo + Proposal on any opportunity above to queue human-gated outreach.</p>
                ) : (
                  (data?.proposals || []).map((p) => {
                    const isLockedHistorical = Boolean(p.proposal_note) && /DO NOT SEND|HISTORICAL_DRAFT/i.test(String(p.proposal_note));
                    const isSelected = selectedProposalId === String(p.id);
                    return (
                    <div
                      key={String(p.id)}
                      className={`bg-[#06080E] border rounded p-3 text-xs space-y-1.5 ${
                        isSelected ? 'border-cyan-400/70' : 'border-[#1E2534]'
                      }`}
                    >
                      <div className="flex flex-wrap justify-between gap-2 font-mono text-[11px]">
                        <span className="text-slate-100 font-semibold">{String(p.client_name)}</span>
                        <span className={isLockedHistorical ? 'text-rose-300' : 'text-amber-300'}>
                          {String(p.status)} · Gate #{String(p.approval_id)}
                        </span>
                      </div>
                      {Boolean(p.proposal_note) && (
                        <div className="text-[10px] font-mono text-rose-300 bg-rose-950/30 border border-rose-500/30 rounded px-2 py-1">
                          {String(p.proposal_note)}
                        </div>
                      )}
                      <div className="font-mono text-[11px] text-cyan-300">
                        Price: €{String(p.setup_price_eur)} + €{String(p.monthly_retainer_eur)}/mo · Cost: €{String(p.estimated_delivery_cost_eur)} · Margin: €{String(p.estimated_margin_eur)}
                      </div>
                      <p className="text-[11px] text-[#94A3B8] whitespace-pre-wrap line-clamp-2">{String(p.outreach_body)}</p>
                      <div className="flex flex-wrap gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedProposalId(String(p.id));
                            setApprovalTab('email');
                          }}
                          className="min-h-[30px] px-2.5 bg-[#111726] border border-cyan-500/40 text-cyan-300 font-mono text-[10px] rounded cursor-pointer"
                        >
                          Inspect in Approval Screen
                        </button>
                        {Boolean(p.site_id) && (
                          <a
                            href={
                              String(p.site_id) === 'site_2e58dc5f-d'
                                ? '/preview/fisioterapia-atlante'
                                : `/preview/${String(p.site_id)}`
                            }
                            target="_blank"
                            rel="noreferrer"
                            className="min-h-[30px] px-2.5 flex items-center bg-[#111726] border border-[#2A344B] text-slate-200 font-mono text-[10px] rounded"
                          >
                            Preview Demo
                          </a>
                        )}
                      </div>
                    </div>
                  );})
                )}
              </div>
            </div>

            {/* Step 9: Acquisition Lifecycle Tracking & Verified Payments */}
            <div className="lg:col-span-6 nexa-plane rounded-lg p-4 space-y-3">
              <div className="text-xs font-mono text-emerald-300 uppercase">Step 9 · Acquisition Lifecycle (Contact → Response → Negotiation → Acceptance → Invoice → Paid)</div>
              <form onSubmit={handleVerifyPayment} className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-2">
                <div className="text-[10px] font-mono text-[#94A3B8] uppercase">Record Actual Customer Payment (Strictly Verified)</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <select
                    value={payCustomerId}
                    onChange={(e) => setPayCustomerId(e.target.value)}
                    className="min-h-[36px] bg-[#0B111E] border border-[#2A344B] rounded px-2 text-xs text-slate-100"
                  >
                    <option value="">Select CRM Customer...</option>
                    {(data?.customers || []).map((c) => (
                      <option key={String(c.id)} value={String(c.id)}>
                        {String(c.name)} ({String(c.stage)})
                      </option>
                    ))}
                  </select>
                  <select
                    value={payProposalId}
                    onChange={(e) => setPayProposalId(e.target.value)}
                    className="min-h-[36px] bg-[#0B111E] border border-[#2A344B] rounded px-2 text-xs text-slate-100"
                  >
                    <option value="">Optional Linked Proposal...</option>
                    {(data?.proposals || []).map((p) => (
                      <option key={String(p.id)} value={String(p.id)}>
                        {String(p.client_name)} (€{String(p.setup_price_eur)})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                  <input
                    type="number"
                    step="0.01"
                    value={payAmountEur}
                    onChange={(e) => setPayAmountEur(Number(e.target.value))}
                    placeholder="EUR"
                    className="sm:col-span-3 min-h-[36px] bg-[#0B111E] border border-[#2A344B] rounded px-2 text-xs font-mono text-slate-100"
                  />
                  <input
                    type="text"
                    value={payReference}
                    onChange={(e) => setPayReference(e.target.value)}
                    placeholder="Verified bank/Stripe/invoice ref..."
                    className="sm:col-span-6 min-h-[36px] bg-[#0B111E] border border-[#2A344B] rounded px-2 text-xs text-slate-100"
                  />
                  <button
                    type="submit"
                    className="sm:col-span-3 min-h-[36px] bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs rounded cursor-pointer"
                  >
                    Verify Paid
                  </button>
                </div>
              </form>

              <div className="space-y-2 max-h-60 overflow-y-auto">
                {(data?.customers || []).map((c) => {
                  const stage = String(c.stage || 'LEAD');
                  const hasCustomerInvoice = (data?.invoices || []).some((inv) => String(inv.customer_id || '') === String(c.id));
                  return (
                  <div key={String(c.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-2.5 text-xs space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-semibold text-slate-100">{String(c.name)}</span>{' '}
                        <span className="font-mono text-[10px] text-cyan-300">[{stage}]</span>
                        {Boolean(c.phone) && <span className="font-mono text-[10px] text-[#94A3B8] ml-2">{String(c.phone)}</span>}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <select
                          value={stage}
                          onChange={(e) => updateLeadStage(String(c.id), e.target.value)}
                          className="min-h-[28px] bg-[#0B111E] border border-[#2A344B] rounded px-2 text-[10px] font-mono text-cyan-300"
                        >
                          <option value="LEAD">LEAD</option>
                          <option value="QUALIFIED">QUALIFIED</option>
                          <option value="CONTACTED">1. CONTACTED</option>
                          <option value="PROPOSAL_SENT">1. PROPOSAL_SENT</option>
                          <option value="RESPONDED">2. RESPONDED</option>
                          <option value="NEGOTIATION">3. NEGOTIATION</option>
                          <option value="ACCEPTED">4. ACCEPTED</option>
                          <option value="CUSTOMER_WON">6. CUSTOMER_WON (PAID)</option>
                          <option value="CHURNED">CHURNED</option>
                        </select>
                        <select
                          value={String(c.reply_status || 'NONE')}
                          onChange={(e) => handleRecordReply(String(c.id), e.target.value)}
                          className="min-h-[28px] bg-[#0B111E] border border-[#2A344B] rounded px-2 text-[10px] font-mono text-amber-300"
                        >
                          <option value="NONE">NO_REPLY</option>
                          <option value="REPLIED_INTERESTED">REPLIED_INTERESTED</option>
                          <option value="REPLIED_QUESTIONS">REPLIED_QUESTIONS</option>
                          <option value="DECLINED">DECLINED</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1 font-mono text-[9.5px]">
                      {[
                        { label: 'Contact', active: ['CONTACTED', 'PROPOSAL_SENT', 'RESPONDED', 'NEGOTIATION', 'ACCEPTED', 'CUSTOMER_WON'].includes(stage) },
                        { label: 'Response', active: ['RESPONDED', 'NEGOTIATION', 'ACCEPTED', 'CUSTOMER_WON'].includes(stage) },
                        { label: 'Negotiation', active: ['NEGOTIATION', 'ACCEPTED', 'CUSTOMER_WON'].includes(stage) },
                        { label: 'Acceptance', active: ['ACCEPTED', 'CUSTOMER_WON'].includes(stage) },
                        { label: 'Invoice', active: hasCustomerInvoice || stage === 'CUSTOMER_WON' },
                        { label: 'Paid', active: stage === 'CUSTOMER_WON' },
                      ].map((step) => (
                        <span
                          key={step.label}
                          className={`px-1.5 py-0.5 rounded border ${
                            step.active
                              ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                              : 'border-[#1E2534] bg-[#0B111E] text-[#64748B]'
                          }`}
                        >
                          {step.label}
                        </span>
                      ))}
                      {stage === 'ACCEPTED' && !hasCustomerInvoice && (
                        <button
                          type="button"
                          onClick={() => createCustomerDraftInvoice(String(c.id), String(c.name), 450)}
                          className="ml-auto px-2 py-0.5 bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 rounded cursor-pointer"
                        >
                          + Create Draft Invoice (€450)
                        </button>
                      )}
                    </div>

                    <input
                      type="text"
                      value={replyDrafts[String(c.id)] ?? String(c.reply_notes || '')}
                      onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [String(c.id)]: e.target.value }))}
                      placeholder="Reply / negotiation note (saved on reply status change)..."
                      className="w-full min-h-[28px] bg-[#0B111E] border border-[#1E2534] rounded px-2 text-[11px] text-slate-200"
                    />
                  </div>
                );})}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'sandbox' && <CommerceSandboxWorkspace />}

      {tab === 'validation' && <Phase7ValidationWorkspace />}

      {/* TAB 01: OPPORTUNITY DISCOVERY & LIVE WEBSITE AUDITING */}
      {tab === 'discovery' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-6 nexa-plane rounded-lg p-4 space-y-4">
            <div className="text-xs font-mono text-[#94A3B8] uppercase">Live Website Presence Auditor (SSRF-Protected HTTP Check)</div>
            <form onSubmit={runAudit} className="flex flex-wrap gap-2">
              <input
                type="url"
                value={auditUrl}
                onChange={(e) => setAuditUrl(e.target.value)}
                placeholder="https://client-business-domain.com"
                className="flex-1 min-w-[200px] min-h-[42px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-100"
              />
              <button
                type="submit"
                disabled={auditing}
                className="min-h-[42px] px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs uppercase rounded cursor-pointer"
              >
                {auditing ? 'Auditing...' : 'Audit Live Site'}
              </button>
            </form>

            <div className="space-y-2 max-h-64 overflow-y-auto">
              {(data?.audits || []).length === 0 ? (
                <p className="text-xs text-[#64748B]">No live business website audits recorded yet.</p>
              ) : (
                (data?.audits || []).map((a) => {
                  const gaps = (() => {
                    try {
                      return JSON.parse(String(a.detected_gaps_json || '[]')) as string[];
                    } catch {
                      return [];
                    }
                  })();
                  return (
                    <div key={String(a.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1">
                      <div className="flex justify-between font-mono text-[11px]">
                        <span className="text-cyan-400 truncate max-w-[68%]">{String(a.target_url)}</span>
                        <span className="text-amber-300">
                          {String(a.source_mode)} · {String(a.digital_readiness_score)}/100
                        </span>
                      </div>
                      <p className="text-[#94A3B8]">{String(a.summary)}</p>
                      {gaps.length > 0 && (
                        <ul className="list-disc list-inside text-[11px] text-rose-300/90 space-y-0.5 pt-1">
                          {gaps.map((g, idx) => (
                            <li key={idx}>{g}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="lg:col-span-6 nexa-plane rounded-lg p-4 space-y-4">
            <div className="text-xs font-mono text-[#94A3B8] uppercase">Live Market Signal Discovery & Scoring</div>
            <form onSubmit={runDiscover} className="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <input
                type="text"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                placeholder="Target SMB niche"
                className="sm:col-span-5 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
              />
              <input
                type="text"
                value={market}
                onChange={(e) => setMarket(e.target.value)}
                placeholder="City / Market"
                className="sm:col-span-4 min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
              />
              <button
                type="submit"
                disabled={discovering}
                className="sm:col-span-3 min-h-[40px] bg-[#111726] border border-cyan-500/40 text-cyan-300 text-xs font-mono rounded cursor-pointer"
              >
                {discovering ? 'Scanning...' : 'Discover Live'}
              </button>
            </form>

            <div className="flex gap-2">
              <input
                type="text"
                value={oppTitle}
                onChange={(e) => setOppTitle(e.target.value)}
                placeholder="Or record specific manual opportunity..."
                className="flex-1 min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
              />
              <button
                type="button"
                onClick={addOpp}
                className="min-h-[38px] px-3 bg-[#111726] border border-[#2A344B] text-xs font-mono text-slate-200 rounded cursor-pointer"
              >
                Add
              </button>
            </div>

            <div className="space-y-2 max-h-56 overflow-y-auto">
              {(data?.opportunities || []).map((o) => (
                <div key={String(o.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-2.5 text-xs space-y-1">
                  <div className="flex justify-between gap-2">
                    <span className="font-semibold text-slate-100">{String(o.title)}</span>
                    <span className="font-mono text-cyan-400 shrink-0">Score {String(o.validation_score)}</span>
                  </div>
                  <div className="text-[11px] font-mono text-amber-300">{String(o.revenue_model)}</div>
                  <p className="text-[11px] text-[#94A3B8] line-clamp-2">{String(o.evidence_notes)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 02: CRM & SALES PROPOSAL ENGINE */}
      {tab === 'proposals' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-5 nexa-plane rounded-lg p-4 space-y-3">
            <div className="text-xs font-mono text-[#94A3B8] uppercase">CRM Pipeline ({data?.customers.length || 0})</div>
            <form onSubmit={addLead} className="space-y-2">
              <input
                type="text"
                value={leadName}
                onChange={(e) => setLeadName(e.target.value)}
                placeholder="Contact full name"
                className="w-full min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="email"
                  value={leadEmail}
                  onChange={(e) => setLeadEmail(e.target.value)}
                  placeholder="Email (optional)"
                  className="min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
                />
                <input
                  type="text"
                  value={leadCompany}
                  onChange={(e) => setLeadCompany(e.target.value)}
                  placeholder="Business / Clinic"
                  className="min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
                />
              </div>
              <button
                type="submit"
                className="w-full min-h-[40px] bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs uppercase rounded cursor-pointer"
              >
                Add Prospect Lead
              </button>
            </form>

            <div className="space-y-1.5 max-h-64 overflow-y-auto pt-2 border-t border-[#1E2534]">
              {(data?.customers || []).map((c) => (
                <div key={String(c.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-2.5 text-xs flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-slate-100 font-medium truncate">
                      {String(c.name)} {c.company ? `· ${String(c.company)}` : ''}
                    </div>
                    <div className="font-mono text-[10px] text-[#64748B]">{String(c.channel)}</div>
                  </div>
                  <select
                    value={String(c.stage)}
                    onChange={(e) => updateLeadStage(String(c.id), e.target.value)}
                    className="min-h-[32px] bg-[#0B111E] border border-[#2A344B] rounded px-2 text-[10px] font-mono text-cyan-300"
                  >
                    <option value="LEAD">LEAD</option>
                    <option value="QUALIFIED">QUALIFIED</option>
                    <option value="CONTACTED">CONTACTED</option>
                    <option value="PROPOSAL_SENT">PROPOSAL_SENT</option>
                    <option value="RESPONDED">RESPONDED</option>
                    <option value="NEGOTIATION">NEGOTIATION</option>
                    <option value="ACCEPTED">ACCEPTED</option>
                    <option value="CUSTOMER_WON">CUSTOMER_WON</option>
                    <option value="CHURNED">CHURNED</option>
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-7 nexa-plane rounded-lg p-4 space-y-3">
            <div className="text-xs font-mono text-[#94A3B8] uppercase">Proposal, Costing & Approval-Gated Outreach Engine</div>
            <form onSubmit={submitProposal} className="space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  value={propClient}
                  onChange={(e) => setPropClient(e.target.value)}
                  placeholder="Client business name"
                  className="min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
                />
                <input
                  type="text"
                  value={propTitle}
                  onChange={(e) => setPropTitle(e.target.value)}
                  placeholder="Proposal title"
                  className="min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
                />
              </div>
              <textarea
                value={propProblem}
                onChange={(e) => setPropProblem(e.target.value)}
                rows={2}
                placeholder="Diagnosed online presence problems & business impact..."
                className="w-full bg-[#06080E] border border-[#1E2534] rounded px-3 py-2 text-xs text-slate-100"
              />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <label className="text-[10px] font-mono text-[#94A3B8]">
                  SETUP PRICE (EUR)
                  <input
                    type="number"
                    value={propPrice}
                    onChange={(e) => setPropPrice(Number(e.target.value))}
                    className="w-full mt-1 min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-xs text-slate-100"
                  />
                </label>
                <label className="text-[10px] font-mono text-[#94A3B8]">
                  MONTHLY SLA (EUR)
                  <input
                    type="number"
                    value={propRetainer}
                    onChange={(e) => setPropRetainer(Number(e.target.value))}
                    className="w-full mt-1 min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-xs text-slate-100"
                  />
                </label>
                <div className="flex items-end">
                  <button
                    type="submit"
                    className="w-full min-h-[38px] bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs uppercase rounded cursor-pointer"
                  >
                    Generate Proposal + Gate
                  </button>
                </div>
              </div>
            </form>

            <div className="space-y-2 max-h-56 overflow-y-auto pt-2 border-t border-[#1E2534]">
              {(data?.proposals || []).map((p) => (
                <div key={String(p.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1">
                  <div className="flex justify-between font-mono text-[11px]">
                    <span className="text-slate-100 font-semibold">
                      {String(p.client_name)} · {String(p.title)}
                    </span>
                    <span className="text-amber-300">
                      {String(p.status)} · Gate #{String(p.approval_id)}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-cyan-300">
                    Price: €{String(p.setup_price_eur)} + €{String(p.monthly_retainer_eur)}/mo · Est. Cost: €
                    {String(p.estimated_delivery_cost_eur)} · Est. Margin: €{String(p.estimated_margin_eur)}
                  </div>
                  <div className="text-[11px] text-[#94A3B8] whitespace-pre-wrap line-clamp-3">{String(p.outreach_body)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 03: WEBSITE & CONTENT FACTORY */}
      {tab === 'factory' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <form onSubmit={buildSite} className="lg:col-span-6 nexa-plane rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Globe className="w-4 h-4 text-cyan-400" /> Commercial Website Factory (Live Inquiry Capture Built-In)
            </div>
            <input
              type="text"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              placeholder="Brand name"
              className="w-full min-h-[42px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-sm text-slate-100"
            />
            <input
              type="text"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="Value proposition tagline"
              className="w-full min-h-[42px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-sm text-slate-100"
            />
            <div className="flex justify-between gap-2">
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value as typeof lang)}
                className="min-h-[42px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-200"
              >
                <option value="en">ENGLISH</option>
                <option value="it">ITALIAN</option>
                <option value="ar">ARABIC (RTL)</option>
                <option value="fr">FRENCH</option>
              </select>
              <button
                type="submit"
                className="min-h-[42px] px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs uppercase rounded cursor-pointer"
              >
                Generate Live Demo Site
              </button>
            </div>
            {previewSiteId && (
              <div className="space-y-1.5">
                <a
                  href={`/preview/${previewSiteId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-mono text-cyan-300 underline block"
                >
                  Open Standalone Storefront MVP (/preview/{previewSiteId})
                </a>
                <iframe
                  title="Generated Site Preview"
                  src={`/preview/${previewSiteId}`}
                  className="w-full h-56 border border-[#1E2534] rounded bg-black"
                />
              </div>
            )}
          </form>

          <div className="lg:col-span-6 nexa-plane rounded-lg p-4 space-y-3">
            <div className="text-xs font-mono text-[#94A3B8] uppercase">Content Factory (Approval-Gated Marketing Assets)</div>
            <div className="flex gap-2">
              <select
                value={contentChannel}
                onChange={(e) => setContentChannel(e.target.value as typeof contentChannel)}
                className="flex-1 min-h-[42px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs font-mono text-slate-200"
              >
                <option value="EMAIL_OUTREACH">EMAIL_OUTREACH</option>
                <option value="FOLLOW_UP_SEQ">FOLLOW_UP_SEQ</option>
                <option value="LANDING_COPY">LANDING_COPY</option>
                <option value="LINKEDIN_POST">LINKEDIN_POST</option>
              </select>
              <button
                type="button"
                onClick={createContentAsset}
                className="min-h-[42px] px-4 bg-[#111726] border border-cyan-500/40 text-cyan-300 text-xs font-mono rounded cursor-pointer"
              >
                Generate Draft
              </button>
            </div>

            <div className="space-y-2 max-h-72 overflow-y-auto">
              {(data?.contentAssets || []).map((asset) => (
                <div key={String(asset.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1">
                  <div className="flex justify-between font-mono text-[11px]">
                    <span className="text-cyan-400">{String(asset.title)}</span>
                    <span className="text-amber-300">
                      {String(asset.status)} · Gate #{String(asset.approval_id)}
                    </span>
                  </div>
                  <p className="text-[#94A3B8] whitespace-pre-wrap">{String(asset.body)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 04: FINANCIAL TRUTH LEDGER & CONTINUOUS SCHEDULER */}
      {tab === 'finance' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-6 nexa-plane rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-mono text-[#94A3B8] uppercase">Financial Truth Ledger & Non-Fiscal Draft Invoices</div>
              <button
                type="button"
                onClick={addDraftInvoice}
                className="min-h-[34px] px-2.5 bg-[#111726] border border-[#2A344B] text-[11px] font-mono text-slate-200 rounded cursor-pointer"
              >
                + Draft Invoice (€250)
              </button>
            </div>

            {/* Cent-Precision Projection vs Verified Cash Separation */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-[11px]">
              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                <div className="text-[9px] text-[#64748B] uppercase">Pipeline Proposals (Proj.)</div>
                <div className="text-violet-300 font-semibold tabular-nums">€{(m?.pipelineProposalValueEur ?? 0).toFixed(2)}</div>
              </div>
              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                <div className="text-[9px] text-[#64748B] uppercase">Est. Delivery Cost (Proj.)</div>
                <div className="text-amber-300 font-semibold tabular-nums">€{(m?.estimatedExpensesEur ?? 0).toFixed(2)}</div>
              </div>
              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                <div className="text-[9px] text-[#64748B] uppercase">Accepted Contracts</div>
                <div className="text-cyan-300 font-semibold tabular-nums">€{(m?.acceptedContractValueEur ?? 0).toFixed(2)}</div>
              </div>
              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                <div className="text-[9px] text-[#64748B] uppercase">Issued / Draft Invoices</div>
                <div className="text-slate-200 tabular-nums">
                  €{(m?.issuedInvoicesTotalEur ?? 0).toFixed(2)} / €{(m?.draftInvoicesTotalEur ?? 0).toFixed(2)}
                </div>
              </div>
              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                <div className="text-[9px] text-[#64748B] uppercase">Verified Payments Recv.</div>
                <div className="text-emerald-300 font-semibold tabular-nums">€{(m?.verifiedPaymentsTotalEur ?? m?.realizedRevenueEur ?? 0).toFixed(2)}</div>
              </div>
              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                <div className="text-[9px] text-[#64748B] uppercase">Outstanding Balance</div>
                <div className="text-rose-300 font-semibold tabular-nums">€{(m?.outstandingBalanceEur ?? 0).toFixed(2)}</div>
              </div>
            </div>

            <form onSubmit={submitLedgerEntry} className="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <select
                value={ledgerType}
                onChange={(e) => setLedgerType(e.target.value as typeof ledgerType)}
                className="sm:col-span-4 min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-xs font-mono text-slate-200"
              >
                <option value="OPERATING_COST">OPERATING_COST</option>
                <option value="REVENUE">VERIFIED REVENUE</option>
              </select>
              <input
                type="text"
                value={ledgerCategory}
                onChange={(e) => setLedgerCategory(e.target.value)}
                placeholder="Category"
                className="sm:col-span-3 min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-xs text-slate-100"
              />
              <input
                type="number"
                step="0.01"
                value={ledgerAmount}
                onChange={(e) => setLedgerAmount(Number(e.target.value))}
                className="sm:col-span-2 min-h-[38px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-xs font-mono text-slate-100"
              />
              <button
                type="submit"
                className="sm:col-span-3 min-h-[38px] bg-cyan-500 text-slate-950 font-semibold text-xs rounded cursor-pointer"
              >
                Record EUR
              </button>
            </form>

            <div className="space-y-1.5 max-h-56 overflow-y-auto pt-2 border-t border-[#1E2534] text-xs font-mono">
              {(data?.ledger || []).map((row) => (
                <div key={String(row.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-2 flex justify-between">
                  <span className={row.entry_type === 'REVENUE' ? 'text-emerald-400' : 'text-rose-300'}>
                    {String(row.entry_type)} · {String(row.category)}
                  </span>
                  <span className="text-slate-200 tabular-nums">€{Number(row.amount_eur).toFixed(2)}</span>
                </div>
              ))}
              {(data?.invoices || []).map((inv) => (
                <div key={String(inv.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-2">
                  <div className="text-slate-200">
                    {String(inv.title)} · €{String(inv.amount)} ({String(inv.status)})
                  </div>
                  <div className="text-[10px] text-amber-400">{String(inv.fiscal_disclaimer)}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-6 nexa-plane rounded-lg p-4 space-y-3">
            <div className="text-xs font-mono text-[#94A3B8] uppercase">24/7 Production Scheduler & Missed-Run Recovery</div>
            {schedulesData?.architectureEvaluation && (
              <div className="bg-[#06080E] border border-[#1E2534] rounded p-2.5 text-[11px] font-mono text-[#94A3B8] space-y-1">
                <div className="text-cyan-300">
                  Mode: {schedulesData.architectureEvaluation.recommendedPattern} · Instance: {schedulesData.instanceId}
                </div>
                <div>
                  HTTP Trigger: POST {schedulesData.architectureEvaluation.cloudSchedulerHttpTrigger.endpoint} · Token:{' '}
                  {schedulesData.architectureEvaluation.cloudSchedulerHttpTrigger.tokenConfigured ? 'CONFIGURED' : 'OPERATOR_FALLBACK_ONLY'}
                </div>
              </div>
            )}
            <div className="space-y-2">
              {(schedulesData?.schedules || []).map((sc) => {
                const enabled = Number(sc.enabled) === 1;
                return (
                  <div key={String(sc.id)} className="bg-[#06080E] border border-[#1E2534] rounded p-3 text-xs space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-100">{String(sc.name)}</div>
                        <div className="font-mono text-[10px] text-[#64748B]">
                          {String(sc.cron_description)} · Last: {sc.last_status ? String(sc.last_status) : 'NEVER_RUN'} · Recovered:{' '}
                          {String(sc.missed_runs_recovered ?? 0)}
                        </div>
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => toggleSchedule(String(sc.id), !enabled)}
                          className={`min-h-[32px] px-2.5 text-[10px] font-mono rounded border cursor-pointer ${
                            enabled ? 'border-emerald-500/40 text-emerald-300' : 'border-[#2A344B] text-[#94A3B8]'
                          }`}
                        >
                          {enabled ? 'ACTIVE' : 'PAUSED'}
                        </button>
                        <button
                          type="button"
                          disabled={runningScheduleId === String(sc.id)}
                          onClick={() => triggerSchedule(String(sc.id))}
                          className="min-h-[32px] px-2.5 bg-cyan-500 text-slate-950 font-semibold text-[10px] font-mono rounded cursor-pointer"
                        >
                          {runningScheduleId === String(sc.id) ? 'Running...' : 'Run Now'}
                        </button>
                      </div>
                    </div>
                    {Boolean(sc.last_summary) && <div className="text-[11px] text-[#94A3B8]">{String(sc.last_summary)}</div>}
                  </div>
                );
              })}
            </div>

            <div className="pt-2 border-t border-[#1E2534] space-y-1 max-h-40 overflow-y-auto font-mono text-[11px]">
              <div className="text-[#64748B] uppercase text-[10px]">Recent Execution Logs</div>
              {(schedulesData?.recentRuns || []).map((r) => (
                <div key={String(r.id)} className="text-[#94A3B8]">
                  [{String(r.status)}] {String(r.schedule_id)} — {String(r.summary || r.error_message || '')}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- ENVIRONMENT 09: ENGINEERING FORGE ----------------
export function EngineeringView({ onRefreshHealth }: { onRefreshHealth: () => void }) {
  const [projects, setProjects] = useState<Array<{ id: string; name: string; stack: string; status: string; lastTestStatus: string }>>([]);
  const [selected, setSelected] = useState<{
    id: string;
    name: string;
    stack: string;
    status: string;
    lastBuildLog: string;
    lastTestStatus: string;
    files: Array<{ path: string; content: string }>;
    snapshots: Array<{ id: string; label: string; sha256: string }>;
  } | null>(null);
  const [activeFilePath, setActiveFilePath] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [newName, setNewName] = useState('');
  const [newObj, setNewObj] = useState('');
  const [newStack, setNewStack] = useState<'node_ts_service' | 'python_quant_script' | 'static_web_app'>('node_ts_service');
  const [running, setRunning] = useState(false);

  function loadList() {
    apiFetch<{ projects: typeof projects }>('/api/engineering/projects').then((d) => setProjects(d.projects || [])).catch(() => {});
  }
  useEffect(() => {
    loadList();
  }, []);

  async function selectProject(id: string) {
    const res = await apiFetch<{ project: NonNullable<typeof selected> }>(`/api/engineering/projects/${id}`);
    setSelected(res.project);
    if (res.project.files.length > 0) {
      setActiveFilePath(res.project.files[0].path);
      setFileContent(res.project.files[0].content);
    }
  }

  async function createProj(e: React.FormEvent) {
    e.preventDefault();
    if (newName.trim().length < 2 || newObj.trim().length < 5) return;
    const res = await apiFetch<{ project: NonNullable<typeof selected> }>('/api/engineering/projects', {
      method: 'POST',
      body: JSON.stringify({ name: newName, objective: newObj, stack: newStack }),
    });
    setNewName('');
    setNewObj('');
    setSelected(res.project);
    if (res.project.files.length > 0) {
      setActiveFilePath(res.project.files[0].path);
      setFileContent(res.project.files[0].content);
    }
    loadList();
    onRefreshHealth();
  }

  async function saveFile() {
    if (!selected || !activeFilePath) return;
    const res = await apiFetch<{ project: NonNullable<typeof selected> }>(`/api/engineering/projects/${selected.id}/files`, {
      method: 'PUT',
      body: JSON.stringify({ path: activeFilePath, content: fileContent }),
    });
    setSelected(res.project);
  }

  async function runTests() {
    if (!selected) return;
    setRunning(true);
    try {
      const res = await apiFetch<{ project: NonNullable<typeof selected> }>(`/api/engineering/projects/${selected.id}/test`, {
        method: 'POST',
      });
      setSelected(res.project);
      loadList();
    } finally {
      setRunning(false);
    }
  }

  async function takeSnapshot() {
    if (!selected) return;
    await apiFetch(`/api/engineering/projects/${selected.id}/snapshot`, {
      method: 'POST',
      body: JSON.stringify({ label: `checkpoint_${new Date().toISOString().slice(11, 19)}` }),
    });
    selectProject(selected.id);
  }

  async function rollback(snapshotId: string) {
    if (!selected) return;
    const res = await apiFetch<{ project: NonNullable<typeof selected> }>(`/api/engineering/projects/${selected.id}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ snapshotId }),
    });
    setSelected(res.project);
    const current = res.project.files.find((f) => f.path === activeFilePath) || res.project.files[0];
    if (current) {
      setActiveFilePath(current.path);
      setFileContent(current.content);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <div className="lg:col-span-4 space-y-4">
        <form onSubmit={createProj} className="nexa-plane rounded-lg p-4 space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Code2 className="w-4 h-4 text-cyan-400" /> New Sandboxed Workspace
          </div>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Project name (e.g., alpha_validator)"
            className="w-full min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
          />
          <input
            type="text"
            value={newObj}
            onChange={(e) => setNewObj(e.target.value)}
            placeholder="Engineering objective..."
            className="w-full min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-3 text-xs text-slate-100"
          />
          <div className="flex justify-between gap-2">
            <select
              value={newStack}
              onChange={(e) => setNewStack(e.target.value as typeof newStack)}
              className="min-h-[40px] bg-[#06080E] border border-[#1E2534] rounded px-2 text-xs font-mono text-slate-200"
            >
              <option value="node_ts_service">NODE ESM SERVICE</option>
              <option value="python_quant_script">PYTHON QUANT</option>
              <option value="static_web_app">STATIC WEB APP</option>
            </select>
            <button type="submit" className="min-h-[40px] px-4 bg-cyan-500 text-slate-950 font-semibold text-xs rounded cursor-pointer">
              Scaffold
            </button>
          </div>
        </form>

        <div className="nexa-plane rounded-lg p-4 space-y-2">
          <div className="text-xs font-mono text-[#94A3B8] uppercase">Projects ({projects.length})</div>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => selectProject(p.id)}
              className={`w-full text-start p-2.5 rounded border text-xs cursor-pointer ${
                selected?.id === p.id ? 'bg-cyan-500/10 border-cyan-500/40' : 'bg-[#06080E] border-[#1E2534]'
              }`}
            >
              <div className="font-semibold text-slate-100">{p.name}</div>
              <div className="font-mono text-[10px] text-[#94A3B8] mt-0.5">
                {p.stack} · TESTS: {p.lastTestStatus}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="lg:col-span-8 nexa-plane rounded-lg p-4 space-y-4">
        {!selected ? (
          <div className="text-xs text-[#64748B] py-16 text-center">
            Scaffold or select a sandboxed project to edit files, run isolated syntax/tests, and manage snapshots.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1E2534]">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">{selected.name}</h3>
                <div className="text-xs font-mono text-cyan-400">
                  {selected.stack} · STATUS: {selected.status} · TESTS: {selected.lastTestStatus}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={saveFile} className="min-h-[38px] px-3 border border-[#2A344B] text-xs font-mono text-slate-200 rounded cursor-pointer">
                  Save File
                </button>
                <button type="button" onClick={takeSnapshot} className="min-h-[38px] px-3 border border-[#2A344B] text-xs font-mono text-slate-200 rounded cursor-pointer">
                  Snapshot
                </button>
                <button
                  type="button"
                  disabled={running}
                  onClick={runTests}
                  className="min-h-[38px] px-4 bg-cyan-500 text-slate-950 font-semibold text-xs rounded cursor-pointer"
                >
                  {running ? 'Running...' : 'Validate & Run Tests'}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {selected.files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => {
                    setActiveFilePath(f.path);
                    setFileContent(f.content);
                  }}
                  className={`px-3 py-1.5 text-xs font-mono rounded border cursor-pointer ${
                    activeFilePath === f.path ? 'border-cyan-400 bg-cyan-500/15 text-cyan-300' : 'border-[#1E2534] bg-[#06080E] text-[#94A3B8]'
                  }`}
                >
                  {f.path}
                </button>
              ))}
            </div>

            <textarea
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              rows={11}
              className="w-full bg-[#06080E] border border-[#1E2534] rounded p-3 font-mono text-xs text-slate-100"
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-[#06080E] border border-[#1E2534] rounded p-3">
                <div className="text-[11px] font-mono text-[#94A3B8] mb-1">BUILD & TEST LOG</div>
                <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {selected.lastBuildLog || 'No build run yet.'}
                </pre>
              </div>
              <div className="bg-[#06080E] border border-[#1E2534] rounded p-3 space-y-1.5">
                <div className="text-[11px] font-mono text-[#94A3B8]">SNAPSHOTS & ROLLBACK ({selected.snapshots.length})</div>
                {selected.snapshots.map((sn) => (
                  <div key={sn.id} className="flex items-center justify-between text-xs font-mono">
                    <span className="text-slate-300 truncate max-w-[180px]">{sn.label}</span>
                    <button
                      type="button"
                      onClick={() => rollback(sn.id)}
                      className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" /> Rollback
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
