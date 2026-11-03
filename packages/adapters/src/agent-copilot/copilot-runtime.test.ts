import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_SETTINGS, type Settings } from '@tandem/shared';
import { BudgetError, RetryableError, type AgentEvent, type AgentSessionOptions } from '@tandem/core';
import { CopilotRuntime, cheapestModel, toModelOption, type ClientLike, type ModelLike, type SessionEventLike, type SessionLike } from './copilot-runtime.js';
import { copilotRuntimeEnv, enforcement } from './enforce.js';

type Reply = (s: FakeSession, prompt: string, schema?: unknown) => Promise<unknown>;

class FakeSession implements SessionLike {
  private handlers = new Set<(e: SessionEventLike) => void>();
  aborted = false;
  disconnected = false;
  constructor(
    readonly sessionId: string,
    readonly config: Record<string, unknown>,
    private readonly reply: Reply,
  ) {}
  on(h: (e: SessionEventLike) => void) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  emit(e: SessionEventLike) {
    for (const h of this.handlers) h(e);
  }
  sendAndWait(a: unknown, b?: unknown): Promise<never> {
    return (typeof a === 'string' ? this.reply(this, a, b) : this.reply(this, (a as { prompt: string }).prompt)) as Promise<never>;
  }
  async abort() {
    this.aborted = true;
  }
  async disconnect() {
    this.disconnected = true;
  }
}

const models: ModelLike[] = [
  { id: 'auto' },
  { id: 'claude-sonnet-5.5', billing: { tokenPrices: { inputPrice: 200, outputPrice: 1000 } } },
  { id: 'gpt-6-luna', billing: { tokenPrices: { inputPrice: 10, outputPrice: 50 } } },
  { id: 'disabled-cheap', policy: { state: 'disabled' }, billing: { multiplier: 0 } },
];

function fakeClient(reply: Reply, o: { resumable?: Set<string>; auth?: boolean } = {}) {
  const sessions: FakeSession[] = [];
  const envs: Array<Record<string, string>> = [];
  let n = 0;
  const make = (env: Record<string, string>): ClientLike => {
    envs.push(env);
    return {
      start: async () => undefined,
      stop: async () => [],
      getStatus: async () => ({ version: '1.0.105', protocolVersion: 3 }),
      getAuthStatus: async () => (o.auth === false ? { isAuthenticated: false, statusMessage: 'Not authenticated' } : { isAuthenticated: true, authType: 'gh-cli', login: 'me', host: 'https://acme.ghe.com' }),
      listModels: async () => models,
      createSession: async (config) => {
        const s = new FakeSession(`s${++n}`, config, reply);
        sessions.push(s);
        return s;
      },
      resumeSession: async (id, config) => {
        if (!o.resumable?.has(id)) throw new Error(`Session not found: ${id}`);
        const s = new FakeSession(id, config, reply);
        sessions.push(s);
        return s;
      },
    };
  };
  return { make, sessions, envs };
}

const ws = mkdtempSync(join(tmpdir(), 'tandem-copilot-'));
const baseOpts = (o: Partial<AgentSessionOptions> = {}): AgentSessionOptions => ({ workspace: ws, mode: 'build', instructions: 'Be careful.', allowedCommands: ['npm test'], tier: 'build', timeoutMs: 5_000, maxModelCalls: 10, ...o });

function runtime(reply: Reply, o: Parameters<typeof fakeClient>[1] & { settings?: () => Promise<Settings> } = {}) {
  const fc = fakeClient(reply, o);
  const rt = new CopilotRuntime({ settings: o.settings ?? (async () => DEFAULT_SETTINGS), createClient: (env) => fc.make(env), env: { PATH: '/bin', GH_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 's', HOME: '/h' } });
  return { rt, ...fc };
}

const usage = (s: FakeSession, nanoAiu = 100, model = 'gpt-6-luna') => s.emit({ type: 'assistant.usage', data: { model, copilotUsage: { totalNanoAiu: nanoAiu } } });

