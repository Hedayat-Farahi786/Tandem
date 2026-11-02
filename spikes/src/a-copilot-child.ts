/**
 * Child process for spike a's restart test. It starts a session with a known id, asks the
 * model to remember a code word, then starts a long answer. The parent kills this process
 * (SIGKILL) as soon as the long answer starts streaming, then resumes the session.
 *
 * Protocol on stdout: "READY" after the first turn, "STREAMING" on the first delta of the second.
 */
import { makeClient, enforcedConfig } from './lib/copilot.js';
import type { Decision } from './lib/agent-policy.js';

const [root, sessionId, codeWord, cliPath, model] = process.argv.slice(2);
if (!root || !sessionId || !codeWord) throw new Error('usage: a-copilot-child <root> <sessionId> <codeWord> [cliPath] [model]');

const client = makeClient(cliPath && cliPath !== '-' ? cliPath : undefined);
await client.start();
const decisions: Decision[] = [];
const session = await client.createSession(enforcedConfig({ mode: 'read-only', root, decisions, sessionId, ...(model && model !== '-' ? { model } : {}) }));
await session.sendAndWait({ prompt: `Remember this code word for later: ${codeWord}. Reply with only the word OK.` }, 180_000);
process.stdout.write('READY\n');
let announced = false;
session.on('assistant.message_delta', () => {
  if (!announced) {
    announced = true;
    process.stdout.write('STREAMING\n');
  }
});
await session.send({ prompt: 'Without using any tools, write a 600-word essay about version control.' });
// Keep the process alive until the parent kills it.
await new Promise(() => undefined);
