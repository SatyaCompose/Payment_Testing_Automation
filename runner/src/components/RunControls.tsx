import { useState } from 'react';
import type { AuthState, RunStatus } from '../types';
import type { StartOptions } from '../hooks/useTestStream';
import { TestScopeSelector, scopeToStartOptions, type TestScope } from './TestScopeSelector';

interface Props {
  status: RunStatus;
  auth: AuthState;
  paused: boolean;
  onStart: (opts: StartOptions) => Promise<void>;
  onStop: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  compact?: boolean;
}

const PROJECTS = [
  { value: 'chromium-desktop', label: 'Desktop Chrome' },
  { value: '', label: 'All browsers' },
  { value: 'safari-desktop', label: 'Desktop Safari' },
  { value: 'mobile-safari', label: 'Mobile Safari' },
  { value: 'android-chrome', label: 'Android Chrome' },
];

const INITIAL_SCOPE: TestScope = { paymentMethod: '', section: 0, subtest: '', subtestIds: '' };

export function RunControls({ status, auth, paused, onStart, onStop, onPause, onResume, compact }: Props) {
  const [headed, setHeaded] = useState(true);
  const [recordVideo, setRecordVideo] = useState(false);
  const [slowMoMs, setSlowMoMs] = useState(0);
  const [workers, setWorkers] = useState<number>(1);
  const [project, setProject] = useState<string>(PROJECTS[0].value);
  const [scope, setScope] = useState<TestScope>(INITIAL_SCOPE);
  const [confirmStop, setConfirmStop] = useState(false);

  const running = status === 'running' || status === 'starting';
  const canStart = auth.status === 'signed-in';

  if (running) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          {paused ? (
            <button
              onClick={onResume}
              className={`flex-1 rounded-full bg-success px-4 font-semibold text-slate-950 shadow-lg transition hover:brightness-110 active:scale-95 ${
                compact ? 'py-2 text-sm' : 'py-3 text-base'
              }`}
            >
              ▶ Resume
            </button>
          ) : (
            <button
              onClick={onPause}
              className={`flex-1 rounded-full bg-warn px-4 font-semibold text-slate-950 shadow-lg transition hover:brightness-110 active:scale-95 ${
                compact ? 'py-2 text-sm' : 'py-3 text-base'
              }`}
            >
              ⏸ Pause
            </button>
          )}
        </div>
        {!confirmStop ? (
          <button
            onClick={() => setConfirmStop(true)}
            className={`w-full rounded-full bg-danger px-5 font-semibold text-white shadow-lg transition hover:brightness-110 active:scale-95 ${
              compact ? 'py-2 text-sm' : 'py-3 text-base'
            }`}
          >
            ■ Stop
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={async () => {
                await onStop();
                setConfirmStop(false);
              }}
              className="flex-1 rounded-full bg-danger px-4 py-2 text-sm font-semibold text-white shadow-lg hover:brightness-110 active:scale-95"
            >
              Confirm stop
            </button>
            <button
              onClick={() => setConfirmStop(false)}
              className="rounded-full border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input
          type="checkbox"
          checked={headed}
          onChange={(e) => setHeaded(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        Show browser windows (headed)
      </label>

      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input
          type="checkbox"
          checked={recordVideo}
          onChange={(e) => setRecordVideo(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        Record video of every test
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        <span>
          Slow-mo: <b className="text-slate-200">{slowMoMs}ms</b> per action
        </span>
        <input
          type="range"
          min={0}
          max={800}
          step={50}
          value={slowMoMs}
          onChange={(e) => setSlowMoMs(Number(e.target.value))}
          className="accent-accent"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        <span>
          Parallel workers: <b className="text-slate-200">{workers}</b>
          {workers > 1 && (
            <span className="ml-2 text-warn">
              (logged-in tests share the same test user — parallel runs can race)
            </span>
          )}
        </span>
        <input
          type="range"
          min={1}
          max={6}
          step={1}
          value={workers}
          onChange={(e) => setWorkers(Number(e.target.value))}
          className="accent-accent"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        Browser project
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 focus:border-accent focus:outline-none"
        >
          {PROJECTS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <TestScopeSelector value={scope} onChange={setScope} />

      <button
        disabled={!canStart}
        onClick={() =>
          onStart({
            headed,
            recordVideo,
            slowMoMs,
            workers,
            project: project || undefined,
            ...scopeToStartOptions(scope),
          })
        }
        className={`w-full rounded-full px-5 font-semibold shadow-lg transition active:scale-95 ${
          canStart
            ? 'bg-accent text-slate-950 hover:brightness-110'
            : 'cursor-not-allowed bg-slate-700 text-slate-400'
        } ${compact ? 'py-2 text-sm' : 'py-3 text-base'}`}
      >
        {canStart ? '▶ Start run' : 'Sign in first'}
      </button>
      {!canStart && (
        <p className="text-[11px] leading-tight text-warn">
          Sign in to the browser first (panel above). Tests reuse that session.
        </p>
      )}

      {headed && (
        <p className="text-[11px] leading-tight text-slate-500">
          Browser windows will open on your desktop. Watch them drive; the feed
          on the right shows the same events.
        </p>
      )}
    </div>
  );
}
