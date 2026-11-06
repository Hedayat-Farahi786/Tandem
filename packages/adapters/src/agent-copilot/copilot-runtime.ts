import { CopilotClient, RuntimeConnection, ToolSet, defineTool } from '@github/copilot-sdk';
import { bundledCopilotRuntime } from '../sandbox/namespace-sandbox.js';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ZodType } from 'zod';
import { BudgetError, RetryableError, allowedBuiltins, type AgentEvent, type AgentRuntime, type AgentSession, type AgentSessionOptions, type AgentUsage, type Logger } from '@tandem/core';
import { vendorOf, type ModelOption, type Settings } from '@tandem/shared';
import { copilotRuntimeEnv, enforcement } from './enforce.js';
import { strictResponseSchema, type ResponseSchemaLike } from './strict-schema.js';
import { RuntimeAccounts, keptSignIns, restoreSignIns, settingsHost, type AccountClientLike, type KeptSignIns } from './accounts.js';
import type { SecretStore } from '../secrets/keychain.js';

/* Structural views of the SDK objects Tandem uses (lets tests drive the adapter with a fake). */
export interface SessionEventLike {
  type: string;
  data: Record<string, unknown>;
}
export interface SessionLike {
  readonly sessionId: string;
  on(handler: (e: SessionEventLike) => void): () => void;
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<{ data: { content?: string } } | undefined>;
  sendAndWait(prompt: string, schema: ResponseSchemaLike<unknown>, timeout?: number): Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  rpc?: { tools?: { execute(params: { name: string; arguments: unknown }): Promise<{ resultType?: string; textResultForLlm?: string }> } };
}
export interface ModelLike {
  id: string;
  name?: string;
  policy?: { state: string };
  billing?: { multiplier?: number; discountPercent?: number; tokenPrices?: { inputPrice?: number; outputPrice?: number; cacheReadPrice?: number; cachePrice?: number; batchSize?: number } };
  capabilities?: { supports?: { vision?: boolean }; limits?: { max_context_window_tokens?: number; max_output_tokens?: number } };
  supportedReasoningEfforts?: string[];
}
export interface ClientLike {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  getStatus(): Promise<{ version: string; protocolVersion: number }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; authType?: string; host?: string; login?: string; statusMessage?: string }>;
  listModels(): Promise<ModelLike[]>;
  rpc?: { models?: { listTokenPriceUnits?(params?: Record<string, unknown>): Promise<{ units: Array<{ modelId: string; unit: string }> }> } };
  createSession(config: Record<string, unknown>): Promise<SessionLike>;
  resumeSession(id: string, config: Record<string, unknown>): Promise<SessionLike>;
}

/** A GitHub identity for Copilot sessions (hosted mode): a user token, its host and when it expires. */
export interface GitHubIdentity {
  token: string;
  /** "github.com" or a GitHub Enterprise Cloud host. */
  host: string;
  login?: string | undefined;
  /** Epoch ms; undefined when the token does not expire. */
  expiresAt?: number | undefined;
}

export interface CopilotRuntimeOptions {
  settings: () => Promise<Settings>;
  logger?: Logger;
  /** Test seam: build a client for the given env and CLI path. */
  createClient?: (env: Record<string, string>, cliPath: string | undefined) => ClientLike;
  env?: NodeJS.ProcessEnv;
  /** After a sign-in or account switch: keep this Copilot host in Settings ('' = github.com). */
  useHost?: (host: string) => Promise<void>;
  /**
   * Tandem's data folder. The runtime keeps its sign-ins and state under <home>/copilot, so Tandem
   * uses only accounts connected in Tandem (never a Copilot CLI or GitHub CLI login).
   */
  home?: string;
  /**
   * Hosted mode: every session runs as this identity (the workspace's GitHub account), passed per
   * session and renewed on demand; the runtime never uses a sign-in of its own.
   */
  identity?: () => Promise<GitHubIdentity | undefined>;
  /**
   * Where Tandem keeps Copilot sign-ins the runtime cannot save itself (a computer without a
   * keychain); they are handed back to the runtime each time it starts. Not in hosted mode.
   */
  keep?: SecretStore;
  /** Tandem's cloud: the runtime, and every command Copilot runs, start inside this sandbox. */
  sandbox?: { wrap(argv: readonly string[], cwd?: string): { file: string; args: string[]; env: Record<string, string> } };
}

