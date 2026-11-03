import { z } from 'zod';

/** A Copilot model as Tandem shows it. Prices are in AI credits per million tokens. */
export const ModelOption = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  price: z.object({ input: z.number(), output: z.number(), cachedInput: z.number().optional() }).optional(),
  /** Older premium-request billing: cost per prompt relative to the base rate. */
  multiplier: z.number().optional(),
  /** Copilot's "auto" model bills routed requests at a discount. */
  discountPercent: z.number().optional(),
  contextWindow: z.number().optional(),
  maxOutput: z.number().optional(),
  vision: z.boolean().default(false),
  /** Reasoning effort levels the model supports, lowest first. */
  reasoning: z.array(z.string()).default([]),
});
export type ModelOption = z.infer<typeof ModelOption>;

/**
 * Tokens of a typical small task, chat included: request chat, spec, build, checks and review,
 * about 20 model calls. Most input is cached context the agent loop sends again on each call.
 * Calibrated on live Copilot runs (gpt-6-luna, 2026-11-03): 1.1 credits for a one-repo task and
 * 1.4 for a two-repo task; this profile gives 1.3 on that model.
 */
export const TYPICAL_TASK_TOKENS = { cachedInput: 500_000, input: 40_000, output: 8_000 } as const;

/** Estimated AI credits for a typical task on this model (undefined when it has no token prices). */
export function estimateTaskCredits(m: Pick<ModelOption, 'price'>): number | undefined {
  const p = m.price;
  if (!p) return undefined;
  const t = TYPICAL_TASK_TOKENS;
  return (t.cachedInput * (p.cachedInput ?? p.input) + t.input * p.input + t.output * p.output) / 1e6;
}

export function vendorOf(id: string): string {
  if (/^claude/i.test(id)) return 'Anthropic';
  if (/^(gpt|o\d|codex)/i.test(id)) return 'OpenAI';
  if (/^gemini/i.test(id)) return 'Google';
  if (/^mai/i.test(id)) return 'Microsoft';
  if (/^grok/i.test(id)) return 'xAI';
  return 'Other';
}
