import type { TestRecord, TestStatus } from '../types';

const statusPill: Record<TestStatus, { label: string; cls: string }> = {
  running: { label: '● running', cls: 'bg-accent/20 text-accent animate-pulse' },
  passed: { label: '✓ passed', cls: 'bg-success/20 text-success' },
  failed: { label: '✗ failed', cls: 'bg-danger/20 text-danger' },
  timedOut: { label: '⧗ timed out', cls: 'bg-danger/20 text-danger' },
  skipped: { label: '– skipped', cls: 'bg-warn/20 text-warn' },
  interrupted: { label: '! interrupted', cls: 'bg-danger/20 text-danger' },
};

export function TestRow({ test }: { test: TestRecord }) {
  const pill = statusPill[test.status];
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-slate-800 bg-panelAlt p-3 transition sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-slate-100 sm:text-base">{test.title}</span>
        <span className="truncate text-[11px] text-slate-500 sm:text-xs">
          {test.project} · {test.file}
        </span>
        {test.error && (
          <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-black/40 p-2 text-[10px] text-danger sm:text-xs">
            {test.error}
          </pre>
        )}
      </div>
      <div className="flex items-center gap-2 self-start sm:self-auto">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold sm:text-xs ${pill.cls}`}>
          {pill.label}
        </span>
        {test.durationMs !== undefined && (
          <span className="text-[10px] text-slate-500 sm:text-xs">{(test.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
    </li>
  );
}
