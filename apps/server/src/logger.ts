import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { redactor, type Logger } from '@tandem/core';

export const LOG_DAYS = 14;

/** Deletes Tandem's daily log files older than `days` days. Returns the names removed. */
export function pruneLogs(dir: string, days = LOG_DAYS, now = new Date()): string[] {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const day = /^tandem-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)?.[1];
    if (day && day < cutoff) {
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

/**
 * JSON logs under ~/.tandem/logs, one file per start day, every value passed through the
 * redactor. Files older than 14 days are deleted at start.
 */
export function createLogger(dir: string, level: string, o: { stdout?: boolean } = {}): Logger & { pino: pino.Logger } {
  mkdirSync(dir, { recursive: true });
  pruneLogs(dir);
  const file = join(dir, `tandem-${new Date().toISOString().slice(0, 10)}.log`);
  const p = pino(
    {
      level,
      base: { pid: process.pid },
      formatters: { log: (obj) => redactor.redactDeep(obj) },
      hooks: {
        logMethod(args, method) {
          method.apply(this, args.map((a) => (typeof a === 'string' ? redactor.redact(a) : a)) as Parameters<typeof method>);
        },
      },
    },
    // In a container the platform collects stdout; the file stays for `tandem` on a computer.
    o.stdout ? pino.multistream([{ stream: pino.destination({ dest: file, mkdir: true, sync: false }) }, { stream: pino.destination({ dest: 1, sync: false }) }]) : pino.destination({ dest: file, mkdir: true, sync: false }),
  );
  return {
    pino: p,
    info: (msg, data) => p.info(data ?? {}, msg),
    warn: (msg, data) => p.warn(data ?? {}, msg),
    error: (msg, data) => p.error(data ?? {}, msg),
  };
}