const RETRYABLE = /(rate.?limit|\b429\b|too many requests|timed? ?out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|\b5\d\d\b|overloaded|temporarily unavailable|stream (closed|ended))/i;
/** Request IDs are hex and can contain "520"; they say nothing about whether to retry. */
const withoutIds = (msg: string) => msg.replace(/\(?request id:?\s*[\w-]+\)?/gi, '');

/** Cheapest enabled model: by request multiplier (legacy billing) or token prices (AI credits). */
export function cheapestModel(models: readonly ModelLike[]): string | undefined {
  const enabled = models.filter((m) => m.policy?.state !== 'disabled' && m.id !== 'auto');
  const score = (m: ModelLike) => m.billing?.multiplier ?? (m.billing?.tokenPrices ? (m.billing.tokenPrices.inputPrice ?? 0) + 4 * (m.billing.tokenPrices.outputPrice ?? 0) : Number.POSITIVE_INFINITY);
  return [...enabled].sort((a, b) => score(a) - score(b))[0]?.id;
}

/**
 * A model as Tandem shows it. Copilot quotes token prices per batch (batchSize tokens) in AI credits
 * or nano-AIU; this converts them to AI credits per million tokens.
 */
export function toModelOption(m: ModelLike, unit: string | undefined): ModelOption {
  const tp = m.billing?.tokenPrices;
  const scale = (1_000_000 / (tp?.batchSize || 1_000_000)) * (unit === 'nano_aiu' ? 1e-9 : 1);
  const per = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * scale * 1000) / 1000);
  const cached = per(tp?.cacheReadPrice ?? tp?.cachePrice);
  const ctx = m.capabilities?.limits?.max_context_window_tokens;
  const out = m.capabilities?.limits?.max_output_tokens;
  return {
    id: m.id,
    name: m.name || m.id,
    vendor: m.id === 'auto' ? 'Copilot' : vendorOf(m.id),
    ...(tp?.inputPrice !== undefined && tp.outputPrice !== undefined ? { price: { input: per(tp.inputPrice)!, output: per(tp.outputPrice)!, ...(cached !== undefined ? { cachedInput: cached } : {}) } } : {}),
    ...(m.billing?.multiplier !== undefined ? { multiplier: m.billing.multiplier } : {}),
    ...(m.billing?.discountPercent ? { discountPercent: m.billing.discountPercent } : {}),
    ...(ctx ? { contextWindow: ctx } : {}),
    ...(out ? { maxOutput: out } : {}),
    vision: Boolean(m.capabilities?.supports?.vision),
    reasoning: m.supportedReasoningEfforts ?? [],
  };
}

/**
 * AgentRuntime on the GitHub Copilot SDK, using the Copilot CLI's existing sign-in (no token is
 * passed; GH_TOKEN and similar are removed from the runtime environment). Safety is enforced in
 * code by a pre-tool hook and a permission handler; see enforce.ts.
 */
export class CopilotRuntime implements AgentRuntime {
  readonly name = 'copilot';
  private client: ClientLike | undefined;
  private clientKey = '';
  private starting: Promise<ClientLike> | undefined;
  private modelCache: { at: number; list: ModelLike[] } | undefined;
  private priceUnits: { at: number; units: Map<string, string> } | undefined;

  /** Connecting, switching and signing out Copilot accounts, through the runtime's own sign-in. */
  readonly accounts: RuntimeAccounts;

  private readonly kept: KeptSignIns | undefined;

  constructor(private readonly o: CopilotRuntimeOptions) {
    this.kept = o.keep && !o.identity ? keptSignIns(o.keep) : undefined;
    this.accounts = new RuntimeAccounts({
      ...(this.kept ? { kept: this.kept } : {}),
      client: async () => (await this.ensureClient()) as unknown as AccountClientLike,
      useHost: async (host) => {
        // Another account means other models and prices; a new host also restarts the runtime.
        this.modelCache = undefined;
        this.priceUnits = undefined;
        await this.o.useHost?.(settingsHost(host));
      },
    });
  }

