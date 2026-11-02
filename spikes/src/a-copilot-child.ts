/**
 * Child process for spike a's restart test: creates a session with a known id, prints READY,
 * and waits to be killed (SIGKILL). No prompt is sent, so this costs nothing.
 */
import { makeClient, enforcedConfig } from './lib/copilot.js';
import type { Decision } from './lib/agent-policy.js';

const [root, sessionId, cliPath] = process.argv.slice(2);
if (!root || !sessionId) throw new Error('usage: a-copilot-child <root> <sessionId> [cliPath]');

const client = makeClient(cliPath && cliPath !== '-' ? cliPath : undefined);
await client.start();
const decisions: Decision[] = [];
const session = await client.createSession(enforcedConfig({ mode: 'build', root, decisions, sessionId }));
// Touch the session through the runtime so it has state worth resuming.
await session.rpc.tools.execute({ name: 'bash', arguments: { command: 'git push origin HEAD', description: 'denied on purpose' } }).catch(() => undefined);
process.stdout.write(`READY ${decisions.length}\n`);
await new Promise(() => undefined);
