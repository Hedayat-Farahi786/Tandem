import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { redactor, type Logger } from '@tandem/core';

/** JSON logs under ~/.tandem/logs, one file per day, every value passed through the redactor. */
export function createLogger(dir: string, level: string): Logger & { pino: pino.Logger } {
  mkdirSync(dir, { recursive: true });
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
    pino.destination({ dest: file, mkdir: true, sync: false }),
  );
  return {
    pino: p,
    info: (msg, data) => p.info(data ?? {}, msg),
    warn: (msg, data) => p.warn(data ?? {}, msg),
    error: (msg, data) => p.error(data ?? {}, msg),
  };
}
