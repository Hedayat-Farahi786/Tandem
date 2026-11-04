import { useMemo, useState } from 'react';
import { ChevronRight, FileCode2 } from 'lucide-react';
import { cx } from './kit';

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  oldNo?: number;
  newNo?: number;
}
export interface DiffFile {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/** Parses `git diff` output into files and lines with old/new line numbers. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      cur = { path: m?.[1] ?? line, status: 'modified', additions: 0, deletions: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename to ')) cur.status = 'renamed';
    else if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      cur.lines.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('similarity') || line.startsWith('rename from') || line.startsWith('Binary files')) {
      if (line.startsWith('Binary files')) cur.lines.push({ kind: 'hunk', text: 'Binary file changed' });
    } else if (line.startsWith('+')) {
      cur.additions++;
      cur.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      cur.deletions++;
      cur.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith(' ')) {
      cur.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

const STATUS_LABEL = { added: 'Added', deleted: 'Deleted', modified: 'Modified', renamed: 'Renamed' } as const;

function FileDiff({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 bg-surface-2/60 px-3 py-2 text-left text-[13px] hover:bg-surface-2">
        <ChevronRight aria-hidden className={cx('size-4 text-faint transition-transform', open && 'rotate-90')} />
        <FileCode2 aria-hidden className="size-4 text-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.path}</span>
        <span className="text-[12px] text-faint">{STATUS_LABEL[file.status]}</span>
        <span className="font-mono text-[12px] text-ok">+{file.additions}</span>
        <span className="font-mono text-[12px] text-danger">−{file.deletions}</span>
      </button>
      {open && (
        // Wide lines scroll sideways; the region takes focus so the keyboard can scroll it too.
        <div tabIndex={0} role="region" aria-label={`Changes in ${file.path}`} className="overflow-x-auto border-t border-line focus-visible:outline-offset-[-2px]">
          <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
            <caption className="sr-only">Changes in {file.path}</caption>
            <tbody>
              {file.lines.map((l, i) =>
                l.kind === 'hunk' ? (
                  <tr key={i} className="bg-accent-soft/40 text-muted">
                    <td colSpan={3} className="px-3 py-1">
                      {l.text}
                    </td>
                  </tr>
                ) : (
                  <tr key={i} className={l.kind === 'add' ? 'bg-ok-soft' : l.kind === 'del' ? 'bg-danger-soft' : ''}>
                    <td className="w-12 border-r border-line px-2 text-right text-faint select-none">{l.oldNo ?? ''}</td>
                    <td className="w-12 border-r border-line px-2 text-right text-faint select-none">{l.newNo ?? ''}</td>
                    <td className="px-3 whitespace-pre">
                      <span aria-hidden className={cx('mr-2 inline-block w-2 select-none', l.kind === 'add' ? 'text-ok' : l.kind === 'del' ? 'text-danger' : 'text-faint')}>
                        {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                      </span>
                      <span className="sr-only">{l.kind === 'add' ? 'added: ' : l.kind === 'del' ? 'removed: ' : ''}</span>
                      {l.text}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Tandem's copy of the approved spec: already reviewed, so it goes last and starts collapsed. */
const isSpecCopy = (path: string) => /^specs\/[^/]+\.md$/.test(path);

export function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => {
    const all = parseDiff(diff);
    return [...all.filter((f) => !isSpecCopy(f.path)), ...all.filter((f) => isSpecCopy(f.path))];
  }, [diff]);
  if (!files.length) return <p className="text-[13px] text-muted">No changes yet.</p>;
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        {files.length} file{files.length > 1 ? 's' : ''} changed · <span className="text-ok">+{add}</span> · <span className="text-danger">−{del}</span>
      </p>
      {files.map((f, i) => (
        <FileDiff key={f.path} file={f} defaultOpen={!isSpecCopy(f.path) && i < 8 && f.lines.length < 400} />
      ))}
    </div>
  );
}
