import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

/*
 * Isolation for builds in Tandem's cloud. Every command a workspace runs (its checks, and the
 * Copilot runtime with all the commands Copilot runs) starts in new Linux namespaces:
 *
 *   user + mount + pid  the command is "root" only inside; a fresh /proc shows its own processes,
 *                       never the server's (whose memory and environment hold every secret).
 *   hidden              the hosted data folder (every workspace, the directory) is replaced by an
 *                       empty folder, then only this workspace's folder is put back.
 *   read-only           git mirrors and reference clones: a build can't plant hooks or git config
 *                       that Tandem's own git would later run.
 *   masked              this workspace's database, logs and the git helper's key.
 *   private             /tmp, /dev/shm, and HOME (a fresh /tmp/home: caches are never shared).
 *   masked too          credentials in the server user's home (.ssh, .aws, …) and secret mounts.
 *
 * The process starts in / and changes to its folder only after the mounts: a working folder kept
 * from before would still lead, with "..", to the folders that are hidden.
 *
 * The network is shared (builds install packages); limit it around the container. Uses only
 * `unshare` and `mount` from util-linux, and user namespaces (see docs/DEPLOYMENT.md for Docker).
 */

export interface SandboxSpec {
  /** Folders hidden entirely (replaced by an empty folder). */
  hide: string[];
  /** Folders inside hidden ones that stay visible, read-write. */
  keep: string[];
  /** Folders made read-only. */
  readOnly: string[];
  /** Files (replaced by an empty file) and folders (replaced by an empty folder) masked. */
  mask: string[];
  /** A folder made private and empty (for example a home folder no build may see). */
  home?: string | undefined;
}

const SCRIPT = String.raw`set -e
IFS='
'
mount -n --make-rprivate /
mount -n -t tmpfs -o mode=700 tandem-stage /dev/shm
i=0
for d in $SBX_KEEP; do i=$((i+1)); mkdir -p "$d" "/dev/shm/k$i"; mount -n --rbind "$d" "/dev/shm/k$i"; done
for d in $SBX_HIDE; do mount -n -t tmpfs -o mode=755 tandem-hidden "$d"; done
mount -n -t tmpfs -o mode=1777 tandem-tmp /tmp
mkdir -p /tmp/home
if [ -n "$SBX_HOME" ]; then mkdir -p "$SBX_HOME" 2>/dev/null || true; mount -n -t tmpfs -o mode=700 tandem-home "$SBX_HOME"; fi
i=0
for d in $SBX_KEEP; do i=$((i+1)); mkdir -p "$d"; mount -n --move "/dev/shm/k$i" "$d"; done
for d in $SBX_RO; do if [ -d "$d" ]; then mount -n --rbind "$d" "$d"; mount -n -o remount,bind,ro "$d"; fi; done
for f in $SBX_MASK; do if [ -d "$f" ]; then mount -n -t tmpfs -o mode=700 tandem-masked "$f"; elif [ -e "$f" ]; then mount -n --bind /dev/null "$f"; fi; done
umount -n /dev/shm
mount -n -t tmpfs -o mode=1777 tandem-shm /dev/shm
cd "$SBX_CWD"
unset SBX_KEEP SBX_HIDE SBX_RO SBX_MASK SBX_HOME SBX_CWD IFS
export HOME=/tmp/home
exec "$@"`;

/** Finds a program on PATH (the SDK needs an absolute path to start its runtime). */
export function onPath(name: string, path = process.env.PATH ?? ''): string | undefined {
  for (const dir of path.split(delimiter)) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The Copilot runtime the SDK would start by itself (its platform package's prebuilt binary). */
export function bundledCopilotRuntime(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const sdk = req.resolve('@github/copilot-sdk');
    const fromSdk = createRequire(sdk);
    const musl = process.platform === 'linux' && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
    const platform = `${process.platform === 'linux' && musl ? 'linuxmusl' : process.platform}-${process.arch}`;
    const root = dirname(fromSdk.resolve(`@github/copilot-sdk-${platform}/package.json`));
    const bin = join(root, 'prebuilds', platform, process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime');
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

export class NamespaceSandbox {
  readonly unshare: string;
  constructor(
    readonly spec: SandboxSpec,
    unshare = onPath('unshare'),
  ) {
    if (process.platform !== 'linux' || !unshare) throw new Error('Isolated builds need Linux with util-linux (unshare).');
    this.unshare = unshare;
  }

  /** The program to start instead of `argv`, and the environment it needs besides the usual. */
  wrap(argv: readonly string[], cwd = '/'): { file: string; args: string[]; env: Record<string, string>; cwd: string } {
    const list = (xs: string[]) => xs.filter((x) => x && !x.includes('\n')).join('\n');
    return {
      file: this.unshare,
      args: ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--kill-child', '--mount-proc', 'sh', '-c', SCRIPT, 'tandem-sandbox', ...argv],
      env: { SBX_HIDE: list(this.spec.hide), SBX_KEEP: list(this.spec.keep), SBX_RO: list(this.spec.readOnly), SBX_MASK: list(this.spec.mask), SBX_HOME: this.spec.home ?? '', SBX_CWD: cwd },
      // Where the process starts, before it changes to `cwd` inside: never a folder of a workspace.
      cwd: '/',
    };
  }

  /** Runs a command in the sandbox; resolves with its exit code and output. */
  run(argv: readonly string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number | null; out: string }> {
    const w = this.wrap(argv, o.cwd);
    return new Promise((resolve) => {
      const child = spawn(w.file, w.args, { cwd: w.cwd, env: { ...(o.env ?? { PATH: process.env.PATH ?? '/usr/bin:/bin' }), ...w.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const t = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 20_000);
      child.on('error', (err) => {
        clearTimeout(t);
        resolve({ code: null, out: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, out });
      });
    });
  }

  /**
   * Proves the isolation works here before any build runs: hidden folders are empty, kept ones
   * are there, read-only ones refuse writes, masked files are empty, and no outside process shows.
   */
  async selfTest(probe: { hidden: string; kept: string; readOnly?: string; masked?: string }): Promise<{ ok: boolean; message: string }> {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const checks = [
      `[ ! -e ${q(probe.hidden)} ] || { echo "can still see ${probe.hidden}"; exit 1; }`,
      `[ -d ${q(probe.kept)} ] || { echo "can't see ${probe.kept}"; exit 1; }`,
      probe.readOnly ? `! touch ${q(`${probe.readOnly}/.tandem-sandbox-probe`)} 2>/dev/null || { echo "${probe.readOnly} is writable"; exit 1; }` : '',
      probe.masked ? `[ ! -s ${q(probe.masked)} ] || { echo "${probe.masked} is readable"; exit 1; }` : '',
      `n=$(ls /proc | grep -c '^[0-9]'); [ "$n" -lt 10 ] || { echo "sees $n processes outside"; exit 1; }`,
      `[ "$(pwd)" = ${q(probe.kept)} ] || { echo "started in $(pwd)"; exit 1; }`,
      'echo sandbox-ok',
    ].filter(Boolean);
    const r = await this.run(['sh', '-c', checks.join('\n')], { cwd: probe.kept });
    return r.code === 0 && r.out.includes('sandbox-ok') ? { ok: true, message: 'Builds run isolated (user, mount and process namespaces).' } : { ok: false, message: r.out.trim().split('\n').slice(-3).join(' ') || `exit ${r.code}` };
  }
}
