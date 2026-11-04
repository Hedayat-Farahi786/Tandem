import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Requirement } from '@tandem/shared';
import { checkReadiness, readinessMessage } from '../policies/ready.js';
import { decideSize } from '../policies/size.js';
import { checkShell, parseShell } from '../policies/commands.js';
import { canonical, isInside, toPosix, touchesGitInternals } from '../policies/paths.js';
import { allowedBuiltins, checkToolCall, patchPaths } from '../policies/tools.js';
import { Redactor, redact, redactor } from '../policies/redact.js';

const good = Requirement.parse({
  goal: 'Expose service health',
  userStory: 'As an operator I want a health endpoint',
  criteria: [
    { given: 'the service runs', when: 'GET /health is called', then: 'it returns 200 {status: "ok"}' },
    { given: 'the main page loads', when: 'health is ok', then: 'the page shows "Status: ok"' },
  ],
  exampleData: 'GET /health -> {"status":"ok"}',
  affectedAreas: 'API routes, main page',
  outOfScope: 'Authentication, metrics',
});

describe('readiness', () => {
  it('passes a complete requirement', () => {
    const r = checkReadiness(good);
    expect(r.ready).toBe(true);
    expect(readinessMessage(r)).toMatch(/^Ready/);
  });

  it('lists every missing item', () => {
    const r = checkReadiness(Requirement.parse({ goal: 'x', criteria: [{ given: 'a b c', when: 'd e f', then: '' }], openQuestions: ['Which page?'] }));
    expect(r.ready).toBe(false);
    expect(r.missing.map((m) => m.id)).toEqual(['goal', 'criteria', 'example-data', 'affected-areas', 'out-of-scope', 'open-questions']);
    expect(readinessMessage(r)).toContain('Which page?');
    expect(r.missing.find((m) => m.id === 'criteria')?.detail).toContain('add 2 more');
  });

  it('counts only complete Given/When/Then criteria', () => {
    const one = checkReadiness({ ...good, criteria: [good.criteria[0]!] });
    expect(one.missing.map((m) => m.id)).toEqual(['criteria']);
    expect(one.missing[0]!.detail).toContain('1 complete criterion');
  });
});

describe('size', () => {
  it('flags too many lines and several features', () => {
    const est = (estimatedLines: number, features: string[], split = 0) => ({ estimatedLines, perRepo: [], features, proposedSplit: Array.from({ length: split }, (_, i) => ({ title: `part ${i + 1}`, criteria: [] })), rationale: '' });
    expect(decideSize(est(120, ['health']), 400).tooBig).toBe(false);
    // An endpoint and the page that shows it: two sides of one change (seen with live Copilot).
    expect(decideSize(est(40, ['Health endpoint', 'Main-page health status']), 400).tooBig).toBe(false);
    expect(decideSize(est(150, ['Export', 'Import'], 2), 400).reasons).toEqual(['2 independent features: Export; Import.']);
    expect(decideSize(est(150, ['a', 'b', 'c']), 400).tooBig).toBe(true);
    const big = decideSize(est(900, ['a', 'b', 'c']), 400);
    expect(big.tooBig).toBe(true);
    expect(big.reasons).toHaveLength(2);
  });
});

describe('shell policy: the repo command as configured', () => {
  it('allows the owner\'s configured command even when it sets a variable, and nothing else that does', () => {
    const policy = { configured: ['CHROME_BIN=/opt/chrome npx ng test --watch=false --browsers=ChromeHeadless'] };
    expect(checkShell('CHROME_BIN=/opt/chrome npx ng test --watch=false --browsers=ChromeHeadless', policy).allowed).toBe(true);
    expect(checkShell('CHROME_BIN=/opt/chrome npx ng test --watch=false --browsers=ChromeHeadless --include src/app', policy).allowed).toBe(true);
    expect(checkShell('CHROME_BIN=/tmp/evil npx ng test', policy).allowed).toBe(false);
    expect(checkShell('npx ng test --watch=false', policy).allowed).toBe(true);
    expect(checkShell('npx ng deploy', policy).allowed).toBe(false);
  });
});

