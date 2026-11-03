import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, FolderGit2, Pencil, Plus, ShieldCheck } from 'lucide-react';
import type { Project, Repo, RepoCommands, RepoRole, Rule } from '@tandem/shared';
import { api, post, put } from '../lib/api';
import type { Bootstrap } from '../lib/types';
import { Button, Card, LinkButton, Dialog, EmptyState, ErrorState, Input, Loading, PageHeader, Pill, RadioCards, Select, useToast } from '../ui/kit';
import { ROLE_LABEL } from './Setup';

const COMMANDS: Array<{ key: keyof RepoCommands; label: string; placeholder: string }> = [
  { key: 'install', label: 'Install', placeholder: 'npm ci' },
  { key: 'lint', label: 'Lint', placeholder: 'npm run lint' },
  { key: 'typecheck', label: 'Type-check', placeholder: 'npm run typecheck' },
  { key: 'build', label: 'Build', placeholder: 'npm run build' },
  { key: 'test', label: 'Test', placeholder: 'npm test' },
  { key: 'testSingle', label: 'Single test', placeholder: 'npx vitest run {file} -t {name}' },
];

export function RepoCommandsEditor({ value, onChange }: { value: RepoCommands; onChange: (c: RepoCommands) => void }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {COMMANDS.map((c) => (
        <Input
          key={c.key}
          label={c.label}
          optional
          className="font-mono text-[12.5px]"
          value={value[c.key] ?? ''}
          placeholder={c.placeholder}
          onChange={(e) => {
            const next = { ...value };
            if (e.target.value.trim()) next[c.key] = e.target.value;
            else delete next[c.key];
            onChange(next);
          }}
          {...(c.key === 'testSingle' ? { help: 'Runs one test per acceptance criterion. {file} and {name} are filled in.' } : {})}
        />
      ))}
    </div>
  );
}

