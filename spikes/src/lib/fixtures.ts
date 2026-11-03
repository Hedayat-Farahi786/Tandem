/**
 * Recorded Copilot event streams become test fixtures for the agent-copilot adapter. They are
 * committed, so only the event types the adapter handles are kept, account-related fields are
 * dropped, long text is shortened, and everything passes through redact().
 */
import { redact } from './redact.js';

export const FIXTURE_EVENT_TYPES = new Set([
  'user.message',
  'assistant.turn_start',
  'assistant.message_start',
  'assistant.message',
  'assistant.reasoning',
  'assistant.usage',
  'assistant.turn_end',
  'assistant.idle',
  'tool.execution_start',
  'tool.execution_partial_result',
  'tool.execution_complete',
  'tool.shell_output',
  'permission.requested',
  'permission.completed',
  'session.idle',
  'session.error',
  'session.warning',
]);

/** Quota, billing identity and request ids say something about the account, not the protocol. */
const DROP_KEYS = new Set(['quotaSnapshots', 'accounting', 'apiCallId', 'providerCallId', 'serviceRequestId', 'requestBodyBytes', 'requestBodyWireBytes', 'requestBodyEncoding']);
const MAX_STRING = 1500;

function clean(value: unknown): unknown {
  if (typeof value === 'string') {
    const r = redact(value);
    return r.length > MAX_STRING ? `${r.slice(0, MAX_STRING)}…[${r.length - MAX_STRING} more chars]` : r;
  }
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!DROP_KEYS.has(k)) out[k] = clean(v);
    return out;
  }
  return value;
}

export function sanitizeEvent(e: { type: string; data?: unknown }): { type: string; data: unknown } | undefined {
  if (!FIXTURE_EVENT_TYPES.has(e.type)) return undefined;
  return { type: e.type, data: clean(e.data ?? {}) };
}

export function sanitizeStreams(streams: Record<string, Array<{ type: string; data?: unknown }>>): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(streams).map(([k, evs]) => [k, evs.map(sanitizeEvent).filter(Boolean)]));
}
