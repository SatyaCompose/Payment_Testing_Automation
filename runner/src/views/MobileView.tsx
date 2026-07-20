import { useState } from 'react';
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
  auth: AuthState;
  paused: boolean;
  onStart: (opts: StartOptions) => Promise<void>;
  onStop: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onSignIn: () => Promise<void>;
  onCancelSignIn: () => Promise<void>;
}

export function MobileView({
  summary,
  tests,
  auth,
  paused,
  onStart,
  onStop,
  onPause,
  onResume,
  onSignIn,
  onCancelSignIn,
}: Props) {
  const [drawer, setDrawer] = useState(false);
  const running = summary.status === 'running' || summary.status === 'starting';

  return (
    <div className="flex h-[100dvh] flex-col">
      <Header summary={summary} />
      <div className="flex flex-col gap-3 px-3 pt-3">
        <StatusPanel summary={summary} compact />
        <AuthPanel auth={auth} onSignIn={onSignIn} onCancel={onCancelSignIn} />
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <TestList tests={tests} />
      </div>
      <div
        className="sticky bottom-0 flex flex-col gap-2 border-t border-slate-800 bg-panel/95 px-4 py-3 backdrop-blur"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
      >
        {!running && !drawer ? (
          <button
            onClick={() => setDrawer(true)}
            className={`w-full rounded-full py-3 text-base font-semibold shadow-lg active:scale-95 ${
              auth.status === 'signed-in'
                ? 'bg-accent text-slate-950'
                : 'bg-slate-700 text-slate-300'
            }`}
          >
            {auth.status === 'signed-in' ? '▶ Configure & start' : 'Sign in first to run tests'}
          </button>
        ) : (
          <RunControls
            status={summary.status}
            auth={auth}
            paused={paused}
            onStart={onStart}
            onStop={onStop}
            onPause={onPause}
            onResume={onResume}
            compact
          />
        )}
      </div>
    </div>
  );
}
