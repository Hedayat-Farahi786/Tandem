/**
 * Secret redaction for every log line, stored event, chat message, command output, PR description
 * and tracker comment. Pattern-based, plus the exact values of secrets Tandem holds at runtime.
 */
const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY_ID]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bATATT[A-Za-z0-9_\-=]{20,}\b/g, '[REDACTED_ATLASSIAN_TOKEN]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/\b(Authorization:\s*(?:Bearer|Basic|token))\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b(aws_secret_access_key|aws_session_token|secret|password|passwd|pwd|token|api[_-]?key|client[_-]?secret)(\s*[=:]\s*)("[^"]+"|'[^']+'|[^\s"',;]+)/gi, '$1$2[REDACTED]'],
  [/(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/([^:\s/]+):([^@\s/]+)@/gi, '$1://$2:[REDACTED]@'],
];

export class Redactor {
  private readonly secrets = new Set<string>();

  /** Registers an exact secret value (for example the Jira token read from the keychain). */
  register(value: string | undefined | null): void {
    if (value && value.length >= 6) this.secrets.add(value);
  }

  redact(input: string): string {
    let out = input;
    for (const s of this.secrets) out = out.split(s).join('[REDACTED]');
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  }

  /** Redacts every string inside a JSON-like value. */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactDeep(v)])) as T;
    }
    return value;
  }
}

/** Process-wide redactor used by loggers and stores. */
export const redactor = new Redactor();
export const redact = (s: string): string => redactor.redact(s);
