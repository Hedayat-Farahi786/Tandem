import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, KeyRound, LogIn, LogOut, X } from 'lucide-react';
import { api, del, post } from '../lib/api';
import { BrandLogo } from './brands';
import { Button, Callout, Dialog, Input, RadioCards, Spinner, cx, useToast } from './kit';

/*
 * Connecting Jira in a few clicks. With Atlassian's sign-in: "Connect Jira", allow Tandem at
 * Atlassian, done (choosing the site when the account has several). Without it (Jira Data Center, or
 * a Tandem without an Atlassian app): paste any link from Jira and a token, which Tandem checks
 * before keeping. Once connected, people pick projects, statuses and PMs from lists, not queries.
 */

export interface JiraState {
  connected: boolean;
  method?: 'atlassian' | 'token';
  site?: { name: string; url: string };
  account?: string;
  sites?: Array<{ id: string; name: string; url: string }>;
  oauth: boolean;
}

/** Leaving for Atlassian's sign-in (a seam for tests, where the page can't navigate). */
export const leavePage = { to: (url: string) => window.location.assign(url) };

export const useJira = () => useQuery({ queryKey: ['jira'], queryFn: () => api<JiraState>('/api/jira') });

/** Statuses of the connected Jira (of one project, or all), for pickers. */
export const useJiraStatuses = (enabled: boolean, project?: string) =>
  useQuery({ queryKey: ['jira', 'statuses', project ?? ''], queryFn: () => api<{ statuses: string[] }>(`/api/jira/statuses${project ? `?project=${encodeURIComponent(project)}` : ''}`), enabled, staleTime: 60_000 });
export const useJiraProjects = (enabled: boolean) => useQuery({ queryKey: ['jira', 'projects'], queryFn: () => api<{ projects: Array<{ key: string; name: string }> }>('/api/jira/projects'), enabled, staleTime: 60_000 });

/** `status = "Ready for AI"` → Ready for AI; a query written by hand → undefined. */
export function statusOfQuery(jql: string): string | undefined {
  return /^\s*status\s*=\s*"([^"]+)"\s*$/i.exec(jql)?.[1];
}
export const queryOfStatus = (status: string) => `status = "${status.replace(/"/g, '')}"`;

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const key of [['jira'], ['bootstrap'], ['settings'], ['secrets']]) void qc.invalidateQueries({ queryKey: key });
  };
}

/** The address someone pasted: a Jira Cloud site (needs their email with the token), or Data Center. */
export function siteOf(input: string): { url: string; cloud: boolean } | undefined {
  let text = input.trim();
  if (!text) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = /^[a-z0-9-]+$/i.test(text) ? `https://${text}.atlassian.net` : `https://${text}`;
  try {
    const u = new URL(text);
    const cloud = /\.atlassian\.net$|\.jira\.com$/i.test(u.hostname);
    return { url: cloud ? `https://${u.hostname}` : `${u.protocol}//${u.host}${u.pathname.split(/\/(?:browse|secure|projects|issues)(?:\/|$)/)[0]!.replace(/\/+$/, '')}`, cloud };
  } catch {
    return undefined;
  }
}

