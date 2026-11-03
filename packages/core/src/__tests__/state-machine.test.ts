import { describe, expect, it } from 'vitest';
import { TASK_STATES } from '@tandem/shared';
import { TRANSITIONS, assertTransition, canTransition, firstStep, isStep, laneOf, nextStep, TransitionError } from '../state-machine.js';

describe('state machine', () => {
  it('follows the happy path', () => {
    const path = ['DRAFT', 'READINESS', 'SPEC_DRAFTING', 'SPEC_REVIEW', 'BUILDING', 'VERIFYING', 'SELF_REVIEW', 'PR_OPEN', 'DONE'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it('has an entry for every state and terminal states go nowhere', () => {
    for (const s of TASK_STATES) expect(TRANSITIONS[s]).toBeDefined();
    expect(TRANSITIONS.DONE).toEqual([]);
    expect(TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('rejects skipping approval and leaving terminal states', () => {
    expect(() => assertTransition('SPEC_DRAFTING', 'BUILDING', 'system')).toThrow(TransitionError);
    expect(() => assertTransition('DONE', 'READINESS', 'owner')).toThrow(/can't go from DONE/);
    expect(() => assertTransition('BUILDING', 'PR_OPEN', 'system')).toThrow();
  });

  it('lets blocked and failed tasks resume into work states only', () => {
    expect(canTransition('BLOCKED', 'SELF_REVIEW')).toBe(true);
    expect(canTransition('FAILED', 'BUILDING')).toBe(true);
    expect(canTransition('BLOCKED', 'DONE')).toBe(false);
    expect(canTransition('FAILED', 'DRAFT')).toBe(false);
  });

  it('only the owner cancels', () => {
    expect(() => assertTransition('BUILDING', 'CANCELLED', 'system')).toThrow(/Only owner/);
    expect(() => assertTransition('BUILDING', 'CANCELLED', 'owner')).not.toThrow();
  });

  it('knows steps and lanes', () => {
    expect(firstStep('BUILDING')).toBe('prepare-workspace');
    expect(nextStep('BUILDING', 'prepare-workspace')).toBe('implement');
    expect(nextStep('BUILDING', 'commit')).toBeUndefined();
    expect(() => nextStep('BUILDING', 'nope')).toThrow();
    expect(isStep('PR_OPEN', 'poll')).toBe(true);
    expect(firstStep('BLOCKED')).toBeUndefined();
    expect(laneOf('VERIFYING')).toBe('build');
    expect(laneOf('SPEC_DRAFTING')).toBe('read');
    expect(laneOf('PR_OPEN')).toBe('io');
  });
});
