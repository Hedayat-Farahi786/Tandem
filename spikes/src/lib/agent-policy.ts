/**
 * Prototype of the agent safety policy (packages/core/src/policies/{paths,commands}.ts and
 * packages/adapters/src/agent-copilot/enforce.ts). Fails closed: anything not understood is denied.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path';

export type Mode = 'read-only' | 'build';

export interface Decision {
  at: string;
  layer: 'hook' | 'permission';
  tool: string;
  summary: string;
  allowed: boolean;
  reason: string;
}

/* ------------------------------------------------------------------ paths */

function canonical(p: string): string {
  // Resolve symlinks of the longest existing prefix so a link can't point outside the root.
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(cur.slice(parent.length).replace(/^[\\/]/, ''));
      cur = parent;
    }
  }
}

export function isInside(root: string, target: string): boolean {
  const r = canonical(root);
  const t = canonical(isAbsolute(target) ? target : resolve(root, target));
  const rel = relative(process.platform === 'win32' ? r.toLowerCase() : r, process.platform === 'win32' ? t.toLowerCase() : t);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function touchesGitInternals(root: string, target: string): boolean {
  const t = isAbsolute(target) ? target : resolve(root, target);
  return t.split(/[\\/]/).includes('.git');
}

/* ------------------------------------------------------------------ shell */

export interface ShellPolicy {
  /** Owner-configured command lines, matched as a prefix of the segment (e.g. "npm test", "npm run lint"). */
  configured: string[];
}

const READ_HELPERS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'sort', 'uniq', 'diff', 'rg', 'grep', 'find', 'true', 'test', 'dir', 'type']);
const DENY_COMMANDS = new Set([
  'aws', 'az', 'gcloud', 'gsutil', 'kubectl', 'helm', 'terraform', 'pulumi', 'cdk', 'serverless', 'sls', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku',
  'ssh', 'scp', 'sftp', 'rsync', 'curl', 'wget', 'nc', 'ncat', 'telnet', 'sudo', 'su', 'doas', 'chmod', 'chown', 'rm', 'rmdir', 'dd', 'mkfs',
  'eval', 'exec', 'source', '.', 'sh', 'bash', 'zsh', 'pwsh', 'powershell', 'cmd', 'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby',
  'docker', 'podman', 'gh', 'flyway', 'liquibase', 'alembic', 'psql', 'mysql', 'mongo', 'mongosh', 'redis-cli', 'sqlcmd',
]);
const GIT_ALLOWED = new Set(['status', 'diff', 'log', 'show', 'add', 'restore', 'rm', 'mv', 'grep', 'ls-files', 'rev-parse', 'blame', 'stash', 'branch', 'checkout']);
const SAFE_ENV_PREFIX = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR)=[\w.-]*$/;