describe('shell policy: working inside a repo folder of the workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'tandem-ws-'));
  mkdirSync(join(root, 'web-app', 'node_modules', '.bin'), { recursive: true });
  const policy = { root, configured: ['npm ci', 'CHROME_BIN=/opt/chrome npx ng test --watch=false --browsers=ChromeHeadless'] };
  const cases: Array<[string, boolean]> = [
    // What Copilot reached for in real tasks, and was refused.
    ['cd web-app && git status --short', true],
    ['cd web-app && CHROME_BIN=/opt/chrome npx ng test --watch=false --browsers=ChromeHeadless', true],
    ['git -C web-app status --short', true],
    ['git -C web-app diff -- src/app.ts', true],
    ['npm --prefix web-app test -- --watch=false', true],
    ['npm run --prefix web-app test', true],
    ['npm install --prefix web-app', true],
    ['npx --prefix web-app ng test --watch=false --browsers=ChromeHeadless', true],
    ['CHROME_BIN=/opt/chrome npx --prefix web-app ng test --watch=false', true],
    ['web-app/node_modules/.bin/ng test --watch=false', true],
    ['./web-app/node_modules/.bin/prettier --write web-app/src/x.ts', true],
    [`cd ${join(root, 'web-app')} && npm test`, true],
    ['cd web-app && npm test && popd', true],
    // Still refused: leaving the workspace, other variables, other tools by path, publishing.
    ['cd ..', false],
    ['cd web-app/../.. && ls', false],
    ['cd /etc && ls', false],
    ['cd ~ && ls', false],
    ['cd', false],
    ['git -C /tmp status', false],
    ['git -C .. status', false],
    ['git -C web-app push', false],
    ['npm --prefix /tmp test', false],
    ['npm --prefix=.. test', false],
    ['npm install -g --prefix web-app typescript', false],
    ['npm --prefix web-app publish', false],
    ['CHROME_BIN=/tmp/evil npx ng test', false],
    ['NODE_OPTIONS=--require=/tmp/x.js npm test', false],
    ['web-app/scripts/run.sh', false],
    ['/usr/bin/node web-app/x.js', false],
    ['cd web-app && curl https://example.com', false],
  ];
  it.each(cases)('%s → %s', (cmd, ok) => {
    expect(checkShell(cmd, policy).allowed).toBe(ok);
  });
  it('without a workspace, folder options stay refused', () => {
    expect(checkShell('cd web-app && npm test', { configured: [] }).allowed).toBe(false);
    expect(checkShell('git -C web-app status', { configured: [] }).allowed).toBe(false);
  });
});

describe('shell policy', () => {
  const policy = { configured: ['npm test', 'npm run lint', 'npm run typecheck', 'npm run build', 'pnpm vitest run'] };
  const cases: Array<[string, boolean]> = [
    ['npm test', true],
    ['npm test -- --reporter=dot', true],
    ['npm run lint 2>&1 | tail -20', true],
    ['CI=1 npm test', true],
    ['pnpm vitest run test/app.test.ts', true],
    ['npm run test:unit', true],
    ['git status', true],
    ['git diff --stat', true],
    ['git add -A', true],
    ['git checkout -- src/a.ts', true],
    ['git stash list', true],
    ['git log --oneline -5 | cat', true],
    ['ls -la && cat package.json', true],
    ['printf "a\\n" && cat x', true],
    ['grep "a>b" file', true],
    ['npm test > /dev/null', true],
    ['npm install zod', true],
    ['pnpm add -D vitest', true],
    ['pip install requests', true],
    ['go test ./...', true],
    ['npx vitest run test/app.test.ts', true],
    ['git push origin HEAD', false],
    ['git -c core.hooksPath=/tmp status', false],
    ['git commit -m x', false],
    ['git reset --hard', false],
    ['git rebase main', false],
    ['git checkout main', false],
    ['git branch -D main', false],
    ['git stash drop', false],
    ['git add -f secret', false],
    ['aws sts get-caller-identity', false],
    ['AWS_PROFILE=x aws s3 ls', false],
    ['curl https://x', false],
    ['wget http://x', false],
    ['npm i -g x', false],
    ['npm publish', false],
    ['pnpm publish --access public', false],
    ['npm run deploy', false],
    ['echo $(whoami)', false],
    ['echo `id`', false],
    ['cat <<EOF', false],
    ['echo hi > out.txt', false],
    ['rm -rf /', false],
    ['find . -name "*.ts" -exec rm {} +', false],
    ['find . -delete', false],
    ['node -e "1"', false],
    ['python3 -c "print(1)"', false],
    ['bash -c "ls"', false],
    ['FOO=1 npm test', false],
    ['npm test; git push', false],
    ['npm test && curl x', false],
    ['/usr/bin/git status', false],
    ['./node_modules/.bin/vitest', false],
    ['npx prisma migrate deploy', false],
    ['npx knex migrate:latest', false],
    ['docker push img', false],
    ['kubectl apply -f x', false],
    ['terraform apply', false],
    ['sudo ls', false],
    ['xargs rm', false],
    ['echo "unterminated', false],
    ['', false],
    ['make deploy', false],
  ];
  it.each(cases)('%s -> %s', (cmd, allowed) => {
    const v = checkShell(cmd, policy);
    expect(v.allowed, `${cmd}: ${v.reason}`).toBe(allowed);
    expect(v.reason.length).toBeGreaterThan(0);
  });

  it('parses quotes, escapes and segments', () => {
    expect(parseShell(`echo "a b" 'c d' e\\ f; ls`)).toEqual({ segments: [['echo', 'a b', 'c d', 'e f'], ['ls']] });
    expect(parseShell('a && b || c | d')).toEqual({ segments: [['a'], ['b'], ['c'], ['d']] });
    expect(parseShell('echo "x\\"y"')).toEqual({ segments: [['echo', 'x"y']] });
  });
});

