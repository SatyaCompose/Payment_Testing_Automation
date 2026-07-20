export type TestStatus = 'running' | 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';
export type RunStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'completed' | 'error';

export interface TestRecord {
  id: string;
  title: string;
  file: string;
  project: string;
  status: TestStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
}

export interface RunSummary {
  status: RunStatus;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  startedAt?: number;
  endedAt?: number;
  message?: string;
}

export type UiEvent =
  | { type: 'run-start'; totalTests: number; timestamp: number }
  | { type: 'test-start'; id: string; title: string; file: string; project: string; timestamp: number }
  | {
      type: 'test-end';
      id: string;
      status: Exclude<TestStatus, 'running'>;
      durationMs: number;
      error?: string;
      timestamp: number;
    }
  | { type: 'run-end'; passed: number; failed: number; skipped: number; timestamp: number }
  | { type: 'stopped'; timestamp: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; timestamp: number }
  | { type: 'auth-start'; timestamp: number }
  | { type: 'auth-progress'; message: string; timestamp: number }
  | { type: 'auth-end'; ok: boolean; error?: string; timestamp: number };

export type AuthStatus = 'unknown' | 'signed-in' | 'signed-out' | 'signing-in' | 'error';

export interface AuthState {
  status: AuthStatus;
  since?: string;
  progress: string[];
  error?: string;
}
