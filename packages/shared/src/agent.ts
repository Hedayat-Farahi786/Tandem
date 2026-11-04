import { z } from 'zod';
import { Criterion, SizeEstimate, SkippableCheck } from './domain.js';

/** Structured outputs the agent returns. Code validates them; the model never decides a gate. */

export const ExtractedRequirement = z.object({
  title: z.string(),
  goal: z.string(),
  userStory: z.string(),
  criteria: z.array(Criterion),
  exampleData: z.string(),
  affectedAreas: z.string(),
  outOfScope: z.string(),
  openQuestions: z.array(z.string()),
  affectedRepos: z.array(z.string()),
  size: SizeEstimate,
});
export type ExtractedRequirement = z.infer<typeof ExtractedRequirement>;

export const ReviewOutput = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['high', 'medium', 'low']),
      category: z.enum(['spec', 'criteria', 'rules', 'security', 'other']),
      repo: z.string().optional(),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
      title: z.string(),
      detail: z.string(),
    }),
  ),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/** Arguments of the custom tools Tandem gives the agent. */
export const RecordTestArgs = z.object({
  criterion: z.number().int().positive(),
  repo: z.string(),
  file: z.string(),
  name: z.string(),
});
export type RecordTestArgs = z.infer<typeof RecordTestArgs>;

/** The build agent names its change: the commit and pull request title, and a line or two on what changed. */
export const NameChangeArgs = z.object({ title: z.string(), body: z.string().default('') });
export type NameChangeArgs = z.infer<typeof NameChangeArgs>;

export const ResolveFindingArgs = z.object({ id: z.string(), status: z.enum(['fixed', 'dismissed']), note: z.string().default('') });
export type ResolveFindingArgs = z.infer<typeof ResolveFindingArgs>;

/** Request mode: the agent updates the draft requirement through this tool. */
export const DraftUpdateArgs = z.object({
  title: z.string().optional(),
  goal: z.string().optional(),
  userStory: z.string().optional(),
  criteria: z.array(Criterion).optional(),
  exampleData: z.string().optional(),
  affectedAreas: z.string().optional(),
  outOfScope: z.string().optional(),
  openQuestions: z.array(z.string()).optional(),
  affectedRepos: z.array(z.string()).optional(),
  size: SizeEstimate.optional(),
});
export type DraftUpdateArgs = z.infer<typeof DraftUpdateArgs>;

/**
 * Request mode: the agent asks the owner 1 to 3 short questions with likely answers to pick from.
 * The owner can always write their own answer instead, so the options never include "Other".
 */
export const AskOwnerArgs = z.object({
  questions: z
    .array(
      z.object({
        /** One to three words, shown as a chip, e.g. "Loading state". */
        header: z.string(),
        /** One short, clear question. */
        question: z.string(),
        options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(2).max(4),
        /** True when several answers can apply. */
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(3),
});
export type AskOwnerArgs = z.infer<typeof AskOwnerArgs>;

/** Task chat: the agent proposes a spec change; the owner confirms it in the UI. */
export const SpecChangeArgs = z.object({
  kind: z.enum(['redraft', 'edit']),
  summary: z.string(),
  feedback: z.string().optional(),
  markdown: z.string().optional(),
});
export type SpecChangeArgs = z.infer<typeof SpecChangeArgs>;

/** Task chat: rename the task (and its pull requests) when the owner asks. */
export const RenameTaskArgs = z.object({ title: z.string() });
export type RenameTaskArgs = z.infer<typeof RenameTaskArgs>;

/** Task chat: the agent proposes how the task should go on; the owner confirms. */
export const ContinueArgs = z.object({
  /** One line for the owner, e.g. "Fix the failing date test by using UTC". */
  summary: z.string(),
  /** Clear instructions for the agent that does the work. */
  guidance: z.string(),
  /**
   * Checks to skip for this task, when the owner wants that: e.g. tests that can't run on this
   * machine. `repo` is the repo's folder name; leave it out for the project's integration check.
   */
  skipChecks: z.array(z.object({ repo: z.string().optional(), kind: SkippableCheck })).optional(),
});
export type ContinueArgs = z.infer<typeof ContinueArgs>;
