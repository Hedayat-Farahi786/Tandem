/**
 * Prototype of packages/adapters/src/agent-copilot: client creation with the existing
 * Copilot CLI login, session config with enforcement, and a turn runner that collects
 * streaming events.
 */
import { CopilotClient, RuntimeConnection, ToolSet, type CopilotSession, type PermissionRequest, type PermissionRequestResult } from '@github/copilot-sdk';
import { allowedBuiltins, checkShell, checkToolCall, isInside, touchesGitInternals, type Decision, type Mode, type ShellPolicy } from './agent-policy.js';

const STRIPPED_ENV = /^(GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|AWS_.*|JIRA_.*|TANDEM_SPIKE_.*)$/;

/** Environment for the Copilot runtime: no tokens from the parent, telemetry off. */
export function runtimeEnv(): { env: Record<string, string>; stripped: string[] } {
  const env: Record<string, string> = {};
  const stripped: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (STRIPPED_ENV.test(k)) stripped.push(k);
    else env[k] = v;
  }
  env.COPILOT_GITHUB_TELEMETRY_DISABLED = 'true';
  env.COPILOT_AUTO_UPDATE = 'false';
  return { env, stripped };
}

export function makeClient(cliPath?: string): CopilotClient {
  const { env } = runtimeEnv();
  return new CopilotClient({
    logLevel: 'error',
    useLoggedInUser: true,
    ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath, env }) } : { env }),
  });
}

export interface EnforcedSessionOptions {
  mode: Mode;
  root: string;
  decisions: Decision[];
  shell?: ShellPolicy;
  instructions?: string;
  model?: string;
  sessionId?: string;
}

export function enforcedConfig(o: EnforcedSessionOptions) {
  const shell = o.shell ?? { configured: [] };
  const custom = new Set<string>();
  const log = (d: Omit<Decision, 'at'>) => o.decisions.push({ at: new Date().toISOString(), ...d });

  const onPermissionRequest = (req: PermissionRequest): PermissionRequestResult => {
    const deny = (tool: string, summary: string, reason: string): PermissionRequestResult => {
      log({ layer: 'permission', tool, summary, allowed: false, reason });
      return { kind: 'reject', feedback: `Blocked by Tandem: ${reason}` };
    };
    const allow = (tool: string, summary: string): PermissionRequestResult => {
      log({ layer: 'permission', tool, summary, allowed: true, reason: 'policy' });
      return { kind: 'approve-once' };
    };
    switch (req.kind) {
      case 'read':
        return isInside(o.root, req.path) ? allow('read', req.path) : deny('read', req.path, `${req.path} is outside the workspace`);
      case 'write':
        if (o.mode !== 'build') return deny('write', req.fileName, 'this session is read-only');
        if (!isInside(o.root, req.fileName)) return deny('write', req.fileName, `${req.fileName} is outside the workspace`);
        if (touchesGitInternals(o.root, req.fileName)) return deny('write', req.fileName, 'writing inside .git is not allowed');
        return allow('write', req.fileName);
      case 'shell': {
        if (o.mode !== 'build') return deny('shell', req.fullCommandText, 'this session is read-only');
        const r = checkShell(req.fullCommandText, shell);
        const outside = req.possiblePaths.find((p) => !isInside(o.root, p));
        if (outside) return deny('shell', req.fullCommandText, `the command touches ${outside}, outside the workspace`);
        return r.allowed ? allow('shell', req.fullCommandText) : deny('shell', req.fullCommandText, r.reason);
      }
      case 'custom-tool':
        return custom.has(req.toolName) ? allow('custom-tool', req.toolName) : deny('custom-tool', req.toolName, 'unknown tool');
      default:
        return deny(req.kind, req.kind, `${req.kind} requests are not allowed in Tandem sessions`);
    }
  };

  const onPreToolUse = (input: { toolName: string; toolArgs: unknown }) => {
    const r = checkToolCall(o.mode, o.root, input.toolName, input.toolArgs, shell, custom);
    log({ layer: 'hook', tool: input.toolName, summary: r.summary, allowed: r.allowed, reason: r.reason });
    // Allowed calls return nothing so the permission handler still runs as a second layer.
    return r.allowed ? undefined : { permissionDecision: 'deny' as const, permissionDecisionReason: `Blocked by Tandem: ${r.reason}` };
  };

  return {
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.model ? { model: o.model } : {}),
    clientName: 'tandem',
    workingDirectory: o.root,
    streaming: true,
    availableTools: new ToolSet().addBuiltIn(allowedBuiltins(o.mode)),
    excludedTools: new ToolSet().addMcp('*'),
    systemMessage: {
      content: [
        o.mode === 'read-only'
          ? 'You are in a read-only session. You can read and search files in the workspace. You cannot change files or run commands.'
          : 'You are in a build session. Edit files only inside the workspace. Tandem commits, rebases and pushes; do not try to. Only allowlisted commands run.',
        o.instructions ?? '',
      ].join('\n\n'),
    },
    onPermissionRequest,
    hooks: { onPreToolUse },
  };
}

export interface TurnResult {
  text: string;
  deltas: number;
  firstDeltaMs?: number;
  totalMs: number;
  tools: Array<{ name: string; args: string; ok?: boolean }>;
  errors: string[];
}

/** Sends one prompt and collects streaming events until the turn completes. */
export async function runTurn(session: CopilotSession, prompt: string, timeoutMs: number): Promise<TurnResult> {
  const started = performance.now();
  const result: TurnResult = { text: '', deltas: 0, totalMs: 0, tools: [], errors: [] };
  const byId = new Map<string, number>();
  const off = session.on((event) => {
    switch (event.type) {
      case 'assistant.message_delta':
        if (result.deltas === 0) result.firstDeltaMs = Math.round(performance.now() - started);
        result.deltas++;
        break;
      case 'tool.execution_start':
        byId.set(event.data.toolCallId, result.tools.length);
        result.tools.push({ name: event.data.toolName, args: JSON.stringify(event.data.arguments ?? {}).slice(0, 200) });
        break;
      case 'tool.execution_complete': {
        const idx = byId.get(event.data.toolCallId);
        if (idx !== undefined && result.tools[idx]) result.tools[idx].ok = !event.data.error;
        break;
      }
      case 'session.error':
        result.errors.push(JSON.stringify(event.data).slice(0, 500));
        break;
      default:
        break;
    }
  });
  try {
    const final = await session.sendAndWait({ prompt }, timeoutMs);
    result.text = final?.data.content ?? '';
  } finally {
    off();
    result.totalMs = Math.round(performance.now() - started);
  }
  return result;
}
