import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findSiteIcon, iconLinks } from './site-icon.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A bare "mirror" whose refs/remotes/origin/main holds the given files, like Tandem's mirrors. */
function mirrorWith(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'tandem-icon-'));
  dirs.push(root);
  const work = join(root, 'work');
  const bare = join(root, 'mirror.git');
  mkdirSync(work);
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  git(work, 'init', '-q');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(work, p)), { recursive: true });
    writeFileSync(join(work, p), body);
  }
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'site');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  git(work, 'push', '-q', bare, 'HEAD:refs/remotes/origin/main');
  return bare;
}

describe('site icon', () => {
  it('uses the icon the page links to, before the usual favicon files', async () => {
    const m = mirrorWith({ 'index.html': '<head><link rel="icon" type="image/svg+xml" href="/brand/mark.svg?v=2"></head>', 'public/brand/mark.svg': SVG, 'public/favicon.ico': PNG });
    const icon = await findSiteIcon(m, 'refs/remotes/origin/main');
    expect(icon).toMatchObject({ path: 'public/brand/mark.svg', type: 'image/svg+xml' });
    expect(icon!.bytes.toString()).toBe(SVG);
    expect(icon!.blob).toMatch(/^[0-9a-f]{40}$/);
  });

  it('falls back to the usual locations, preferring SVG, and reads binary files intact', async () => {
    expect(await findSiteIcon(mirrorWith({ 'public/favicon.ico': PNG, 'src/app/icon.svg': SVG }), 'refs/remotes/origin/main')).toMatchObject({ path: 'src/app/icon.svg' });
    const png = await findSiteIcon(mirrorWith({ 'app/favicon.ico': PNG }), 'refs/remotes/origin/main');
    expect(png).toMatchObject({ path: 'app/favicon.ico', type: 'image/x-icon' });
    expect(Buffer.compare(png!.bytes, PNG)).toBe(0);
  });

  it('finds nothing in a repository without an icon, and skips fakes and huge files', async () => {
    expect(await findSiteIcon(mirrorWith({ 'README.md': '# api' }), 'refs/remotes/origin/main')).toBeUndefined();
    expect(await findSiteIcon(mirrorWith({ 'public/favicon.svg': 'not an svg', 'favicon.png': Buffer.alloc(300 * 1024, 1) }), 'refs/remotes/origin/main')).toBeUndefined();
    expect(await findSiteIcon(mirrorWith({ 'favicon.svg': SVG }), 'refs/remotes/origin/nope')).toBeUndefined();
  });
});

describe('iconLinks', () => {
  it('resolves rooted and relative links, and ignores remote, data and unknown ones', () => {
    const html = `<link rel="icon" href="/favicon.svg"><link rel="apple-touch-icon" href="img/touch.png"><link rel="stylesheet" href="/a.css">
      <link href="https://cdn.example.com/i.png" rel="icon"><link rel="icon" href="data:image/png;base64,AA"><link rel="shortcut icon" href="../x.ico">`;
    expect(iconLinks(html, 'index.html')).toEqual(['public/favicon.svg', 'favicon.svg', 'static/favicon.svg', 'img/touch.png', 'public/img/touch.png', 'x.ico']);
    expect(iconLinks('<link rel="icon" href="./logo.png">', 'src/index.html')).toEqual(['src/logo.png', 'public/logo.png']);
  });
});
