import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Logger } from '@tandem/core';

/*
 * Company runners. A workspace can work on a company's own computer instead of Tandem's cloud: the
 * runner there (`tandem runner`) keeps the workspace's data, repositories and sign-ins, and opens
 * one outbound WebSocket to the web app. The web app forwards the workspace's API requests over
 * it, after its own checks (signed in, member, CSRF token), and streams the answers back.
 *
 * Frames are JSON text. Web app → runner: req {id, method, url, headers, body?}, cancel {id}.
 * Runner → web app: hello {machine, version}, head {id, status, headers}, data {id, b64}, end {id},
 * error {id, message}. No inbound port is opened on the company's side.
 */

export const RUNNER_PROTOCOL = 1;

export interface RunnerRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface RunnerStream {
  onHead(status: number, headers: Record<string, string>): void;
  onData(chunk: Buffer): void;
  onEnd(): void;
  onError(message: string): void;
}
export interface RunnerStatus {
  machine: string;
  version: string;
  connectedAt: number;
}

interface Connection extends RunnerStatus {
  ws: WebSocket;
  streams: Map<string, RunnerStream>;
  alive: boolean;
}

/**
 * Only these answers are passed on, and each one is sandboxed: whatever a runner sends is served
 * on the web app's own address, so it must never run as a page or a script there.
 */
const SAFE_TYPE = /^(application\/(json|pdf|octet-stream)|text\/(event-stream|csv|markdown|plain)|image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon))\b/i;
const KEEP = new Set(['content-type', 'content-disposition', 'cache-control', 'last-modified', 'etag']);
export function safeRunnerHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (KEEP.has(k.toLowerCase()) && typeof v === 'string' && v.length < 500) out[k.toLowerCase()] = v;
  if (!out['content-type'] || !SAFE_TYPE.test(out['content-type'])) out['content-type'] = 'application/octet-stream';
  // Live updates must not wait in a proxy's buffer.
  if (/^text\/event-stream/i.test(out['content-type'])) out['x-accel-buffering'] = 'no';
  return { ...out, 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
}

export class RunnerHub {
  private readonly conns = new Map<string, Connection>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private readonly timer: NodeJS.Timeout;
  private seq = 0;

  constructor(
    private readonly o: {
      /** The workspace a runner key belongs to; undefined refuses it (401), a number refuses with that status (429: try later). */
      authenticate(token: string | undefined, req: IncomingMessage): Promise<string | number | undefined>;
      welcome(workspaceId: string): Promise<Record<string, unknown>>;
      seen(workspaceId: string, machine: string): Promise<void>;
      /** A runner connected here, or the one connected here went away (where it is, for the other replicas). */
      connected?(workspaceId: string, here: boolean): Promise<void>;
      logger: Logger;
    },
  ) {
    // A runner that stops answering pings is let go, so the workspace shows it as not connected.
    this.timer = setInterval(() => {
      for (const c of this.conns.values()) {
        if (!c.alive) c.ws.terminate();
        else {
          c.alive = false;
          c.ws.ping();
        }
      }
    }, 25_000);
    this.timer.unref();
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '/').split('?')[0];
      const refuse = (code: number, text: string) => {
        socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (path !== '/runner/connect') return refuse(404, 'Not Found');
      const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      void this.o
        .authenticate(token, req)
        .catch(() => undefined)
        .then((workspaceId) => {
          if (typeof workspaceId === 'number') return refuse(workspaceId, workspaceId === 429 ? 'Too Many Requests' : 'Refused');
          if (!workspaceId) return refuse(401, 'Unauthorized');
          this.wss.handleUpgrade(req, socket, head, (ws) => void this.connected(workspaceId, ws));
          return undefined;
        });
      return undefined;
    });
  }

  private async connected(workspaceId: string, ws: WebSocket): Promise<void> {
    const conn: Connection = { ws, machine: 'a computer', version: '', connectedAt: Date.now(), streams: new Map(), alive: true };
    const old = this.conns.get(workspaceId);
    this.conns.set(workspaceId, conn);
    if (old) old.ws.close(4000, 'Another runner connected with this key.');
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data: RawData) => this.message(workspaceId, conn, data));
    ws.on('error', () => undefined);
    ws.on('close', () => {
      if (this.conns.get(workspaceId) === conn) {
        this.conns.delete(workspaceId);
        void this.o.connected?.(workspaceId, false).catch(() => undefined);
      }
      for (const s of conn.streams.values()) s.onError("The company runner disconnected.");
      conn.streams.clear();
      this.o.logger.info('runner disconnected', { workspace: workspaceId });
    });
    await this.o.connected?.(workspaceId, true).catch(() => undefined);
    ws.send(JSON.stringify({ t: 'welcome', protocol: RUNNER_PROTOCOL, ...(await this.o.welcome(workspaceId).catch(() => ({}))) }));
    this.o.logger.info('runner connected', { workspace: workspaceId });
  }

  private message(workspaceId: string, conn: Connection, data: RawData): void {
    let f: { t?: string; id?: string; status?: number; headers?: Record<string, string>; b64?: string; message?: string; machine?: string; version?: string };
    try {
      f = JSON.parse(String(data)) as typeof f;
    } catch {
      return;
    }
    if (f.t === 'hello') {
      conn.machine = String(f.machine ?? 'a computer').slice(0, 120);
      conn.version = String(f.version ?? '').slice(0, 40);
      void this.o.seen(workspaceId, conn.machine).catch(() => undefined);
      return;
    }
    const s = f.id ? conn.streams.get(f.id) : undefined;
    if (!s || !f.id) return;
    if (f.t === 'head') s.onHead(Math.min(599, Math.max(100, Number(f.status) || 502)), f.headers && typeof f.headers === 'object' ? f.headers : {});
    else if (f.t === 'data' && typeof f.b64 === 'string') s.onData(Buffer.from(f.b64, 'base64'));
    else if (f.t === 'end') {
      conn.streams.delete(f.id);
      s.onEnd();
    } else if (f.t === 'error') {
      conn.streams.delete(f.id);
      s.onError(String(f.message ?? 'The runner could not answer.').slice(0, 300));
    }
  }

  /** How many runners are connected here. */
  count(): number {
    return this.conns.size;
  }

  status(workspaceId: string): RunnerStatus | undefined {
    const c = this.conns.get(workspaceId);
    return c ? { machine: c.machine, version: c.version, connectedAt: c.connectedAt } : undefined;
  }

  /** Sends a request to the workspace's runner; returns a cancel function, or undefined when none is connected. */
  request(workspaceId: string, r: RunnerRequest, s: RunnerStream): (() => void) | undefined {
    const c = this.conns.get(workspaceId);
    if (!c) return undefined;
    const id = `r${++this.seq}`;
    c.streams.set(id, s);
    c.ws.send(JSON.stringify({ t: 'req', id, ...r }));
    return () => {
      if (!c.streams.delete(id)) return;
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify({ t: 'cancel', id }));
    };
  }

  /** Lets the workspace's runner go (its key was replaced or the workspace moved back to the cloud). */
  disconnect(workspaceId: string, reason: string): void {
    this.conns.get(workspaceId)?.ws.close(4001, reason.slice(0, 120));
  }

  close(): void {
    clearInterval(this.timer);
    for (const c of this.conns.values()) c.ws.terminate();
    this.wss.close();
  }
}
