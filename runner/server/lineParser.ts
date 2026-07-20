/**
 * Parses one line of Playwright stdout. Lines containing the "__UI__:"
 * marker carry a JSON payload emitted by tests/reporters/ui-reporter.ts;
 * anything else is forwarded as a plain info log.
 */
export interface LineHandlers {
  broadcast: (payload: unknown) => void;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const MARKER = '__UI__:';

export function handleLine(line: string, handlers: LineHandlers): void {
  const at = line.indexOf(MARKER);
  if (at < 0) {
    if (line.trim()) handlers.log('info', line.trim());
    return;
  }
  try {
    const payload = JSON.parse(line.slice(at + MARKER.length));
    handlers.broadcast(payload);
  } catch {
    handlers.log('warn', `Malformed UI event: ${line}`);
  }
}
