import { checkShell, checkToolCall, isInside, touchesGitInternals, type AgentEvent, type AgentMode } from '@tandem/core';

/** Shapes from @github/copilot-sdk 1.0.28 that the enforcement reads (kept structural for tests). */
export type PermissionRequestLike =
  | { kind: 'read'; path: string }
  | { kind: 'write'; fileName: string }
  | { kind: 'shell'; fullCommandText: string; possiblePaths?: string[] }
  | { kind: 'custom-tool'; toolName: string }
  | { kind: string; [k: string]: unknown };

export type PermissionResultLike = { kind: 'approve-once' } | { kind: 'reject'; feedback?: string };

export interface EnforcementOptions {
  mode: AgentMode;
  root: string;
  allowedCommands: readonly string[];
  customTools: ReadonlySet<string>;
  onEvent?: (e: AgentEvent) => void;
}

/**
 * Two layers, both in code: the pre-tool hook runs before every tool call (including calls the
 * runtime would auto-approve) and the permission handler answers whatever the runtime asks.
 * Both fail closed. Verified live in spike a (15/15 forbidden actions denied, 0 model calls).
 */
export function enforcement(o: EnforcementOptions) {
  const shell = { configured: o.allowedCommands, root: o.root };
  // Absolute paths the owner's own repo commands use (CHROME_BIN=/path/to/chrome): not "outside" for them.
  const ownerPaths = new Set(o.allowedCommands.flatMap((c) => c.split(/\s+/).map((t) => t.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '')).filter((t) => t.startsWith('/'))));
  const tell = (tool: string, summary: string, allowed: boolean, reason: string) => o.onEvent?.({ type: 'tool', tool, summary, allowed, ...(allowed ? {} : { reason }) });

  const onPreToolUse = (input: { toolName: string; toolArgs: unknown }) => {
    const r = checkToolCall(o.mode, o.root, input.toolName, input.toolArgs, shell, o.customTools);
    tell(input.toolName, r.summary, r.allowed, r.reason);
    // Allowed calls return nothing, so the permission handler still runs as the second layer.
    return r.allowed ? undefined : { permissionDecision: 'deny' as const, permissionDecisionReason: `Blocked by Tandem: ${r.reason}` };
  };

  const onPermissionRequest = (req: PermissionRequestLike): PermissionResultLike => {
    const deny = (reason: string): PermissionResultLike => ({ kind: 'reject', feedback: `Blocked by Tandem: ${reason}` });
    switch (req.kind) {
      case 'read': {
        const p = String((req as { path: string }).path);
        return isInside(o.root, p) ? { kind: 'approve-once' } : deny(`${p} is outside the workspace`);
      }
      case 'write': {
        const f = String((req as { fileName: string }).fileName);
        if (o.mode !== 'build') return deny('this session is read-only');
        if (!isInside(o.root, f)) return deny(`${f} is outside the workspace`);
        if (touchesGitInternals(o.root, f)) return deny('writing inside .git is not allowed');
        return { kind: 'approve-once' };
      }
      case 'shell': {
        const r = req as { fullCommandText: string; possiblePaths?: string[] };
        if (o.mode !== 'build') return deny('this session is read-only');
        const outside = (r.possiblePaths ?? []).find((p) => !isInside(o.root, p) && !ownerPaths.has(p));
        if (outside) return deny(`the command touches ${outside}, outside the workspace`);
        const v = checkShell(r.fullCommandText, shell);
        return v.allowed ? { kind: 'approve-once' } : deny(v.reason);
      }
      case 'custom-tool':
        return o.customTools.has(String((req as { toolName: string }).toolName)) ? { kind: 'approve-once' } : deny('unknown tool');
      default:
        return deny(`${req.kind} requests are not allowed in Tandem sessions`);
    }
  };

  return { onPreToolUse, onPermissionRequest };
}

const STRIPPED = /^(GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|AWS_.*|JIRA_.*|TANDEM_.*|.*_SECRET.*|.*_PASSWORD.*)$/;

/** Environment for the Copilot runtime: no tokens or cloud credentials, telemetry off, fixed version. */
export function copilotRuntimeEnv(base: NodeJS.ProcessEnv, host: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !STRIPPED.test(k) && k !== 'COPILOT_GH_HOST') env[k] = v;
  env.COPILOT_GITHUB_TELEMETRY_DISABLED = 'true';
  env.COPILOT_AUTO_UPDATE = 'false';
  if (host) env.COPILOT_GH_HOST = host;
  return env;
}
