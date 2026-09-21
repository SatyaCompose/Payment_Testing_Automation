import { type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { SseBroadcaster } from './sseBroadcaster';
import { killTree, spawnCli } from './procUtils';
// Shared with tests/pages/LoginPage.ts, tests/globalSetup.ts and
// tests/auth.setup.ts — do NOT re-derive the "signed in" rule here.
// This predicate is pure Node (fs + JSON), so it has no Playwright
// dependency and imports cleanly across the runner's separate tsconfig.
import { isSignedInFile } from '../../tests/fixtures/authState';

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
    // File existence alone used to be treated as "signed in" — that let a
    // guest session (which still writes a valid-looking storageState file)
    // show a green "signed in" state in the UI. `since` intentionally still
    // reflects the file's mtime whenever it exists, signed-in or not, so
    // the UI can show "last attempt at …" even for a failed capture.
    const exists = fs.existsSync(this.authFile);
    const signedIn = exists && isSignedInFile(this.authFile);
    const since = exists ? fs.statSync(this.authFile).mtime.toISOString() : undefined;
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

    try {
      this.child = spawnCli(this.root, 'tsx', ['tests/scripts/interactive-signin.ts'], {
        env: { ...process.env, FORCE_COLOR: '0' },
      });
    } catch (err) {
      this.child = null;
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `Could not start sign-in: ${message}`);
      this.broadcaster.broadcast({
        type: 'auth-end',
        ok: false,
        error: message,
        timestamp: Date.now(),
      });
      return false;
    }

    // A spawn failure emits 'error', not 'exit'. Unhandled, it takes the
    // whole server down and every subsequent request dies on ECONNREFUSED.
    this.child.on('error', (err) => {
      this.child = null;
      this.log('error', `Sign-in process error: ${err.message}`);
      this.broadcaster.broadcast({
        type: 'auth-end',
        ok: false,
        error: err.message,
        timestamp: Date.now(),
      });
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
      // "File exists" used to count as success, which reported a green
      // check even when interactive-signin.ts captured (and, pre-fix,
      // would have saved) a guest session. The script itself now refuses
      // to write a non-signed-in capture, but this check stays defensive.
      const ok = code === 0 && isSignedInFile(this.authFile);
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
    killTree(this.child, 'SIGTERM');
    return true;
  }
}
