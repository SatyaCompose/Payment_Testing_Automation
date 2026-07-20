import { useEffect, useRef } from 'react';
import type { AuthState, RunSummary, TestRecord } from '../types';
import { Header } from '../components/Header';
import { StatusPanel } from '../components/StatusPanel';
import { RunControls } from '../components/RunControls';
import { AuthPanel } from '../components/AuthPanel';
import { TestList } from '../components/TestList';
import type { StartOptions } from '../hooks/useTestStream';

interface Props {
  summary: RunSummary;
  tests: TestRecord[];
  logs: Array<{ ts: number; level: string; msg: string }>;
  auth: AuthState;
  paused: boolean;
  onStart: (opts: StartOptions) => Promise<void>;
  onStop: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onSignIn: () => Promise<void>;
  onCancelSignIn: () => Promise<void>;
}

export function DesktopView({
  summary,
  tests,
  logs,
  auth,
  paused,
  onStart,
  onStop,
  onPause,
  onResume,
  onSignIn,
  onCancelSignIn,
}: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <div className="flex h-screen flex-col">
      <Header summary={summary} />
      <div className="grid flex-1 gap-6 overflow-hidden p-6 lg:grid-cols-[380px_1fr]">
        <aside className="flex flex-col gap-4 overflow-hidden">
          <StatusPanel summary={summary} />
          <AuthPanel auth={auth} onSignIn={onSignIn} onCancel={onCancelSignIn} />
          <div className="rounded-2xl border border-slate-800 bg-panel p-4">
            <div className="mb-3 text-sm font-semibold text-slate-200">Run controls</div>
            <RunControls
              status={summary.status}
              auth={auth}
              paused={paused}
              onStart={onStart}
              onStop={onStop}
              onPause={onPause}
              onResume={onResume}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-panel">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2 text-xs uppercase tracking-widest text-slate-500">
              <span>Server log · {logs.length} lines</span>
              <span className="normal-case text-slate-600">auto-scroll</span>
            </div>
            <div
              ref={logRef}
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-2 font-mono text-[11px] leading-tight text-slate-400"
            >
              {logs.length === 0 && <div className="text-slate-600">— idle —</div>}
              {logs.map((l, i) => (
                <div
                  key={i}
                  className={`whitespace-pre-wrap break-words ${
                    l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warn' : ''
                  }`}
                >
                  {new Date(l.ts).toLocaleTimeString()} · {l.msg}
                </div>
              ))}
            </div>
          </div>
        </aside>
        <main className="flex flex-col gap-3 overflow-hidden">
          <div className="text-sm font-semibold text-slate-300">Live test feed</div>
          <div className="flex-1 overflow-y-auto pr-2">
            <TestList tests={tests} />
          </div>
        </main>
      </div>
    </div>
  );
}
