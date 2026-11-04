import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteAccess } from './repo-git.js';

/*
 * Tandem as git's credential helper. git asks a tiny script, the script asks the running Tandem,
 * and Tandem answers with a CodeCommit password it signs from the AWS connection, or the token of
 * the GitHub account connected in Tandem. Nothing is written to git's config or to disk but the
 * helper and where to reach Tandem; no AWS CLI or GitHub CLI is needed.
 */

const SCRIPT = `#!/usr/bin/env node
// Written by Tandem. Asks the running Tandem for the credentials of a git remote it manages.
// Prints nothing when Tandem isn't running, so git carries on as it would without it.
import { readFileSync } from 'node:fs';
if (process.argv[2] !== 'get') process.exit(0);
const fields = {};
for (const line of readFileSync(0, 'utf8').split('\\n')) {
  const i = line.indexOf('=');
  if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
}
try {
  const { port, key } = JSON.parse(readFileSync(new URL('./git-credential.json', import.meta.url), 'utf8'));
  const res = await fetch('http://127.0.0.1:' + port + '/git/credential', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tandem-git-key': key }, body: JSON.stringify(fields), signal: AbortSignal.timeout(30000) });
  if (res.ok) {
    const c = await res.json();
    if (c.username && c.password) process.stdout.write('username=' + c.username + '\\npassword=' + c.password + '\\n');
  }
} catch {}
`;

/**
 * Writes the helper and where to reach this Tandem (owner-only files); returns the script path. The
 * key is the helper's own, never given to the web page, so no page can ask Tandem for a credential.
 */
export function installCredentialHelper(home: string, port: number, key: string): string {
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const script = join(dir, 'git-credential-tandem.mjs');
  writeFileSync(script, SCRIPT, { mode: 0o700 });
  writeFileSync(join(dir, 'git-credential.json'), JSON.stringify({ port, key }), { mode: 0o600 });
  try {
    chmodSync(join(dir, 'git-credential.json'), 0o600);
  } catch {
    // Windows: the file lives in the user's own profile folder.
  }
  return script;
}

/** HTTPS git through Tandem's helper (and nothing else: any helper set elsewhere is cleared first). */
export function tandemAccess(gitUrl: string, script: string): RemoteAccess {
  const helper = `!"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`;
  return {
    gitUrl,
    config: ['credential.helper=', `credential.helper=${helper}`, 'credential.useHttpPath=true'],
    mirrorConfig: [
      ['credential.helper', ''],
      ['credential.helper', helper],
      ['credential.useHttpPath', 'true'],
    ],
  };
}

/** A git credential request, as git sends it. */
export interface CredentialRequest {
  protocol?: string;
  host?: string;
  path?: string;
}
