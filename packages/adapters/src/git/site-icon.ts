import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { gitEnv } from './git.js';

/** The icon a website repository ships, read from a git ref without a checkout. */
export interface SiteIcon {
  path: string;
  type: string;
  bytes: Buffer;
  /** The blob id: changes when the icon changes, so it works as an ETag. */
  blob: string;
}

/** Where sites keep their icon: Vite and static sites, Next.js, Create React App, SvelteKit, Astro. Best formats first. */
export const ICON_PATHS = [
  'public/favicon.svg',
  'favicon.svg',
  'static/favicon.svg',
  'src/app/icon.svg',
  'app/icon.svg',
  'public/icon.svg',
  'public/apple-touch-icon.png',
  'apple-touch-icon.png',
  'src/app/apple-icon.png',
  'app/apple-icon.png',
  'public/favicon.png',
  'favicon.png',
  'static/favicon.png',
  'src/app/icon.png',
  'app/icon.png',
  'public/favicon.ico',
  'favicon.ico',
  'static/favicon.ico',
  'src/app/favicon.ico',
  'app/favicon.ico',
  'src/favicon.ico',
] as const;

const TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_BYTES = 256 * 1024;

function git(gitDir: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['--git-dir', gitDir, ...args], { encoding: 'buffer', env: gitEnv(), timeout: 10_000, maxBuffer: MAX_BYTES * 2, windowsHide: true }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

/** `<link rel="icon" href="…">` targets in an HTML file, resolved to repository paths. */
export function iconLinks(html: string, htmlPath: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href || !/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel) || /^(https?:|data:|\/\/)/i.test(href)) continue;
    const clean = href.split(/[?#]/)[0]!;
    const dir = posix.dirname(htmlPath);
    if (clean.startsWith('/')) out.push(`public${clean}`, clean.slice(1), `static${clean}`);
    else out.push(posix.normalize(posix.join(dir === '.' ? '' : dir, clean)), posix.normalize(posix.join('public', clean)));
  }
  return [...new Set(out)].filter((p) => !p.startsWith('..') && TYPES[posix.extname(p).toLowerCase()]);
}

/**
 * Finds the site's icon at `ref` in a (bare) repository: the icon its index.html links to, else the
 * usual favicon locations. Returns nothing for files that are missing, too big or not images.
 */
export async function findSiteIcon(gitDir: string, ref: string): Promise<SiteIcon | undefined> {
  const linked: string[] = [];
  for (const html of ['index.html', 'public/index.html', 'src/index.html', 'src/app.html']) {
    const text = await git(gitDir, ['show', `${ref}:${html}`]);
    if (text) linked.push(...iconLinks(text.toString('utf8'), html));
  }
  const candidates = [...new Set([...linked, ...ICON_PATHS])];
  // One call lists which candidates exist, with their blob ids and sizes.
  const listing = await git(gitDir, ['ls-tree', '-l', ref, '--', ...candidates]);
  if (!listing) return undefined;
  const found = new Map<string, { blob: string; size: number }>();
  for (const line of listing.toString('utf8').split('\n')) {
    const m = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(line);
    if (m) found.set(m[3]!, { blob: m[1]!, size: Number(m[2]) });
  }
  for (const path of candidates) {
    const f = found.get(path);
    if (!f || f.size === 0 || f.size > MAX_BYTES) continue;
    const bytes = await git(gitDir, ['cat-file', 'blob', f.blob]);
    if (!bytes) continue;
    const type = TYPES[posix.extname(path).toLowerCase()]!;
    if (type === 'image/svg+xml' && !/<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8'))) continue;
    return { path, type, bytes, blob: f.blob };
  }
  return undefined;
}
