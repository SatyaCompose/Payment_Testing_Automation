import { test as setup } from '@playwright/test';
import * as fs from 'fs';
import { AUTH_FILE } from './fixtures/auth';
import { isSignedInFile } from './fixtures/authState';

/**
 * Auth is no longer scripted. Sign in manually via `npm run auth:setup`
 * (or the "Sign in to browser" button in the runner UI) — a real Chrome
 * window opens, you sign in normally, and the session is saved to
 * `tests/.auth/user.json`. All browser projects reuse it via `storageState`.
 *
 * This setup step verifies the saved session both exists AND is actually
 * signed in (not a guest session) so tests fail here with a clear message
 * instead of a cryptic checkout failure two steps into the flow, or a
 * silent pass that placed the order on the wrong identity. Fail-closed:
 * "file exists" alone is not proof of anything.
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
  if (!isSignedInFile(AUTH_FILE)) {
    throw new Error(
      'The saved session at tests/.auth/user.json is a GUEST session, not a ' +
      'signed-in one — the previous sign-in attempt captured a guest session ' +
      'before you finished logging in.\n\n' +
      'Re-run sign-in and wait for the confirmation that you are signed in to ' +
      'KWH before closing the window:\n' +
      '  • CLI:  npm run auth:setup\n' +
      '  • UI:   click "Sign in to browser" in the runner (http://localhost:5173)',
    );
  }
});
