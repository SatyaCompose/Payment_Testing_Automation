import type express from 'express';

interface Client {
  id: number;
  res: express.Response;
}

/**
 * Multi-client Server-Sent-Events broadcaster. Any payload passed to
 * `broadcast()` is JSON-encoded and pushed to every connected client.
 * Broken pipes are silently ignored so one dead browser tab can't affect
 * the others.
 */
export class SseBroadcaster {
  private readonly clients: Client[] = [];
  private nextClientId = 1;

  register(req: express.Request, res: express.Response): void {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    const id = this.nextClientId++;
    this.clients.push({ id, res });
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      const idx = this.clients.findIndex((c) => c.id === id);
      if (idx >= 0) this.clients.splice(idx, 1);
    });
  }

  broadcast(payload: unknown): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.clients) {
      try {
        c.res.write(data);
      } catch {
        // ignore broken pipes
      }
    }
  }

  clientCount(): number {
    return this.clients.length;
  }
}
