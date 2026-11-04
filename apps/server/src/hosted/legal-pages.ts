import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Marked } from 'marked';

/*
 * The legal documents (docs/legal, Markdown) as pages of the hosted app: /legal/privacy,
 * /legal/terms, /legal/dpa, /legal/subprocessors. Rendered on the server
 * with marked; the page loads nothing else.
 */

export const LEGAL_PAGES: Record<string, { file: string; title: string }> = {
  privacy: { file: 'privacy-policy.md', title: 'Privacy policy' },
  terms: { file: 'terms-of-service.md', title: 'Terms of service' },
  dpa: { file: 'dpa.md', title: 'Data processing agreement' },
  subprocessors: { file: 'subprocessors.md', title: 'Subprocessors' },
};
const BY_FILE = new Map(Object.entries(LEGAL_PAGES).map(([slug, p]) => [p.file, slug]));

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The Markdown of a legal document as HTML: links to the other documents become their pages, tables scroll. */
export function renderMarkdown(md: string): string {
  const html = new Marked({ gfm: true, async: false }).parse(md) as string;
  return html
    .replace(/<h(\d)>([^<]*)<\/h\1>/g, (_m, level: string, text: string) => `<h${level} id="${text.toLowerCase().replace(/&[a-z#0-9]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}">${text}</h${level}>`)
    .replace(/href="(?:\.\/)?([\w-]+\.md)(#[^"]*)?"/g, (m, file: string, hash = '') => (BY_FILE.has(file) ? `href="/legal/${BY_FILE.get(file)}${hash as string}"` : m))
    .replace(/<table>/g, '<div class="table"><table>')
    .replace(/<\/table>/g, '</table></div>');
}

/** A legal document as a full page, or undefined when there is no such document. */
export function legalPage(dir: string | undefined, slug: string): string | undefined {
  const page = LEGAL_PAGES[slug];
  if (!page || !dir) return undefined;
  const path = join(dir, page.file);
  if (!existsSync(path)) return undefined;
  const body = renderMarkdown(readFileSync(path, 'utf8'));
  const nav = Object.entries(LEGAL_PAGES)
    .map(([s, p]) => `<a href="/legal/${s}"${s === slug ? ' aria-current="page"' : ''}>${esc(p.title)}</a>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(page.title)} · Tandem</title>
<style>
:root{--bg:#fafaf9;--surface:#fff;--border:#e2e2df;--text:#18181a;--muted:#4e4e52;--accent:#0e3b3b;--accent-text:#0e5c58}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--surface:#1c1c1f;--border:#313135;--text:#f1f1f2;--muted:#b4b4b9;--accent:#7cc7c0;--accent-text:#7cc7c0}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--text);font:15.5px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
header{border-bottom:1px solid var(--border);background:var(--surface)}header div{max-width:820px;margin:0 auto;padding:14px 16px;display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center}
header strong{margin-right:auto;font-size:15px}header a{color:var(--muted);font-size:13.5px;text-decoration:none}header a[aria-current]{color:var(--text);font-weight:600}header a:hover{color:var(--text)}
main{max-width:820px;margin:0 auto;padding:32px 16px 72px}h1{font-size:30px;letter-spacing:-.02em;line-height:1.2;margin:0 0 8px}h2{font-size:19px;margin:36px 0 8px;letter-spacing:-.01em}h3{font-size:16px;margin:24px 0 6px}
p,li{color:var(--muted)}strong{color:var(--text)}a{color:var(--accent-text)}code{font-size:.92em;padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--text) 7%,transparent)}
blockquote{margin:16px 0;padding:2px 16px;border-left:3px solid var(--accent);background:var(--surface);border-radius:0 10px 10px 0}
.table{overflow-x:auto;margin:14px 0;border-radius:12px;box-shadow:0 0 0 1px var(--border)}table{border-collapse:collapse;width:100%;font-size:13.5px;background:var(--surface)}th,td{padding:9px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--border)}th{color:var(--text);font-weight:600}tr:last-child td{border-bottom:0}td{color:var(--muted)}
</style>
</head>
<body>
<header><div><strong>Tandem</strong>${nav}<a href="/">Back to the app</a></div></header>
<main>
${body}
</main>
</body>
</html>`;
}
