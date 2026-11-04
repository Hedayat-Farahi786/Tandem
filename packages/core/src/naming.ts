/** Branch names are feature/<taskKey>-<slug>, like a person's. Tandem never pushes anywhere else. */
export function slugify(title: string, max = 40): string {
  const s = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= max) return s || 'task';
  const cut = s.slice(0, max);
  const i = cut.lastIndexOf('-');
  return (i > 10 ? cut.slice(0, i) : cut).replace(/-+$/, '') || 'task';
}

export function branchName(taskKey: string, slug: string): string {
  return `feature/${taskKey}-${slug}`;
}

/** "Add Health Endpoint To API" → "Add health endpoint to API"; acronyms stay. */
function sentenceCase(title: string): string {
  const words = title.replace(/\s+/g, ' ').trim().replace(/[.!?;:,\s]+$/, '').split(' ');
  return words.map((w, i) => (i > 0 && /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

/** Wraps text at `width` columns, between words, as commit bodies are. */
function wrap(text: string, width = 72): string {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + w.length > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join('\n');
}

/**
 * The one commit a task's branch holds when it is pushed, written the way a developer would:
 * "SHOP-12: Add a health endpoint", then the goal in a short wrapped paragraph.
 */
export function commitMessage(taskKey: string, title: string, goal?: string): string {
  const subject = `${taskKey}: ${sentenceCase(title)}`;
  const g = (goal ?? '').replace(/\s+/g, ' ').trim();
  // Two sentences at most: the why, not the whole spec.
  const body = (g.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [g]).slice(0, 2).join('').trim();
  return body && body.toLowerCase() !== title.toLowerCase() ? `${subject}\n\n${wrap(body)}` : subject;
}

export function specFileName(taskKey: string, slug: string): string {
  return `specs/${taskKey}-${slug}.md`;
}
