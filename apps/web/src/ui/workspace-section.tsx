import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, LogOut, Trash2, Users } from 'lucide-react';
import { api, del, patch, post } from '../lib/api';
import { Avatar, Button, CopyButton, Dialog, Input, Row, Select, SettingsSection, Spinner, useToast } from './kit';
import { IconTile } from './visual';

interface WorkspaceInfo {
  id: string;
  name: string;
  role: 'owner' | 'member';
  me: string;
  copilotUserId: string | null;
  members: Array<{ id: string; login: string; name: string; role: 'owner' | 'member' }>;
}

/** The web app's workspace: its name, who is in it, invitation links, leaving and deleting it. */
export function WorkspaceSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['workspace'], queryFn: () => api<WorkspaceInfo>('/api/workspace') });
  const [name, setName] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => {
    for (const k of ['workspace', 'me']) void qc.invalidateQueries({ queryKey: [k] });
  };
  const fail = (e: unknown) => toast((e as Error).message, 'danger');
  const rename = useMutation({ mutationFn: (n: string) => patch('/api/workspace', { name: n }), onSuccess: () => (refresh(), setName(null), toast('Workspace renamed.', 'ok')), onError: fail });
  const makeInvite = useMutation({ mutationFn: () => post<{ url: string }>('/api/workspace/invites', { role: 'member' }), onSuccess: (r) => setInvite(r.url), onError: fail });
  const setRole = useMutation({ mutationFn: (v: { id: string; role: string }) => post(`/api/workspace/members/${v.id}/role`, { role: v.role }), onSuccess: refresh, onError: fail });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/workspace/members/${id}`),
    onSuccess: (_r, id) => (id === q.data?.me ? window.location.assign('/') : refresh()),
    onError: fail,
  });
  const destroy = useMutation({ mutationFn: () => del('/api/workspace'), onSuccess: () => window.location.assign('/'), onError: fail });
  const w = q.data;
  const intro = 'A workspace is a team\'s own space: its projects, tasks, connections and history, apart from every other workspace.';
  // The section is there from the start, so the section menu can follow it.
  if (!w)
    return (
      <SettingsSection id="workspace" icon={<IconTile icon={Users} />} title="Workspace" description={intro}>
        <p className="flex items-center gap-2.5 py-4 text-[13px] text-muted">
          {q.isError ? (q.error as Error).message : <><Spinner /> Loading the workspace…</>}
        </p>
      </SettingsSection>
    );
  const owner = w.role === 'owner';
  const soleOwner = owner && w.members.filter((m) => m.role === 'owner').length <= 1;
  return (
    <SettingsSection id="workspace" icon={<IconTile icon={Users} />} title="Workspace" description={intro}>
      <Row label="Name" htmlFor="ws-name" description={owner ? undefined : 'Only owners can rename it.'}>
        <div className="flex gap-2">
          <Input id="ws-name" disabled={!owner} value={name ?? w.name} onChange={(e) => setName(e.target.value)} />
          {owner && name !== null && name.trim() && name !== w.name && (
            <Button busy={rename.isPending} onClick={() => rename.mutate(name)}>
              Save
            </Button>
          )}
        </div>
      </Row>
      <div className="py-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[13.5px] font-medium">Members</p>
          {owner && (
            <Button size="sm" icon={Link2} busy={makeInvite.isPending} onClick={() => makeInvite.mutate()}>
              Invite people
            </Button>
          )}
        </div>
        {invite && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-accent-soft/50 px-3 py-2.5 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={invite}>
              {invite}
            </span>
            <CopyButton text={invite} label="Copy link" />
            <p className="w-full text-muted">Anyone with this link can join for 7 days, after signing in with GitHub.</p>
          </div>
        )}
        <ul className="flex flex-col divide-y divide-line rounded-xl shadow-[0_0_0_1px_var(--border)]">
          {w.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
              <Avatar name={m.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium">
                  {m.name}
                  {m.id === w.me && <span className="font-normal text-faint"> (you)</span>}
                </p>
                <p className="truncate text-[12px] text-muted">
                  @{m.login}
                  {m.id === w.copilotUserId ? ' · Copilot plan used here' : ''}
                </p>
              </div>
              {owner ? (
                <div className="w-32">
                  <Select id={`role-${m.id}`} label={`Role of ${m.name}`} hideLabel value={m.role} onChange={(role) => setRole.mutate({ id: m.id, role })} options={[{ value: 'owner', label: 'Owner' }, { value: 'member', label: 'Member' }]} />
                </div>
              ) : (
                <span className="text-[12.5px] text-muted">{m.role === 'owner' ? 'Owner' : 'Member'}</span>
              )}
              {(owner || m.id === w.me) && !(m.id === w.me && soleOwner) && (
                <Button size="sm" variant="ghost" icon={m.id === w.me ? LogOut : Trash2} onClick={() => remove.mutate(m.id)}>
                  {m.id === w.me ? 'Leave' : 'Remove'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {owner && (
        <Row label="Delete workspace" description="Deletes its projects, tasks, chats, connections and history for everyone. This can't be undone.">
          <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)}>
            Delete workspace
          </Button>
        </Row>
      )}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${w.name}?`}
        description="Everything in it is deleted for every member: projects, tasks, chats, connections and the audit log. Pull requests already opened stay on GitHub or CodeCommit."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Keep it</Button>
            <Button variant="danger" icon={Trash2} busy={destroy.isPending} onClick={() => destroy.mutate()}>
              Delete workspace
            </Button>
          </>
        }
      />
    </SettingsSection>
  );
}
