import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { findSiteIcon, type SiteIcon } from '@tandem/adapters';
import type { Project, Repo } from '@tandem/shared';
import { HttpError, type ServerContext } from '../app.js';

/** The repositories most likely to hold the site: the spec repo, then frontend and full-stack ones. */
const rank = (p: Project, r: Repo) => (r.id === p.specRepoId && r.role !== 'backend' ? 0 : r.role === 'frontend' ? 1 : r.role === 'full-stack' ? 2 : r.role === 'other' ? 3 : 4);

/** Each project shows its website's own icon, read from its repositories' default branch. */
export function registerIconRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { tandem } = ctx;
  const cache = new Map<string, { at: number; icon: SiteIcon | undefined }>();
  const TTL = 60_000;

  const iconFor = async (p: Project): Promise<SiteIcon | undefined> => {
    const hit = cache.get(p.id);
    if (hit && Date.now() - hit.at < TTL) return hit.icon;
    const repos = (await Promise.all(p.repoIds.map((id) => tandem.store.repos.get(id)))).filter((r): r is Repo => Boolean(r)).sort((a, b) => rank(p, a) - rank(p, b));
    let icon: SiteIcon | undefined;
    for (const repo of repos) {
      const mirror = tandem.hostFor(repo).mirrorPath(repo);
      if (!existsSync(mirror)) continue;
      icon = await findSiteIcon(mirror, `refs/remotes/origin/${repo.defaultBranch}`);
      if (icon) break;
    }
    cache.set(p.id, { at: Date.now(), icon });
    return icon;
  };

  /** Which projects have an icon, with a version for cache busting. Lets the page skip missing ones. */
  app.get('/api/project-icons', async () => {
    const projects = await tandem.store.projects.list();
    const out: Record<string, { v: string } | null> = {};
    for (const p of projects) {
      const icon = await iconFor(p);
      out[p.id] = icon ? { v: icon.blob.slice(0, 12) } : null;
    }
    return out;
  });

  app.get('/api/projects/:id/icon', async (req, reply) => {
    const p = await tandem.store.projects.get((req.params as { id: string }).id);
    if (!p) throw new HttpError(404, 'Project not found.');
    const icon = await iconFor(p);
    if (!icon) throw new HttpError(404, 'This project has no site icon.');
    // The file comes from a repository: never let it run script, even when opened directly.
    return reply
      .type(icon.type)
      .header('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'private, max-age=300')
      .header('ETag', `"${icon.blob}"`)
      .send(icon.bytes);
  });
}
