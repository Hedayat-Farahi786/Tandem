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