function RepoDialog({ repo, onClose }: { repo: Repo; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState(repo);
  const save = useMutation({
    mutationFn: () => put<Repo>(`/api/repos/${repo.id}`, { defaultBranch: draft.defaultBranch, role: draft.role, commands: draft.commands, name: draft.name }),
    onSuccess: () => {
      toast(`Saved ${draft.name}.`, 'ok');
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Edit ${repo.name}`}
      description="Tandem runs these commands to verify every change. The build agent may run them too."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-3">
        <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <Input label="Default branch" value={draft.defaultBranch} onChange={(e) => setDraft({ ...draft, defaultBranch: e.target.value })} />
        <Select label="Role" value={draft.role} onChange={(role: RepoRole) => setDraft({ ...draft, role })} options={(Object.keys(ROLE_LABEL) as RepoRole[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
      </div>
      <RepoCommandsEditor value={draft.commands} onChange={(commands) => setDraft({ ...draft, commands })} />
      {save.isError && <ErrorState error={save.error} />}
    </Dialog>
  );
}

function ProjectDialog({ project, repos, jira, onClose }: { project: Project; repos: Repo[]; jira: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState({ ...project, pmNamesText: project.pmNames.join(', '), pmIdsText: project.jiraPmAccountIds.join(', ') });
  const save = useMutation({
    mutationFn: () =>
      put<Project>(`/api/projects/${project.id}`, {
        name: d.name,
        repoIds: d.repoIds,
        contractOrder: d.contractOrder,
        specRepoId: d.specRepoId,
        pmGate: d.pmGate,
        pmNames: d.pmNamesText.split(',').map((s) => s.trim()).filter(Boolean),
        jiraPmAccountIds: d.pmIdsText.split(',').map((s) => s.trim()).filter(Boolean),
        keyPrefix: d.keyPrefix,
        ...(d.integrationCommand?.trim() ? { integrationCommand: d.integrationCommand.trim() } : {}),
        ...(d.jiraJql?.trim() ? { jiraJql: d.jiraJql.trim() } : {}),
      }),
    onSuccess: () => {
      toast('Project saved.', 'ok');
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      onClose();
    },
  });
  const inProject = repos.filter((r) => d.repoIds.includes(r.id));
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Edit ${project.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Input label="Name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        <Input label="Task key prefix" value={d.keyPrefix} onChange={(e) => setD({ ...d, keyPrefix: e.target.value.toUpperCase() })} />
        <Select label="Spec is committed to" value={d.specRepoId} onChange={(specRepoId) => setD({ ...d, specRepoId })} options={inProject.map((r) => ({ value: r.id, label: r.name }))} />
        <Input label="Integration command" optional value={d.integrationCommand ?? ''} onChange={(e) => setD({ ...d, integrationCommand: e.target.value })} placeholder="npm run e2e" />
      </div>
      <RadioCards
        label="PM approval"
        value={d.pmGate}
        onChange={(pmGate) => setD({ ...d, pmGate })}
        columns={3}
        options={[
          { value: 'tandem', label: 'Recorded in Tandem', description: 'Share the spec, record the approval.' },
          { value: 'jira', label: 'Via Jira replies', description: jira ? 'Only configured PMs count.' : 'Set up Jira first.', disabled: !jira },
          { value: 'off', label: 'Off', description: 'Owner approval only.' },
        ]}
      />
      {d.pmGate === 'tandem' && <Input label="PM names" value={d.pmNamesText} onChange={(e) => setD({ ...d, pmNamesText: e.target.value })} help="Comma-separated." />}
      {d.pmGate === 'jira' && <Input label="Jira account IDs of PMs" value={d.pmIdsText} onChange={(e) => setD({ ...d, pmIdsText: e.target.value })} help="Only replies from these accounts count as approval." />}
      {jira && <Input label="Import query (JQL)" optional value={d.jiraJql ?? ''} onChange={(e) => setD({ ...d, jiraJql: e.target.value })} placeholder='project = SHOP AND status = "Ready for AI"' />}
      {save.isError && <ErrorState error={save.error} />}
    </Dialog>
  );
}

function RulesCard({ repos }: { repos: Repo[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<Rule[]>('/api/rules') });
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '');
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: () => post<Rule>('/api/rules', { repoId, text, source: 'Added in Tandem' }),
    onSuccess: () => {
      setText('');
      toast('Rule saved. It is committed to docs/agent-rules.md on the next task branch.', 'ok');
      void qc.invalidateQueries({ queryKey: ['rules'] });
    },
  });
  return (
    <Card title="Learned rules" description="Turn review feedback into rules the agent follows. Each is appended to docs/agent-rules.md on that repo's next task branch.">
      {repos.length > 0 && (
        <form
          className="mb-4 grid gap-3 md:grid-cols-[200px_1fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) add.mutate();
          }}
        >
          <Select label="Repository" value={repoId} onChange={setRepoId} options={repos.map((r) => ({ value: r.id, label: r.name }))} />
          <Input label="Rule" value={text} onChange={(e) => setText(e.target.value)} placeholder="Validate every query parameter with zod." />
          <Button type="submit" variant="primary" icon={Plus} busy={add.isPending} disabled={!text.trim()}>
            Add rule
          </Button>
        </form>
      )}
      {add.isError && <ErrorState error={add.error} />}
      {rules.isLoading ? (
        <Loading rows={2} />
      ) : !rules.data?.length ? (
        <p className="text-[13px] text-muted">No rules yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rules.data.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-4 py-2.5 text-[13px]">
              <span>
                <span className="font-medium">{repos.find((x) => x.id === r.repoId)?.name ?? 'Removed repo'}</span>
                <span className="text-muted"> · {r.text}</span>
              </span>
              <Pill tone={r.status === 'committed' ? 'ok' : 'accent'}>{r.status === 'committed' ? 'Committed' : 'Next task'}</Pill>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ProjectsScreen() {
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap') });
  const [editRepo, setEditRepo] = useState<Repo | null>(null);
  const [editProject, setEditProject] = useState<Project | null>(null);
  if (boot.isLoading) return <Loading />;
  if (boot.isError || !boot.data) return <ErrorState error={boot.error} retry={() => void boot.refetch()} />;
  const { projects, repos } = boot.data;
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Projects" subtitle="Repositories, their roles and commands, and how specs are approved." actions={<LinkButton to="/setup" icon={Plus}>Add repository</LinkButton>} />
      {projects.length === 0 && <EmptyState icon={FolderGit2} title="No projects yet" body="Run the setup wizard to add repositories and group them into a project." action={<LinkButton to="/setup" variant="primary">Open setup</LinkButton>} />}
      {projects.map((p) => (
        <Card
          key={p.id}
          title={<h2 className="font-serif text-[18px] font-medium">{p.name}</h2>}
          description={
            <span className="flex flex-wrap items-center gap-2">
              <span>Keys {p.keyPrefix}-1, {p.keyPrefix}-2…</span>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <ShieldCheck aria-hidden className="size-3.5" /> PM approval: {p.pmGate === 'tandem' ? 'recorded in Tandem' : p.pmGate === 'jira' ? 'via Jira' : 'off'}
              </span>
            </span>
          }
          actions={<Button size="sm" icon={Pencil} onClick={() => setEditProject(p)}>Edit project</Button>}
          padded={false}
        >
          <ul className="divide-y divide-line">
            {p.contractOrder.map((id, n) => {
              const r = repos.find((x) => x.id === id);
              if (!r) return null;
              return (
                <li key={id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {r.name}
                      {p.repoIds.length > 1 && <Pill>{n === 0 ? 'Built first' : `Step ${n + 1}`}</Pill>}
                      {p.specRepoId === r.id && <Pill tone="accent">Spec repo</Pill>}
                    </p>
                    <p className="mt-0.5 font-mono text-[12px] text-muted">{r.url}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill>{ROLE_LABEL[r.role]}</Pill>
                    <Pill>{[r.language, r.framework].filter(Boolean).join(' · ') || 'Unknown'}</Pill>
                    <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditRepo(r)}>
                      Edit
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
      <RulesCard repos={repos} />
      <p className="flex items-center gap-2 text-[12.5px] text-faint">
        <BookOpen aria-hidden className="size-3.5" />
        Tandem also reads each repo's .github/copilot-instructions.md and .github/agents/ as context.
      </p>
      {editRepo && <RepoDialog repo={editRepo} onClose={() => setEditRepo(null)} />}
      {editProject && <ProjectDialog project={editProject} repos={repos} jira={boot.data.jiraConfigured} onClose={() => setEditProject(null)} />}
    </div>
  );
}
