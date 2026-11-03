import { CopilotClient, RuntimeConnection, ToolSet, defineTool } from '@github/copilot-sdk';
import { dirname, join } from 'node:path';
import type { ZodType } from 'zod';
import { RetryableError, allowedBuiltins, type AgentEvent, type AgentRuntime, type AgentSession, type AgentSessionOptions, type AgentUsage, type Logger } from '@tandem/core';
import type { Settings } from '@tandem/shared';
import { copilotRuntimeEnv, enforcement } from './enforce.js';

/* Structural views of the SDK objects Tandem uses (lets tests drive the adapter with a fake). */
export interface SessionEventLike {
  type: string;
  data: Record<string, unknown>;
}
export interface SessionLike {
  readonly sessionId: string;
  on(handler: (e: SessionEventLike) => void): () => void;
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<{ data: { content?: string } } | undefined>;
  sendAndWait(prompt: string, schema: ZodType<unknown>, timeout?: number): Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  rpc?: { tools?: { execute(params: { name: string; arguments: unknown }): Promise<{ resultType?: string; textResultForLlm?: string }> } };
}
export interface ModelLike {
  id: string;
  policy?: { state: string };
  billing?: { multiplier?: number; tokenPrices?: { inputPrice?: number; outputPrice?: number } };
}
export interface ClientLike {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  getStatus(): Promise<{ version: string; protocolVersion: number }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; authType?: string; host?: string; login?: string; statusMessage?: string }>;
  listModels(): Promise<ModelLike[]>;
  createSession(config: Record<string, unknown>): Promise<SessionLike>;
  resumeSession(id: string, config: Record<string, unknown>): Promise<SessionLike>;
}

export interface CopilotRuntimeOptions {
  settings: () => Promise<Settings>;
  logger?: Logger;
  /** Test seam: build a client for the given env and CLI path. */
  createClient?: (env: Record<string, string>, cliPath: string | undefined) => ClientLike;
  env?: NodeJS.ProcessEnv;
}

const RETRYABLE = /(rate.?limit|429|too many requests|timed? ?out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|5\d\d|overloaded|temporarily unavailable|stream (closed|ended))/i;

/** Cheapest enabled model: by request multiplier (legacy billing) or token prices (AI credits). */
export function cheapestModel(models: readonly ModelLike[]): string | undefined {
  const enabled = models.filter((m) => m.policy?.state !== 'disabled' && m.id !== 'auto');
  const score = (m: ModelLike) => m.billing?.multiplier ?? (m.billing?.tokenPrices ? (m.billing.tokenPrices.inputPrice ?? 0) + 4 * (m.billing.tokenPrices.outputPrice ?? 0) : Number.POSITIVE_INFINITY);
  return [...enabled].sort((a, b) => score(a) - score(b))[0]?.id;
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
  private models: { at: number; list: ModelLike[] } | undefined;

  constructor(private readonly o: CopilotRuntimeOptions) {}

  private async ensureClient(): Promise<ClientLike> {
    const s = await this.o.settings();
    const key = `${s.copilot.host}|${s.copilot.cliPath}`;
    if (this.client && this.clientKey === key) return this.client;
    if (this.starting && this.clientKey === key) return this.starting;
    if (this.client) await this.client.stop().catch(() => undefined);
    this.client = undefined;
    this.clientKey = key;
    this.models = undefined;
    const env = copilotRuntimeEnv(this.o.env ?? process.env, s.copilot.host || undefined);
    const cliPath = s.copilot.cliPath || undefined;
    this.starting = (async () => {
      const c: ClientLike = this.o.createClient
        ? this.o.createClient(env, cliPath)
        : (new CopilotClient({ logLevel: 'error', useLoggedInUser: true, ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath, env }) } : { env }) }) as unknown as ClientLike);
      await c.start();
      this.client = c;
      return c;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /** For doctor: runtime version, sign-in and model access (no model call). */
  async check(): Promise<{ version?: string; authenticated: boolean; login?: string; host?: string; authType?: string; models?: ModelLike[]; error?: string }> {
    try {
      const c = await this.ensureClient();
      const status = await c.getStatus();
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
    if (this.models && Date.now() - this.models.at < 10 * 60_000) return this.models.list;
    const list = await (await this.ensureClient()).listModels();
    this.models = { at: Date.now(), list };
    return list;
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
      }
      if (e.type === 'session.error') emit({ type: 'error', message: String(e.data.message ?? JSON.stringify(e.data)).slice(0, 500) });
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
      try {
        const value = await Promise.race([run(), timeout]);
        if (overBudget) throw new Error(`The agent used ${modelCalls} model calls in one run (limit ${opts.maxModelCalls}), so Tandem stopped it. Raise "model calls per run" in Settings if this task needs more.`);
        return { value, usage: { model: lastModel, modelCalls: modelCalls - before.modelCalls, nanoAiu: nanoAiu - before.nanoAiu } };
      } catch (err) {
        throw classify(err);
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
        const r = await turn(() => s.sendAndWait(prompt, schema as ZodType<unknown>, opts.timeoutMs + 5_000) as Promise<T>);
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
      const session = await client.createSession({ clientName: 'tandem-selftest', workingDirectory: workspace, availableTools: new ToolSet().addBuiltIn(allowedBuiltins(mode)), excludedTools: new ToolSet().addMcp('*'), onPermissionRequest, hooks: { onPreToolUse } });
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
  if (err instanceof RetryableError) return err;
  const msg = String((err as Error)?.message ?? err);
  if (/did not finish within|model calls in one run/.test(msg)) return err as Error;
  if (RETRYABLE.test(msg)) return new RetryableError(`Copilot: ${msg.slice(0, 300)}`);
  if (/403|not authorized|unauthorized|policy/i.test(msg)) return new Error(`Copilot refused the request (${msg.slice(0, 200)}). Check the Copilot host in Settings and that your organization allows Copilot CLI.`);
  return err instanceof Error ? err : new Error(msg);
}
