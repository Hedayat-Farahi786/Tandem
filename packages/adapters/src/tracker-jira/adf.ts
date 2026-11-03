/**
 * Minimal Markdown <-> Atlassian Document Format conversion for comments and descriptions:
 * headings, paragraphs, bullet and numbered lists, code blocks, tables, bold, inline code, links.
 */
type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> };

function inline(text: string): Node[] {
  const out: Node[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith('**')) out.push({ type: 'text', text: t.slice(2, -2), marks: [{ type: 'strong' }] });
    else if (t.startsWith('`')) out.push({ type: 'text', text: t.slice(1, -1), marks: [{ type: 'code' }] });
    else {
      const l = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      out.push({ type: 'text', text: l[1]!, marks: [{ type: 'link', attrs: { href: l[2] } }] });
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out.length ? out : [{ type: 'text', text: ' ' }];
}

const para = (text: string): Node => ({ type: 'paragraph', content: inline(text) });

export function markdownToAdf(markdown: string): { type: 'doc'; version: 1; content: Node[] } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const content: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      content.push({ type: 'codeBlock', attrs: fence[1] ? { language: fence[1] } : {}, content: body.length ? [{ type: 'text', text: body.join('\n') }] : [] });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      content.push({ type: 'heading', attrs: { level: h[1]!.length }, content: inline(h[2]!) });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const cells = lines[i]!.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
        if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      content.push({
        type: 'table',
        content: rows.map((r, ri) => ({ type: 'tableRow', content: r.map((c) => ({ type: ri === 0 ? 'tableHeader' : 'tableCell', content: [para(c)] })) })),
      });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const ordered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line) && !bullet.test(line);
      const re = isOrdered ? ordered : bullet;
      const items: Node[] = [];
      while (i < lines.length && re.test(lines[i]!)) items.push({ type: 'listItem', content: [para(re.exec(lines[i++]!)![1]!)] });
      content.push({ type: isOrdered ? 'orderedList' : 'bulletList', content: items });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ''));
    content.push(para(buf.join(' ')));
  }
  return { type: 'doc', version: 1, content };
}

/** Plain text from ADF (for reading descriptions and PM replies). */
export function adfToText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as Node;
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  const inner = (n.content ?? []).map(adfToText);
  switch (n.type) {
    case 'doc':
      return inner.join('\n\n').trim();
    case 'paragraph':
    case 'heading':
      return inner.join('');
    case 'bulletList':
      return inner.map((t) => `- ${t}`).join('\n');
    case 'orderedList':
      return inner.map((t, i) => `${i + 1}. ${t}`).join('\n');
    case 'listItem':
      return inner.join(' ');
    case 'codeBlock':
      return `\`\`\`\n${inner.join('')}\n\`\`\``;
    case 'tableRow':
      return `| ${inner.join(' | ')} |`;
    case 'table':
      return inner.join('\n');
    default:
      return inner.join('');
  }
}
