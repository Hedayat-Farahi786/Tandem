/**
 * Seeds empty sandbox repos with the templates in spikes/sandbox.
 *
 *   pnpm spike:seed -- fullstack ssh://git-codecommit.<region>.amazonaws.com/v1/repos/tandem-sandbox-fullstack
 *   pnpm spike:seed -- backend   <ssh-url>
 *   pnpm spike:seed -- frontend  <ssh-url>
 */
import { spikeEnv } from './lib/env.js';
import { resolveRemote } from './lib/git.js';
import { seedRemote, type Template } from './lib/sandbox.js';

const [template, url] = process.argv.slice(2).filter((a) => a !== '--');
const templates: Template[] = ['backend', 'frontend', 'fullstack'];

if (!template || !url || !templates.includes(template as Template)) {
  console.error('Usage: pnpm spike:seed -- <backend|frontend|fullstack> <ssh-url-of-empty-repo>');
  process.exit(2);
}

try {
  const remote = resolveRemote(url, spikeEnv().awsProfile);
  const sha = await seedRemote(remote.gitUrl, template as Template);
  console.log(`Seeded ${url} with the ${template} template on main (${sha.slice(0, 8)}).`);
} catch (err) {
  console.error(`Could not seed ${url}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
