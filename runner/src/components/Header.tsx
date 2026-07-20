import type { RunSummary } from '../types';

const statusColor: Record<RunSummary['status'], string> = {
  idle: 'bg-slate-600',
  starting: 'bg-warn animate-pulse',
  running: 'bg-accent animate-pulse',
  stopped: 'bg-danger',
  completed: 'bg-success',
  error: 'bg-danger',
};

export function Header({ summary }: { summary: RunSummary }) {
  return (
    <header className="flex items-center gap-3 border-b border-slate-800 bg-panel px-4 py-3 sm:px-6">
      <div className={`h-3 w-3 rounded-full ${statusColor[summary.status]}`} />
      <div className="flex flex-col leading-tight">
        <div className="text-xs uppercase tracking-widest text-slate-400">KWH Payments</div>
        <div className="text-sm font-semibold text-slate-100 sm:text-base">Live Runner · {summary.status}</div>
      </div>
    </header>
  );
}