/** Tokenizes one command line into segments of argv, refusing constructs it can't reason about. */
export function parseShell(command: string): { segments: string[][] } | { error: string } {
  if (/`|\$\(|<\(|>\(|<<|\$\{/.test(command)) return { error: 'command substitution, process substitution and heredocs are not allowed' };
  // The only redirections accepted: merging stderr and discarding output.
  command = command.replace(/\s*\d?>\s*(\/dev\/null|NUL)\b/gi, ' ').replace(/\s*2>&1/g, ' ');
  const segments: string[][] = [];
  let cur: string[] = [];
  let tok = '';
  let quote: '"' | "'" | null = null;
  let hasTok = false;
  const pushTok = () => {
    if (hasTok) cur.push(tok);
    tok = '';
    hasTok = false;
  };
  const pushSeg = () => {
    pushTok();
    if (cur.length) segments.push(cur);
    cur = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) tok += command[++i];
      else tok += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasTok = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      tok += command[++i];
      hasTok = true;
      continue;
    }
    if (/\s/.test(ch) && ch !== '\n') {
      pushTok();
      continue;
    }
    if (ch === '\n' || ch === ';') {
      pushSeg();
      continue;
    }
    if (ch === '&' || ch === '|') {
      if (command[i + 1] === ch) i++;
      pushSeg();
      continue;
    }
    if (ch === '>' || ch === '<') return { error: 'redirection is not allowed (only 2>&1 and /dev/null); write files with the edit tools' };
    tok += ch;
    hasTok = true;
  }
  if (quote) return { error: 'unbalanced quotes' };
  pushSeg();
  return { segments };
}

export function checkShell(command: string, policy: ShellPolicy): { allowed: boolean; reason: string } {
  const parsed = parseShell(command);
  if ('error' in parsed) return { allowed: false, reason: parsed.error };
  if (parsed.segments.length === 0) return { allowed: false, reason: 'empty command' };
  for (const raw of parsed.segments) {
    const seg = [...raw];
    while (seg.length && SAFE_ENV_PREFIX.test(seg[0]!)) seg.shift();
    if (seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[0]!)) return { allowed: false, reason: `setting ${seg[0]!.split('=')[0]} is not allowed` };
    const [cmd, ...args] = seg;
    if (!cmd) continue;
    const base = cmd.replace(/\.(exe|cmd|bat)$/i, '');
    const line = seg.join(' ');
    if (base.includes('/') || base.includes('\\')) return { allowed: false, reason: `run commands by name, not by path (${cmd})` };
    if (DENY_COMMANDS.has(base)) return { allowed: false, reason: `"${base}" is not allowed in Tandem build sessions` };
    if (base === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (args[0]?.startsWith('-')) return { allowed: false, reason: 'git options before the subcommand (like -c or -C) are not allowed' };
      if (!sub || !GIT_ALLOWED.has(sub)) return { allowed: false, reason: `git ${sub ?? ''} is not allowed; Tandem commits, rebases and pushes for you` };
      if (args.some((a) => a === '--force' || a === '-f' || a === '--hard' || a.startsWith('--force'))) return { allowed: false, reason: 'forced git operations are not allowed' };
      if (sub === 'branch' && args.some((a) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)/.test(a))) return { allowed: false, reason: 'changing branches is not allowed' };
      if (sub === 'checkout' && !args.includes('--')) return { allowed: false, reason: 'git checkout is only allowed for paths (git checkout -- <path>)' };
      continue;
    }
    if (policy.configured.some((c) => line === c || line.startsWith(`${c} `))) continue;
    if (/^(npm|pnpm|yarn)$/.test(base) && /^(install|i|ci|add)$/.test(args[0] ?? '') && !args.some((a) => /^(-g|--global|--prefix)/.test(a))) continue;
    if (base === 'npx' && /^(vitest|tsc|eslint|jest|prettier)$/.test(args[0] ?? '')) continue;
    if (READ_HELPERS.has(base)) {
      if (base === 'find' && args.some((a) => /^-(exec|execdir|delete|ok|fprint)/.test(a))) return { allowed: false, reason: 'find with -exec/-delete is not allowed' };
      continue;
    }
    return { allowed: false, reason: `"${line}" is not on the allowlist (configured repo commands, package installs, read-only helpers, safe git)` };
  }
  return { allowed: true, reason: 'allowlisted' };
}

/* ------------------------------------------------------------- tool calls */

const READ_TOOLS = new Set(['view', 'glob', 'grep']);
const BUILD_TOOLS = new Set([...READ_TOOLS, 'create', 'edit', 'apply_patch', 'bash', 'powershell', 'read_bash', 'stop_bash', 'list_bash', 'write_bash', 'read_powershell', 'stop_powershell', 'list_powershell', 'write_powershell']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);

export function allowedBuiltins(mode: Mode): string[] {
  return [...(mode === 'read-only' ? READ_TOOLS : BUILD_TOOLS)];
}

export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1]!.trim());
  for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push(m[1]!.trim());
  return out;
}

export function checkToolCall(mode: Mode, root: string, toolName: string, args: unknown, shell: ShellPolicy, customTools: Set<string>): { allowed: boolean; reason: string; summary: string } {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (customTools.has(toolName)) return { allowed: true, reason: 'Tandem tool', summary: toolName };
  const allowed = mode === 'read-only' ? READ_TOOLS : BUILD_TOOLS;
  if (!allowed.has(toolName)) return { allowed: false, reason: `${toolName} is not available in ${mode} sessions`, summary: toolName };
  const path = typeof a.path === 'string' ? a.path : undefined;
  if (path !== undefined) {
    if (!isInside(root, path)) return { allowed: false, reason: `${path} is outside the workspace`, summary: `${toolName} ${path}` };
    if ((toolName === 'create' || toolName === 'edit') && touchesGitInternals(root, path)) return { allowed: false, reason: 'writing inside .git is not allowed', summary: `${toolName} ${path}` };
  }
  if (toolName === 'apply_patch') {
    const patch = typeof args === 'string' ? args : typeof a.input === 'string' ? a.input : '';
    const paths = patchPaths(patch);
    if (paths.length === 0) return { allowed: false, reason: 'could not read the files this patch changes', summary: 'apply_patch' };
    const bad = paths.find((p) => !isInside(root, p) || touchesGitInternals(root, p));
    if (bad) return { allowed: false, reason: `${bad} is outside the workspace`, summary: `apply_patch ${paths.join(', ')}` };
    return { allowed: true, reason: 'inside workspace', summary: `apply_patch ${paths.join(', ')}` };
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = typeof a.command === 'string' ? a.command : '';
    const r = checkShell(command, shell);
    return { ...r, summary: `${toolName}: ${command}` };
  }
  return { allowed: true, reason: 'allowed', summary: `${toolName}${path ? ` ${path}` : ''}` };
}

/** Normalizes a path for display relative to the workspace. */
export function rel(root: string, p: string): string {
  const r = relative(root, isAbsolute(p) ? p : resolve(root, p));
  return r.split(sep).join('/') || '.';
}
