import { isInside } from './paths.js';

/**
 * Shell command policy for build sessions. Fails closed: a command line is allowed only when every
 * segment is understood and matches the allowlist, and the denylist always wins.
 */

export interface ShellPolicy {
  /** Owner-configured command lines (repo commands), matched as a prefix of a segment. */
  configured: readonly string[];
  /**
   * The workspace folder. When set, commands may work in a folder inside it: `cd <repo> && …`,
   * `git -C <repo> …`, `npm --prefix <repo> …`. Never outside it, never with `..`.
   */
  root?: string;
}

export interface Verdict {
  allowed: boolean;
  reason: string;
}

const READ_HELPERS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'sort', 'uniq', 'diff', 'rg', 'grep', 'find', 'true', 'test', 'dir', 'type', 'tree', 'stat', 'file']);

export const DENIED_COMMANDS: ReadonlySet<string> = new Set([
  // cloud and deploy
  'aws', 'az', 'gcloud', 'gsutil', 'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'cdk', 'serverless', 'sls', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'firebase', 'eb', 'sam', 'copilot',
  // network and remote access
  'ssh', 'scp', 'sftp', 'rsync', 'curl', 'wget', 'nc', 'ncat', 'telnet', 'ftp',
  // privilege and destructive
  'sudo', 'su', 'doas', 'chmod', 'chown', 'rm', 'rmdir', 'dd', 'mkfs', 'shred', 'kill', 'pkill', 'killall',
  // interpreters and shells (could run anything)
  'eval', 'exec', 'source', '.', 'sh', 'bash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'osascript', 'env', 'xargs',
  // containers, other CLIs that publish or talk to services
  'docker', 'podman', 'gh', 'glab', 'hub', 'npx-publish',
  // databases and migration tools pointed at real databases
  'flyway', 'liquibase', 'alembic', 'psql', 'mysql', 'mongo', 'mongosh', 'redis-cli', 'sqlcmd', 'sqlplus',
]);

const GIT_ALLOWED = new Set(['status', 'diff', 'log', 'show', 'add', 'restore', 'rm', 'mv', 'grep', 'ls-files', 'rev-parse', 'blame', 'stash', 'branch', 'checkout']);
const SAFE_ENV_PREFIX = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ)=[\w.:/-]*$/;
const PUBLISH = /^(publish|deploy|release|login|adduser|logout|token|owner|dist-tag|unpublish|deprecate)$/;
const MIGRATIONS = /\b(prisma\s+(migrate\s+(deploy|reset)|db\s+push)|knex\s+migrate|sequelize(-cli)?\s+db:migrate|typeorm\s+migration:run|rails\s+db:(migrate|reset)|manage\.py\s+migrate|drizzle-kit\s+(push|migrate))\b/;

