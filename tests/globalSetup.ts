import * as fs from 'fs';
import { AUTH_FILE } from './fixtures/auth';
import { isSignedInFile } from './fixtures/authState';

/**
 * Runs once in the Playwright main process, before any worker spawns.
 * File-based check only (no browser launch) — kept out of a
 * `test.setup.ts` on purpose so it does not spawn a separate worker +
 * browser context (which was causing the "blinking" browser opens
 * between the setup and main runs). `isSignedInFile` needs no browser —
 * it just reads the saved JSON — so that constraint still holds.
 *
 * Fail-closed: a file that merely *exists* is not enough — it may hold a
 * guest session (the exact bug that motivated this check). Refusing to
 * start the run is safer than silently testing against the wrong identity.
 */
async function globalSetup(): Promise<void> {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error(
      '\n\nNo saved auth session at tests/.auth/user.json.\n' +
      'Sign in first:\n' +
      '  • CLI:  npm run auth:setup\n' +
      '  • UI:   click "Sign in to browser" in the runner (http://localhost:5173)\n\n' +
      'A real Chrome window opens — use "Continue with Google". The script saves\n' +
      'the session and closes the window itself once you are signed in, and every\n' +
      'subsequent test run reuses it.\n',
    );
  }
  if (!isSignedInFile(AUTH_FILE)) {
    throw new Error(
      '\n\nThe saved session at tests/.auth/user.json is a GUEST session, not a\n' +
      'signed-in one — the last sign-in attempt did not actually complete before\n' +
      'the browser closed.\n\n' +
      'Re-run sign-in: click "Sign in to browser" in the runner UI (or run\n' +
      '`npm run auth:setup`), and wait for the on-screen confirmation that you\n' +
      'are signed in to KWH before closing the window.\n',
    );
  }
}

export default globalSetup;