describe('enforcement', () => {
  it('denies by mode and path in the hook, approves inside the workspace', () => {
    const events: AgentEvent[] = [];
    const ro = enforcement({ mode: 'read-only', root: ws, allowedCommands: [], customTools: new Set(), onEvent: (e) => events.push(e) });
    expect(ro.onPreToolUse({ toolName: 'bash', toolArgs: { command: 'ls' } })).toMatchObject({ permissionDecision: 'deny' });
    expect(ro.onPreToolUse({ toolName: 'view', toolArgs: { path: join(ws, 'a.ts') } })).toBeUndefined();
    expect(ro.onPermissionRequest({ kind: 'write', fileName: join(ws, 'a.ts') })).toMatchObject({ kind: 'reject', feedback: expect.stringContaining('read-only') });
    expect(ro.onPermissionRequest({ kind: 'read', path: '/etc/passwd' })).toMatchObject({ kind: 'reject' });
    expect(ro.onPermissionRequest({ kind: 'url', url: 'https://x' })).toMatchObject({ kind: 'reject', feedback: expect.stringContaining('url requests') });
    expect(events.map((e) => (e.type === 'tool' ? `${e.tool}:${e.allowed}` : e.type))).toEqual(['bash:false', 'view:true']);
    const b = enforcement({ mode: 'build', root: ws, allowedCommands: ['npm test'], customTools: new Set(['tandem_record_test']) });
    expect(b.onPermissionRequest({ kind: 'shell', fullCommandText: 'npm test', possiblePaths: [] })).toEqual({ kind: 'approve-once' });
    expect(b.onPermissionRequest({ kind: 'shell', fullCommandText: 'git push', possiblePaths: [] })).toMatchObject({ kind: 'reject' });
    expect(b.onPermissionRequest({ kind: 'shell', fullCommandText: 'cat x', possiblePaths: ['/etc/shadow'] })).toMatchObject({ kind: 'reject', feedback: expect.stringContaining('/etc/shadow') });
    expect(b.onPermissionRequest({ kind: 'write', fileName: join(ws, '.git', 'HEAD') })).toMatchObject({ kind: 'reject' });
    expect(b.onPermissionRequest({ kind: 'write', fileName: join(ws, 'src', 'a.ts') })).toEqual({ kind: 'approve-once' });
    expect(b.onPermissionRequest({ kind: 'custom-tool', toolName: 'tandem_record_test' })).toEqual({ kind: 'approve-once' });
    expect(b.onPermissionRequest({ kind: 'custom-tool', toolName: 'other' })).toMatchObject({ kind: 'reject' });
  });

  it('builds a runtime environment without tokens, with telemetry off and the Copilot host', () => {
    const env = copilotRuntimeEnv({ PATH: '/bin', GH_TOKEN: 't', GITHUB_TOKEN: 't', COPILOT_GITHUB_TOKEN: 't', AWS_PROFILE: 'p', JIRA_API_TOKEN: 'j', TANDEM_HOME: 'x', DB_PASSWORD: 'p', COPILOT_GH_HOST: 'old' }, 'acme.ghe.com');
    expect(env).toEqual({ PATH: '/bin', COPILOT_GITHUB_TELEMETRY_DISABLED: 'true', COPILOT_AUTO_UPDATE: 'false', COPILOT_GH_HOST: 'acme.ghe.com' });
    expect(copilotRuntimeEnv({ PATH: '/bin' }, undefined).COPILOT_GH_HOST).toBeUndefined();
  });

  it('picks the cheapest enabled model', () => {
    expect(cheapestModel(models)).toBe('gpt-6-luna');
    expect(cheapestModel([{ id: 'a', billing: { multiplier: 1 } }, { id: 'b', billing: { multiplier: 0 } }])).toBe('b');
    expect(cheapestModel([{ id: 'auto' }])).toBeUndefined();
  });
});

