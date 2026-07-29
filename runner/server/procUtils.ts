import { spawn, execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

/**
 * Suspending a process (Pause) needs SIGSTOP, which Windows does not have.
 * Worse, `child.kill('SIGSTOP')` on Windows falls through to
 * TerminateProcess — a Pause click would *end* the run. Callers must check
 * this before attempting pause/resume.
 */
export const canSuspend = !isWindows;

/** Locally-installed CLIs, mapped to their JS entry points. */
const CLI_ENTRIES: Record<string, string[]> = {
  playwright: [
    'node_modules/@playwright/test/cli.js',
    'node_modules/playwright/cli.js',
  ],
  tsx: ['node_modules/tsx/dist/cli.mjs'],
};

/**
 * Resolve a CLI to an absolute JS entry path so it can be run with
 * `process.execPath` (node) rather than `npx`.
 *
 * Why not npx: on Windows the binary is `npx.cmd`, so `spawn('npx', …)`
 * fails with ENOENT, and since the CVE-2024-27980 fix Node refuses to
 * spawn `.cmd`/`.bat` without `shell: true` — which then drags in shell
 * quoting rules for args like `--grep "a b"`. Invoking node against the
 * package's own entry point sidesteps both and behaves identically on
 * macOS, Linux, and Windows.
 */
export function resolveCli(root: string, name: keyof typeof CLI_ENTRIES | string): string {
  const candidates = CLI_ENTRIES[name] ?? [];
  for (const rel of candidates) {
    const abs = path.join(root, ...rel.split('/'));
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error(
    `Cannot find the "${name}" CLI under ${root}. Run \`npm install\` in the project root.`,
  );
}

/**
 * Spawn a local CLI via node. On POSIX the child gets its own process
 * group so signals can reach Playwright's whole subprocess tree; on
 * Windows `detached` is left off (it would pop a new console window) and
 * the tree is torn down with taskkill instead — see {@link killTree}.
 */
export function spawnCli(
  root: string,
  cli: string,
  args: string[],
  opts: Omit<SpawnOptions, 'detached' | 'cwd'> = {},
): ChildProcess {
  const entry = resolveCli(root, cli);
  return spawn(process.execPath, [entry, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
    detached: !isWindows,
  });
}

/**
 * Signal a child and everything it spawned.
 *
 * POSIX: negative PID hits the whole process group.
 * Windows: no process groups and no real signals — `taskkill /T /F` walks
 * the child tree. Only terminate/kill are expressible; SIGSTOP/SIGCONT
 * are rejected by {@link canSuspend} before reaching here.
 */
export function killTree(child: ChildProcess, sig: NodeJS.Signals): boolean {
  if (!child.pid || child.killed) return false;

  if (isWindows) {
    if (sig === 'SIGSTOP' || sig === 'SIGCONT') return false;
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return true;
    } catch {
      // taskkill exits non-zero when the tree is already gone.
      try {
        child.kill();
        return true;
      } catch {
        return false;
      }
    }
  }

  try {
    process.kill(-child.pid, sig);
    return true;
  } catch {
    try {
      child.kill(sig);
      return true;
    } catch {
      return false;
    }
  }
}
