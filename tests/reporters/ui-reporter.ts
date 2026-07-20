import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

/**
 * Emits JSON-line events on stdout with the `__UI__:` prefix so the runner
 * server can parse them out of Playwright's mixed output. All non-prefixed
 * output continues to work with the standard reporters as usual.
 */
export default class UiReporter implements Reporter {
  private startTs = 0;
  private testIndex = new Map<string, TestCase>();

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startTs = Date.now();
    const all = suite.allTests();
    for (const t of all) this.testIndex.set(t.id, t);
    this.emit({ type: 'run-start', totalTests: all.length, timestamp: this.startTs });
  }

  onTestBegin(test: TestCase): void {
    this.emit({
      type: 'test-start',
      id: test.id,
      title: this.titleFor(test),
      file: this.relFile(test),
      project: test.parent.project()?.name ?? 'unknown',
      timestamp: Date.now(),
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const status = mapStatus(result.status);
    const error =
      result.error?.message ??
      result.errors?.[0]?.message ??
      undefined;
    this.emit({
      type: 'test-end',
      id: test.id,
      status,
      durationMs: result.duration,
      error,
      timestamp: Date.now(),
    });
  }

  onEnd(result: FullResult): void {
    const passed = countBy(result, 'passed');
    const failed = countBy(result, 'failed') + countBy(result, 'timedOut') + countBy(result, 'interrupted');
    const skipped = countBy(result, 'skipped');
    this.emit({
      type: 'run-end',
      passed,
      failed,
      skipped,
      timestamp: Date.now(),
    });
  }

  onError(error: { message?: string }): void {
    this.emit({
      type: 'log',
      level: 'error',
      message: error.message ?? 'Unknown error',
      timestamp: Date.now(),
    });
  }

  private titleFor(test: TestCase): string {
    const chain: string[] = [];
    let s: Suite | undefined = test.parent;
    while (s && s.title) {
      chain.unshift(s.title);
      s = s.parent;
    }
    return [...chain, test.title].join(' › ');
  }

  private relFile(test: TestCase): string {
    return test.location.file.replace(process.cwd() + '/', '');
  }

  private emit(payload: unknown): void {
    process.stdout.write(`__UI__:${JSON.stringify(payload)}\n`);
  }
}

function mapStatus(s: TestResult['status']): 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted' {
  switch (s) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'timedOut':
      return 'timedOut';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'skipped';
  }
}

function countBy(_result: FullResult, _key: string): number {
  // FullResult in Playwright doesn't expose per-status counts directly.
  // The runner UI already accumulates counts from `test-end` events, so
  // here we return 0 for run-end and let the client keep its own tally.
  return 0;
}
