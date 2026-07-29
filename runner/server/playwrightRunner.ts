import { execSync, type ChildProcess } from 'node:child_process';
import type { SseBroadcaster } from './sseBroadcaster';
import { buildScopeArgs, StartOptions } from './scopeArgs';
import { handleLine } from './lineParser';
import { canSuspend, isWindows, killTree, spawnCli } from './procUtils';

type LogLevel = 'info' | 'warn' | 'error';
type Log = (level: LogLevel, message: string) => void;

/** Kill any zombie Playwright workers from previous sessions (paused,
 *  orphaned by tsx-watch restarts, etc.).
 *
 *  POSIX only. The Windows equivalent would have to match on node.exe,
 *  which is indistinguishable from this server's own process — killing
 *  those would take the runner down with them. Windows relies on the
 *  taskkill /T teardown in killTree instead. */
function killZombieWorkers(): void {
  if (isWindows) return;
  try {
    execSync(
      "ps -A -o pid,stat,command | awk '($2 ~ /^T/ || $0 ~ /workerProcessEntry/) && $0 !~ /awk/ { print $1 }' | while read pid; do kill -CONT $pid 2>/dev/null; kill -TERM $pid 2>/dev/null; done",
      { stdio: 'ignore' },
    );
  } catch {}
}

/**
 * Owns the Playwright child process — spawn/stop/pause/resume, all via
 * signals sent to the entire process group so browser drivers get them.
 */
export class PlaywrightRunner {
  private child: ChildProcess | null = null;
  private stopping = false;
  private paused = false;

  constructor(
    private readonly root: string,
    private readonly broadcaster: SseBroadcaster,
    private readonly log: Log,
  ) {}

  isRunning(): boolean {
    return !!this.child && !this.child.killed;
  }

  isPaused(): boolean {
    return this.paused && this.isRunning();
  }

  /**
   * Send a signal to the entire process group so it reaches Playwright's
   * subprocess tree, not just the outer npx wrapper.
   */
  private signalGroup(sig: NodeJS.Signals): boolean {
    if (!this.child || this.child.killed || !this.child.pid) return false;
    return killTree(this.child, sig);
  }

  start(opts: StartOptions): void {
    // If a Playwright child is already tracked, terminate it first — the
    // browser refresh + Pause/Start sequence can leave a stale reference.
    if (this.child && !this.child.killed) {
      this.log('warn', 'Existing run present — terminating before starting new one');
      this.signalGroup('SIGCONT'); // unfreeze if paused
      this.signalGroup('SIGTERM');
      this.child = null;
    }
    // Kill any zombie Playwright workers from previous sessions.
    killZombieWorkers();

    // Give any dying processes a moment before spawning the new one.
    const start = Date.now();
    while (Date.now() - start < 300) {
      /* short spin — 300ms so old browser windows finish closing */
    }
    this.stopping = false;
    this.paused = false;

    const args = ['playwright', 'test'];
    if (opts.headed) args.push('--headed');
    if (opts.slowMoMs && opts.slowMoMs > 0) {
      // Playwright's CLI doesn't have --slow-mo; pipe via env for the fixture layer.
      // Consumers of the fixtures/index.ts merged `test` can honor RUN_SLOW_MO_MS.
    }
    if (opts.project) args.push(`--project=${opts.project}`);

    const { positional, grep } = buildScopeArgs(opts);
    if (grep) args.push('--grep', grep);
    for (const p of positional) args.push(p);

    this.log(
      'info',
      `Spawning Playwright: ${args.join(' ')}${opts.headed ? '  (browser windows will open on your desktop)' : ''}`,
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UI_REPORTER: '1',
      FORCE_COLOR: '0',
    };
    if (opts.slowMoMs && opts.slowMoMs > 0) {
      env.RUN_SLOW_MO_MS = String(opts.slowMoMs);
    }
    // When the user explicitly targeted a single sub-test in the UI,
    // bypass the "screenshot already exists → auto-skip" guard in
    // tests/fixtures/index.ts. Explicit selection means they want to
    // re-run it regardless of a leftover screenshot on disk.
    if (opts.subtest) {
      env.FORCE_RERUN = '1';
    }
    if (opts.recordVideo) {
      env.RECORD_VIDEO = '1';
    }

    // spawnCli runs the local Playwright CLI through node — see procUtils
    // for why npx is avoided. On POSIX the child lands in its own process
    // group so SIGSTOP/SIGTERM reach the deeper Playwright children and
    // browser drivers, not just the wrapper.
    try {
      this.child = spawnCli(this.root, 'playwright', args.slice(1), { env });
    } catch (err) {
      this.child = null;
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `Could not start Playwright: ${message}`);
      this.broadcaster.broadcast({ type: 'stopped', timestamp: Date.now() });
      return;
    }

