import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { openDatabase } from '@tandem/adapters';

/*
 * Backups of Tandem's data: every database under TANDEM_HOME, copied consistently while Tandem
 * runs (SQLite's VACUUM INTO). That is the directory (one replica), the local app's database and
 * each workspace's: projects, tasks, chats, approvals, the audit log. Repository mirrors and task
 * folders are not included: they come back from the repositories, and a task that was building
 * starts its step again. With Postgres, back the directory up with the database's own backups.
 */

const FORMAT = 'tandem-backup';

/** The databases under a Tandem home, relative to it. */
function databases(home: string): string[] {
  const out: string[] = [];
  for (const f of ['directory.db', 'tandem.db']) if (existsSync(join(home, f))) out.push(f);
  const ws = join(home, 'workspaces');
  if (existsSync(ws)) for (const id of readdirSync(ws)) if (!id.startsWith('.') && existsSync(join(ws, id, 'tandem.db'))) out.push(join('workspaces', id, 'tandem.db'));
  return out;
}

export interface Manifest {
  format: typeof FORMAT;
  version: 1;
  createdAt: string;
  tandemVersion: string;
  databases: string[];
}

/** Copies every database of `home` to the (new or empty) folder `to`. */
export async function backup(home: string, to: string, tandemVersion: string): Promise<Manifest> {
  if (existsSync(to) && readdirSync(to).length) throw new Error(`${to} is not empty. Back up into a new folder.`);
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const dbs = databases(home);
  if (!dbs.length) throw new Error(`There is no Tandem data in ${home}.`);
  for (const rel of dbs) {
    const dest = join(to, rel);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const db = await openDatabase(join(home, rel));
    try {
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  }
  const manifest: Manifest = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), tandemVersion, databases: dbs };
  writeFileSync(join(to, 'tandem-backup.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

/** Puts a backup's databases into `home` (Tandem stopped). Refuses to overwrite data unless `force`. */
export function restore(from: string, home: string, o: { force?: boolean } = {}): Manifest {
  const file = join(from, 'tandem-backup.json');
  if (!existsSync(file)) throw new Error(`${from} is not a Tandem backup (no tandem-backup.json).`);
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  if (m.format !== FORMAT || m.version !== 1) throw new Error('This backup is from a format this Tandem does not know.');
  const root = resolve(home);
  for (const rel of m.databases) {
    const dest = resolve(root, rel);
    if (!dest.startsWith(root + sep) || relative(root, dest).startsWith('..')) throw new Error(`The backup names a file outside the data folder: ${rel}.`);
    if (existsSync(dest) && !o.force) throw new Error(`${dest} exists. Restore into an empty data folder, or pass --force to replace it.`);
  }
  for (const rel of m.databases) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    for (const extra of ['-wal', '-shm', '-journal']) rmSync(`${dest}${extra}`, { force: true });
    copyFileSync(join(from, rel), dest);
  }
  return m;
}
