import * as fs from 'fs';
import { AUTH_FILE } from './fixtures/auth';

/**
 * Runs once in the Playwright main process, before any worker spawns.
 * Just a file existence check — kept out of a `test.setup.ts` on purpose
 * so it does not spawn a separate worker + browser context (which was
 * causing the "blinking" browser opens between the setup and main runs).
 */
async function globalSetup(): Promise<void> {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error(
      '\n\nNo saved auth session at tests/.auth/user.json.\n' +
      'Click "Sign in to browser" in the runner UI first — a real Chrome window\n' +
      'will open. Sign in to Google, then to KWH, close the window, and every\n' +
      'subsequent test run reuses that session.\n',
    );
  }
}

export default globalSetup;
