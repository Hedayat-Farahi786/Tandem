import { DEFAULT_SETTINGS, RuntimeConfig, Settings } from '@tandem/shared';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const int = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ConfigError(`${name} must be a whole number (got "${v}").`);
  return n;
};
const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number (got "${v}").`);
  return n;
};
const str = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** Which environment variable sets each overridable setting ("a.b" path). */
export const SETTING_ENV: Readonly<Record<string, string>> = {
  'copilot.host': 'COPILOT_GH_HOST',
  'copilot.cliPath': 'COPILOT_CLI_PATH',
  'copilot.buildModel': 'TANDEM_MODEL',
  'copilot.lightModel': 'TANDEM_LIGHT_MODEL',
  'aws.profile': 'TANDEM_AWS_PROFILE',
  'aws.region': 'TANDEM_AWS_REGION',
  'limits.maxConcurrentBuilds': 'TANDEM_MAX_CONCURRENT_BUILDS',
  'limits.buildTimeoutMin': 'TANDEM_BUILD_TIMEOUT_MIN',
  'budget.perTaskPrompts': 'TANDEM_BUDGET_PER_TASK',
  'budget.perDayPrompts': 'TANDEM_BUDGET_PER_DAY',
  'budget.perTaskCredits': 'TANDEM_CREDITS_PER_TASK',
  'budget.perDayCredits': 'TANDEM_CREDITS_PER_DAY',
};

/** The value at an "a.b" path of a settings object. */
export const settingAt = (s: unknown, path: string): unknown => path.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k] : undefined), s);

/**
 * The one typed config. Environment variables (documented in .env.example) override stored
 * settings. Secrets never come through here: they live in the OS keychain.
 */
export function loadConfig(env: Record<string, string | undefined>, homedir: string, joinPath: (...p: string[]) => string): RuntimeConfig {
  const host = str(env.TANDEM_HOST) ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new ConfigError(`Tandem only listens on 127.0.0.1 (TANDEM_HOST was "${host}"). Remove TANDEM_HOST.`);
  const overrides: Record<string, unknown> = {};
  const set = (path: string, value: unknown) => {
    if (value !== undefined) overrides[path] = value;
  };
  set('copilot.host', str(env.COPILOT_GH_HOST));
  set('copilot.cliPath', str(env.COPILOT_CLI_PATH));
  set('copilot.buildModel', str(env.TANDEM_MODEL));
  set('copilot.lightModel', str(env.TANDEM_LIGHT_MODEL));
  set('aws.profile', str(env.TANDEM_AWS_PROFILE));
  set('aws.region', str(env.TANDEM_AWS_REGION));
  set('limits.maxConcurrentBuilds', int(env.TANDEM_MAX_CONCURRENT_BUILDS, 'TANDEM_MAX_CONCURRENT_BUILDS'));
  set('limits.buildTimeoutMin', int(env.TANDEM_BUILD_TIMEOUT_MIN, 'TANDEM_BUILD_TIMEOUT_MIN'));
  set('budget.perTaskPrompts', int(env.TANDEM_BUDGET_PER_TASK, 'TANDEM_BUDGET_PER_TASK'));
  set('budget.perDayPrompts', int(env.TANDEM_BUDGET_PER_DAY, 'TANDEM_BUDGET_PER_DAY'));
  set('budget.perTaskCredits', num(env.TANDEM_CREDITS_PER_TASK, 'TANDEM_CREDITS_PER_TASK'));
  set('budget.perDayCredits', num(env.TANDEM_CREDITS_PER_DAY, 'TANDEM_CREDITS_PER_DAY'));
  const agent = str(env.TANDEM_AGENT) ?? 'copilot';
  const parsed = RuntimeConfig.safeParse({
    home: str(env.TANDEM_HOME) ?? joinPath(homedir, '.tandem'),
    host,
    port: int(env.TANDEM_PORT, 'TANDEM_PORT') ?? 4317,
    logLevel: str(env.TANDEM_LOG_LEVEL) ?? 'info',
    agent,
    overrides,
  });
  if (!parsed.success) throw new ConfigError(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** Stored settings with environment overrides applied ("a.b" paths). */
export function effectiveSettings(stored: Settings | undefined, overrides: Record<string, unknown>): Settings {
  const base: Record<string, unknown> = structuredClone(stored ?? DEFAULT_SETTINGS);
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.');
    let node = base;
    for (const k of keys.slice(0, -1)) {
      node[k] = (node[k] && typeof node[k] === 'object' ? node[k] : {}) as Record<string, unknown>;
      node = node[k] as Record<string, unknown>;
    }
    node[keys[keys.length - 1]!] = value;
  }
  return Settings.parse(base);
}
