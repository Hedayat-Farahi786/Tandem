import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyTemplate, workDir } from './env.js';
import { commitAll, git, tryGit } from './git.js';

export type Template = 'backend' | 'frontend' | 'fullstack';

/**
 * Seeds an EMPTY remote with a sandbox template on `main`. This is test-harness
 * setup, not Tandem behaviour: Tandem itself never pushes to a default branch.
 */
export async function seedRemote(url: string, template: Template, branch = 'main'): Promise<string> {
  const tmp = await workDir('seed');
  try {
    const dir = join(tmp.path, 'repo');
    await git(['clone', url, dir], { timeoutMs: 300_000 });
    const hasCommits = (await tryGit(['rev-parse', '--verify', 'HEAD'], { cwd: dir })).code === 0;
    if (hasCommits) throw new Error(`${url} already has commits. Seeding only runs on an empty repo.`);
    await git(['checkout', '-b', branch], { cwd: dir });
    await copyTemplate(template, dir);
    const sha = await commitAll(dir, `chore: seed ${template} sandbox from Tandem template`);
    await git(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, timeoutMs: 300_000 });
    return sha;
  } finally {
    await tmp.cleanup();
  }
}

/** A local bare repo standing in for CodeCommit, for rehearsals in environments without SSH access. */
export async function createLocalRemote(root: string, template: Template): Promise<string> {
  const bare = join(root, `${template}-remote.git`);
  await git(['init', '--bare', '--initial-branch=main', bare]);
  const url = pathToFileURL(bare).href;
  await seedRemote(url, template);
  return url;
}
