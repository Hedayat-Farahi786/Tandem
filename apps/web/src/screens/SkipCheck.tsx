import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SkipForward } from 'lucide-react';
import { post } from '../lib/api';
import { Button, Dialog, Textarea, useToast } from '../ui/kit';

/** The checks the owner can skip for a task, in plain words. */
export const CHECK_NAME: Record<string, string> = { install: 'install', lint: 'lint', typecheck: 'type check', build: 'build', test: 'tests', 'test-single': 'tests', integration: 'integration tests' };
export const SKIPPABLE = new Set(['install', 'lint', 'typecheck', 'build', 'test', 'test-single', 'integration']);

/**
 * "Skip for this task": for a check that fails or hangs for reasons outside the change (a test
 * runner that can't start on this machine, say). Tandem stops it if it's running, carries on without
 * it, and the pull request says it was skipped and why.
 */
export function SkipCheckButton({ taskId, repoId, repoName, kind, size = 'sm', variant = 'ghost', label = 'Skip for this task' }: { taskId: string; repoId?: string | undefined; repoName?: string | undefined; kind: string; size?: 'sm' | 'md'; variant?: 'ghost' | 'secondary'; label?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const check = kind === 'test-single' ? 'test' : kind;
  const name = `${CHECK_NAME[check] ?? check}${repoName ? ` in ${repoName}` : ''}`;
  const skip = useMutation({
    mutationFn: () => post<{ action: string }>(`/api/tasks/${taskId}/skip-check`, { ...(repoId ? { repoId } : {}), kind: check, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: (r) => {
      setOpen(false);
      setReason('');
      toast(r.action === 'rechecking' ? `Skipping ${name}; checking the rest again.` : `Skipping ${name} for this task.`, 'ok');
      void qc.invalidateQueries({ queryKey: ['task', taskId] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), 'danger'),
  });
  if (!SKIPPABLE.has(kind)) return null;
  return (
    <>
      <Button size={size} variant={variant} icon={SkipForward} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Skip ${name}?`}
        description="Tandem stops it if it's running and carries on without it for this task only. The pull request lists it as skipped, with your reason, so reviewers know it wasn't run."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Keep it</Button>
            <Button variant="primary" icon={SkipForward} busy={skip.isPending} onClick={() => skip.mutate()}>
              Skip {CHECK_NAME[check] ?? check}
            </Button>
          </>
        }
      >
        <Textarea label="Why? (optional)" optional value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Chrome isn't installed on this machine, so the browser tests can't start." />
      </Dialog>
    </>
  );
}
