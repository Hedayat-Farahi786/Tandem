/**
 * Spike d: the local tracker. Create a task, add comments, change status, and survive
 * process restarts, including a hard kill in the middle of a transaction.
 *
 *   pnpm spike:d
 *
 * Every phase runs in its own Node process, so "restart" is a real process restart.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workDir } from './lib/env.js';
import { LocalTracker } from './lib/local-tracker.js';
import { Report, check } from './lib/report.js';

const self = fileURLToPath(import.meta.url);
const [, , mode, dbPath, key] = process.argv;

if (mode === '--child' || process.argv.includes('--child')) {
  const phase = process.argv[process.argv.indexOf('--child') + 1];
  const db = process.argv[process.argv.indexOf('--child') + 2]!;
  const k = process.argv[process.argv.indexOf('--child') + 3];
  const t = new LocalTracker(db);
  switch (phase) {
    case 'write': {
      const task = t.createTask('Add a GET /health endpoint', 'Return {status: "ok"} and show it on the main page.');
      t.comment(task.key, 'Readiness: missing example data.', 'tandem');
      t.comment(task.key, 'Example: GET /health -> 200 {"status":"ok"}', 'owner');
      t.transition(task.key, 'READINESS', 'submitted by owner');
      process.stdout.write(JSON.stringify({ key: task.key }));
      t.close();
      break;
    }
    case 'commit-then-kill': {
      t.comment(k!, 'Committed right before a hard kill.', 'tandem');
      process.kill(process.pid, 'SIGKILL');
      break;
    }
    case 'kill-mid-transaction': {
      t.db.exec('BEGIN IMMEDIATE');
      t.db.prepare("UPDATE tracker_tasks SET status = 'SPEC_DRAFTING' WHERE key = ?").run(k!);
      t.db.prepare("INSERT INTO tracker_comments (id, key, author, body, created_at) VALUES ('uncommitted', ?, 'tandem', 'must not survive', ?)").run(k!, new Date().toISOString());
      process.kill(process.pid, 'SIGKILL');
      break;
    }
    case 'read': {
      const task = t.getTask(k!);
      const comments = t.readReplies(k!, new Date(0));
      const ownerOnly = t.readReplies(k!, new Date(0), ['owner']);
      const transitions = t.transitions(k!);
      const integrity = (t.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      const journal = (t.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
      process.stdout.write(JSON.stringify({ task, comments, ownerOnly, transitions, integrity, journal }));
      t.close();
      break;
    }
    default:
      throw new Error(`unknown phase ${phase}`);
  }
} else {
  void mode;
  void dbPath;
  void key;
  await main();
}

function child(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Reuse the tsx loader flags of this process.
    const p = spawn(process.execPath, [...process.execArgv, self, '--child', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function main(): Promise<void> {
  const report = new Report('d-local-tracker', 'Spike d: local tracker survives restarts');
  const work = await workDir('spike-d');
  const db = join(work.path, 'tandem.db');
  let taskKey = '';
  try {
    await report.step('Process 1: create task, add two comments, change status, exit', async (ctx) => {
      const r = await child(['write', db]);
      check(r.code === 0, `child failed: ${r.stderr}`);
      taskKey = (JSON.parse(r.stdout) as { key: string }).key;
      ctx.detail(`created ${taskKey}`);
      check(taskKey === 'TND-1', `unexpected key ${taskKey}`);
    });

    await report.step('Process 2: commit a comment, then hard kill (SIGKILL)', async (ctx) => {
      const r = await child(['commit-then-kill', db, taskKey]);
      ctx.detail(`child ended with ${r.signal ?? r.code}`);
      check(r.signal === 'SIGKILL' || (process.platform === 'win32' && r.code !== 0), 'child was not killed');
    });

    await report.step('Process 3: hard kill in the middle of a transaction', async (ctx) => {
      const r = await child(['kill-mid-transaction', db, taskKey]);
      ctx.detail(`child ended with ${r.signal ?? r.code}`);
    });

    await report.step('Process 4: data intact after restarts, partial transaction rolled back', async (ctx) => {
      const r = await child(['read', db, taskKey]);
      check(r.code === 0, `reader failed: ${r.stderr}`);
      const s = JSON.parse(r.stdout) as {
        task: { status: string; title: string };
        comments: Array<{ id: string; author: string; body: string }>;
        ownerOnly: unknown[];
        transitions: Array<{ from: string; to: string; reason: string }>;
        integrity: string;
        journal: string;
      };
      check(s.integrity === 'ok', `integrity_check: ${s.integrity}`);
      check(s.task.status === 'READINESS', `status is ${s.task.status}; the uncommitted change leaked`);
      check(s.comments.length === 3, `expected 3 comments, found ${s.comments.length}`);
      check(!s.comments.some((c) => c.id === 'uncommitted'), 'uncommitted comment survived');
      check(s.ownerOnly.length === 1, 'author filter (PM replies) did not work');
      check(s.transitions.length === 1 && s.transitions[0]?.to === 'READINESS', 'transition history wrong');
      ctx.detail(`status ${s.task.status}, ${s.comments.length} comments, ${s.transitions.length} transition, integrity ${s.integrity}, journal ${s.journal}`);
      ctx.fact('sqlite.journal', s.journal);
    });

    await report.step('Same process: create a second task after restart (key sequence continues)', async () => {
      const t = new LocalTracker(db);
      const second = t.createTask('Second task', '');
      t.transition(second.key, 'READY', 'ready');
      const ready = t.findReadyTasks('READY');
      t.close();
      check(second.key === 'TND-2', `got ${second.key}`);
      check(ready.length === 1 && ready[0]?.key === 'TND-2', 'findReadyTasks wrong');
    });
  } finally {
    await work.cleanup();
    await report.finish({ sqlite: 'node:sqlite' });
  }
}
