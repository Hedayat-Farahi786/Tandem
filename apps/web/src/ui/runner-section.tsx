import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Cloud, KeyRound, RefreshCw, Server } from 'lucide-react';
import { api, del, post } from '../lib/api';
import { relativeTime } from '../lib/format';
import { Button, Callout, CopyButton, Dialog, Pill, cx, useToast } from './kit';

/*
 * Where a web app workspace works: in Tandem's cloud, or on a company's own computer through its
 * runner (`tandem runner`). There, the workspace's data, repositories and sign-ins stay on that
 * computer; the web app only passes the members' requests to it.
 */

export interface RunnerInfo {
  mode: 'cloud' | 'company';
  connected: boolean;
  machine?: string;
  version?: string;
  connectedAt?: string;
  lastSeenAt?: string;
}
interface WorkspaceRunner {
  role: 'owner' | 'member';
  runner: RunnerInfo;
}

export const useWorkspaceRunner = (poll = false) =>
  useQuery({ queryKey: ['workspace'], queryFn: () => api<WorkspaceRunner & Record<string, unknown>>('/api/workspace'), refetchInterval: poll ? 3_000 : false });

function Command({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-2 py-1.5 pr-1.5 pl-3 shadow-[0_0_0_1px_var(--border)]">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12.5px] whitespace-nowrap [scrollbar-width:none]">{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

/** The status line of a company runner. */
function RunnerStatus({ r }: { r: RunnerInfo }) {
  return r.connected ? (
    <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
      <Pill tone="ok" dot>
        Connected
      </Pill>
      <span>
        {r.machine}
        {r.connectedAt ? ` · since ${relativeTime(r.connectedAt)}` : ''}
      </span>
    </p>
  ) : (
    <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
      <Pill tone="warn" dot>
        Not connected
      </Pill>
      <span>{r.lastSeenAt ? `Last seen ${relativeTime(r.lastSeenAt)}${r.machine ? ` on ${r.machine}` : ''}` : 'Not started yet'}</span>
    </p>
  );
}

/** The command to start the runner, shown once with its new key; it waits there for the runner. */
function NewKey({ command, install, onDone }: { command: string; install?: string; onDone: () => void }) {
  const q = useWorkspaceRunner(true);
  const connected = q.data?.runner.connected;
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl bg-accent-soft/40 p-4">
      {install && (
        <>
          <p className="text-[13.5px] font-medium">On the company computer, install Tandem once:</p>
          <Command text={install} />
        </>
      )}
      <p className="text-[13.5px] font-medium">{install ? 'Then start the runner:' : 'On the company computer, run:'}</p>
      <Command text={command} />
      <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-muted">
        <li>
          It needs Node.js 22.13 or later, git, and access to your repositories{install ? '' : ', and a copy of Tandem (the same one your team runs locally)'}. <code className="font-mono">tandem doctor</code> checks that computer.
        </li>
        <li>The key is shown only now. The runner keeps it in that computer's keychain, so the next start is just <code className="font-mono">tandem runner</code>.</li>
        <li>Only outgoing connections: nothing on that computer is opened to the network.</li>
      </ul>
      {connected ? (
        <Callout tone="ok" title={`Connected from ${q.data?.runner.machine ?? 'the company computer'}`} actions={<Button variant="primary" icon={RefreshCw} onClick={onDone}>Open the workspace</Button>}>
          The workspace now works there.
        </Callout>
      ) : (
        <p className="flex items-center gap-2 text-[12.5px] text-muted">
          <span aria-hidden className="size-2 animate-pulse rounded-full bg-warn" /> Waiting for the runner to connect…
        </p>
      )}
    </div>
  );
}

/** Settings › Workspace: where the workspace works, and (for owners) moving it. */
export function RunnerControls() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useWorkspaceRunner();
  const [ask, setAsk] = useState<'company' | 'key' | 'cloud' | null>(null);
  const [command, setCommand] = useState<{ command: string; install?: string } | null>(null);
  const fail = (e: unknown) => toast((e as Error).message, 'danger');
  const toCompany = useMutation({
    mutationFn: () => post<{ command: string; install?: string }>('/api/workspace/runner', {}),
    onSuccess: (r) => {
      setAsk(null);
      setCommand({ command: r.command, ...(r.install ? { install: r.install } : {}) });
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: fail,
  });
  const toCloud = useMutation({ mutationFn: () => del('/api/workspace/runner'), onSuccess: () => window.location.reload(), onError: fail });
  const w = q.data;
  if (!w) return null;
  const owner = w.role === 'owner';
  const r = w.runner;
  return (
    <div className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className={cx('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg', r.mode === 'company' ? 'bg-accent-soft text-accent-text' : 'bg-surface-3 text-muted')}>
            {r.mode === 'company' ? <Building2 className="size-4" /> : <Cloud className="size-4" />}
          </span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium">{r.mode === 'company' ? 'Works on a company computer' : "Works in Tandem's cloud"}</p>
            <p className="mt-0.5 text-[12.5px] text-muted">
              {r.mode === 'company' ? 'Its data, repositories, Copilot and AWS sign-ins stay on that computer. The web app passes requests to it.' : 'In the EU. Repositories are cloned there for each task, with the connections made in Settings.'}
            </p>
            {r.mode === 'company' && (
              <div className="mt-2">
                <RunnerStatus r={r} />
              </div>
            )}
          </div>
        </div>
        {owner && (
          <div className="flex flex-wrap gap-2">
            {r.mode === 'cloud' ? (
              <Button size="sm" icon={Server} onClick={() => setAsk('company')}>
                Use a company computer
              </Button>
            ) : (
              <>
                <Button size="sm" icon={KeyRound} onClick={() => setAsk('key')}>
                  New runner key
                </Button>
                <Button size="sm" variant="ghost" icon={Cloud} onClick={() => setAsk('cloud')}>
                  Move back to the cloud
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {command && <NewKey command={command.command} {...(command.install ? { install: command.install } : {})} onDone={() => window.location.reload()} />}
      <Dialog
        open={ask === 'company' || ask === 'key'}
        onClose={() => setAsk(null)}
        title={ask === 'key' ? 'Make a new runner key?' : 'Work on a company computer?'}
        description={
          ask === 'key'
            ? 'The current key stops working at once, and its runner disconnects. Start the runner again with the new key.'
            : "Tandem then works on a computer of yours (a work laptop, a VM or a server): with its git, SSH keys, AWS sign-in and Copilot account, in clones that are already there. Projects and tasks of this workspace live on that computer. What the workspace has in the cloud now is kept, and comes back if you move back."
        }
        footer={
          <>
            <Button onClick={() => setAsk(null)}>Cancel</Button>
            <Button variant="primary" icon={KeyRound} busy={toCompany.isPending} onClick={() => toCompany.mutate()}>
              Make a runner key
            </Button>
          </>
        }
      />
      <Dialog
        open={ask === 'cloud'}
        onClose={() => setAsk(null)}
        title="Move back to Tandem's cloud?"
        description="The runner's key stops working and the runner stops. Projects and tasks made on the company computer stay there; the workspace shows what it had in the cloud before."
        footer={
          <>
            <Button onClick={() => setAsk(null)}>Cancel</Button>
            <Button variant="primary" icon={Cloud} busy={toCloud.isPending} onClick={() => toCloud.mutate()}>
              Move back
            </Button>
          </>
        }
      />
    </div>
  );
}

/** In place of the app when the workspace's company runner isn't connected. */
export function RunnerOffline({ retry }: { retry: () => void }) {
  const q = useWorkspaceRunner(true);
  const r = q.data?.runner;
  const back = Boolean(r?.connected);
  // It just came back: load the workspace.
  useEffect(() => {
    if (back) retry();
  }, [back, retry]);
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 py-10">
      <span aria-hidden className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent-text">
        <Building2 className="size-5" />
      </span>
      <div>
        <h1 className="font-display text-[24px] leading-tight">The company runner isn't connected</h1>
        <p className="mt-2 text-[14px] text-muted">This workspace works on a company computer: its projects, tasks and repositories are there, so Tandem can open it only while the runner runs. On that computer, start it with:</p>
      </div>
      <Command text="tandem runner" />
      {r && q.data?.role !== 'owner' && <RunnerStatus r={r} />}
      <div className="flex flex-wrap gap-2">
        <Button icon={RefreshCw} onClick={retry}>
          Try again
        </Button>
      </div>
      {q.data?.role === 'owner' && (
        <div className="rounded-xl shadow-[0_0_0_1px_var(--border)] px-4">
          <RunnerControls />
        </div>
      )}
    </div>
  );
}
