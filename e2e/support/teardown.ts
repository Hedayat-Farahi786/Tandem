import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Removes the work folder the browser tests made for themselves (about 250 MB: Tandem's data,
 * git remotes, installed dependencies). Failure traces under results/ are kept, with a note of
 * where. A folder passed in TANDEM_E2E_DIR is the caller's and is left alone.
 */
export default function teardown(): void {
  const work = process.env.TANDEM_E2E_WORK;
  if (!work || process.env.TANDEM_E2E_OWN_DIR !== '1' || !existsSync(work)) return;
  const results = join(work, 'results');
  const failed = existsSync(results) && readdirSync(results).length > 0;
  for (const name of readdirSync(work)) if (name !== 'results' || !failed) rmSync(join(work, name), { recursive: true, force: true, maxRetries: 3 });
  if (failed) console.warn(`Browser test traces kept in ${results}`);
  else rmSync(work, { recursive: true, force: true });
}
