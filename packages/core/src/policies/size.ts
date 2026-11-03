import type { SizeEstimate } from '@tandem/shared';

export interface SizeDecision {
  tooBig: boolean;
  reasons: string[];
}

/**
 * Too big for one reviewable change: more lines than the limit, three or more independent
 * features, or two that the estimate itself proposes to split. Two listed features without a
 * proposed split are usually one change seen from two sides (an endpoint and the page that shows
 * it), so they pass.
 */
export function decideSize(estimate: SizeEstimate, lineLimit: number): SizeDecision {
  const reasons: string[] = [];
  if (estimate.estimatedLines > lineLimit) reasons.push(`About ${estimate.estimatedLines} changed lines, over the ${lineLimit}-line limit for one review.`);
  const features = estimate.features.filter((f) => f.trim());
  if (features.length > 2 || (features.length === 2 && estimate.proposedSplit.length > 1)) reasons.push(`${features.length} independent features: ${features.join('; ')}.`);
  return { tooBig: reasons.length > 0, reasons };
}