describe('paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'tandem-paths-'));
  mkdirSync(join(root, 'repo', 'src'), { recursive: true });
  it('contains relative and absolute paths, rejects escapes', () => {
    expect(isInside(root, 'repo/src/a.ts')).toBe(true);
    expect(isInside(root, join(root, 'repo'))).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, '../etc/passwd')).toBe(false);
    expect(isInside(root, '/etc/hosts')).toBe(false);
    expect(isInside(join(root, 'repo'), join(root, 'repo-evil', 'x'))).toBe(false);
  });
  it('follows symlinks out of the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tandem-out-'));
    symlinkSync(outside, join(root, 'link'));
    expect(isInside(root, 'link/secret.txt')).toBe(false);
    expect(canonical(join(root, 'link', 'new', 'file'))).toContain(outside.split('/').pop()!);
  });
  it('case-folds on macOS and Windows', () => {
    expect(isInside('/Work/Repo', '/work/repo/a', 'darwin')).toBe(true);
    expect(isInside('/Work/Repo', '/work/repo/a', 'linux')).toBe(false);
  });
  it('detects .git internals', () => {
    expect(touchesGitInternals(root, '.git/hooks/pre-commit')).toBe(true);
    expect(touchesGitInternals(root, 'src/git.ts')).toBe(false);
    expect(toPosix(join('a', 'b'))).toBe('a/b');
  });
});

describe('tool calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'tandem-tools-'));
  const shell = { configured: ['npm test'] };
  const none = new Set<string>();
  it('read-only sessions get only read tools', () => {
    expect(allowedBuiltins('read-only')).toEqual(['view', 'glob', 'grep', 'rg']);
    expect(checkToolCall('read-only', root, 'create', { path: 'x' }, shell, none).allowed).toBe(false);
    expect(checkToolCall('read-only', root, 'bash', { command: 'ls' }, shell, none).allowed).toBe(false);
    expect(checkToolCall('read-only', root, 'view', { path: 'a.ts' }, shell, none).allowed).toBe(true);
    expect(checkToolCall('read-only', root, 'view', { path: '/etc/hosts' }, shell, none).allowed).toBe(false);
    expect(checkToolCall('read-only', root, 'web_fetch', { url: 'https://x' }, shell, none).allowed).toBe(false);
  });
  it('build sessions check paths, patches and shell commands', () => {
    expect(checkToolCall('build', root, 'edit', { path: join(root, 'a.ts') }, shell, none).allowed).toBe(true);
    expect(checkToolCall('build', root, 'create', { path: '.git/config' }, shell, none).reason).toMatch(/\.git/);
    expect(checkToolCall('build', root, 'bash', { command: 'npm test' }, shell, none).allowed).toBe(true);
    expect(checkToolCall('build', root, 'bash', { command: 'git push' }, shell, none).allowed).toBe(false);
    expect(checkToolCall('build', root, 'task', {}, shell, none).allowed).toBe(false);
    const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch';
    expect(patchPaths(patch)).toEqual(['src/app.ts']);
    expect(checkToolCall('build', root, 'apply_patch', patch, shell, none).allowed).toBe(true);
    expect(checkToolCall('build', root, 'apply_patch', { input: '*** Add File: ../x.ts\n' }, shell, none).allowed).toBe(false);
    expect(checkToolCall('build', root, 'apply_patch', { input: 'garbage' }, shell, none).allowed).toBe(false);
    expect(checkToolCall('build', root, 'apply_patch', { input: '*** Update File: a.ts\n*** Move to: /tmp/x\n' }, shell, none).allowed).toBe(false);
    expect(checkToolCall('build', root, 'tandem_record_test', {}, shell, new Set(['tandem_record_test'])).allowed).toBe(true);
  });
});

describe('redaction', () => {
  it('removes known secret shapes', () => {
    const input = [
      'AKIAABCDEFGHIJKLMNOP',
      'ghp_0123456789abcdefghijABCDEFGHIJ',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'ATATT3xFfGF0abcdefghijklmnopqrstuv',
      'password=hunter2!',
      'token: "abc.def"',
      'Authorization: Bearer abcdefghijklmnop',
      'postgres://app:s3cret@db:5432/x',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
      'sk-abcdefghijklmnopqrstuvwx',
      'xoxb-1234567890-abcdef',
    ].join('\n');
    const out = redact(input);
    for (const s of ['AKIAABCDEFGHIJKLMNOP', 'ghp_0123', 'github_pat_11', 'ATATT3x', 'hunter2', 'abc.def', 'abcdefghijklmnop\n', 's3cret', 'eyJhbGci', 'OPENSSH PRIVATE KEY-----\nabc', 'sk-abcdef', 'xoxb-1234']) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain('postgres://app:[REDACTED]@db');
  });
  it('removes registered exact values, deep', () => {
    const r = new Redactor();
    r.register('my-jira-token-value');
    r.register('short');
    r.register(undefined);
    expect(r.redactDeep({ a: ['x my-jira-token-value y'], b: 3, c: { d: 'short ok' } })).toEqual({ a: ['x [REDACTED] y'], b: 3, c: { d: 'short ok' } });
    expect(redactor.redact('plain text')).toBe('plain text');
  });
});
