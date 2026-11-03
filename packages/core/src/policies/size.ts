import type { SizeEstimate } from '@tandem/shared';

export interface SizeDecision {
  tooBig: boolean;
  reasons: string[];
}

/** Too big for one reviewable change: several independent features, or more lines than the limit. */
export function decideSize(estimate: SizeEstimate, lineLimit: number): SizeDecision {
  const reasons: string[] = [];
  if (estimate.estimatedLines > lineLimit) reasons.push(`About ${estimate.estimatedLines} changed lines, over the ${lineLimit}-line limit for one review.`);
  const features = estimate.features.filter((f) => f.trim());
  if (features.length > 1) reasons.push(`${features.length} independent features: ${features.join('; ')}.`);
  return { tooBig: reasons.length > 0, reasons };
}
