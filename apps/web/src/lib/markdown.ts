import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Markdown to sanitised HTML (specs and chat). Links open in a new tab, nothing executable survives. */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true, breaks: false });
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'img'], FORBID_ATTR: ['style'] });
  return clean.replace(/<a href=/g, '<a target="_blank" rel="noreferrer noopener" href=');
}
