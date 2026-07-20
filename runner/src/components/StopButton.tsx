import { useState } from 'react';
import type { RunStatus } from '../types';

interface Props {
  status: RunStatus;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  size?: 'sm' | 'lg';
}

export function StopButton({ status, onStart, onStop, size = 'lg' }: Props) {
  const [confirm, setConfirm] = useState(false);
  const running = status === 'running' || status === 'starting';

  if (!running) {
    return (
      <button
        onClick={onStart}
        className={`rounded-full bg-accent px-5 font-semibold text-slate-950 shadow-lg transition hover:brightness-110 active:scale-95 ${
          size === 'sm' ? 'py-2 text-sm' : 'py-3 text-base'
        }`}
      >
        ▶ Start run
      </button>
    );
  }

  if (!confirm) {
    return (
      <button
        onClick={() => setConfirm(true)}
        className={`rounded-full bg-danger px-5 font-semibold text-white shadow-lg transition hover:brightness-110 active:scale-95 ${
          size === 'sm' ? 'py-2 text-sm' : 'py-3 text-base'
        }`}
      >
        ■ Stop
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={async () => {
          await onStop();
          setConfirm(false);
        }}
        className={`rounded-full bg-danger px-5 font-semibold text-white shadow-lg transition hover:brightness-110 active:scale-95 ${
          size === 'sm' ? 'py-2 text-sm' : 'py-3 text-base'
        }`}
      >
        Confirm stop
      </button>
      <button
        onClick={() => setConfirm(false)}
        className="rounded-full border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
      >
        Cancel
      </button>
    </div>
  );
}
