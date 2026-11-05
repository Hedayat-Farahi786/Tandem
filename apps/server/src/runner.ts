import { createServer } from 'node:net';
import { hostname } from 'node:os';
import WebSocket, { type RawData } from 'ws';
import type { RuntimeConfig } from '@tandem/shared';
import { JiraError, type JiraOAuth, type JiraTokens } from '@tandem/adapters';
import { VERSION, startServer, type Running } from './start.js';

/*
 * `tandem runner`: a workspace of the web app, working on this computer. It runs Tandem here
 * (data, repositories, Copilot, checks) with this computer's own git, SSH keys, AWS sign-in and
 * Copilot account, and opens one outbound connection to the web app. Members use the web app as
 * usual; their requests come over that connection, already checked by the web app, and are
 * answered by the Tandem running here. Nothing listens on the network: Tandem answers on
 * 127.0.0.1 only, and the code never leaves this computer except as the pushes you'd make anyway.
 */

const RECONNECT_MAX_MS = 30_000;
/** Without a ping from the web app for this long, the connection is dead: reconnect. */
const SILENCE_MS = 75_000;
const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'accept-encoding', 'x-tandem-token']);

export interface RunnerOptions {
  /** The web app's address, e.g. https://app.example.com. */
  url: string;
  /** The runner key an owner made in Settings › Workspace. */
  key: string;
  config: RuntimeConfig;
  log?: (line: string) => void;
  /** Called when the web app refuses the key for good (replaced, or the workspace moved back to the cloud). */
  onRefused?: (why: string) => void;
}

export interface Runner {
  running: Running;
  connected(): boolean;
  stop(): Promise<void>;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });

export async function startRunner(o: RunnerOptions): Promise<Runner> {
  const log = o.log ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const port = o.config.port || (await freePort());
  // Jira's sign-in is made in the web app; it holds Tandem's Atlassian app, so it renews the tokens too.
  const jiraSignIn = { on: false };
  const jiraOAuth: JiraOAuth = {
    available: () => jiraSignIn.on,
    refresh: async (refresh) => {
      const res = await fetch(new URL('/runner/jira/refresh', o.url), { method: 'POST', headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ refresh }), signal: AbortSignal.timeout(30_000) });
      const answer = (await res.json().catch(() => ({}))) as Partial<JiraTokens> & { error?: string };
      if (!res.ok || !answer.access || !answer.expiresAt) throw new JiraError(answer.error ?? "Jira's sign-in could not be renewed through the web app.", res.status === 401 ? 401 : 502);
      return { access: answer.access, ...(answer.refresh ? { refresh: answer.refresh } : {}), expiresAt: answer.expiresAt };
    },
  };
  const running = await startServer({ ...o.config, port }, { webDir: undefined, trustActor: true, jiraOAuth });
  const local = `http://127.0.0.1:${port}`;
  const target = new URL('/runner/connect', o.url);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';

  let ws: WebSocket | undefined;
  let open = false;
  let stopped = false;
  let delay = 1_000;
  let silence: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  const inflight = new Map<string, AbortController>();

  const send = (sock: WebSocket, frame: Record<string, unknown>) => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(frame));
  };
  /** Waits while the connection has a lot queued, so a big download doesn't pile up in memory. */
  const drain = async (sock: WebSocket) => {
    while (sock.readyState === WebSocket.OPEN && sock.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 20));
  };
  const alive = (sock: WebSocket) => {
    clearTimeout(silence);
    silence = setTimeout(() => sock.terminate(), SILENCE_MS);
  };

  /** One request from the web app, answered by the Tandem on this computer and streamed back. */
  const serve = async (sock: WebSocket, f: { id: string; method: string; url: string; headers?: Record<string, string>; body?: string }) => {
    if (typeof f.url !== 'string' || !f.url.startsWith('/api/')) return send(sock, { t: 'error', id: f.id, message: 'Not allowed.' });
    const ctl = new AbortController();
    inflight.set(f.id, ctl);
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(f.headers ?? {})) if (typeof v === 'string' && !HOP.has(k.toLowerCase())) headers[k] = v;
      headers['x-tandem-token'] = running.token;
      const res = await fetch(`${local}${f.url}`, { method: f.method, headers, signal: ctl.signal, ...(f.body !== undefined && f.method !== 'GET' && f.method !== 'HEAD' ? { body: f.body } : {}) });
      send(sock, { t: 'head', id: f.id, status: res.status, headers: Object.fromEntries(res.headers) });
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          send(sock, { t: 'data', id: f.id, b64: Buffer.from(value).toString('base64') });
          await drain(sock);
        }
      }
      send(sock, { t: 'end', id: f.id });
    } catch (err) {
      if (!ctl.signal.aborted) send(sock, { t: 'error', id: f.id, message: `The runner could not answer: ${(err as Error).message}` });
    } finally {
      inflight.delete(f.id);
    }
  };

  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(target, { headers: { Authorization: `Bearer ${o.key}`, 'User-Agent': `tandem-runner/${VERSION}` }, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 20_000 });
    ws = sock;
    sock.on('open', () => {
      open = true;
      delay = 1_000;
      alive(sock);
      send(sock, { t: 'hello', machine: hostname(), version: VERSION });
    });
    sock.on('ping', () => alive(sock));
    sock.on('message', (data: RawData) => {
      let f: { t?: string; id?: string; workspace?: string; jiraSignIn?: boolean; method?: string; url?: string; headers?: Record<string, string>; body?: string };
      try {
        f = JSON.parse(String(data)) as typeof f;
      } catch {
        return;
      }
      if (f.t === 'welcome') jiraSignIn.on = f.jiraSignIn === true;
      if (f.t === 'welcome') log(`Connected to ${o.url}${f.workspace ? ` for the workspace "${f.workspace}"` : ''}. Leave this running; stop it with Ctrl+C.`);
      else if (f.t === 'req' && f.id && f.method && f.url) void serve(sock, { id: f.id, method: f.method, url: f.url, ...(f.headers ? { headers: f.headers } : {}), ...(f.body !== undefined ? { body: f.body } : {}) });
      else if (f.t === 'cancel' && f.id) inflight.get(f.id)?.abort();
    });
    sock.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) {
        stopped = true;
        o.onRefused?.('The web app did not accept this runner key. An owner can make a new one in Settings › Workspace.');
      } else log(`The web app answered ${res.statusCode}; trying again.`);
      sock.terminate();
    });
    sock.on('error', (err) => {
      if (!open) log(`Can't reach ${o.url} (${err.message}); trying again.`);
    });
    sock.on('close', (code, reason) => {
      clearTimeout(silence);
      for (const c of inflight.values()) c.abort();
      inflight.clear();
      if (open) log(code === 4000 || code === 4001 ? `Disconnected: ${String(reason)}` : 'Disconnected from the web app; reconnecting.');
      open = false;
      if (stopped) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    });
  };
  connect();

  return {
    running,
    connected: () => open,
    stop: async () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(silence);
      ws?.close(1000, 'The runner stopped.');
      for (const c of inflight.values()) c.abort();
      await running.stop();
    },
  };
}
