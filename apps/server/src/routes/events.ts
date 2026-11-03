import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../app.js';

/** One SSE stream for everything live. Reconnects resume from Last-Event-ID. */
export function registerEventRoutes(app: FastifyInstance, ctx: ServerContext) {
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (e: { id: number; event: unknown }) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(e.event)}\n\n`);
    const last = Number(req.headers['last-event-id'] ?? (req.query as { since?: string }).since ?? 0);
    if (last > 0) for (const e of ctx.bus.since(last)) send(e);
    res.write(': connected\n\n');
    const off = ctx.bus.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });
}