describe('CopilotRuntime', () => {
  it('configures sessions with enforcement, streams deltas and accounts usage per turn', async () => {
    const { rt, sessions, envs } = runtime(async (s) => {
      s.emit({ type: 'assistant.message_delta', data: { deltaContent: 'Hel' } });
      s.emit({ type: 'assistant.message_delta', data: { deltaContent: 'lo' } });
      usage(s, 120);
      usage(s, 80);
      return { data: { content: 'Hello' } };
    });
    const events: AgentEvent[] = [];
    const session = await rt.startSession(baseOpts({ onEvent: (e) => events.push(e) }));
    const cfg = sessions[0]!.config;
    expect(cfg).toMatchObject({ clientName: 'tandem', workingDirectory: ws, streaming: true, systemMessage: { content: 'Be careful.' } });
    expect(cfg.model).toBeUndefined(); // build tier: runtime default
    expect(JSON.stringify(cfg.availableTools)).toContain('builtin:bash');
    expect(JSON.stringify(cfg.excludedTools)).toContain('mcp:*');
    expect(envs[0]).toEqual({ PATH: '/bin', HOME: '/h', COPILOT_GITHUB_TELEMETRY_DISABLED: 'true', COPILOT_AUTO_UPDATE: 'false' });
    const t1 = await session.send('hi');
    expect(t1).toEqual({ text: 'Hello', usage: { model: 'gpt-6-luna', modelCalls: 2, nanoAiu: 200 } });
    const t2 = await session.send('again');
    expect(t2.usage.modelCalls).toBe(2);
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('HelloHello');
    await session.stop();
    expect(sessions[0]!.disconnected).toBe(true);
  });

  it('uses the cheapest model for light work and an explicit model when given', async () => {
    const { rt, sessions } = runtime(async () => ({ data: { content: '' } }));
    await rt.startSession(baseOpts({ tier: 'light', mode: 'read-only' }));
    await rt.startSession(baseOpts({ tier: 'light', model: 'claude-sonnet-5.5' }));
    expect(sessions.map((s) => s.config.model)).toEqual(['gpt-6-luna', 'claude-sonnet-5.5']);
    expect(JSON.stringify(sessions[0]!.config.availableTools)).not.toContain('builtin:bash');
  });

  it('resumes a stored session and falls back to a new one', async () => {
    const { rt, sessions } = runtime(async () => ({ data: { content: '' } }), { resumable: new Set(['keep-me']) });
    expect((await rt.startSession(baseOpts({ resumeId: 'keep-me' }))).id).toBe('keep-me');
    expect((await rt.startSession(baseOpts({ resumeId: 'gone' }))).id).toBe('s1');
    expect(sessions).toHaveLength(2);
  });

  it('aborts a run that exceeds its model-call limit', async () => {
    const { rt, sessions } = runtime(async (s) => {
      for (let i = 0; i < 5; i++) usage(s);
      return { data: { content: 'x' } };
    });
    const session = await rt.startSession(baseOpts({ maxModelCalls: 3 }));
    await expect(session.send('loop')).rejects.toThrow(/used 5 model calls in one run \(limit 3\)/);
    expect(sessions[0]!.aborted).toBe(true);
  });

  it('stops a run at its credit limit with a BudgetError that carries what it used', async () => {
    const { rt, sessions } = runtime(async (s) => {
      for (let i = 0; i < 5; i++) usage(s, 400);
      return { data: { content: 'x' } };
    });
    const session = await rt.startSession(baseOpts({ maxNanoAiu: 1000 }));
    const err = await session.send('spend').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetError);
    expect((err as Error).message).toMatch(/credit limit after 5 model calls/);
    expect((err as { usage: unknown }).usage).toEqual({ model: 'gpt-6-luna', modelCalls: 5, nanoAiu: 2000 });
    expect(sessions[0]!.aborted).toBe(true);
  });

  it('lists models with prices in credits per million tokens', async () => {
    const opt = toModelOption(
      { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', billing: { tokenPrices: { inputPrice: 200, outputPrice: 1000, cacheReadPrice: 10, batchSize: 1_000_000 } }, capabilities: { supports: { vision: true }, limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 128_000 } }, supportedReasoningEfforts: ['low', 'max'] },
      'ai_credits',
    );
    expect(opt).toEqual({ id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', vendor: 'Anthropic', price: { input: 200, output: 1000, cachedInput: 10 }, contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: ['low', 'max'] });
    // nano-AIU per 1,000-token batch: 2e5 nano per 1K tokens = 0.2 credits per 1M tokens.
    expect(toModelOption({ id: 'gpt-x', billing: { tokenPrices: { inputPrice: 2e5, outputPrice: 1e6, batchSize: 1000 } } }, 'nano_aiu').price).toEqual({ input: 0.2, output: 1 });
    expect(toModelOption({ id: 'old', billing: { multiplier: 0.33 } }, undefined)).toMatchObject({ multiplier: 0.33, vendor: 'Other' });
    expect(toModelOption({ id: 'auto', billing: { discountPercent: 10 } }, undefined)).toMatchObject({ vendor: 'Copilot', discountPercent: 10 });

    const { rt } = runtime(async () => ({ data: { content: '' } }));
    const list = await rt.models();
    expect(list.map((m) => m.id)).toEqual(['auto', 'claude-sonnet-5.5', 'gpt-6-luna']);
    expect(list.find((m) => m.id === 'gpt-6-luna')!.price).toEqual({ input: 10, output: 50 });
    expect(await rt.defaultModel('light')).toBe('gpt-6-luna');
    expect(await rt.defaultModel('build')).toBeUndefined();
  });

  it('times out and aborts a stuck turn', async () => {
    const { rt, sessions } = runtime(() => new Promise(() => undefined));
    const session = await rt.startSession(baseOpts({ timeoutMs: 30 }));
    await expect(session.send('stuck')).rejects.toThrow(/did not finish within/);
    expect(sessions[0]!.aborted).toBe(true);
  });

  it('classifies errors: transient ones are retryable, policy ones explain the fix', async () => {
    let fail = 'rate limit exceeded (429)';
    const { rt } = runtime(async () => {
      throw new Error(fail);
    });
    const session = await rt.startSession(baseOpts());
    await expect(session.send('a')).rejects.toBeInstanceOf(RetryableError);
    fail = 'HTTP 403 unauthorized: not authorized to use this Copilot feature';
    await expect(session.send('b')).rejects.toThrow(/Check the Copilot host in Settings/);
    fail = 'something odd';
    await expect(session.send('c')).rejects.toThrow('something odd');
    // Seen live: a 400 whose request ID contains "520" is not a server error.
    fail = "Execution failed: 400 Invalid schema for response_format 'response'. (Request ID: d0693b40-24ea-9b75-965b-2d8a4ef11520)";
    const bad = await session.send('d').catch((e: unknown) => e);
    expect(bad).not.toBeInstanceOf(RetryableError);
    fail = 'upstream returned 503 Service Unavailable';
    await expect(session.send('e')).rejects.toBeInstanceOf(RetryableError);
  });

  it('sends structured output as a strict schema and maps nulls back to absent fields', async () => {
    const Review = z.object({ findings: z.array(z.object({ title: z.string(), repo: z.string().optional(), line: z.number().int().positive().optional() })), notes: z.array(z.string()).default([]) });
    let sent: { toJSONSchema(): unknown } | undefined;
    // Like the SDK: JSON from the model goes through the schema's parse().
    const { rt } = runtime(async (_s, _p, schema) => {
      sent = schema as { toJSONSchema(): unknown };
      return (schema as { parse(v: unknown): unknown }).parse({ findings: [{ title: 'x', repo: null, line: null }], notes: null });
    });
    const session = await rt.startSession(baseOpts());
    expect((await session.sendStructured('review', Review)).value).toEqual({ findings: [{ title: 'x' }], notes: [] });
    const json = sent!.toJSONSchema() as { required: string[]; additionalProperties: boolean; properties: { findings: { items: { required: string[]; additionalProperties: boolean; properties: Record<string, { type: unknown }> } } } };
    expect(json.required).toEqual(['findings', 'notes']);
    expect(json.additionalProperties).toBe(false);
    const item = json.properties.findings.items;
    expect(item.required).toEqual(['title', 'repo', 'line']);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.repo!.type).toEqual(['string', 'null']);
    expect(item.properties.line!.type).toEqual(['integer', 'null']);
    expect(JSON.stringify(json)).not.toContain('"default"');
  });

  it('validates structured output and custom tool arguments', async () => {
    const { rt, sessions } = runtime(async (_s, _p, schema) => (schema ? { answer: 42 } : { data: { content: '' } }));
    const recorded: unknown[] = [];
    const session = await rt.startSession(
      baseOpts({
        tools: [{ name: 'tandem_record_test', description: 'd', schema: z.object({ criterion: z.number() }), handler: (a: { criterion: number }) => (recorded.push(a), 'ok') }] as never,
      }),
    );
    expect((await session.sendStructured('q', z.object({ answer: z.number() }))).value).toEqual({ answer: 42 });
    const tool = (sessions[0]!.config.tools as Array<{ name: string; skipPermission?: boolean; handler: (a: unknown, inv: unknown) => Promise<string> }>)[0]!;
    expect(tool).toMatchObject({ name: 'tandem_record_test', skipPermission: true });
    expect(await tool.handler({ criterion: 'one' }, {})).toMatch(/^Invalid arguments: criterion/);
    expect(await tool.handler({ criterion: 1 }, {})).toBe('ok');
    expect(recorded).toEqual([{ criterion: 1 }]);
    expect(JSON.stringify(sessions[0]!.config.availableTools)).toContain('custom:*');
  });

  it('restarts the runtime when the Copilot host changes, and reports sign-in for doctor', async () => {
    let s: Settings = DEFAULT_SETTINGS;
    const { rt, envs } = runtime(async () => ({ data: { content: '' } }), { settings: async () => s });
    expect(await rt.check()).toMatchObject({ version: '1.0.105', authenticated: true, login: 'me', authType: 'gh-cli' });
    s = { ...DEFAULT_SETTINGS, copilot: { ...DEFAULT_SETTINGS.copilot, host: 'acme.ghe.com' } };
    await rt.startSession(baseOpts());
    expect(envs.map((e) => e.COPILOT_GH_HOST)).toEqual([undefined, 'acme.ghe.com']);
    const signedOut = runtime(async () => ({}), { auth: false });
    expect(await signedOut.rt.check()).toEqual({ version: '1.0.105', authenticated: false, error: 'Not authenticated' });
  });

  it('replays a recorded live event stream (SDK 1.0.28) with the right usage totals', async () => {
    const fixture = join(import.meta.dirname, '..', '..', '..', '..', 'spikes', 'reports', 'fixtures', 'copilot-events-1.0.28.json');
    expect(existsSync(fixture)).toBe(true);
    const streams = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, SessionEventLike[]>;
    const build = streams['build-edit-test']!;
    const usageEvents = build.filter((e) => e.type === 'assistant.usage');
    const final = build.filter((e) => e.type === 'assistant.message').at(-1)!;
    const { rt } = runtime(async (s) => {
      for (const e of build) s.emit(e);
      return final;
    });
    const session = await rt.startSession(baseOpts());
    const turn = await session.send('replay');
    expect(usageEvents.length).toBeGreaterThan(0);
    expect(turn.usage.modelCalls).toBe(usageEvents.length);
    expect(turn.usage.model).toBe('gpt-6-luna');
    expect(turn.usage.nanoAiu).toBe(usageEvents.reduce((n, e) => n + ((e.data.copilotUsage as { totalNanoAiu?: number })?.totalNanoAiu ?? 0), 0));
    expect(turn.text).toContain('Tandem');
  });
});
