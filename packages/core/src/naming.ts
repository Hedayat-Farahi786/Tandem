/** Branch names are always agent/<taskKey>-<slug>. Tandem never pushes anywhere else. */
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
  return `agent/${taskKey}-${slug}`;
}

export function specFileName(taskKey: string, slug: string): string {
  return `specs/${taskKey}-${slug}.md`;
}
