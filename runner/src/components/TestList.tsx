import { useEffect, useRef } from 'react';
import type { TestRecord } from '../types';
import { TestRow } from './TestRow';

export function TestList({ tests }: { tests: TestRecord[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [tests.length]);

  if (tests.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-800 bg-panel p-6 text-center text-sm text-slate-500">
        No tests started yet. Press <b className="text-slate-300">Start</b> to launch the suite.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {tests.map((t) => (
        <TestRow key={t.id} test={t} />
      ))}
      <div ref={endRef} />
    </ul>
  );
}
