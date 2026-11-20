import crypto from 'node:crypto';
import { getDb, nowIso, recordAuditEvent } from '../db/database.ts';
import { saveArtifact } from '../kernel/masterKernel.ts';

export function isLiveTradingEnabled(): boolean {
  // Paper-only policy: reads NEXA_LIVE_TRADING_ENABLED for audit inspection but refuses live capital execution in this build.
  const requested = (process.env.NEXA_LIVE_TRADING_ENABLED || 'false').trim().toLowerCase();
  if (requested === 'true') {
    recordAuditEvent('system', 'QUANT_SAFETY', 'LIVE_TRADING_OVERRIDE_BLOCKED', { requested: true, enforced: false });
  }
  return false;
}

export interface OhlcvBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DataQualityReport {
  barCount: number;
  missingIntervals: number;
  nonMonotonicTimestamps: number;
  ohlcAnomalies: number;
  outlierReturns: number;
  passed: boolean;
  notes: string[];
}

export type StrategyName = 'SMA_CROSSOVER' | 'RSI_MEAN_REVERSION' | 'EMA_ATR_TREND';

export interface BacktestParams {
  datasetId: string;
  strategyName: StrategyName;
  fastPeriod?: number;
  slowPeriod?: number;
  rsiPeriod?: number;
  rsiBuy?: number;
  rsiSell?: number;
  initialCapital?: number;
  commissionBps?: number;
  slippageBps?: number;
  riskPerTradePct?: number;
}

export interface TradeRecord {
  entryTime: string;
  exitTime: string;
  side: 'LONG';
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  returnPct: number;
}

export interface PerformanceMetrics {
  totalReturnPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  tradeCount: number;
  finalEquity: number;
}

function createPrng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function generateSyntheticSampleBars(symbol: 'XAUUSD' | 'BTCUSD' | string, count = 240): OhlcvBar[] {
  const upper = symbol.toUpperCase();
  const seed = upper === 'XAUUSD' ? 20261116 : upper === 'BTCUSD' ? 91827364 : 42424242;
  const rand = createPrng(seed);
  const startPrice = upper === 'XAUUSD' ? 2620 : upper === 'BTCUSD' ? 88500 : 100;
  const volScale = upper === 'XAUUSD' ? 0.0045 : upper === 'BTCUSD' ? 0.012 : 0.008;

  const bars: OhlcvBar[] = [];
  let price = startPrice;
  const startMs = Date.UTC(2026, 7, 1, 0, 0, 0);

  for (let i = 0; i < count; i++) {
    const cycle = Math.sin(i / 18) * volScale * 0.65;
    const shock = (rand() - 0.495) * volScale * 2.1;
    const ret = cycle + shock;
    const open = price;
    const close = Math.max(1, open * (1 + ret));
    const wickUp = Math.abs(rand() * volScale * 0.85) * open;
    const wickDown = Math.abs(rand() * volScale * 0.85) * open;
    const high = Math.max(open, close) + wickUp;
    const low = Math.max(0.5, Math.min(open, close) - wickDown);
    const volume = Math.round((1000 + rand() * 3500) * (upper === 'BTCUSD' ? 12 : 1));

    bars.push({
      timestamp: new Date(startMs + i * 3600 * 1000).toISOString(),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
    });
    price = close;
  }
  return bars;
}

export function parseCsvOhlcv(csvText: string): OhlcvBar[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 10) {
    throw new Error('CSV must contain header plus at least 10 OHLCV bars.');
  }

  const startIdx = lines[0].toLowerCase().includes('open') || lines[0].toLowerCase().includes('close') ? 1 : 0;
  const bars: OhlcvBar[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(',').map((p) => p.trim());
    if (parts.length < 5) continue;
    const [timestamp, o, h, l, c, v] = parts;
    const open = Number(o);
    const high = Number(h);
    const low = Number(l);
    const close = Number(c);
    const volume = Number(v || 0);
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      continue;
    }
    bars.push({
      timestamp: timestamp || new Date(Date.now() + i * 3600000).toISOString(),
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }
  if (bars.length < 10) {
    throw new Error('Parsed fewer than 10 valid OHLCV bars.');
  }
  return bars;
}

