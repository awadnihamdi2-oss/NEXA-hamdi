import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoreState } from '../types/ui';

export interface ExecutionRunSample {
  id?: number;
  mission_id?: string;
  agent_id: string;
  status: string;
  created_at?: string;
}

export interface ExecutionRhythm {
  /** Dynamic breathing/heartbeat frequency in cycles per second (Hz). */
  cadenceHz: number;
  /** Visual heartbeat pulse intensity (0.2 .. 1.0) increasing with active agent runs. */
  pulseIntensity: number;
  /** Backwards-compatible alias of pulseIntensity. */
  pulseAmplitude: number;
  /** Whether an active execution state or in-flight agent run is present. */
  isActiveExecution: boolean;
  /** Count of currently active/running records in agentRunsRaw. */
  activeRunCount: number;
  /** Total records in agentRunsRaw driving the cadence curve. */
  totalRunCount: number;
  /** Latest agent ID present in agentRunsRaw. */
  latestAgentId: string | null;
  /** Monotonically incremented counter whenever agentRunsRaw changes. */
  pulseNonce: number;
  /** Short-lived boolean flag (680ms) for CSS/SVG fallback transitions on updates. */
  burstActive: boolean;
}

const ACTIVE_STATUSES = new Set(['RUNNING', 'IN_PROGRESS', 'EXECUTING', 'PENDING']);

export function computeExecutionRhythm(
  agentRunsRaw: ExecutionRunSample[],
  coreState: CoreState
): Omit<ExecutionRhythm, 'pulseNonce' | 'burstActive'> {
  const totalRunCount = agentRunsRaw.length;
  let activeRunCount = 0;
  for (let i = 0; i < totalRunCount; i++) {
    if (ACTIVE_STATUSES.has(agentRunsRaw[i].status)) {
      activeRunCount++;
    }
  }

  const isStateActive =
    coreState === 'executing' || coreState === 'collaborating' || coreState === 'reasoning';
  const isActiveExecution = activeRunCount > 0 || isStateActive;

  // Breathing cadence scales monotonically with active runs and total run density in agentRunsRaw
  const activeRunBoost = activeRunCount * 0.16;
  const historyDensityBoost = Math.log1p(totalRunCount) * 0.22;
  const stateBoost = isStateActive && activeRunCount === 0 ? 0.34 : 0;
  const cadenceHz = Number(
    Math.min(2.35, Math.max(0.42, 0.42 + activeRunBoost + historyDensityBoost + stateBoost)).toFixed(3)
  );

  // Heartbeat pulseIntensity scales proportionally with active run load and state activity
  const pulseIntensity = Number(
    Math.min(
      1.0,
      (isActiveExecution ? 0.56 : 0.2) +
        Math.min(0.3, activeRunCount * 0.085) +
        Math.min(0.24, totalRunCount * 0.012)
    ).toFixed(3)
  );

  return {
    cadenceHz,
    pulseIntensity,
    pulseAmplitude: pulseIntensity,
    isActiveExecution,
    activeRunCount,
    totalRunCount,
    latestAgentId: agentRunsRaw[0]?.agent_id ?? null,
  };
}

export function useExecutionRhythm(
  agentRunsRaw: ExecutionRunSample[],
  coreState: CoreState
): ExecutionRhythm {
  const base = useMemo(
    () => computeExecutionRhythm(agentRunsRaw, coreState),
    [agentRunsRaw, coreState]
  );

  const lastSignatureRef = useRef<string>('');
  const [pulseNonce, setPulseNonce] = useState(0);
  const [burstActive, setBurstActive] = useState(false);

  useEffect(() => {
    const latest = agentRunsRaw[0];
    const sig = `${agentRunsRaw.length}:${latest?.id ?? ''}:${latest?.agent_id ?? ''}:${latest?.status ?? ''}:${base.activeRunCount}`;

    if (lastSignatureRef.current && sig !== lastSignatureRef.current && agentRunsRaw.length > 0) {
      setPulseNonce((n) => n + 1);
      setBurstActive(true);
      const timer = window.setTimeout(() => setBurstActive(false), 680);
      lastSignatureRef.current = sig;
      return () => window.clearTimeout(timer);
    }

    lastSignatureRef.current = sig;
  }, [agentRunsRaw, base.activeRunCount]);

  return useMemo(
    () => ({
      ...base,
      pulseNonce,
      burstActive,
    }),
    [base, pulseNonce, burstActive]
  );
}
