import { Fragment } from 'react';

/** Plain text with `inline code` shown as code (agents write paths and payloads that way). */
export function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.length > 2 && p.startsWith('`') && p.endsWith('`') ? (
          <code key={i} className="rounded-[5px] bg-surface-3/70 px-1 py-px font-mono text-[0.9em] break-words">
            {p.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** One clause of "Given …, when …, then …": no trailing period, and "The server" reads "the server". */
export function clause(s: string): string {
  const t = s.trim().replace(/[.;,]+$/, '');
  // "The server" / "A client" read lowercase mid-sentence; acronyms ("GET", "API") and "I" stay.
  return /^[A-Z](?=[a-z]|\s)/.test(t) && !/^I\b/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t;
}

export function CriterionText({ c, keywordClass = 'text-muted' }: { c: { given: string; when: string; then: string }; keywordClass?: string }) {
  return (
    <>
      <span className={keywordClass}>Given</span> <InlineText text={clause(c.given)} />, <span className={keywordClass}>when</span> <InlineText text={clause(c.when)} />, <span className={keywordClass}>then</span> <InlineText text={clause(c.then)} />.
    </>
  );
}

/** A file path that keeps its file name when space runs out: the folders shorten first ("src/app/…/image-measure.component.spec.ts"). */
export function FilePath({ path, prefix, className }: { path: string; prefix?: string; className?: string }) {
  const cut = path.lastIndexOf('/');
  const dir = cut >= 0 ? path.slice(0, cut + 1) : '';
  const base = cut >= 0 ? path.slice(cut + 1) : path;
  return (
    <span className={`flex min-w-0 font-mono ${className ?? ''}`} title={`${prefix ?? ''}${path}`}>
      {(prefix || dir) && <span className="min-w-0 truncate">{prefix}{dir}</span>}
      <span className="shrink-0">{base}</span>
    </span>
  );
}
