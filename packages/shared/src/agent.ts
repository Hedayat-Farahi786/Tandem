import { z } from 'zod';
import { Criterion, SizeEstimate } from './domain.js';

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

export const ResolveFindingArgs = z.object({ id: z.string(), status: z.enum(['fixed', 'dismissed']), note: z.string().default('') });
export type ResolveFindingArgs = z.infer<typeof ResolveFindingArgs>;
