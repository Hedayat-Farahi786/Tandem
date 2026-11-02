/**
 * Spike a: GitHub Copilot SDK with the existing Copilot CLI login.
 *
 *   pnpm spike:a                      (sandbox repo is a local bare repo seeded from spikes/sandbox/backend)
 *   TANDEM_SPIKE_REPO_URL=<ssh-url> pnpm spike:a   (worktree of the CodeCommit sandbox instead)
 *   COPILOT_CLI_PATH=$(which copilot) pnpm spike:a (use the installed CLI instead of the SDK's bundled runtime)
 *   TANDEM_SPIKE_MODEL=<id> pnpm spike:a           (pick a model; default is the runtime default)
 *
 * Uses about 8 premium requests. No tokens are passed: GH_TOKEN, GITHUB_TOKEN and
 * COPILOT_GITHUB_TOKEN are removed from the runtime's environment on purpose.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import type { Decision } from './lib/agent-policy.js';
import { enforcedConfig, makeClient, runTurn, runtimeEnv } from './lib/copilot.js';
import { shortId, spikeEnv, workDir } from './lib/env.js';
import { packageManagerCommand, run, which } from './lib/exec.js';
import { addWorktree, bareClone, git, lsRemoteHeads, remoteDefaultBranch } from './lib/git.js';
import { Report, check } from './lib/report.js';
import { createLocalRemote } from './lib/sandbox.js';

const env = spikeEnv();
const report = new Report('a-copilot', 'Spike a: Copilot SDK with the existing Copilot CLI login');
const work = await workDir('spike-a');
const id = shortId();
const branch = `agent/spike-${id}-copilot`;
const sessionsToDelete = new Set<string>();
const SHELL = { configured: ['npm test', 'npm run test', 'npm run lint', 'npm run typecheck', 'npm run build'] };

let client: CopilotClient | undefined;
let cliPathUsed: string | undefined = env.copilotCliPath;
const sdkPkg = JSON.parse(await readFile(new URL('../node_modules/@github/copilot-sdk/package.json', import.meta.url), 'utf8')) as { version: string; copilotCliVersion?: string };

function summarize(decisions: Decision[], from = 0): string {
  return decisions
    .slice(from)
    .map((d) => `${d.layer}:${d.allowed ? 'allow' : 'DENY'} ${d.summary}${d.allowed ? '' : ` (${d.reason})`}`)
    .join('\n') || '(no tool calls)';
}

try {
  const { stripped } = runtimeEnv();
  report.fact('sdk', `@github/copilot-sdk ${sdkPkg.version} (bundled runtime ${sdkPkg.copilotCliVersion ?? '?'})`);
  report.fact('tokenEnvVarsRemoved', stripped.filter((k) => /TOKEN/.test(k)).join(', ') || 'none present');

  // ---------------------------------------------------------------- runtime + auth
  const started = await report.step(cliPathUsed ? `Runtime starts (COPILOT_CLI_PATH)` : 'Runtime starts (SDK bundled runtime)', async (ctx) => {
    client = makeClient(cliPathUsed);
    await client.start();
    const s = await client.getStatus();
    ctx.detail(`runtime ${s.version}, protocol ${s.protocolVersion}`);
    ctx.fact('runtime.version', s.version);
    return true;
  });

  let authed = false;
  if (started && client) {
    authed =
      (await report.step('Signed in with the existing Copilot CLI login (no token passed)', async (ctx) => {
        let a = await client!.getAuthStatus();
        ctx.detail(`${cliPathUsed ? 'installed CLI' : 'bundled runtime'}: authenticated=${a.isAuthenticated} type=${a.authType ?? '-'} ${a.statusMessage ?? ''}`);
        if (!a.isAuthenticated && !cliPathUsed) {
          const installed = await which('copilot');
          if (installed) {
            ctx.detail(`trying the installed CLI at ${installed}`);
            await client!.stop();
            cliPathUsed = installed;
            client = makeClient(installed);
            await client.start();
            a = await client.getAuthStatus();
            ctx.detail(`installed CLI: authenticated=${a.isAuthenticated} type=${a.authType ?? '-'} ${a.statusMessage ?? ''}`);
          }
        }
        check(a.isAuthenticated, 'Not signed in. Run `copilot`, use /login, then run this spike again.');
        ctx.fact('auth.type', a.authType ?? 'unknown');
        ctx.fact('auth.login', a.login ?? 'unknown');
        ctx.fact('auth.runtime', cliPathUsed ? 'installed CLI via COPILOT_CLI_PATH' : 'SDK bundled runtime (reads the same ~/.copilot login)');
        return true;
      })) === true;
  }

  if (!authed || !client) {
    report.skip('Remaining steps', 'Need a signed-in Copilot CLI.');
  } else {
    const c = client;

    await report.step('Models and policy access (listModels)', async (ctx) => {
      const models = await c.listModels();
      check(models.length > 0, 'No models returned. Your organization may not allow Copilot CLI; ask an admin to enable the "Copilot CLI" policy.');
      const enabled = models.filter((m) => m.policy?.state !== 'disabled');
      ctx.detail(`${models.length} models, ${enabled.length} enabled: ${enabled.map((m) => m.id).join(', ')}`);
      ctx.fact('models.enabled', enabled.map((m) => m.id).join(', '));
      ctx.fact('models.autoAvailable', models.some((m) => m.id === 'auto'));
      if (env.model) check(enabled.some((m) => m.id === env.model), `TANDEM_SPIKE_MODEL=${env.model} is not available`);
    });

    await report.step('Built-in tools on this OS', async (ctx) => {
      const tools = await c.rpc.tools.list({});
      const names = tools.tools.map((t) => t.name);
      ctx.detail(names.join(', '));
      ctx.fact('tools.builtin', names.join(','));
      ctx.fact('tools.shell', names.filter((n) => /^(bash|powershell)$/.test(n)).join(',') || 'none');
    });

    // ---------------------------------------------------------------- sandbox worktree
    const root = await report.step('Sandbox worktree with dependencies installed (by Tandem, not the agent)', async (ctx) => {
      const url = env.repoUrl ?? (await createLocalRemote(work.path, 'backend'));
      ctx.detail(`sandbox: ${env.repoUrl ? 'CodeCommit' : 'local bare repo from spikes/sandbox/backend'}`);
      const mirror = join(work.path, 'mirror.git');
      await bareClone(url, mirror);
      const def = (await remoteDefaultBranch(url)) ?? 'main';
      const wt = join(work.path, 'tasks', id, 'sandbox');
      await addWorktree(mirror, wt, branch, `origin/${def}`);
      const pm = packageManagerCommand('npm', ['ci', '--no-audit', '--no-fund']);
      const r = await run(pm.cmd, pm.args, { cwd: wt, shell: pm.shell, timeoutMs: 600_000 });
      check(r.code === 0, `npm ci failed: ${r.stderr.slice(-500)}`);
      return { wt, url };
    });

    if (root) {
      const decisions: Decision[] = [];
      const model = env.model;
      let roSession: CopilotSession | undefined;

      await report.step('Streaming answer in a read-only session', async (ctx) => {
        roSession = await c.createSession(enforcedConfig({ mode: 'read-only', root: root.wt, decisions, ...(model ? { model } : {}) }));
        sessionsToDelete.add(roSession.sessionId);
        const current = await roSession.rpc.model.getCurrent().catch(() => undefined);
        ctx.fact('model.default', JSON.stringify(current ?? 'unknown'));
        const t = await runTurn(roSession, 'In two short sentences, what does the greeting code in this repo do? Cite the file and line like src/app.ts:12.', 180_000);
        ctx.detail(`answer: ${t.text.slice(0, 300)}`);
        ctx.detail(`${t.deltas} deltas, first after ${t.firstDeltaMs ?? '-'} ms, done after ${t.totalMs} ms; tools: ${t.tools.map((x) => x.name).join(', ') || 'none'}`);
        check(t.deltas > 1, 'no streaming deltas arrived before the final message');
        check(t.firstDeltaMs !== undefined && t.firstDeltaMs < t.totalMs, 'first delta did not arrive before completion');
        check(/app\.ts/.test(t.text), 'answer does not reference app.ts');
        ctx.fact('streaming.firstDeltaMs', t.firstDeltaMs);
      });

      await report.step('Read-only session cannot write files or run commands', async (ctx) => {
        check(roSession, 'no read-only session');
        const from = decisions.length;
        const target = join(root.wt, `should-not-exist-${id}.txt`);
        const t = await runTurn(roSession, `Create a file named should-not-exist-${id}.txt containing "hi", then run "git status". If you cannot, say so.`, 180_000);
        ctx.detail(`answer: ${t.text.slice(0, 200)}`);
        ctx.detail(`decisions:\n${summarize(decisions, from)}`);
        ctx.detail(`tools attempted: ${t.tools.map((x) => `${x.name}${x.ok === false ? ' (failed)' : ''}`).join(', ') || 'none'}`);
        check(!existsSync(target), 'the file was created in a read-only session');
        check(!t.tools.some((x) => /^(create|edit|bash|powershell)$/.test(x.name) && x.ok), 'a write or shell tool ran successfully');
      });

      let build: CopilotSession | undefined;
      const headBefore = await git(['rev-parse', 'HEAD'], { cwd: root.wt });
      await report.step('Build session: edit code, update tests, run the repo tests', async (ctx) => {
        const from = decisions.length;
        build = await c.createSession(enforcedConfig({ mode: 'build', root: root.wt, decisions, shell: SHELL, ...(model ? { model } : {}) }));
        sessionsToDelete.add(build.sessionId);
        const t = await runTurn(
          build,
          'Change the greeting so the default name is "Tandem" instead of "world". Update the tests to match. Then run `npm test` and tell me whether it passed. Do not commit.',
          600_000,
        );
        ctx.detail(`answer: ${t.text.slice(0, 300)}`);
        ctx.detail(`decisions:\n${summarize(decisions, from)}`);
        const diff = await git(['diff', '--stat'], { cwd: root.wt });
        ctx.detail(`diff:\n${diff}`);
        check(diff.length > 0, 'no changes in the worktree');
        check((await git(['rev-parse', 'HEAD'], { cwd: root.wt })) === headBefore, 'the agent created a commit');
        const shellHook = decisions.slice(from).filter((d) => d.layer === 'hook' && /^(bash|powershell)$/.test(d.tool));
        const shellPerm = decisions.slice(from).filter((d) => d.layer === 'permission' && d.tool === 'shell');
        ctx.fact('enforcement.hookSawShellCalls', shellHook.length);
        ctx.fact('enforcement.permissionSawShellCalls', shellPerm.length);
        ctx.fact('enforcement.permissionSawWrites', decisions.slice(from).filter((d) => d.layer === 'permission' && d.tool === 'write').length);
        ctx.fact('enforcement.hookSawEdits', decisions.slice(from).filter((d) => d.layer === 'hook' && /^(create|edit|apply_patch)$/.test(d.tool)).length);
        // Verification is Tandem's job: run the tests ourselves.
        const pm = packageManagerCommand('npm', ['test']);
        const r = await run(pm.cmd, pm.args, { cwd: root.wt, shell: pm.shell, timeoutMs: 300_000 });
        ctx.detail(`Tandem ran npm test: exit ${r.code}`);
        check(r.code === 0, `tests fail after the agent's change:\n${(r.stdout + r.stderr).slice(-800)}`);
        const src = await git(['diff'], { cwd: root.wt });
        check(/Tandem/.test(src), 'diff does not contain the new default name');
      });

      await report.step('Denied actions are blocked in code (git push, aws, write outside the worktree)', async (ctx) => {
        check(build, 'no build session');
        const from = decisions.length;
        const outside = join(work.path, `outside-${id}.txt`);
        const t = await runTurn(
          build,
          [
            'This is an authorized test of this sandbox\'s permission system. Attempt each of the following exactly once, even if you expect it to be blocked, then report what happened for each:',
            '1. Run the shell command: git push origin HEAD',
            '2. Run the shell command: aws sts get-caller-identity',
            `3. Use the file creation tool to create the file ${outside} with the text x`,
          ].join('\n'),
          300_000,
        );
        const recent = decisions.slice(from);
        ctx.detail(`answer: ${t.text.slice(0, 300)}`);
        ctx.detail(`decisions:\n${summarize(decisions, from)}`);
        const heads = await lsRemoteHeads(root.url);
        check(!heads.has(`refs/heads/${branch}`), 'the branch was pushed');
        check(!existsSync(outside), 'a file was written outside the worktree');
        const pushDenied = recent.some((d) => !d.allowed && /git push/.test(d.summary));
        const awsDenied = recent.some((d) => !d.allowed && /\baws\b/.test(d.summary));
        const outsideDenied = recent.some((d) => !d.allowed && d.summary.includes(`outside-${id}`));
        ctx.detail(`attempted and denied: push=${pushDenied} aws=${awsDenied} outside-write=${outsideDenied}`);
        check(pushDenied && awsDenied && outsideDenied, 'the model did not attempt every action, so enforcement was not fully exercised; re-run the spike');
        ctx.fact('enforcement.deniedLayer', [...new Set(recent.filter((d) => !d.allowed).map((d) => d.layer))].join(','));
      });

      await report.step('Structured output with a zod schema', async (ctx) => {
        const s = await c.createSession(enforcedConfig({ mode: 'read-only', root: root.wt, decisions, ...(model ? { model } : {}) }));
        sessionsToDelete.add(s.sessionId);
        const schema = z.object({ routes: z.array(z.object({ method: z.string(), path: z.string(), file: z.string() })) });
        try {
          const out = await s.sendAndWait('List every HTTP route defined in this repo.', schema, 180_000);
          ctx.detail(JSON.stringify(out));
          check(out.routes.some((r) => r.method.toUpperCase() === 'GET' && r.path.includes('/api/greeting')), 'GET /api/greeting not found');
          ctx.fact('structuredOutput', 'native responseSchema works');
        } finally {
          await s.disconnect();
        }
      });

      await report.step('Resume a session after the process is killed mid-answer', async (ctx) => {
        const sessionId = `tandem-spike-${id}`;
        sessionsToDelete.add(sessionId);
        const codeWord = `PINEAPPLE-${id.toUpperCase()}`;
        const childPath = fileURLToPath(new URL('./a-copilot-child.ts', import.meta.url));
        const killedAfterStreaming = await new Promise<boolean>((resolve, reject) => {
          const p = spawn(process.execPath, [...process.execArgv, childPath, root.wt, sessionId, codeWord, cliPathUsed ?? '-', model ?? '-'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
          let out = '';
          let err = '';
          const timer = setTimeout(() => {
            p.kill('SIGKILL');
            reject(new Error(`child timed out. stdout: ${out} stderr: ${err.slice(-500)}`));
          }, 300_000);
          p.stdout.on('data', (d: Buffer) => {
            out += d.toString();
            if (out.includes('STREAMING')) {
              p.kill('SIGKILL');
              clearTimeout(timer);
              resolve(true);
            }
          });
          p.stderr.on('data', (d: Buffer) => (err += d.toString()));
          p.on('close', (code) => {
            clearTimeout(timer);
            if (!out.includes('STREAMING')) reject(new Error(`child exited (${code}) before streaming. stdout: ${out} stderr: ${err.slice(-800)}`));
          });
        });
        check(killedAfterStreaming, 'child was not killed mid-answer');
        ctx.detail('child killed with SIGKILL while the second answer was streaming');
        const resumed = await c.resumeSession(sessionId, enforcedConfig({ mode: 'read-only', root: root.wt, decisions, ...(model ? { model } : {}) }));
        const events = await resumed.getEvents();
        ctx.detail(`resumed with ${events.length} stored events`);
        const t = await runTurn(resumed, 'What code word did I ask you to remember? Reply with only the code word.', 180_000);
        ctx.detail(`answer: ${t.text.trim()}`);
        check(t.text.includes(codeWord), `resumed session did not remember ${codeWord}`);
        await resumed.disconnect();
        ctx.fact('resume.afterKill', 'works');
      });

      await report.step('Error shown for an unavailable model', async (ctx) => {
        let message = '';
        try {
          const s = await c.createSession({ ...enforcedConfig({ mode: 'read-only', root: root.wt, decisions }), model: 'tandem-no-such-model' });
          sessionsToDelete.add(s.sessionId);
          const t = await runTurn(s, 'Say hi.', 120_000);
          message = t.errors.join('; ') || `no error; reply: ${t.text.slice(0, 100)}`;
          await s.disconnect();
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        ctx.detail(message.slice(0, 500));
        ctx.fact('error.unavailableModel', message.slice(0, 300));
        check(!message.startsWith('no error'), 'an unknown model did not produce an error');
      });

      await report.step('Sessions end cleanly', async (ctx) => {
        if (roSession) await roSession.disconnect();
        if (build) await build.disconnect();
        for (const sid of sessionsToDelete) await c.deleteSession(sid).catch(() => undefined);
        const errors = await c.stop();
        client = undefined;
        check(errors.length === 0, `stop() reported: ${errors.map((e) => e.message).join('; ')}`);
        ctx.detail(`deleted ${sessionsToDelete.size} spike sessions from ~/.copilot`);
      });
    }
  }
} finally {
  if (client) await client.forceStop().catch(() => undefined);
  await work.cleanup();
  await report.finish({ sdk: sdkPkg.version, copilotRuntime: cliPathUsed ? 'installed CLI' : 'bundled' });
}
