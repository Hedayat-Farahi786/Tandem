import type * as Sqlite from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';

let loaded: typeof Sqlite | undefined;

/**
 * Loads node:sqlite (Node >= 22.13) without its one-time ExperimentalWarning for this module only;
 * other warnings are untouched.
 */
export async function openDatabase(path: string): Promise<DatabaseSync> {
  if (!loaded) {
    const original = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : warning.message;
      if (/SQLite is an experimental feature/.test(text)) return;
      return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      loaded = await import('node:sqlite');
    } finally {
      process.emitWarning = original;
    }
  }
  return new loaded.DatabaseSync(path);
}
