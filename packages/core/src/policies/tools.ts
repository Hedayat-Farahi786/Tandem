import type { AgentMode } from '../ports.js';
import { checkShell, type ShellPolicy, type Verdict } from './commands.js';
import { isInside, touchesGitInternals } from './paths.js';

// Search tool names vary by model (gpt models get `rg`, others `grep`).
const READ_TOOLS = ['view', 'glob', 'grep', 'rg'] as const;
const WRITE_TOOLS = ['create', 'edit', 'apply_patch'] as const;
const SHELL_TOOLS = ['bash', 'powershell'] as const;
const SHELL_COMPANIONS = ['read_bash', 'stop_bash', 'list_bash', 'write_bash', 'read_powershell', 'stop_powershell', 'list_powershell', 'write_powershell'] as const;

export function allowedBuiltins(mode: AgentMode): string[] {
  return mode === 'read-only' ? [...READ_TOOLS] : [...READ_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS, ...SHELL_COMPANIONS];
}

/** File paths changed by an apply_patch payload. */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1]!.trim());
  for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push(m[1]!.trim());
  return out;
}

export interface ToolCheck extends Verdict {
  summary: string;
}

/** Checks one tool call before it runs. Used by the runtime hook (first layer). */
export function checkToolCall(mode: AgentMode, root: string, toolName: string, args: unknown, shell: ShellPolicy, customTools: ReadonlySet<string>): ToolCheck {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (customTools.has(toolName)) return { allowed: true, reason: 'Tandem tool', summary: toolName };
  if (!allowedBuiltins(mode).includes(toolName)) return { allowed: false, reason: `${toolName} is not available in ${mode} sessions`, summary: toolName };
  const path = typeof a.path === 'string' ? a.path : undefined;
  if (path !== undefined) {
    if (!isInside(root, path)) return { allowed: false, reason: `${path} is outside the workspace`, summary: `${toolName} ${path}` };
    if ((WRITE_TOOLS as readonly string[]).includes(toolName) && touchesGitInternals(root, path)) return { allowed: false, reason: 'writing inside .git is not allowed', summary: `${toolName} ${path}` };
  }
  if (toolName === 'apply_patch') {
    const patch = typeof args === 'string' ? args : typeof a.input === 'string' ? a.input : typeof a.patch === 'string' ? a.patch : '';
    const paths = patchPaths(patch);
    if (paths.length === 0) return { allowed: false, reason: 'could not read which files this patch changes', summary: 'apply_patch' };
    const bad = paths.find((p) => !isInside(root, p) || touchesGitInternals(root, p));
    if (bad) return { allowed: false, reason: `${bad} is outside the workspace or inside .git`, summary: `apply_patch ${paths.join(', ')}` };
    return { allowed: true, reason: 'inside the workspace', summary: `apply_patch ${paths.join(', ')}` };
  }
  if ((SHELL_TOOLS as readonly string[]).includes(toolName)) {
    const command = typeof a.command === 'string' ? a.command : '';
    return { ...checkShell(command, { root, ...shell }), summary: `${toolName}: ${command}` };
  }
  return { allowed: true, reason: 'allowed', summary: `${toolName}${path ? ` ${path}` : ''}` };
}
