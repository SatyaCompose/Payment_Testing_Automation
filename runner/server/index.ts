import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { SseBroadcaster } from './sseBroadcaster';
import { AuthSession } from './authSession';
import { PlaywrightRunner } from './playwrightRunner';
import { isWindows } from './procUtils';
import type { StartOptions } from './scopeArgs';

const PORT = Number(process.env.RUNNER_PORT ?? 3001);
const ROOT = path.resolve(__dirname, '..', '..');
const AUTH_FILE = path.join(ROOT, 'tests', '.auth', 'user.json');

const app = express();
app.use(cors());
app.use(express.json());

const broadcaster = new SseBroadcaster();

/** Log to console AND to every connected SSE client. */
function log(level: 'info' | 'warn' | 'error', message: string): void {
  broadcaster.broadcast({ type: 'log', level, message, timestamp: Date.now() });
  const line = `[${level}] ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

const runner = new PlaywrightRunner(ROOT, broadcaster, log);
const auth = new AuthSession(ROOT, AUTH_FILE, broadcaster, log);

// ---------- SSE ----------
app.get('/events', (req, res) => {
  broadcaster.register(req, res);
});

// ---------- Playwright ----------
app.post('/api/start', (req, res) => {
  const opts: StartOptions = req.body ?? {};
  runner.start(opts);
  res.json({ ok: true });
});

app.post('/api/stop', (_req, res) => {
  if (!runner.stop()) {
    return res.status(409).json({ error: 'No run in progress' });
  }
  res.json({ ok: true });
});

const PAUSE_UNSUPPORTED =
  'Pause/Resume needs SIGSTOP, which Windows does not have. Use Stop and re-run instead.';

app.post('/api/pause', (_req, res) => {
  const result = runner.pause();
  if (result === 'unsupported') return res.status(501).json({ error: PAUSE_UNSUPPORTED });
  if (result === 'not-running') return res.status(409).json({ error: 'No run in progress' });
  if (result === 'already-paused') return res.status(409).json({ error: 'Already paused' });
  if (result === 'signal-failed') return res.status(500).json({ error: 'Could not pause the process group' });
  res.json({ ok: true, paused: true });
});

app.post('/api/resume', (_req, res) => {
  const result = runner.resume();
  if (result === 'unsupported') return res.status(501).json({ error: PAUSE_UNSUPPORTED });
  if (result === 'not-running') return res.status(409).json({ error: 'No run in progress' });
  if (result === 'not-paused') return res.status(409).json({ error: 'Not paused' });
  if (result === 'signal-failed') return res.status(500).json({ error: 'Could not resume the process group' });
  res.json({ ok: true, paused: false });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: runner.isRunning() ? 'running' : 'idle',
    paused: runner.isPaused(),
    clients: broadcaster.clientCount(),
  });
});

// ---------- Auth ----------
app.get('/api/auth-status', (_req, res) => {
  res.json(auth.status());
});

app.post('/api/auth-setup', (_req, res) => {
  if (!auth.start()) {
    return res.status(409).json({ error: 'Sign-in already in progress' });
  }
  res.json({ ok: true });
});

app.post('/api/auth-cancel', (_req, res) => {
  if (!auth.cancel()) {
    return res.status(409).json({ error: 'No sign-in in progress' });
  }
  res.json({ ok: true });
});

// ---------- Boot ----------
// Last-resort net: a stray child-process 'error' used to kill the server
// outright, which surfaced in the UI only as ECONNREFUSED on every poll.
// Log it loudly and keep serving.
process.on('uncaughtException', (err) => {
  log('error', `Uncaught server exception (recovered): ${err.message}`);
  console.error(err);
});

const server = app.listen(PORT, () => {
  console.log(`▶ Runner server listening on http://localhost:${PORT}`);
});

// A failed listen must stay fatal — recovering from it would leave a
// server process alive with no listener, so the UI would keep failing
// with ECONNREFUSED while the log claimed everything was fine.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `✗ Port ${PORT} is already in use — an older runner is probably still alive.\n` +
        (isWindows
          ? `  Find it:  netstat -ano | findstr :${PORT}\n  Kill it:  taskkill /PID <pid> /T /F`
          : `  Find it:  lsof -ti tcp:${PORT}\n  Kill it:  kill -9 $(lsof -ti tcp:${PORT})`),
    );
  } else {
    console.error(`✗ Runner server failed to start: ${err.message}`);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    runner.terminate();
    process.exit(0);
  });
}