  private async ensureClient(): Promise<ClientLike> {
    const s = await this.o.settings();
    const key = `${s.copilot.host}|${s.copilot.cliPath}`;
    if (this.client && this.clientKey === key) return this.client;
    if (this.starting && this.clientKey === key) return this.starting;
    if (this.client) await this.client.stop().catch(() => undefined);
    this.client = undefined;
    this.clientKey = key;
    this.modelCache = undefined;
    this.priceUnits = undefined;
    const home = this.o.home ? { copilot: join(this.o.home, 'copilot'), gh: join(this.o.home, 'copilot', 'gh-none') } : undefined;
    if (home) mkdirSync(home.gh, { recursive: true, mode: 0o700 });
    const env = copilotRuntimeEnv(this.o.env ?? process.env, s.copilot.host || undefined, home);
    const cliPath = s.copilot.cliPath || undefined;
    // Isolated: start the runtime the SDK would start, inside the sandbox (its arguments follow ours).
    const isolated = (): Record<string, unknown> => {
      const runtime = cliPath ?? bundledCopilotRuntime();
      if (!runtime) throw new Error('The Copilot runtime was not found, so it cannot start isolated. Reinstall dependencies (pnpm install).');
      const w = this.o.sandbox!.wrap([runtime]);
      return { connection: RuntimeConnection.forStdio({ path: w.file, args: w.args, env: { ...env, ...w.env } }) };
    };
    this.starting = (async () => {
      const c: ClientLike = this.o.createClient
        ? this.o.createClient(env, cliPath)
        : (new CopilotClient({ logLevel: 'error', useLoggedInUser: !this.o.identity, ...(home ? { baseDirectory: home.copilot } : {}), ...(this.o.sandbox ? isolated() : cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath, env }) } : { env }) }) as unknown as ClientLike);
      await c.start();
      if (this.kept) {
        await restoreSignIns(c as unknown as AccountClientLike, this.kept, s.copilot.host, (host, err) => this.o.logger?.warn('a kept Copilot sign-in was not accepted', { host, error: String((err as Error)?.message ?? err) }));
      }
      this.client = c;
      return c;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /** Hosted: hands each session the workspace identity's token, renewed when it nears expiry. */
  private tokenProvider() {
    return async () => {
      const id = await this.o.identity!();
      if (!id) return { kind: 'cancelled' as const };
      // The runtime refreshes an hour before expiry: report at least a little over that.
      const left = id.expiresAt ? Math.floor((id.expiresAt - Date.now()) / 1000) : 8 * 3600;
      return { kind: 'token' as const, accessToken: id.token, expiresIn: Math.max(left, 3700) };
    };
  }

  /** For doctor: runtime version, sign-in and model access (no model call). */
  async check(): Promise<{ version?: string; authenticated: boolean; login?: string; host?: string; authType?: string; models?: ModelLike[]; error?: string }> {
    try {
      const c = await this.ensureClient();
      const status = await c.getStatus();
      if (this.o.identity) {
        const id = await this.o.identity();
        if (!id) return { version: status.version, authenticated: false, error: 'No GitHub account is set for Copilot in this workspace.' };
        const base = { version: status.version, authenticated: true, host: id.host, authType: 'workspace', ...(id.login ? { login: id.login } : {}) };
        try {
          return { ...base, models: await this.listModels() };
        } catch (err) {
          return { ...base, error: String((err as Error).message ?? err) };
        }
      }
      const auth = await c.getAuthStatus();
      if (!auth.isAuthenticated) return { version: status.version, authenticated: false, ...(auth.statusMessage ? { error: auth.statusMessage } : {}) };
      const base = { version: status.version, authenticated: true, ...(auth.login ? { login: auth.login } : {}), ...(auth.host ? { host: auth.host } : {}), ...(auth.authType ? { authType: auth.authType } : {}) };
      try {
        return { ...base, models: await this.listModels() };
      } catch (err) {
        return { ...base, error: String((err as Error).message ?? err) };
      }
    } catch (err) {
      return { authenticated: false, error: String((err as Error).message ?? err) };
    }
  }