function TokenDialog({ onClose }: { onClose: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [address, setAddress] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const site = siteOf(address);
  const connect = useMutation({
    mutationFn: () => post<JiraState>('/api/jira/token', { site: address, token, ...(site?.cloud ? { email } : {}) }),
    onSuccess: (s) => {
      refresh();
      toast(`Jira is connected${s.site ? ` to ${s.site.name}` : ''}${s.account ? ` as ${s.account}` : ''}.`, 'ok');
      onClose();
    },
  });
  const ready = Boolean(site && token.trim() && (!site.cloud || email.trim()));
  const tokenHelp: ReactNode = !site ? (
    'Paste your Jira address first.'
  ) : site.cloud ? (
    <>
      <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-accent-text hover:underline">
        Create a token
        <ArrowUpRight aria-hidden className="size-3.5" />
      </a>{' '}
      at Atlassian: choose <b>Create API token</b>, name it Tandem, and paste it here.
    </>
  ) : (
    <>
      <a href={`${site.url}/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-accent-text hover:underline">
        Create a personal access token
        <ArrowUpRight aria-hidden className="size-3.5" />
      </a>{' '}
      in your Jira profile, and paste it here.
    </>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Connect Jira with a token"
      description="Tandem checks the token with Jira before keeping it. Its comments in Jira appear under your name."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={connect.isPending} disabled={!ready} onClick={() => connect.mutate()}>
            Connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input label="Your Jira" autoFocus value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://your-company.atlassian.net" help="Paste any link from your Jira (an issue, a board), or just the site's name." />
        {site?.cloud && <Input label="Your Atlassian email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />}
        <Input label={site && !site.cloud ? 'Personal access token' : 'API token'} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} help={tokenHelp} />
        {connect.isError && <Callout tone="danger">{(connect.error as Error).message}</Callout>}
      </div>
    </Dialog>
  );
}

/** Choosing the site, when the Atlassian account reaches several. */
function SiteChoice({ sites }: { sites: NonNullable<JiraState['sites']> }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [id, setId] = useState(sites[0]!.id);
  const choose = useMutation({
    mutationFn: () => post<JiraState>('/api/jira/site', { id }),
    onSuccess: (s) => {
      refresh();
      toast(`Jira is connected to ${s.site?.name ?? 'your site'}.`, 'ok');
    },
  });
  const cancel = useMutation({ mutationFn: () => del('/api/jira'), onSuccess: refresh });
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-4 shadow-[0_0_0_1px_var(--border)]">
      <RadioCards label="Your Atlassian account reaches several Jira sites. Which one is this workspace's?" value={id} onChange={setId} options={sites.map((s) => ({ value: s.id, label: s.name, description: s.url.replace(/^https:\/\//, '') }))} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" busy={cancel.isPending} onClick={() => cancel.mutate()}>
          Cancel
        </Button>
        <Button variant="primary" busy={choose.isPending} onClick={() => choose.mutate()}>
          Use this site
        </Button>
      </div>
      {choose.isError && <Callout tone="danger">{(choose.error as Error).message}</Callout>}
    </div>
  );
}

/** Settings › Jira and the setup wizard: connect, see the connection, disconnect. */
export function JiraConnect({ from = 'settings' }: { from?: 'settings' | 'setup' }) {
  const q = useJira();
  const refresh = useRefresh();
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [returned, setReturned] = useState<string | null>(null);

  // Back from Atlassian: say how it went, once, and tidy the address.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const outcome = p.get('jira');
    if (!outcome) return;
    if (outcome === 'connected') toast('Jira is connected.', 'ok');
    if (outcome === 'failed') setReturned(p.get('message') || 'Jira could not be connected. Please try again.');
    refresh();
    p.delete('jira');
    p.delete('message');
    window.history.replaceState(null, '', `${window.location.pathname}${p.size ? `?${p}` : ''}${window.location.hash}`);
  }, []);

  const signIn = useMutation({
    mutationFn: () => post<{ url: string }>('/api/jira/oauth/start', { from }),
    onSuccess: (r) => leavePage.to(r.url),
  });
  const disconnect = useMutation({
    mutationFn: () => del<JiraState>('/api/jira'),
    onSuccess: () => {
      refresh();
      toast('Jira is disconnected.', 'ok');
    },
  });

  if (q.isLoading)
    return (
      <p className="flex items-center gap-2.5 py-3 text-[13px] text-muted">
        <Spinner /> Checking the Jira connection…
      </p>
    );
  const s = q.data;
  if (s?.sites?.length) return <SiteChoice sites={s.sites} />;
  if (s?.connected)
    return (
      <div className="flex items-center gap-3.5 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--border)]">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 shadow-[0_0_0_1px_var(--border)]">
          <BrandLogo brand="jira" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14.5px] font-semibold">{s.site?.name}</span>
            <span className="shrink-0 rounded-full bg-ok-soft px-2 py-px text-[11.5px] font-medium text-ok">Connected</span>
          </p>
          <p className="mt-0.5 truncate text-[12.5px] text-muted">
            {s.site?.url.replace(/^https?:\/\//, '')}
            {s.account ? ` · comments appear as ${s.account}` : ''}
            {s.method === 'token' ? ' · with a token' : ''}
          </p>
        </div>
        <Button size="sm" variant="ghost" icon={LogOut} busy={disconnect.isPending} onClick={() => disconnect.mutate()}>
          Disconnect
        </Button>
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      {returned && (
        <Callout tone="danger" title="Jira is not connected" actions={<Button size="sm" variant="ghost" icon={X} onClick={() => setReturned(null)} aria-label="Dismiss" />}>
          {returned}
        </Callout>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--border)]">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 shadow-[0_0_0_1px_var(--border)]">
          <BrandLogo brand="jira" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium">Connect your Jira</p>
          <p className="mt-0.5 text-[12.5px] text-muted">{s?.oauth ? 'Sign in at Atlassian and allow Tandem. That is all.' : 'Paste a link from your Jira and a token; Tandem checks it for you.'}</p>
        </div>
        <Button variant="primary" icon={s?.oauth ? LogIn : KeyRound} busy={signIn.isPending} onClick={() => (s?.oauth ? signIn.mutate() : setDialog(true))}>
          Connect Jira
        </Button>
      </div>
      {s?.oauth && (
        <button type="button" onClick={() => setDialog(true)} className={cx('self-start px-1 text-[12.5px] font-medium text-muted hover:text-fg hover:underline')}>
          Jira Data Center, or a token instead
        </button>
      )}
      {signIn.isError && <Callout tone="danger">{(signIn.error as Error).message}</Callout>}
      {dialog && <TokenDialog onClose={() => setDialog(false)} />}
    </div>
  );
}

/** Choosing PMs by name: their replies in Jira approve a spec. */
export function JiraPeoplePicker({ ids, names, onChange }: { ids: string[]; names: Record<string, string>; onChange: (ids: string[], names: Record<string, string>) => void }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const found = useQuery({ queryKey: ['jira', 'people', debounced], queryFn: () => api<{ people: Array<{ id: string; name: string }> }>(`/api/jira/people?query=${encodeURIComponent(debounced)}`), enabled: debounced.length >= 2 });
  const add = (p: { id: string; name: string }) => {
    if (!ids.includes(p.id)) onChange([...ids, p.id], { ...names, [p.id]: p.name });
    setQuery('');
  };
  const remove = (id: string) => {
    const { [id]: _gone, ...rest } = names;
    onChange(
      ids.filter((x) => x !== id),
      rest,
    );
  };
  const results = (found.data?.people ?? []).filter((p) => !ids.includes(p.id));
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium">PMs who approve in Jira</span>
      {ids.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Chosen PMs">
          {ids.map((id) => (
            <li key={id} className="flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-1 pl-2.5 text-[12.5px] shadow-[0_0_0_1px_var(--border)]">
              {names[id] ?? id}
              <button type="button" onClick={() => remove(id)} aria-label={`Remove ${names[id] ?? id}`} className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-fg">
                <X aria-hidden className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input aria-label="Add a PM" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Jira by name" help="Only their replies count: “approve”, or “changes: …”." />
      {debounced.length >= 2 && (
        <div className="rounded-lg bg-surface shadow-[0_0_0_1px_var(--border)]">
          {found.isLoading ? (
            <p className="flex items-center gap-2 px-3 py-2 text-[12.5px] text-muted">
              <Spinner /> Searching Jira…
            </p>
          ) : results.length ? (
            <ul aria-label="People in Jira">
              {results.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => add(p)} className="w-full px-3 py-2 text-left text-[13px] hover:bg-surface-2">
                    {p.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-[12.5px] text-muted">{found.isError ? (found.error as Error).message : `Nobody in Jira matches “${debounced}”.`}</p>
          )}
        </div>
      )}
    </div>
  );
}
