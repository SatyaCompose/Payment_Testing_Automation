import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthState, RunStatus, RunSummary, TestRecord, UiEvent } from '../types';

export interface StartOptions {
  headed?: boolean;
  slowMoMs?: number;
  project?: string;
  /** Legacy escape hatch — raw Playwright --grep pattern. Prefer the structured fields below. */
  grep?: string;
  /** Payment-method folder slug: 'credit-card' | 'paypal' | 'afterpay' | 'gpay' | 'applepay'. */
  paymentMethod?: string;
  /** Section number 1..8. */
  section?: number;
  /** Sub-test id like "1.2" or "6.1". */
  subtest?: string;
  /** Record every test as WebM video (overrides retain-on-failure default). */
  recordVideo?: boolean;
}

export interface UseTestStream {
  status: RunStatus;
  summary: RunSummary;
  tests: TestRecord[];
  logs: Array<{ ts: number; level: string; msg: string }>;
  auth: AuthState;
  paused: boolean;
  start: (opts?: StartOptions) => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  signIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const initialAuth: AuthState = { status: 'unknown', progress: [] };

const initialSummary: RunSummary = {
  status: 'idle',
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
};

export function useTestStream(): UseTestStream {
  const [summary, setSummary] = useState<RunSummary>(initialSummary);
  const [tests, setTests] = useState<TestRecord[]>([]);
  const [logs, setLogs] = useState<Array<{ ts: number; level: string; msg: string }>>([]);
  const [auth, setAuth] = useState<AuthState>(initialAuth);
  const [paused, setPaused] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const refreshAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/auth-status');
      const data = await res.json();
      setAuth((prev) => ({
        ...prev,
        status: data.running ? 'signing-in' : data.signedIn ? 'signed-in' : 'signed-out',
        since: data.since,
      }));
    } catch {
      setAuth((prev) => ({ ...prev, status: 'error', error: 'Cannot reach runner server' }));
    }
  }, []);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  const reconcileWithServer = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      // Bidirectional sync so the UI matches the server after a browser
      // refresh or a dropped SSE stream.
      if (data.status === 'idle') {
        // Server has no active run — clear any stale 'running' / 'starting'
        // state left over from a dropped SSE.
        setSummary((s) =>
          s.status === 'running' || s.status === 'starting'
            ? { ...s, status: 'stopped', endedAt: Date.now() }
            : s,
        );
        setPaused(false);
      } else if (data.status === 'running') {
        // Server is mid-run but the UI missed the run-start event (e.g.
        // page refresh). Adopt 'running' so Stop / Pause reappear. Totals
        // stay 0 until fresh test-start events flow in — better a running
        // UI without counts than a stuck idle UI.
        setSummary((s) =>
          s.status === 'idle' || s.status === 'stopped' || s.status === 'completed'
            ? { ...s, status: 'running', startedAt: s.startedAt ?? Date.now() }
            : s,
        );
        setPaused(Boolean(data.paused));
      }
    } catch {
      // health unreachable — leave UI alone
    }
  }, []);

  useEffect(() => {
    const es = new EventSource('/events');
    esRef.current = es;
    es.onopen = () => {
      // On (re)connect, ask the server what its actual state is. If we
      // missed a run-end / stopped event during a disconnect, this will
      // reset the UI so Stop/Pause don't linger on a dead run.
      void reconcileWithServer();
    };
    es.onmessage = (msg) => {
      try {
        const ev: UiEvent = JSON.parse(msg.data);
        apply(ev);
      } catch {
        // ignore malformed
      }
    };
    es.onerror = () => {
      setSummary((s) => ({ ...s, status: s.status === 'running' ? 'error' : s.status }));
    };
    return () => es.close();
  }, [reconcileWithServer]);

  const apply = useCallback((ev: UiEvent) => {
    switch (ev.type) {
      case 'run-start':
        setSummary({
          status: 'running',
          total: ev.totalTests,
          passed: 0,
          failed: 0,
          skipped: 0,
          startedAt: ev.timestamp,
        });
        setTests([]);
        setLogs([]);
        // Stale paused=true from a previous run/reconnect would cause
        // the RunControls to show "Resume" instead of "Pause" during
        // the fresh run. Clear it explicitly.
        setPaused(false);
        return;
      case 'test-start':
        setTests((prev) => [
          ...prev,
          {
            id: ev.id,
            title: ev.title,
            file: ev.file,
            project: ev.project,
            status: 'running',
            startedAt: ev.timestamp,
          },
        ]);
        return;
      case 'test-end':
        setTests((prev) =>
          prev.map((t) =>
            t.id === ev.id
              ? {
                  ...t,
                  status: ev.status,
                  endedAt: ev.timestamp,
                  durationMs: ev.durationMs,
                  error: ev.error,
                }
              : t,
          ),
        );
        setSummary((s) => ({
          ...s,
          passed: s.passed + (ev.status === 'passed' ? 1 : 0),
          failed: s.failed + (ev.status === 'failed' || ev.status === 'timedOut' ? 1 : 0),
          skipped: s.skipped + (ev.status === 'skipped' ? 1 : 0),
        }));
        return;
      case 'run-end':
        setSummary((s) => ({ ...s, status: 'completed', endedAt: ev.timestamp }));
        return;
      case 'stopped':
        setSummary((s) => ({ ...s, status: 'stopped', endedAt: ev.timestamp }));
        return;
      case 'log':
        setLogs((prev) => [
          ...prev.slice(-499),
          { ts: ev.timestamp, level: ev.level, msg: ev.message },
        ]);
        return;
      case 'auth-start':
        setAuth({ status: 'signing-in', progress: [] });
        return;
      case 'auth-progress':
        setAuth((a) => ({ ...a, progress: [...a.progress.slice(-49), ev.message] }));
        return;
      case 'auth-end':
        setAuth((a) => ({
          ...a,
          status: ev.ok ? 'signed-in' : 'error',
          since: ev.ok ? new Date(ev.timestamp).toISOString() : a.since,
          error: ev.ok ? undefined : ev.error,
        }));
        return;
    }
  }, []);

  const start = useCallback(async (opts: StartOptions = {}) => {
    setSummary({ ...initialSummary, status: 'starting' });
    setTests([]);
    setLogs([]);
    setPaused(false);
    await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
  }, []);

  const stop = useCallback(async () => {
    const r = await fetch('/api/stop', { method: 'POST' });
    // 409 = server has no active run. Our UI thought one was running
    // (probably because we missed a run-end event during a disconnect) —
    // sync back to idle so the Stop button stops looping on a dead run.
    if (r.status === 409) {
      await reconcileWithServer();
    }
  }, [reconcileWithServer]);

  const pause = useCallback(async () => {
    const r = await fetch('/api/pause', { method: 'POST' });
    if (r.ok) setPaused(true);
    else if (r.status === 409) await reconcileWithServer();
  }, [reconcileWithServer]);
  const resume = useCallback(async () => {
    const r = await fetch('/api/resume', { method: 'POST' });
    if (r.ok) setPaused(false);
    else if (r.status === 409) await reconcileWithServer();
  }, [reconcileWithServer]);

  const signIn = useCallback(async () => {
    setAuth({ status: 'signing-in', progress: [] });
    await fetch('/api/auth-setup', { method: 'POST' });
  }, []);

  const cancelSignIn = useCallback(async () => {
    await fetch('/api/auth-cancel', { method: 'POST' });
  }, []);

  return {
    status: summary.status,
    summary,
    tests,
    logs,
    auth,
    paused,
    start,
    stop,
    pause,
    resume,
    signIn,
    cancelSignIn,
    refreshAuth,
  };
}
