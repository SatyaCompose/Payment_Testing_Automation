import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { SseBroadcaster } from './sseBroadcaster';

export interface AuthStatus {
  signedIn: boolean;
  since?: string;
  running: boolean;
}

type LogLevel = 'info' | 'warn' | 'error';
type Log = (level: LogLevel, message: string) => void;

/**
 * Manages the interactive-signin child process (a real Chrome window
 * driven by tests/scripts/interactive-signin.ts) and the on-disk auth
 * file it produces.
 */
export class AuthSession {
  private child: ChildProcess | null = null;

  constructor(
    private readonly root: string,
    private readonly authFile: string,
    private readonly broadcaster: SseBroadcaster,
    private readonly log: Log,
  ) {}

  status(): AuthStatus {
    const signedIn = fs.existsSync(this.authFile);
    const since = signedIn ? fs.statSync(this.authFile).mtime.toISOString() : undefined;
    const running = !!(this.child && !this.child.killed);
    return { signedIn, since, running };
  }

  /**
   * Spawn the interactive-signin script. Returns false if a sign-in is
   * already in flight (caller should respond 409).
   */
  start(): boolean {
    if (this.child && !this.child.killed) return false;

    this.broadcaster.broadcast({ type: 'auth-start', timestamp: Date.now() });
    this.log('info', 'Opening a real Chrome window for sign-in…');

    this.child = spawn('npx', ['tsx', 'tests/scripts/interactive-signin.ts'], {
      cwd: this.root,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const forward = (level: 'info' | 'error') => (buf: Buffer) => {
      const text = buf.toString();
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        this.broadcaster.broadcast({ type: 'auth-progress', message: line, timestamp: Date.now() });
        if (level === 'error') console.error(line);
        else console.log(line);
      }
    };
    this.child.stdout?.on('data', forward('info'));
    this.child.stderr?.on('data', forward('error'));

    this.child.on('exit', (code) => {
      const ok = code === 0 && fs.existsSync(this.authFile);
      this.broadcaster.broadcast({
        type: 'auth-end',
        ok,
        error: ok ? undefined : `Sign-in exited with code ${code}`,
        timestamp: Date.now(),
      });
      this.log(ok ? 'info' : 'error', ok ? '✓ Session saved.' : `Sign-in failed (code ${code}).`);
      this.child = null;
    });

    return true;
  }

  /** Cancel an in-progress sign-in. Returns false if nothing was running. */
  cancel(): boolean {
    if (!this.child || this.child.killed) return false;
    this.child.kill('SIGTERM');
    return true;
  }
}
