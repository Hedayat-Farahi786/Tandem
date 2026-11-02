import { homedir } from 'node:os';

/**
 * Spike-level redaction. The production version lives in packages/core and is
 * unit-tested; this one is deliberately conservative so reports are safe to commit.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY_ID]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bATATT[A-Za-z0-9_\-=]{20,}\b/g, '[REDACTED_ATLASSIAN_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(aws_secret_access_key|secret|password|passwd|token|api[_-]?key)(\s*[=:]\s*)("[^"]+"|'[^']+'|\S+)/gi, '$1$2[REDACTED]'],
  [/\bAPKA[0-9A-Z]{16}\b/g, '[REDACTED_SSH_KEY_ID]'],
];

const extraSecrets = new Set<string>();

/** Register an exact secret value (for example a token read from the environment) so it is always redacted. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) extraSecrets.add(value);
}

export function redact(input: string): string {
  let out = input;
  for (const secret of extraSecrets) out = out.split(secret).join('[REDACTED]');
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  const home = homedir();
  if (home.length > 1) out = out.split(home).join('~');
  return out;
}