  async listModels(): Promise<ModelLike[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.list;
    const client = await this.ensureClient();
    let list: ModelLike[];
    if (this.o.identity) {
      // Hosted: the models the workspace's account may use, asked with its token.
      const id = await this.o.identity();
      if (!id) throw new Error('No GitHub account is set for Copilot in this workspace.');
      const r = (await (client.rpc as unknown as { models: { list(p: { gitHubToken: string }): Promise<{ models: ModelLike[] } | ModelLike[]> } }).models.list({ gitHubToken: id.token })) as { models?: ModelLike[] } | ModelLike[];
      list = Array.isArray(r) ? r : (r.models ?? []);
    } else list = await client.listModels();
    this.modelCache = { at: Date.now(), list };
    return list;
  }

  /** Models this account may use, with prices in AI credits per million tokens (no model call). */
  async models(): Promise<ModelOption[]> {
    const list = (await this.listModels()).filter((m) => m.policy?.state !== 'disabled');
    if (!this.priceUnits || Date.now() - this.priceUnits.at > 10 * 60_000) {
      const client = await this.ensureClient();
      const units = await client.rpc?.models?.listTokenPriceUnits?.({}).catch(() => undefined);
      this.priceUnits = { at: Date.now(), units: new Map((units?.units ?? []).map((u) => [u.modelId, u.unit])) };
    }
    const units = this.priceUnits.units;
    return list.map((m) => toModelOption(m, units.get(m.id)));
  }

  async defaultModel(tier: 'light' | 'build'): Promise<string | undefined> {
    if (tier === 'build') return undefined;
    return cheapestModel(await this.listModels().catch(() => []));
  }

  private async resolveModel(opts: AgentSessionOptions): Promise<string | undefined> {
    if (opts.model) return opts.model;
    if (opts.tier !== 'light') return undefined;
    try {
      return cheapestModel(await this.listModels());
    } catch {
      return undefined;
    }
  }

