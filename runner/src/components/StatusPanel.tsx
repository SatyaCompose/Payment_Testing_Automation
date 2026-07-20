import type { RunSummary } from '../types';

interface Props {
  summary: RunSummary;
  compact?: boolean;
}

export function StatusPanel({ summary, compact }: Props) {
  const elapsed = summary.startedAt
    ? Math.max(0, ((summary.endedAt ?? Date.now()) - summary.startedAt) / 1000)
    : 0;
  const stats = [
    { label: 'Total', value: summary.total, color: 'text-slate-100' },
    { label: 'Passed', value: summary.passed, color: 'text-success' },
    { label: 'Failed', value: summary.failed, color: 'text-danger' },
    { label: 'Skipped', value: summary.skipped, color: 'text-warn' },
  ];

  return (
    <div
      className={`grid gap-3 ${
        compact ? 'grid-cols-4' : 'grid-cols-2 sm:grid-cols-4'
      } rounded-2xl border border-slate-800 bg-panel p-4`}
    >
      {stats.map((s) => (
        <div key={s.label} className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-widest text-slate-500 sm:text-xs">
            {s.label}
          </span>
          <span className={`text-2xl font-bold sm:text-3xl ${s.color}`}>{s.value}</span>
        </div>
      ))}
      {!compact && (
        <div className="col-span-full flex items-center justify-between text-xs text-slate-400">
          <span>Elapsed: {elapsed.toFixed(1)}s</span>
          {summary.status === 'running' && (
            <span className="text-accent">
              {summary.total > 0
                ? Math.round(((summary.passed + summary.failed + summary.skipped) / summary.total) * 100)
                : 0}
              % complete
            </span>
          )}
        </div>
      )}
    </div>
  );
}
