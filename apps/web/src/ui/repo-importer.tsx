import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderGit2, GitBranch, Lock, Search } from 'lucide-react';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { AwsConnect, AWS_REGIONS, useAws } from './aws-connect';
import { BrandLogo } from './brands';
import { CopilotConnect, useCopilotAccounts } from './copilot-connect';
import { isCompanyRunner } from './account-menu';
import { Button, Callout, Input, Select, Spinner, Tabs, cx } from './kit';

/*
 * Adding a repository the way people expect from Vercel or Netlify: pick it from a list of what your
 * connected accounts can reach (GitHub through the Copilot sign-in, CodeCommit through the AWS
 * connection), use a clone already on the runner's computer (company runners), or paste a clone URL.
 */

interface Choice {
  id: string;
  name: string;
  owner?: string;
  url: string;
  description: string;
  updatedAt: string;
  defaultBranch: string;
  private?: boolean;
  canPush?: boolean;
  added: boolean;
}
interface LocalChoice {
  path: string;
  name: string;
  remote: string;
  host: 'github' | 'codecommit';
  branch: string;
  added: boolean;
}

type Source = 'github' | 'codecommit' | 'local' | 'url';

function ChoiceList({ items, busyUrl, onPick, empty }: { items: Choice[]; busyUrl: string | null; onPick: (url: string) => void; empty: string }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (t ? items.filter((r) => `${r.owner ?? ''}/${r.name} ${r.description}`.toLowerCase().includes(t)) : items).slice(0, 60);
  }, [items, q]);
  return (
    <div className="flex flex-col gap-2">
      <label className="relative block">
        <span className="sr-only">Search repositories</span>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${items.length} repositories`} className="h-10 w-full rounded-lg bg-surface pr-3 pl-9 text-[13.5px] shadow-[0_0_0_1px_var(--border)] outline-none placeholder:text-faint focus:shadow-[0_0_0_2px_var(--accent)]" />
      </label>
      <ul aria-label="Repositories" className="flex max-h-[380px] flex-col overflow-y-auto rounded-xl shadow-[0_0_0_1px_var(--border)]">
        {shown.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-muted">{items.length ? 'No repository matches.' : empty}</li>}
        {shown.map((r) => (
          <li key={r.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
                {r.owner && <span className="truncate text-muted">{r.owner} /</span>}
                <span className="truncate font-medium">{r.name}</span>
                {r.private && <Lock aria-label="Private" className="size-3 shrink-0 text-faint" />}
              </p>
              <p className="truncate text-[12px] text-faint">{[r.description, r.updatedAt ? `updated ${relativeTime(r.updatedAt)}` : ''].filter(Boolean).join(' · ') || ' '}</p>
            </div>
            {r.added ? (
              <span className="shrink-0 text-[12.5px] text-muted">Added</span>
            ) : (
              <Button size="sm" busy={busyUrl === r.url} disabled={Boolean(busyUrl) || r.canPush === false} title={r.canPush === false ? 'You can read but not push to this repository.' : undefined} onClick={() => onPick(r.url)}>
                Add
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function GitHubSource({ busyUrl, onPick }: { busyUrl: string | null; onPick: (url: string) => void }) {
  const accounts = useCopilotAccounts();
  const hosts = useMemo(() => {
    const all = accounts.data?.accounts ?? [];
    const list = [...new Set([...(accounts.data?.active ? [accounts.data.active.host] : []), ...all.map((a) => a.host)])];
    return list;
  }, [accounts.data]);
  const [host, setHost] = useState<string | null>(null);
  const h = host ?? hosts[0] ?? 'github.com';
  const repos = useQuery({ queryKey: ['github-repos', h], queryFn: () => api<{ connected: boolean; repos: Choice[]; installUrl?: string }>(`/api/github/repos?host=${encodeURIComponent(h)}`), enabled: hosts.length > 0, retry: false, staleTime: 60_000 });
  const install = repos.data?.installUrl;
  if (accounts.isLoading) return <Loading text="Checking your GitHub account…" />;
  if (!hosts.length)
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-muted">Connect the GitHub account you use for Copilot; it also lists the repositories you can work in.</p>
        <CopilotConnect compact />
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      {hosts.length > 1 && <Select id="gh-host" label="GitHub" value={h} onChange={setHost} options={hosts.map((x) => ({ value: x, label: x }))} />}
      {repos.isLoading ? (
        <Loading text={`Listing your repositories on ${h}…`} />
      ) : repos.isError ? (
        <Callout tone="danger" title="Couldn't list your repositories">
          {(repos.error as Error).message}
        </Callout>
      ) : (
        <ChoiceList items={repos.data?.repos ?? []} busyUrl={busyUrl} onPick={onPick} empty={install ? 'Tandem can see none of your repositories yet. Install it on your account or organization.' : `Your account has no repositories on ${h}.`} />
      )}
      {install && (
        <p className="text-[12.5px] text-muted">
          Missing a repository?{' '}
          <a className="font-medium text-accent-text underline-offset-2 hover:underline" href={install} target="_blank" rel="noreferrer">
            Give Tandem access to it on GitHub
          </a>
          , then come back.
        </p>
      )}
    </div>
  );
}

function CodeCommitSource({ busyUrl, onPick }: { busyUrl: string | null; onPick: (url: string) => void }) {
  const aws = useAws();
  const [region, setRegion] = useState<string | null>(null);
  const r = region ?? aws.data?.region ?? 'eu-central-1';
  const repos = useQuery({ queryKey: ['aws-repos', r], queryFn: () => api<Choice[]>(`/api/aws/repos?region=${r}`), enabled: Boolean(aws.data?.connected && !aws.data.error), retry: false, staleTime: 60_000 });
  if (aws.isLoading) return <Loading text="Checking the AWS connection…" />;
  if (!aws.data?.connected || aws.data.error)
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-muted">Connect AWS to see the CodeCommit repositories you can work in.</p>
        <AwsConnect />
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-[240px] flex-1">
          <Select id="cc-region" label="Region" value={r} onChange={setRegion} options={AWS_REGIONS} />
        </div>
        <p className="pb-2 text-[12px] text-muted">
          As <span className="font-medium text-fg">{aws.data.label}</span>
        </p>
      </div>
      {repos.isLoading ? (
        <Loading text={`Listing repositories in ${r}…`} />
      ) : repos.isError ? (
        <Callout tone="warn" title="Couldn't list repositories here">
          {(repos.error as Error).message}
        </Callout>
      ) : (
        <ChoiceList items={repos.data ?? []} busyUrl={busyUrl} onPick={onPick} empty={`No CodeCommit repositories in ${r}. Try another region.`} />
      )}
    </div>
  );
}

function LocalSource({ busyUrl, onPickLocal }: { busyUrl: string | null; onPickLocal: (path: string) => void }) {
  const found = useQuery({ queryKey: ['local-repos'], queryFn: () => api<LocalChoice[]>('/api/repos/local'), retry: false, staleTime: 30_000 });
  const [path, setPath] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (path.trim()) onPickLocal(path.trim());
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        Work in a repository you already cloned, for example on a work laptop. Tandem uses that clone and your own sign-in for it (SSH keys or git credentials), so nothing is cloned again and Copilot's changes go out as if you made them.
      </p>
      {found.isLoading ? (
        <Loading text="Looking for repositories on the runner's computer…" />
      ) : found.data?.length ? (
        <ul aria-label="Repositories on the runner's computer" className="flex max-h-[300px] flex-col overflow-y-auto rounded-xl shadow-[0_0_0_1px_var(--border)]">
          {found.data.map((r) => (
            <li key={r.path} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
              <BrandLogo brand={r.host === 'github' ? 'github' : 'aws'} size={16} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium">{r.name}</p>
                <p className="truncate font-mono text-[11.5px] text-faint" title={r.path}>
                  {r.path}
                </p>
              </div>
              {r.added ? (
                <span className="shrink-0 text-[12.5px] text-muted">Added</span>
              ) : (
                <Button size="sm" busy={busyUrl === r.path} disabled={Boolean(busyUrl)} onClick={() => onPickLocal(r.path)}>
                  Use
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Input id="local-path" label="Folder" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/code/my-repo" help="The folder of a clone whose origin is on GitHub or CodeCommit." />
        <div>
          <Button type="submit" icon={FolderGit2} disabled={!path.trim()} busy={busyUrl === path.trim()}>
            Use this folder
          </Button>
        </div>
      </form>
    </div>
  );
}

const Loading = ({ text }: { text: string }) => (
  <p className="flex items-center gap-2.5 py-4 text-[13px] text-muted">
    <Spinner /> {text}
  </p>
);

/** The ways to add a repository, as tabs. */
export function RepoImporter({ busy, onPick, onPickLocal }: { busy: string | null; onPick: (url: string) => void; onPickLocal: (path: string) => void }) {
  const [source, setSource] = useState<Source>('github');
  const [url, setUrl] = useState('');
  return (
    <div className="flex flex-col gap-4">
      <Tabs<Source>
        label="Where the repository is"
        value={source}
        onChange={setSource}
        tabs={[
          { id: 'github', label: 'GitHub' },
          { id: 'codecommit', label: 'AWS CodeCommit' },
          ...(isCompanyRunner() ? [{ id: 'local' as const, label: "On the runner's computer" }] : []),
          { id: 'url', label: 'Clone URL' },
        ]}
      />
      <div role="tabpanel" id={`panel-${source}`} aria-labelledby={`tab-${source}`} className={cx('animate-in')}>
        {source === 'github' && <GitHubSource busyUrl={busy} onPick={onPick} />}
        {source === 'codecommit' && <CodeCommitSource busyUrl={busy} onPick={onPick} />}
        {source === 'local' && <LocalSource busyUrl={busy} onPickLocal={onPickLocal} />}
        {source === 'url' && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) onPick(url.trim());
            }}
          >
            <Input id="clone-url" label="Clone URL" placeholder="https://github.com/org/repo.git or codecommit::eu-central-1://my-repo" value={url} onChange={(e) => setUrl(e.target.value)} help="GitHub (HTTPS or SSH) and CodeCommit (HTTPS, SSH or codecommit::) URLs work." />
            <div>
              <Button type="submit" variant="primary" icon={GitBranch} busy={busy === url.trim()} disabled={!url.trim()}>
                Read the repository
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