export function validateOhlcvData(bars: OhlcvBar[]): DataQualityReport {
  let missingIntervals = 0;
  let nonMonotonicTimestamps = 0;
  let ohlcAnomalies = 0;
  let outlierReturns = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const currMs = new Date(b.timestamp).getTime();
    if (!Number.isFinite(currMs)) {
      nonMonotonicTimestamps++;
    }
    if (b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.close <= 0) {
      ohlcAnomalies++;
    }
    if (i > 0) {
      const prev = bars[i - 1];
      const prevMs = new Date(prev.timestamp).getTime();
      const ret = Math.abs((b.close - prev.close) / prev.close);
      if (ret > 0.2) outlierReturns++;
      const dt = currMs - prevMs;
      if (Number.isFinite(currMs) && Number.isFinite(prevMs) && dt <= 0) {
        nonMonotonicTimestamps++;
      }
      if (i > 1) {
        const prevDt = prevMs - new Date(bars[i - 2].timestamp).getTime();
        if (prevDt > 0 && dt > prevDt * 1.8) {
          missingIntervals++;
        }
      }
    }
  }

  const notes: string[] = [];
  if (nonMonotonicTimestamps > 0) notes.push(`Detected ${nonMonotonicTimestamps} invalid or non-monotonic timestamps.`);
  if (ohlcAnomalies > 0) notes.push(`Detected ${ohlcAnomalies} OHLC consistency anomalies.`);
  if (missingIntervals > 0) notes.push(`Detected ${missingIntervals} timestamp gaps.`);
  if (outlierReturns > 0) notes.push(`Detected ${outlierReturns} >20% single-bar jumps.`);
  if (notes.length === 0) notes.push('All OHLCV integrity, monotonicity, and continuity checks passed.');

  return {
    barCount: bars.length,
    missingIntervals,
    nonMonotonicTimestamps,
    ohlcAnomalies,
    outlierReturns,
    passed: ohlcAnomalies === 0 && nonMonotonicTimestamps === 0 && bars.length >= 30,
    notes,
  };
}

