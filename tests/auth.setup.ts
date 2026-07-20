import { test as setup } from '@playwright/test';
import * as fs from 'fs';
import { AUTH_FILE } from './fixtures/auth';

/**
 * Auth is no longer scripted. Sign in manually via `npm run auth:setup`
 * (or the "Sign in to browser" button in the runner UI) — a real Chrome
 * window opens, you sign in normally, and the session is saved to
 * `tests/.auth/user.json`. All browser projects reuse it via `storageState`.
 *
 * This setup step just verifies the saved session exists so tests fail
 * with a clear message instead of a cryptic "storageState file not found".
 */
setup('verify saved auth session', async () => {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error(
      'No saved auth session at tests/.auth/user.json.\n\n' +
      'Do one of these first:\n' +
      '  • CLI:  npm run auth:setup\n' +
      '  • UI:   click "Sign in to browser" in the runner (http://localhost:5173)\n\n' +
      'A real Chrome window will open. Sign in to Google, then to KWH. ' +
      'The session is saved once — all subsequent test runs reuse it.',
    );
  }
});
