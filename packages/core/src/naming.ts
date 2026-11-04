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

/** "Add Health Endpoint To API" → "Add health endpoint to API"; acronyms and names in capitals stay. */
export function sentenceCase(title: string): string {
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
 * A commit or pull request title as people write them: no task key, no "feat:" prefix, no tags,
 * no trailing period, first letter capital ("Bump version to 1.7.13"). Undefined when nothing is left.
 */
export function cleanTitle(raw: string): string | undefined {
  const t = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(\[[^\]]*\]\s*)+/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^[A-Z][A-Z0-9]*-\d+\s*[:\-–—]?\s*/, '')
    .replace(/^(feat|fix|chore|refactor|style|docs|test|build|ci|perf)(\([^)]*\))?!?:\s*/i, '')
    .replace(/[\s.,;:!?–—-]+$/, '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : undefined;
}

/** The change's title: the one Copilot gave it when it finished, else the task's title in sentence case. */
export function changeTitle(task: { title: string; progress: Record<string, unknown> }): string {
  const named = typeof task.progress.commitTitle === 'string' ? cleanTitle(task.progress.commitTitle) : undefined;
  return named ?? cleanTitle(sentenceCase(task.title)) ?? 'Update';
}

/** The body of the change's commit: what Copilot said changed, else the goal in two sentences at most. */
export function changeBody(task: { title: string; progress: Record<string, unknown>; requirement?: { goal?: string } }): string {
  const said = typeof task.progress.commitBody === 'string' ? task.progress.commitBody.trim() : '';
  if (said) return said;
  const g = (task.requirement?.goal ?? '').replace(/\s+/g, ' ').trim();
  return (g.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [g]).slice(0, 2).join('').trim();
}

/**
 * The one commit a task's branch holds when it is pushed, written the way a developer would: a short
 * title ("Bump version to 1.7.13"), then a few wrapped lines on what changed. No task key.
 */
export function commitMessage(title: string, body?: string): string {
  const b = (body ?? '').trim();
  if (!b || b.toLowerCase() === title.toLowerCase()) return title;
  // Keep the agent's own lines (a short list, say); wrap each paragraph.
  return `${title}\n\n${b.split(/\n{2,}/).map((p) => (/^\s*[-*] /m.test(p) ? p.trim() : wrap(p))).join('\n\n')}`;
}

export function specFileName(taskKey: string, slug: string): string {
  return `specs/${taskKey}-${slug}.md`;
}
