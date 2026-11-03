import { join } from 'node:path';
import type { Paths } from '@tandem/core';

/** ~/.tandem layout: tandem.db, logs/, mirrors/, projects/<id>/<repo>/, tasks/<id>/<repo>/. */
export function tandemPaths(home: string): Paths & { db: string; logs: string; mirrors: string } {
  return {
    home,
    db: join(home, 'tandem.db'),
    logs: join(home, 'logs'),
    mirrors: join(home, 'mirrors'),
    taskDir: (taskId) => join(home, 'tasks', taskId),
    referenceRoot: (projectId) => join(home, 'projects', projectId),
    referenceDir: (projectId, repoName) => join(home, 'projects', projectId, repoName),
  };
}