export function importOrCreateDataset(params: {
  symbol: string;
  timeframe: string;
  sourceType: 'SYNTHETIC_SAMPLE' | 'CSV_IMPORT' | 'JSON_IMPORT';
  bars?: OhlcvBar[];
  csvText?: string;
}) {
  const symbol = params.symbol.trim().toUpperCase();
  const timeframe = params.timeframe.trim() || '1H';
  let bars: OhlcvBar[];

  if (params.sourceType === 'CSV_IMPORT' && params.csvText) {
    bars = parseCsvOhlcv(params.csvText);
  } else if (params.bars && params.bars.length > 0) {
    bars = params.bars;
  } else {
    bars = generateSyntheticSampleBars(symbol, 240);
  }

  const quality = validateOhlcvData(bars);
  const id = `qds_${crypto.randomUUID().slice(0, 10)}`;
  getDb()
    .prepare(
      `INSERT INTO quant_datasets (id, symbol, timeframe, source_type, bar_count, quality_report_json, bars_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, symbol, timeframe, params.sourceType, bars.length, JSON.stringify(quality), JSON.stringify(bars), nowIso());

  recordAuditEvent('researcher', 'QUANT', 'DATASET_REGISTERED', { id, symbol, sourceType: params.sourceType, bars: bars.length });
  return { id, symbol, timeframe, sourceType: params.sourceType, barCount: bars.length, quality, bars };
}

export function listDatasets() {
  const rows = getDb()
    .prepare('SELECT id, symbol, timeframe, source_type, bar_count, quality_report_json, created_at FROM quant_datasets ORDER BY created_at DESC LIMIT 50')
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    symbol: String(r.symbol),
    timeframe: String(r.timeframe),
    sourceType: String(r.source_type),
    barCount: Number(r.bar_count),
    quality: JSON.parse(String(r.quality_report_json)) as DataQualityReport,
    createdAt: String(r.created_at),
  }));
}

export function computeSma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = [];
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < period) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

export function computeEma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = [];
  const k = 2 / (period + 1);
  let ema: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < period) {
      out.push(null);
      continue;
    }
    if (ema === null) {
      const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      ema = seed;
    } else {
      ema = values[i] * k + ema * (1 - k);
    }
    out.push(ema);
  }
  return out;
}

export function computeRsi(closes: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function computeAtr(bars: OhlcvBar[], period = 14): Array<number | null> {
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      trs.push(bars[i].high - bars[i].low);
    } else {
      const prevClose = bars[i - 1].close;
      trs.push(
        Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose))
      );
    }
  }
  return computeSma(trs, period);
}

function simulateSlice(bars: OhlcvBar[], params: BacktestParams): {
  metrics: PerformanceMetrics;
  trades: TradeRecord[];
  equityCurve: Array<{ timestamp: string; equity: number; drawdownPct: number }>;
} {
  const closes = bars.map((b) => b.close);
  const fast = Math.max(3, params.fastPeriod || 10);
  const slow = Math.max(fast + 2, params.slowPeriod || 30);
  const rsiPeriod = Math.max(5, params.rsiPeriod || 14);
  const rsiBuy = params.rsiBuy ?? 34;
  const rsiSell = params.rsiSell ?? 66;
  const initialCapital = params.initialCapital || 10000;
  const costRate = ((params.commissionBps ?? 4) + (params.slippageBps ?? 3)) / 10000;
  const allocPct = Math.min(Math.max(params.riskPerTradePct ?? 25, 5), 100) / 100;

  const smaFast = computeSma(closes, fast);
  const smaSlow = computeSma(closes, slow);
  const emaFast = computeEma(closes, fast);
  const emaSlow = computeEma(closes, slow);
  const rsi = computeRsi(closes, rsiPeriod);
  const atr = computeAtr(bars, 14);

  let equity = initialCapital;
  let peakEquity = initialCapital;
  let maxDrawdownPct = 0;
  let inPosition = false;
  let entryPrice = 0;
  let entryTime = '';
  let units = 0;

  const trades: TradeRecord[] = [];
  const equityCurve: Array<{ timestamp: string; equity: number; drawdownPct: number }> = [];
  const barReturns: number[] = [];
  let prevEquity = equity;

  for (let i = 0; i < bars.length; i++) {
    const price = bars[i].close;
    let buySignal = false;
    let sellSignal = false;

    if (params.strategyName === 'SMA_CROSSOVER') {
      if (smaFast[i] !== null && smaSlow[i] !== null) {
        buySignal = smaFast[i]! > smaSlow[i]!;
        sellSignal = smaFast[i]! < smaSlow[i]!;
      }
    } else if (params.strategyName === 'RSI_MEAN_REVERSION') {
      if (rsi[i] !== null) {
        buySignal = rsi[i]! < rsiBuy;
        sellSignal = rsi[i]! > rsiSell;
      }
    } else {
      if (emaFast[i] !== null && emaSlow[i] !== null && atr[i] !== null) {
        buySignal = emaFast[i]! > emaSlow[i]! && price > emaFast[i]! - atr[i]! * 0.5;
        sellSignal = emaFast[i]! < emaSlow[i]!;
      }
    }

    if (!inPosition && buySignal && i < bars.length - 1) {
      const fill = price * (1 + costRate);
      const notional = equity * allocPct;
      units = notional / fill;
      entryPrice = fill;
      entryTime = bars[i].timestamp;
      inPosition = true;
    } else if (inPosition && (sellSignal || i === bars.length - 1)) {
      const fill = price * (1 - costRate);
      const pnl = units * (fill - entryPrice);
      equity += pnl;
      const returnPct = ((fill - entryPrice) / entryPrice) * 100;
      trades.push({
        entryTime,
        exitTime: bars[i].timestamp,
        side: 'LONG',
        entryPrice: Number(entryPrice.toFixed(2)),
        exitPrice: Number(fill.toFixed(2)),
        pnlUsd: Number(pnl.toFixed(2)),
        returnPct: Number(returnPct.toFixed(2)),
      });
      inPosition = false;
      units = 0;
    }

    const markToMarket = inPosition ? equity + units * (price - entryPrice) : equity;
    if (markToMarket > peakEquity) peakEquity = markToMarket;
    const ddPct = peakEquity > 0 ? ((peakEquity - markToMarket) / peakEquity) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    if (prevEquity > 0) {
      barReturns.push((markToMarket - prevEquity) / prevEquity);
    }
    prevEquity = markToMarket;

    equityCurve.push({
      timestamp: bars[i].timestamp,
      equity: Number(markToMarket.toFixed(2)),
      drawdownPct: Number(ddPct.toFixed(2)),
    });
  }

  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const grossProfit = wins.reduce((a, b) => a + b.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnlUsd, 0));

  const meanR = barReturns.length > 0 ? barReturns.reduce((a, b) => a + b, 0) / barReturns.length : 0;
  const variance =
    barReturns.length > 1
      ? barReturns.reduce((a, r) => a + (r - meanR) ** 2, 0) / (barReturns.length - 1)
      : 0;
  const std = Math.sqrt(variance);
  const downsideVals = barReturns.filter((r) => r < 0);
  const downVar =
    downsideVals.length > 1 ? downsideVals.reduce((a, r) => a + r ** 2, 0) / downsideVals.length : variance;
  const downStd = Math.sqrt(downVar);

  const annFactor = Math.sqrt(252 * 6);
  const sharpeRatio = std > 0 ? (meanR / std) * annFactor : 0;
  const sortinoRatio = downStd > 0 ? (meanR / downStd) * annFactor : 0;

  return {
    metrics: {
      totalReturnPct: Number((((equity - initialCapital) / initialCapital) * 100).toFixed(2)),
      sharpeRatio: Number(sharpeRatio.toFixed(2)),
      sortinoRatio: Number(sortinoRatio.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      winRatePct: Number((trades.length > 0 ? (wins.length / trades.length) * 100 : 0).toFixed(1)),
      profitFactor: Number((grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 9.99 : 0).toFixed(2)),
      tradeCount: trades.length,
      finalEquity: Number(equity.toFixed(2)),
    },
    trades,
    equityCurve,
  };
}

export function runQuantBacktest(params: BacktestParams) {
  const db = getDb();
  const dsRow = db.prepare('SELECT * FROM quant_datasets WHERE id = ?').get(params.datasetId) as
    | Record<string, unknown>
    | undefined;
  if (!dsRow) {
    throw new Error(`Quant dataset not found: ${params.datasetId}`);
  }

  const symbol = String(dsRow.symbol);
  const sourceType = String(dsRow.source_type);
  const bars = JSON.parse(String(dsRow.bars_json)) as OhlcvBar[];

  const fullSim = simulateSlice(bars, params);
  const splitIdx = Math.floor(bars.length * 0.7);
  const inSample = simulateSlice(bars.slice(0, splitIdx), params);
  const outOfSample = simulateSlice(bars.slice(splitIdx), params);

  // Monte Carlo Bootstrap over realized trade returns
  const rand = createPrng(99887766);
  const tradeReturns = fullSim.trades.map((t) => t.returnPct / 100);
  const mcFinals: number[] = [];
  const mcMaxDds: number[] = [];
  const iterations = 200;

  for (let run = 0; run < iterations; run++) {
    let eq = 1.0;
    let pk = 1.0;
    let mdd = 0;
    const n = Math.max(tradeReturns.length, 5);
    for (let k = 0; k < n; k++) {
      const r = tradeReturns.length > 0 ? tradeReturns[Math.floor(rand() * tradeReturns.length)] : 0;
      eq *= 1 + r * 0.25;
      if (eq > pk) pk = eq;
      const dd = ((pk - eq) / pk) * 100;
      if (dd > mdd) mdd = dd;
    }
    mcFinals.push((eq - 1) * 100);
    mcMaxDds.push(mdd);
  }
  mcFinals.sort((a, b) => a - b);
  mcMaxDds.sort((a, b) => a - b);

  const monteCarlo = {
    iterations,
    p5ReturnPct: Number((mcFinals[Math.floor(iterations * 0.05)] || 0).toFixed(2)),
    medianReturnPct: Number((mcFinals[Math.floor(iterations * 0.5)] || 0).toFixed(2)),
    p95ReturnPct: Number((mcFinals[Math.floor(iterations * 0.95)] || 0).toFixed(2)),
    p95MaxDrawdownPct: Number((mcMaxDds[Math.floor(iterations * 0.95)] || 0).toFixed(2)),
  };

  // Parameter sensitivity grid
  const fastOptions = [6, 10, 14];
  const slowOptions = [22, 30, 42];
  const sensitivity = fastOptions.flatMap((f) =>
    slowOptions.map((s) => {
      const sim = simulateSlice(bars, { ...params, fastPeriod: f, slowPeriod: s });
      return {
        fastPeriod: f,
        slowPeriod: s,
        totalReturnPct: sim.metrics.totalReturnPct,
        sharpeRatio: sim.metrics.sharpeRatio,
        maxDrawdownPct: sim.metrics.maxDrawdownPct,
      };
    })
  );

  const walkForward = {
    inSampleBars: splitIdx,
    outOfSampleBars: bars.length - splitIdx,
    inSampleMetrics: inSample.metrics,
    outOfSampleMetrics: outOfSample.metrics,
  };

  const reportMd = [
    `# NEXA QUANT RESEARCH REPORT — ${symbol}`,
    `**Dataset Source Type:** ${sourceType} (Research & Paper Simulation Only — Live Execution Disabled)`,
    `**Strategy:** ${params.strategyName}`,
    '',
    '## Full-Sample Metrics (Net of Slippage & Commissions)',
    `- Total Return: ${fullSim.metrics.totalReturnPct}%`,
    `- Sharpe Ratio: ${fullSim.metrics.sharpeRatio} | Sortino: ${fullSim.metrics.sortinoRatio}`,
    `- Max Drawdown: ${fullSim.metrics.maxDrawdownPct}% | Win Rate: ${fullSim.metrics.winRatePct}%`,
    `- Trades: ${fullSim.metrics.tradeCount} | Profit Factor: ${fullSim.metrics.profitFactor}`,
    '',
    '## Out-of-Sample Walk-Forward Split (70% IS / 30% OOS)',
    `- IS Return: ${inSample.metrics.totalReturnPct}% (Sharpe ${inSample.metrics.sharpeRatio})`,
    `- OOS Return: ${outOfSample.metrics.totalReturnPct}% (Sharpe ${outOfSample.metrics.sharpeRatio})`,
    '',
    '## Monte Carlo Bootstrap (200 Resamples)',
    `- P5 / Median / P95 Return: ${monteCarlo.p5ReturnPct}% / ${monteCarlo.medianReturnPct}% / ${monteCarlo.p95ReturnPct}%`,
    `- P95 Max Drawdown: ${monteCarlo.p95MaxDrawdownPct}%`,
  ].join('\n');

  const id = `qbt_${crypto.randomUUID().slice(0, 10)}`;
  db.prepare(
    `INSERT INTO quant_backtests
     (id, dataset_id, symbol, strategy_name, params_json, metrics_json, walk_forward_json, monte_carlo_json, sensitivity_json, equity_curve_json, trades_json, report_markdown, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.datasetId,
    symbol,
    params.strategyName,
    JSON.stringify(params),
    JSON.stringify(fullSim.metrics),
    JSON.stringify(walkForward),
    JSON.stringify(monteCarlo),
    JSON.stringify(sensitivity),
    JSON.stringify(fullSim.equityCurve),
    JSON.stringify(fullSim.trades),
    reportMd,
    nowIso()
  );

  saveArtifact({
    subsystem: 'quant_lab',
    name: `quant_report_${symbol}_${id}.md`,
    mimeType: 'text/markdown',
    content: reportMd,
    metadata: { symbol, sourceType, strategy: params.strategyName },
  });

  recordAuditEvent('researcher', 'QUANT', 'BACKTEST_COMPLETED', { id, symbol, strategy: params.strategyName });

  return {
    id,
    datasetId: params.datasetId,
    symbol,
    sourceType,
    strategyName: params.strategyName,
    metrics: fullSim.metrics,
    walkForward,
    monteCarlo,
    sensitivity,
    equityCurve: fullSim.equityCurve,
    trades: fullSim.trades,
    reportMarkdown: reportMd,
    liveExecutionAllowed: false,
  };
}

export function listBacktests() {
  const rows = getDb()
    .prepare('SELECT id, dataset_id, symbol, strategy_name, metrics_json, walk_forward_json, monte_carlo_json, sensitivity_json, equity_curve_json, trades_json, report_markdown, created_at FROM quant_backtests ORDER BY created_at DESC LIMIT 30')
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    datasetId: String(r.dataset_id),
    symbol: String(r.symbol),
    strategyName: String(r.strategy_name),
    metrics: JSON.parse(String(r.metrics_json)) as PerformanceMetrics,
    walkForward: JSON.parse(String(r.walk_forward_json)),
    monteCarlo: JSON.parse(String(r.monte_carlo_json)),
    sensitivity: JSON.parse(String(r.sensitivity_json)),
    equityCurve: JSON.parse(String(r.equity_curve_json)),
    trades: JSON.parse(String(r.trades_json)) as TradeRecord[],
    reportMarkdown: String(r.report_markdown),
    createdAt: String(r.created_at),
  }));
}

export function createPaperOrder(params: {
  symbol: string;
  side: 'BUY' | 'SELL';
  accountEquityUsd: number;
  riskPct: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit?: number | null;
  maxDrawdownLimitPct?: number;
  currentDrawdownPct?: number;
  notes?: string;
}) {
  // Verify paper-only posture
  const liveAllowed = isLiveTradingEnabled();
  if (liveAllowed) {
    throw new Error('Live capital trading is disabled in NEXA QUANT INTELLIGENCE.');
  }
  // Risk engine checks before allowing even a paper order
  const maxDdLimit = params.maxDrawdownLimitPct ?? 12;
  const currentDd = params.currentDrawdownPct ?? 0;
  if (currentDd >= maxDdLimit) {
    throw new Error(`Risk engine rejected order: current drawdown (${currentDd}%) >= max drawdown limit (${maxDdLimit}%).`);
  }
  const stopDist = Math.abs(params.entryPrice - params.stopLoss);
  if (stopDist <= 0) {
    throw new Error('Stop loss must differ from entry price for valid position sizing.');
  }
  const boundedRiskPct = Math.min(Math.max(params.riskPct, 0.1), 2.5);
  const riskUsd = Number(((params.accountEquityUsd * boundedRiskPct) / 100).toFixed(2));
  const quantity = Number((riskUsd / stopDist).toFixed(4));
  const id = `qpo_${crypto.randomUUID().slice(0, 10)}`;

  getDb()
    .prepare(
      `INSERT INTO quant_paper_orders
       (id, symbol, side, quantity, entry_price, stop_loss, take_profit, risk_usd, status, mode, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PAPER_OPEN', 'PAPER_ONLY', ?, ?)`
    )
    .run(
      id,
      params.symbol.toUpperCase(),
      params.side,
      quantity,
      params.entryPrice,
      params.stopLoss,
      params.takeProfit ?? null,
      riskUsd,
      params.notes || 'Paper simulation order',
      nowIso()
    );

  recordAuditEvent('operator', 'QUANT_PAPER', 'PAPER_ORDER_CREATED', { id, symbol: params.symbol, side: params.side, quantity, riskUsd });
  return { id, symbol: params.symbol.toUpperCase(), side: params.side, quantity, riskUsd, mode: 'PAPER_ONLY', status: 'PAPER_OPEN' };
}

export function listPaperOrders() {
  return getDb().prepare('SELECT * FROM quant_paper_orders ORDER BY created_at DESC LIMIT 50').all();
}