/** Tokenizes one command line into segments of argv, refusing constructs it can't reason about. */
export function parseShell(input: string): { segments: string[][] } | { error: string } {
  if (/`|\$\(|<\(|>\(|<<|\$\{/.test(input)) return { error: 'command substitution, process substitution and heredocs are not allowed' };
  // The only redirections accepted: merging stderr and discarding output.
  const command = input.replace(/\s*\d?>\s*(\/dev\/null|NUL)\b/gi, ' ').replace(/\s*2>&1/g, ' ');
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
    } else if (ch === '\\' && i + 1 < command.length) {
      tok += command[++i];
      hasTok = true;
    } else if (ch === '\n' || ch === ';') {
      pushSeg();
    } else if (/\s/.test(ch)) {
      pushTok();
    } else if (ch === '&' || ch === '|') {
      if (command[i + 1] === ch) i++;
      pushSeg();
    } else if (ch === '>' || ch === '<') {
      return { error: 'redirection is not allowed (only 2>&1 and /dev/null); write files with the edit tools' };
    } else {
      tok += ch;
      hasTok = true;
    }
  }
  if (quote) return { error: 'unbalanced quotes' };
  pushSeg();
  return { segments };
}

/** A folder a command may move to: inside the workspace, spelled without `..` or `~`. */
function folderOk(dir: string | undefined, policy: ShellPolicy): boolean {
  if (!policy.root || !dir || dir === '-' || dir.startsWith('~') || dir.split(/[\\/]/).includes('..')) return false;
  return isInside(policy.root, dir);
}

/** `NAME=value` the owner's own repo commands set (CHROME_BIN=/path/to/chrome, say): the agent may set them the same way. */
function configuredEnv(policy: ShellPolicy): Set<string> {
  const out = new Set<string>();
  for (const c of policy.configured) for (const t of c.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) out.add(t);
    else break;
  }
  return out;
}

/**
 * Drops the "where" options (git -C <dir>, npm --prefix <dir>, pnpm --dir/-C, yarn --cwd) when the
 * folder is inside the workspace, so the rest is checked like the same command run there.
 */
function withoutFolderOptions(seg: string[], policy: ShellPolicy): string[] | { reason: string } {
  const [cmd, ...args] = seg;
  const base = (cmd ?? '').toLowerCase();
  const out: string[] = [];
  const isPm = /^(npm|npx|pnpm|yarn)$/.test(base);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const flag = base === 'git' ? (i === out.length && a === '-C' ? a : undefined) : isPm && /^(--prefix|--dir|--cwd|-C)$/.test(a) ? a : undefined;
    const inline = isPm ? /^(--prefix|--dir|--cwd)=(.*)$/.exec(a) : null;
    if (flag || inline) {
      const dir = inline ? inline[2] : args[++i];
      if (!folderOk(dir, policy)) return { reason: `${flag ?? inline![1]} ${dir ?? ''} must be a folder inside the workspace`.trim() };
      continue;
    }
    out.push(a);
  }
  return [cmd!, ...out];
}

function checkSegment(raw: readonly string[], policy: ShellPolicy): Verdict {
  // Moving into a repo folder of the workspace: `cd app && npm test`.
  if (raw[0] === 'cd' || raw[0] === 'pushd') {
    if (raw.length === 2 && folderOk(raw[1], policy)) return { allowed: true, reason: 'folder in the workspace' };
    return { allowed: false, reason: policy.root ? `cd only into a folder inside the workspace (cd ${raw[1] ?? ''})`.replace(' ()', '') : `"${raw.join(' ')}" is not on the allowlist (repo commands, package installs, read-only helpers, safe git)` };
  }
  if (raw[0] === 'popd' && raw.length === 1) return { allowed: true, reason: 'back to the previous folder' };
  // The owner's own repo command, exactly as configured (it may set a variable, e.g. CHROME_BIN=...).
  const rawLine = raw.join(' ');
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[0] ?? '') && policy.configured.some((c) => c.trim() && (rawLine === c.trim() || rawLine.startsWith(`${c.trim()} `)))) return { allowed: true, reason: 'configured repo command' };
  const envOk = configuredEnv(policy);
  let seg = [...raw];
  while (seg.length && (SAFE_ENV_PREFIX.test(seg[0]!) || envOk.has(seg[0]!))) seg.shift();
  if (seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[0]!)) return { allowed: false, reason: `setting ${seg[0]!.split('=')[0]} is not allowed` };
  if (!seg.length) return { allowed: true, reason: 'empty' };
  // A repo's own tool by path (app/node_modules/.bin/ng) reads as the same tool run with npx.
  const bin = /^(?:\.\/)?(?:[\w.@-]+\/)*node_modules\/\.bin\/([\w.-]+)$/.exec(seg[0]!);
  if (bin && folderOk(seg[0], policy)) seg = ['npx', bin[1]!, ...seg.slice(1)];
  if (policy.root) {
    const moved = withoutFolderOptions(seg, policy);
    if (!Array.isArray(moved)) return { allowed: false, reason: moved.reason };
    seg = moved;
  }
  const [cmd, ...args] = seg;
  if (!cmd) return { allowed: true, reason: 'empty' };
  const base = cmd.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  const line = seg.join(' ');
  if (base.includes('/') || base.includes('\\')) return { allowed: false, reason: `run commands by name, not by path (${cmd})` };
  if (DENIED_COMMANDS.has(base)) return { allowed: false, reason: `"${base}" is not allowed in Tandem build sessions` };
  if (MIGRATIONS.test(line)) return { allowed: false, reason: 'database migrations are not allowed in build sessions' };
  if (base === 'git') {
    if (args[0]?.startsWith('-')) return { allowed: false, reason: 'git options before the subcommand (like -c or -C) are not allowed' };
    const sub = args[0];
    if (!sub || !GIT_ALLOWED.has(sub)) return { allowed: false, reason: `git ${sub ?? ''} is not allowed; Tandem commits, rebases and pushes for you`.replace('  ', ' ') };
    if (args.some((a) => a === '--force' || a === '-f' || a === '--hard' || a.startsWith('--force'))) return { allowed: false, reason: 'forced git operations are not allowed' };
    if (sub === 'branch' && args.slice(1).some((a) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy|set-upstream)/.test(a))) return { allowed: false, reason: 'changing branches is not allowed' };
    if (sub === 'checkout' && !args.includes('--')) return { allowed: false, reason: 'git checkout is only allowed for paths (git checkout -- <path>)' };
    if (sub === 'stash' && args[1] && !/^(list|show|push|pop|apply)$/.test(args[1])) return { allowed: false, reason: `git stash ${args[1]} is not allowed` };
    return { allowed: true, reason: 'safe git' };
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(base) && args.some((a) => PUBLISH.test(a))) return { allowed: false, reason: `${base} ${args.find((a) => PUBLISH.test(a))} is not allowed` };
  if (policy.configured.some((c) => c.trim() && (line === c.trim() || line.startsWith(`${c.trim()} `)))) return { allowed: true, reason: 'configured repo command' };
  if (/^(npm|pnpm|yarn)$/.test(base) && /^(install|i|ci|add)$/.test(args[0] ?? '') && !args.some((a) => /^(-g|--global|--prefix|--location=global)/.test(a))) {
    return { allowed: true, reason: 'package install' };
  }
  if (base === 'pip' && args[0] === 'install' && !args.some((a) => /^(--user|--target|--prefix|-t)$/.test(a))) return { allowed: true, reason: 'package install' };
  if (base === 'go' && /^(get|mod|build|test|vet)$/.test(args[0] ?? '')) return { allowed: true, reason: 'go tooling' };
  if (base === 'npx' && /^(vitest|tsc|eslint|jest|prettier|playwright|ng)$/.test(args[0] ?? '') && !(args[0] === 'ng' && /^(deploy|add|update|new)$/.test(args[1] ?? ''))) return { allowed: true, reason: 'local dev tool' };
  if (/^(npm|pnpm|yarn)$/.test(base) && (args[0] === 'test' || (args[0] === 'run' && /^(test|lint|typecheck|type-check|build|format)(:[\w-]+)?$/.test(args[1] ?? '')))) {
    return { allowed: true, reason: 'repo script' };
  }
  if (READ_HELPERS.has(base)) {
    if (base === 'find' && args.some((a) => /^-(exec|execdir|delete|ok|okdir|fprint|fls)/.test(a))) return { allowed: false, reason: 'find with -exec or -delete is not allowed' };
    return { allowed: true, reason: 'read-only helper' };
  }
  return { allowed: false, reason: `"${line}" is not on the allowlist (repo commands, package installs, read-only helpers, safe git)` };
}

export function checkShell(command: string, policy: ShellPolicy): Verdict {
  const parsed = parseShell(command);
  if ('error' in parsed) return { allowed: false, reason: parsed.error };
  if (parsed.segments.length === 0) return { allowed: false, reason: 'empty command' };
  for (const seg of parsed.segments) {
    const v = checkSegment(seg, policy);
    if (!v.allowed) return v;
  }
  return { allowed: true, reason: 'allowlisted' };
}
