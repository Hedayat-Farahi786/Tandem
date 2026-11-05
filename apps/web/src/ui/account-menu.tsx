import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Download, LogOut, Plus, Trash2, type LucideIcon } from 'lucide-react';
import { api, del, post } from '../lib/api';
import { Avatar, Button, Dialog, Input, useToast } from './kit';
import { ActionMenu, type MenuItem } from './thread-actions';

/** A workspace that works on a company computer (its runner): its folders, keychain and sign-ins are that computer's. The page says so in a meta tag. */
export const isCompanyRunner = () => document.querySelector('meta[name="tandem-runner"]')?.getAttribute('content') === 'company';
/** A workspace in Tandem's cloud, where nothing of a computer (folders, keychain, profiles) is reachable. */
export const isCloud = () => !isCompanyRunner();
/** Where secrets are kept, in words. */
export const secretsKept = () => (isCompanyRunner() ? "in the keychain of the runner's computer" : 'encrypted, for this workspace only');

interface Me {
  user: { id: string; login: string; name: string; avatarUrl?: string };
  workspaces: Array<{ id: string; name: string; role: 'owner' | 'member' }>;
  current: string | null;
}

/**
 * Who is signed in, and their workspaces: switch, create one, export your data, delete your
 * account, sign out. In the sidebar.
 */
export function AccountMenu() {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<{ agent: string; localRepoCopies?: boolean }>('/api/bootstrap') });
  const testMode = boot.data && (boot.data.agent !== 'copilot' || boot.data.localRepoCopies) ? `Test mode · ${boot.data.agent !== 'copilot' ? `${boot.data.agent} agent` : 'local repos'}` : undefined;
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState('');
  const fresh = () => {
    // Another workspace: every screen's data is different.
    void qc.invalidateQueries();
    window.location.assign('/');
  };
  const use = useMutation({ mutationFn: (id: string) => post(`/api/workspaces/${id}/use`), onSuccess: fresh, onError: (e) => toast((e as Error).message, 'danger') });
  const create = useMutation({ mutationFn: () => post('/api/workspaces', { name }), onSuccess: fresh, onError: (e) => toast((e as Error).message, 'danger') });
  const remove = useMutation({ mutationFn: () => del('/api/me'), onSuccess: () => window.location.assign('/'), onError: (e) => toast((e as Error).message, 'danger') });
  const signOut = () => void post('/auth/sign-out').finally(() => window.location.assign('/'));
  if (!me.data) return <div className="h-11" />;
  const { user, workspaces, current } = me.data;
  const ws = workspaces.find((w) => w.id === current);
  const items: MenuItem[] = [
    ...workspaces
      .filter((w) => w.id !== current)
      .map((w): MenuItem => ({ label: `Switch to ${w.name}`, icon: Building2 as LucideIcon, run: () => use.mutate(w.id) })),
    { label: 'New workspace', icon: Plus, run: () => setCreating(true) },
    { label: 'Export my data', icon: Download, run: () => window.location.assign('/api/me/export') },
    { label: 'Sign out', icon: LogOut, run: signOut },
    { label: 'Delete my account', icon: Trash2, run: () => setDeleting(true), danger: true },
  ];
  return (
    <div className="group/acct flex items-center gap-2.5 rounded-xl px-2 py-1.5">
      <Avatar name={user.name} />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[13px] font-medium">{user.name}</p>
        <p className="truncate text-[12px] text-faint">{ws?.name ?? 'No workspace'}</p>
        {testMode && <p className="truncate text-[12px] text-warn">{testMode}</p>}
      </div>
      <ActionMenu label="Account and workspaces" items={items} />
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New workspace"
        description="A separate place for a team or a client: its own projects, tasks and connections."
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} busy={create.isPending} onClick={() => create.mutate()}>
              Create
            </Button>
          </>
        }
      >
        <Input id="ws-name" label="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" />
      </Dialog>
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete your account?"
        description="Your sign-in and connections are removed now. Workspaces only you own are deleted with everything in them. This can't be undone; export your data first if you want a copy."
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>Keep my account</Button>
            <Button variant="danger" icon={Trash2} busy={remove.isPending} onClick={() => remove.mutate()}>
              Delete my account
            </Button>
          </>
        }
      />
    </div>
  );
}
