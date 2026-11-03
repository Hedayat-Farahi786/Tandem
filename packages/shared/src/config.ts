import { z } from 'zod';

/**
 * Settings the owner edits in the UI. Stored in the database (no secrets here, ever).
 * Environment variables override them; see `.env.example` and `@tandem/core` loadConfig().
 */
export const Settings = z.object({
  ownerName: z.string().default(''),
  copilot: z
    .object({
      /** GitHub host that provides Copilot, e.g. company.ghe.com. Empty = github.com. Passed as COPILOT_GH_HOST. */
      host: z.string().default(''),
      /** Model for build, fix and conflict sessions. Empty = runtime default. */
      buildModel: z.string().default(''),
      /** Model for chat, extraction, size, spec and review. Empty = cheapest enabled model. */
      lightModel: z.string().default(''),
      cliPath: z.string().default(''),
    })
    .default({ host: '', buildModel: '', lightModel: '', cliPath: '' }),
  aws: z.object({ profile: z.string().default(''), region: z.string().default('') }).default({ profile: '', region: '' }),
  limits: z
    .object({
      maxConcurrentBuilds: z.number().int().min(1).max(8).default(1),
      maxConcurrentReadOnly: z.number().int().min(1).max(8).default(2),
      chatTimeoutMin: z.number().int().min(1).default(5),
      readOnlyTimeoutMin: z.number().int().min(1).default(15),
      buildTimeoutMin: z.number().int().min(1).default(60),
      commandTimeoutMin: z.number().int().min(1).default(15),
      maxFixAttempts: z.number().int().min(0).max(5).default(2),
      sizeLineLimit: z.number().int().min(50).default(400),
      /** A task waits instead of installing dependencies when less disk space than this is free. */
      minFreeDiskGb: z.number().min(0.5).default(2),
    })
    .default({ maxConcurrentBuilds: 1, maxConcurrentReadOnly: 2, chatTimeoutMin: 5, readOnlyTimeoutMin: 15, buildTimeoutMin: 60, commandTimeoutMin: 15, maxFixAttempts: 2, sizeLineLimit: 400, minFreeDiskGb: 2 }),
  budget: z
    .object({
      perTaskPrompts: z.number().int().min(1).default(15),
      perDayPrompts: z.number().int().min(1).default(40),
      /** Abort a single agent run after this many model calls (agent loop runaway guard). */
      perRunModelCalls: z.number().int().min(5).default(60),
      /** AI credits one task may use; a run that reaches it stops at once and the task waits. */
      perTaskCredits: z.number().min(1).default(25),
      /** AI credits all of Tandem may use per day. */
      perDayCredits: z.number().min(1).default(75),
    })
    .default({ perTaskPrompts: 15, perDayPrompts: 40, perRunModelCalls: 60, perTaskCredits: 25, perDayCredits: 75 }),
  jira: z
    .object({
      baseUrl: z.string().default(''),
      /** Jira Cloud: email + API token (Basic). Data Center: leave empty and use a personal access token. */
      email: z.string().default(''),
      readyJql: z.string().default('status = "Ready for AI"'),
      inReviewStatus: z.string().default('In Review'),
      pollIntervalMin: z.number().int().min(1).default(5),
    })
    .default({ baseUrl: '', email: '', readyJql: 'status = "Ready for AI"', inReviewStatus: 'In Review', pollIntervalMin: 5 }),
  github: z.object({ apiBase: z.string().default('https://api.github.com') }).default({ apiBase: 'https://api.github.com' }),
  polling: z
    .object({
      prPollIntervalMin: z.number().int().min(1).default(5),
      /**
       * When the base branch changes under an open PR and they conflict, Tandem merges the base
       * into the PR branch, resolves the conflicts, runs every check and pushes (never a force
       * push). It never does this on a branch someone else has pushed to; those wait for a person.
       */
      fixConflicts: z.boolean().default(true),
    })
    .default({ prPollIntervalMin: 5, fixConflicts: true }),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = Settings.parse({});

/** Process-level configuration from the environment (fixed for the life of the process). */
export const RuntimeConfig = z.object({
  home: z.string().min(1),
  /** Always loopback; any other value is rejected by loadConfig(). */
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  /** Which AgentRuntime to use. "scripted" exists for tests only. */
  agent: z.enum(['copilot', 'scripted']),
  /** Settings overrides from the environment, applied on top of the stored settings. */
  overrides: z.record(z.string(), z.unknown()),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfig>;