  async startSession(opts: AgentSessionOptions): Promise<AgentSession> {
    const client = await this.ensureClient();
    const model = await this.resolveModel(opts);
    const customTools = new Set((opts.tools ?? []).map((t) => t.name));
    let events: AgentEvent[] = [];
    const emit = (e: AgentEvent) => {
      events.push(e);
      opts.onEvent?.(e);
    };
    const { onPreToolUse, onPermissionRequest } = enforcement({ mode: opts.mode, root: opts.workspace, allowedCommands: opts.allowedCommands, customTools, onEvent: emit });
    const tools = (opts.tools ?? []).map((t) =>
      defineTool(t.name, {
        description: t.description,
        parameters: t.schema as never,
        skipPermission: true,
        handler: async (args: unknown) => {
          const parsed = t.schema.safeParse(args);
          if (!parsed.success) return `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
          return t.handler(parsed.data as never);
        },
      }),
    );
    const config: Record<string, unknown> = {
      clientName: 'tandem',
      workingDirectory: opts.workspace,
      streaming: true,
      ...(model ? { model } : {}),
      availableTools: new ToolSet().addBuiltIn(allowedBuiltins(opts.mode)).addCustom('*'),
      excludedTools: new ToolSet().addMcp('*'),
      systemMessage: { content: opts.instructions },
      onPermissionRequest,
      hooks: { onPreToolUse },
      tools,
      ...(this.o.identity ? { gitHubTokenProvider: this.tokenProvider() } : {}),
    };

    let session: SessionLike | undefined;
    if (opts.resumeId) {
      try {
        session = await client.resumeSession(opts.resumeId, config);
      } catch (err) {
        // Sessions are only stored after their first turn (spike a); start fresh with the same rules.
        this.o.logger?.warn('copilot session could not be resumed; starting a new one', { resumeId: opts.resumeId, error: String(err) });
      }
    }
    session ??= await client.createSession(config).catch((err: unknown) => {
      throw classify(err);
    });
    const s = session;

    let modelCalls = 0;
    let nanoAiu = 0;
    let lastModel = model ?? 'default';
    let overBudget = false;
    let overCredits = false;
    const off = s.on((e) => {
      if (e.type === 'assistant.message_delta' && typeof e.data.deltaContent === 'string') emit({ type: 'delta', text: e.data.deltaContent });
      if (e.type === 'assistant.usage') {
        modelCalls++;
        const usage = e.data.copilotUsage as { totalNanoAiu?: number } | undefined;
        nanoAiu += usage?.totalNanoAiu ?? 0;
        if (typeof e.data.model === 'string') lastModel = e.data.model;
        emit({ type: 'usage', model: lastModel, nanoAiu: usage?.totalNanoAiu ?? 0 });
        if (modelCalls >= opts.maxModelCalls && !overBudget) {
          overBudget = true;
          void s.abort().catch(() => undefined);
        }
        if (opts.maxNanoAiu !== undefined && nanoAiu >= opts.maxNanoAiu && !overCredits) {
          overCredits = true;
          void s.abort().catch(() => undefined);
        }
      }
      if (e.type === 'session.error') emit({ type: 'error', message: String(e.data.message ?? JSON.stringify(e.data)).slice(0, 500) });
      // The run's story for the task's Activity tab.
      const d = e.data as Record<string, unknown>;
      if (e.type === 'assistant.intent' && typeof d.intent === 'string') emit({ type: 'intent', text: d.intent });
      if (e.type === 'assistant.reasoning' && typeof d.content === 'string') emit({ type: 'reasoning', text: d.content });
      // Structured answers arrive as JSON messages; they are shown elsewhere (spec, review), not here.
      if (e.type === 'assistant.message' && typeof d.content === 'string' && !/^\s*[{[]/.test(d.content)) emit({ type: 'message', text: d.content });
      if (e.type === 'tool.execution_start' && typeof d.toolCallId === 'string') emit({ type: 'tool-start', id: d.toolCallId, tool: String(d.toolName ?? 'tool'), ...(typeof d.toolTitle === 'string' ? { title: d.toolTitle } : {}), input: relativeIn(opts.workspace, toolInput(d.arguments)) });
      if (e.type === 'tool.execution_complete' && typeof d.toolCallId === 'string') {
        const result = d.result as { content?: string } | undefined;
        const error = d.error as { message?: string } | undefined;
        const files = Array.isArray(d.fileEdits) ? (d.fileEdits as Array<{ kind?: string; path?: string }>).filter((f) => f.path).map((f) => ({ kind: String(f.kind ?? 'edit'), path: relativeTo(opts.workspace, String(f.path)) })) : [];
        emit({ type: 'tool-end', id: d.toolCallId, ok: d.success === true, ...(error?.message ? { output: error.message } : result?.content ? { output: result.content } : {}), ...(files.length ? { files } : {}) });
      }
    });

    const turn = async <T>(run: () => Promise<T>): Promise<{ value: T; usage: AgentUsage }> => {
      const before = { modelCalls, nanoAiu };
      events = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void s.abort().catch(() => undefined);
          reject(new Error(`The agent did not finish within ${Math.round(opts.timeoutMs / 60_000)} minutes, so Tandem stopped it.`));
        }, opts.timeoutMs);
      });
      const used = (): AgentUsage => ({ model: lastModel, modelCalls: modelCalls - before.modelCalls, nanoAiu: nanoAiu - before.nanoAiu });
      try {
        const value = await Promise.race([run(), timeout]).catch((err: unknown) => {
          // An abort Tandem asked for: report why below, not the runtime's "aborted".
          if (overCredits || overBudget) return undefined as T;
          throw err;
        });
        if (overCredits) throw new BudgetError(`The run reached its Copilot credit limit after ${modelCalls} model calls.`);
        if (overBudget) throw new Error(`The agent used ${modelCalls} model calls in one run (limit ${opts.maxModelCalls}), so Tandem stopped it. Raise "model calls per run" in Settings if this task needs more.`);
        return { value, usage: used() };
      } catch (err) {
        // A stopped turn still cost something; the caller records it.
        throw Object.assign(classify(err), { usage: used() });
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    return {
      id: s.sessionId,
      send: async (prompt) => {
        const r = await turn(() => s.sendAndWait({ prompt }, opts.timeoutMs + 5_000));
        return { text: r.value?.data.content ?? '', usage: r.usage };
      },
      sendStructured: async <T>(prompt: string, schema: ZodType<T>) => {
        // Strict-mode schema: every field required, optional ones nullable (OpenAI models insist).
        const r = await turn(() => s.sendAndWait(prompt, strictResponseSchema(schema) as ResponseSchemaLike<unknown>, opts.timeoutMs + 5_000) as Promise<T>);
        return { value: schema.parse(r.value), usage: r.usage };
      },
      stop: async () => {
        off();
        await s.disconnect().catch(() => undefined);
      },
    };
  }

  /**
   * Proves the safety rules are active in the real runtime without any model call: forbidden tool
   * calls are run through the runtime's own tool pipeline and must be denied by Tandem's hook.
   */
  async selfTest(workspace: string): Promise<{ total: number; denied: number; failures: string[] }> {
    const client = await this.ensureClient();
    const outside = join(dirname(workspace), `tandem-selftest-outside-${process.pid}.txt`);
    const cases: Array<[AgentSessionOptions['mode'], string, Record<string, unknown>]> = [
      ['read-only', 'create', { path: join(workspace, 'selftest.txt'), file_text: 'x' }],
      ['read-only', 'bash', { command: 'ls', description: 'selftest' }],
      ['build', 'bash', { command: 'git push origin HEAD', description: 'selftest' }],
      ['build', 'bash', { command: 'aws sts get-caller-identity', description: 'selftest' }],
      ['build', 'bash', { command: 'curl https://example.com', description: 'selftest' }],
      ['build', 'create', { path: outside, file_text: 'x' }],
      ['build', 'create', { path: join(workspace, '.git', 'config'), file_text: 'x' }],
      ['build', 'web_fetch', { url: 'https://example.com' }],
    ];
    const failures: string[] = [];
    let denied = 0;
    for (const mode of ['read-only', 'build'] as const) {
      const { onPreToolUse, onPermissionRequest } = enforcement({ mode, root: workspace, allowedCommands: [], customTools: new Set() });
      const session = await client.createSession({ clientName: 'tandem-selftest', workingDirectory: workspace, availableTools: new ToolSet().addBuiltIn(allowedBuiltins(mode)), excludedTools: new ToolSet().addMcp('*'), onPermissionRequest, hooks: { onPreToolUse }, ...(this.o.identity ? { gitHubTokenProvider: this.tokenProvider() } : {}) });
      try {
        for (const [m, name, args] of cases.filter((c) => c[0] === mode)) {
          const r = await session.rpc?.tools?.execute({ name, arguments: args }).catch((err: unknown) => ({ resultType: 'error', textResultForLlm: String(err) }));
          if (r?.resultType === 'denied') denied++;
          else failures.push(`${m} ${name} ${JSON.stringify(args.command ?? args.path ?? args.url)} was not denied (${r?.resultType ?? 'no result'})`);
        }
      } finally {
        await session.disconnect().catch(() => undefined);
      }
    }
    return { total: cases.length, denied, failures };
  }

  async stop(): Promise<void> {
    if (this.client) await this.client.stop().catch(() => undefined);
    this.client = undefined;
  }
}

function classify(err: unknown): Error {
  if (err instanceof RetryableError || err instanceof BudgetError) return err;
  const msg = String((err as Error)?.message ?? err);
  if (/did not finish within|model calls in one run/.test(msg)) return err as Error;
  if (RETRYABLE.test(withoutIds(msg)) && !/\b4(0[0-9]|1[0-9]|2[0-8])\b/.test(withoutIds(msg))) return new RetryableError(`Copilot: ${msg.slice(0, 300)}`);
  if (/403|not authorized|unauthorized|policy/i.test(msg)) return new Error(`Copilot refused the request (${msg.slice(0, 200)}). Check the Copilot host in Settings and that your organization allows Copilot CLI.`);
  return err instanceof Error ? err : new Error(msg);
}

/** A tool call's input in one line: the command, the path or the query, else short JSON. */
export function toolInput(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args.slice(0, 600);
  if (typeof args !== 'object') return String(args);
  const a = args as Record<string, unknown>;
  for (const k of ['command', 'cmd', 'path', 'file', 'filePath', 'pattern', 'query', 'url']) if (typeof a[k] === 'string') return (a[k] as string).slice(0, 600);
  return JSON.stringify(args).slice(0, 600);
}

/** Paths inside the task folder are shown relative to it. */
function relativeTo(root: string, p: string): string {
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
}

/** Every mention of the workspace folder in a tool's input becomes relative ("app/src/x.ts"). */
function relativeIn(root: string, text: string): string {
  return root ? text.split(`${root}/`).join('').split(root).join('.') : text;
}
