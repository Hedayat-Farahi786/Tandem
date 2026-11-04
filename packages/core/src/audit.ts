import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AuditEntry, AuditInput } from '@tandem/shared';

/** The previous hash of the first entry. */
export const AUDIT_GENESIS = '0'.repeat(64);

/** JSON with sorted keys, so the hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** SHA-256 over the previous hash and the entry without its own hashes. */
export function auditHash(prevHash: string, entry: Omit<AuditEntry, 'hash' | 'prevHash'>): string {
  return createHash('sha256').update(prevHash).update('\n').update(canonicalJson(entry)).digest('hex');
}

export interface AuditVerification {
  ok: boolean;
  count: number;
  /** The first entry whose hash or link does not match, when not ok. */
  brokenAt?: number;
  reason?: string;
  /** The hash of the last entry: write it down to prove later that nothing before it changed. */
  head: string;
}

/** Recomputes the chain from the first entry. Entries must be in sequence order. */
export function verifyAuditChain(entries: readonly AuditEntry[]): AuditVerification {
  let prev = AUDIT_GENESIS;
  let expectedSeq = 1;
  for (const e of entries) {
    const { hash, prevHash, ...rest } = e;
    if (e.seq !== expectedSeq) return { ok: false, count: entries.length, brokenAt: e.seq, reason: `Entry ${expectedSeq} is missing.`, head: prev };
    if (prevHash !== prev) return { ok: false, count: entries.length, brokenAt: e.seq, reason: `Entry ${e.seq} does not link to the entry before it.`, head: prev };
    if (auditHash(prevHash, rest) !== hash) return { ok: false, count: entries.length, brokenAt: e.seq, reason: `Entry ${e.seq} was changed after it was written.`, head: prev };
    prev = hash;
    expectedSeq++;
  }
  return { ok: true, count: entries.length, head: prev };
}

/** Builds the next entry in the chain. Both stores use it, so they hash identically. */
export function chainEntry(prev: { seq: number; hash: string } | undefined, input: AuditInput): AuditEntry {
  const { detail, ...rest } = input;
  const body = { ...rest, detail: detail ?? {}, seq: (prev?.seq ?? 0) + 1 };
  const prevHash = prev?.hash ?? AUDIT_GENESIS;
  return { ...body, prevHash, hash: auditHash(prevHash, body) };
}

export type AuditScope = { taskId?: string; since?: string; until?: string; afterSeq?: number; limit?: number };

export function auditMatches(e: AuditEntry, scope: AuditScope): boolean {
  return (!scope.taskId || e.taskId === scope.taskId) && (!scope.since || e.at >= scope.since) && (!scope.until || e.at < scope.until) && (!scope.afterSeq || e.seq > scope.afterSeq);
}

/**
 * The person acting in this request, when the app knows them (a member of a hosted workspace).
 * Entries "by the owner" name them instead of the one name in Settings.
 */
export const acting = new AsyncLocalStorage<{ name: string }>();

/** Who "the owner" is right now: the acting member, else the name in Settings ('' when none). */
export const ownerNameOf = (s: { ownerName: string }): string => acting.getStore()?.name.trim() || s.ownerName.trim();

/** `actorName` for an entry made by the owner, when their name is known. */
export const ownerOf = (s: { ownerName: string }): { actorName?: string } => {
  const name = ownerNameOf(s);
  return name ? { actorName: name } : {};
};
