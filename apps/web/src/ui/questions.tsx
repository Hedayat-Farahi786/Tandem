import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Check, PenLine } from 'lucide-react';
import type { OwnerAnswer, OwnerQuestion } from '@tandem/shared';
import { BrandTile } from './brands';
import { Button, cx } from './kit';

/** The answers as the owner's message reads to Copilot (and in the chat history). */
export function answersText(answers: OwnerAnswer[]): string {
  if (answers.length === 1) return answers[0]!.answers.join(', ');
  return answers.map((a) => `${a.header}: ${a.answers.join(', ')}`).join('\n');
}

/**
 * Copilot needs you: its questions one at a time, each with likely answers to pick (one, or any
 * that apply) and room for your own. Number keys pick, Enter goes on.
 */
export function QuestionCard({ questions, busy, onSubmit, onWriteOwn }: { questions: OwnerQuestion[]; busy?: boolean; onSubmit: (text: string, answers: OwnerAnswer[]) => void; onWriteOwn: () => void }) {
  const uid = useId();
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const [ownOn, setOwnOn] = useState<Record<string, boolean>>({});
  const ownInput = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLElement>(null);
  const q = questions[at]!;
  const answerOf = (x: OwnerQuestion) => [...(picked[x.id] ?? []), ...(ownOn[x.id] && own[x.id]?.trim() ? [own[x.id]!.trim()] : [])];
  const answered = (x: OwnerQuestion) => answerOf(x).length > 0;
  const last = at === questions.length - 1;

  // Focus the card when it appears so the number keys work at once.
  useEffect(() => {
    card.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (ownOn[q.id]) ownInput.current?.focus();
  }, [ownOn, q.id]);

  const toggle = (label: string) => {
    setPicked((p) => {
      const cur = p[q.id] ?? [];
      if (q.multiSelect) return { ...p, [q.id]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...p, [q.id]: [label] };
    });
    if (!q.multiSelect) setOwnOn((o) => ({ ...o, [q.id]: false }));
  };
  const chooseOwn = () => {
    setOwnOn((o) => ({ ...o, [q.id]: q.multiSelect ? !o[q.id] : true }));
    if (!q.multiSelect) setPicked((p) => ({ ...p, [q.id]: [] }));
  };
  const next = () => {
    if (!answered(q) || busy) return;
    if (!last) return setAt(at + 1);
    const answers: OwnerAnswer[] = questions.map((x) => ({ questionId: x.id, header: x.header, question: x.question, answers: answerOf(x) }));
    onSubmit(answersText(answers), answers);
  };
  const onKey = (e: KeyboardEvent) => {
    const typing = (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text';
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      next();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= q.options.length) {
      e.preventDefault();
      toggle(q.options[n - 1]!.label);
    } else if (n === q.options.length + 1) {
      e.preventDefault();
      chooseOwn();
    }
  };

  const row = (selected: boolean) =>
    cx(
      'group/opt flex cursor-pointer items-start gap-3 rounded-xl px-3.5 py-2.5 transition-[background-color,box-shadow] duration-150',
      selected ? 'bg-accent-soft/60 shadow-[0_0_0_1.5px_var(--accent)]' : 'shadow-[0_0_0_1px_var(--border)] hover:bg-surface-2',
    );
  const mark = (selected: boolean) => (
    <span
      aria-hidden
      className={cx(
        'mt-[3px] grid size-[18px] shrink-0 place-items-center border-[1.5px] transition-colors duration-150',
        q.multiSelect ? 'rounded-[5px]' : 'rounded-full',
        selected ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface group-hover/opt:border-faint',
      )}
    >
      {selected && (q.multiSelect ? <Check className="size-3" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-accent-fg" />)}
    </span>
  );
  const key = (n: number) => <kbd className="mt-0.5 hidden h-5 min-w-5 shrink-0 place-items-center rounded-md border border-line px-1 font-sans text-[11px] text-faint sm:grid">{n}</kbd>;
  const name = `${uid}-${q.id}`;

  return (
    <section ref={card} tabIndex={-1} aria-label="Copilot needs you" onKeyDown={onKey} className="animate-rise overflow-hidden rounded-2xl bg-surface shadow-panel focus:outline-none">
      <header className="flex items-center gap-2.5 px-4 pt-3.5 pb-3">
        <BrandTile brand="copilot" size="sm" />
        <p className="flex-1 text-[13.5px] font-medium">Copilot needs you</p>
        {questions.length > 1 && (
          <p className="text-[12px] text-faint tabular-nums">
            {at + 1} of {questions.length}
          </p>
        )}
      </header>
      {questions.length > 1 && (
        <nav aria-label="Questions" className="flex flex-wrap gap-1.5 px-4 pb-3">
          {questions.map((x, i) => (
            <button
              key={x.id}
              type="button"
              aria-current={i === at ? 'step' : undefined}
              disabled={i > at && !questions.slice(0, i).every(answered)}
              onClick={() => setAt(i)}
              className={cx(
                'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors duration-150',
                i === at ? 'bg-fg text-bg' : answered(x) ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-muted enabled:hover:text-fg',
              )}
            >
              {answered(x) && i !== at && <Check aria-hidden className="size-3" strokeWidth={2.75} />}
              {x.header}
            </button>
          ))}
        </nav>
      )}
      <div key={q.id} className="animate-in border-t border-line px-4 pt-4 pb-4">
        <p id={`${name}-q`} className="text-[15px] leading-snug font-medium">
          {q.question}
        </p>
        <p className="mt-1 text-[12px] text-faint">{q.multiSelect ? 'Pick any that apply' : 'Pick one'}, or write your own.</p>
        <div role={q.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={`${name}-q`} className="mt-3 flex flex-col gap-2">
          {q.options.map((o, i) => {
            const on = (picked[q.id] ?? []).includes(o.label);
            return (
              <label key={o.label} className={row(on)}>
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={name} checked={on} onChange={() => toggle(o.label)} className="sr-only" />
                {mark(on)}
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium">{o.label}</span>
                  {o.description && <span className="mt-0.5 block text-[13px] leading-snug text-muted">{o.description}</span>}
                </span>
                {key(i + 1)}
              </label>
            );
          })}
          <label className={row(Boolean(ownOn[q.id]))}>
            <input type={q.multiSelect ? 'checkbox' : 'radio'} name={name} checked={Boolean(ownOn[q.id])} onChange={chooseOwn} className="sr-only" />
            {mark(Boolean(ownOn[q.id]))}
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium">Other</span>
              {!ownOn[q.id] && <span className="mt-0.5 block text-[13px] text-muted">Write your own answer</span>}
            </span>
            {key(q.options.length + 1)}
          </label>
          {ownOn[q.id] && (
            <input
              ref={ownInput}
              type="text"
              aria-label={`Your answer: ${q.header}`}
              value={own[q.id] ?? ''}
              onChange={(e) => setOwn((o) => ({ ...o, [q.id]: e.target.value }))}
              placeholder="Type your answer…"
              className="-mt-1 ml-[46px] h-9 rounded-lg border border-line-strong bg-surface px-3 text-[14px] animate-in placeholder:text-faint focus:border-[color-mix(in_srgb,var(--accent)_45%,var(--border-strong))] focus:outline-none"
            />
          )}
        </div>
      </div>
      <footer className="flex items-center gap-2 border-t border-line bg-surface-2/40 px-3 py-2.5">
        <Button size="sm" variant="ghost" icon={PenLine} onClick={onWriteOwn}>
          Answer in chat
        </Button>
        <span className="flex-1" />
        {at > 0 && (
          <Button size="sm" icon={ArrowLeft} onClick={() => setAt(at - 1)}>
            Back
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={!answered(q)} busy={busy && last} onClick={next}>
          {last ? (questions.length > 1 ? 'Send answers' : 'Send answer') : 'Next'}
        </Button>
      </footer>
    </section>
  );
}

/** Your answers to Copilot's questions, as your message in the chat. */
export function AnswersBubble({ answers }: { answers: OwnerAnswer[] }) {
  return (
    <dl className="flex flex-col gap-2">
      {answers.map((a) => (
        <div key={a.questionId}>
          <dt className="text-[12px] text-muted">{a.header}</dt>
          <dd className="text-[14px] leading-snug">{a.answers.join(', ')}</dd>
        </div>
      ))}
    </dl>
  );
}