    // Without this, a spawn failure emits an unhandled 'error' event and
    // crashes the server, leaving the UI on ECONNREFUSED.
    this.child.on('error', (err) => {
      this.child = null;
      this.stopping = false;
      this.paused = false;
      this.log('error', `Playwright process error: ${err.message}`);
      this.broadcaster.broadcast({ type: 'stopped', timestamp: Date.now() });
    });

    const handlers = {
      broadcast: (payload: unknown) => this.broadcaster.broadcast(payload),
      log: this.log,
    };

    let stdoutBuf = '';
    this.child.stdout?.on('data', (buf) => {
      stdoutBuf += buf.toString();
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        handleLine(line, handlers);
      }
    });

    this.child.stderr?.on('data', (buf) => {
      const text = buf.toString().trim();
      if (text) this.log('warn', text.split('\n').slice(-3).join(' · '));
    });

    this.child.on('exit', (code, signal) => {
      if (this.stopping || signal === 'SIGTERM' || signal === 'SIGINT') {
        this.log('warn', `Playwright terminated (signal=${signal ?? 'n/a'})`);
        this.broadcaster.broadcast({ type: 'stopped', timestamp: Date.now() });
      } else {
        this.log('info', `Playwright exited with code ${code}`);
      }
      this.child = null;
      this.stopping = false;
    });
  }

  /** Stop a running Playwright child. Returns false if nothing was running. */
  stop(): boolean {
    if (!this.child || this.child.killed) return false;
    this.stopping = true;
    // ALWAYS SIGCONT first — a SIGSTOP'd process can't handle SIGTERM,
    // and our in-memory `paused` flag can go stale if the server was
    // restarted by tsx-watch while a run was frozen.
    this.signalGroup('SIGCONT');
    this.paused = false;
    this.log('warn', 'Stop requested — terminating Playwright');
    this.signalGroup('SIGTERM');
    setTimeout(() => {
      if (this.child && !this.child.killed) {
        this.log('warn', 'Playwright did not exit within 3s — SIGKILL');
        this.signalGroup('SIGKILL');
      }
    }, 3000);
    return true;
  }

  pause(): 'ok' | 'not-running' | 'already-paused' | 'signal-failed' | 'unsupported' {
    if (!canSuspend) return 'unsupported';
    if (!this.child || this.child.killed) return 'not-running';
    if (this.paused) return 'already-paused';
    if (!this.signalGroup('SIGSTOP')) return 'signal-failed';
    this.paused = true;
    this.log('warn', '⏸ Paused (browser stays open, run is frozen)');
    return 'ok';
  }

  resume(): 'ok' | 'not-running' | 'not-paused' | 'signal-failed' | 'unsupported' {
    if (!canSuspend) return 'unsupported';
    if (!this.child || this.child.killed) return 'not-running';
    if (!this.paused) return 'not-paused';
    if (!this.signalGroup('SIGCONT')) return 'signal-failed';
    this.paused = false;
    this.log('info', '▶ Resumed');
    return 'ok';
  }

  /** Forceful shutdown for process-exit handlers. Does not clean up state. */
  terminate(): void {
    if (this.child && !this.child.killed) killTree(this.child, 'SIGTERM');
  }
}
