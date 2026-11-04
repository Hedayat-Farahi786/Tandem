import type { RepoCommands, RepoRole } from '@tandem/shared';

export interface DetectedProject {
  language: string;
  framework?: string;
  packageManager?: string;
  role: RepoRole;
  commands: RepoCommands;
  /** What the detection was based on, for the setup wizard. */
  evidence: string[];
}

const FRONTEND: Record<string, string> = { next: 'Next.js', nuxt: 'Nuxt', react: 'React', vue: 'Vue', '@angular/core': 'Angular', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', 'solid-js': 'Solid', vite: 'Vite' };
const BACKEND: Record<string, string> = { '@nestjs/core': 'NestJS', fastify: 'Fastify', express: 'Express', koa: 'Koa', '@hapi/hapi': 'hapi', hono: 'Hono', '@trpc/server': 'tRPC' };
const FULLSTACK = new Set(['next', 'nuxt', '@sveltejs/kit', '@remix-run/node', 'astro']);

/**
 * Detects language, framework, role and commands from a repo's file list and contents (read from
 * the default branch without a checkout). Everything is a suggestion the owner can edit.
 */
export function detectProject(files: readonly string[], read: (path: string) => string | undefined): DetectedProject {
  const has = (f: string) => files.includes(f);
  const evidence: string[] = [];

  if (has('package.json')) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string } = {};
    try {
      pkg = JSON.parse(read('package.json') ?? '{}');
    } catch {
      evidence.push('package.json could not be parsed');
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const pm = pkg.packageManager?.split('@')[0] ?? (has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm');
    evidence.push(`package.json, ${pm}${has('package-lock.json') || has('pnpm-lock.yaml') || has('yarn.lock') ? ' lockfile' : ''}`);
    const scripts = pkg.scripts ?? {};
    const run = (s: string) => (pm === 'yarn' ? `yarn ${s}` : pm === 'npm' && s === 'test' ? 'npm test' : `${pm} run ${s}`);
    const pick = (...names: string[]) => names.find((n) => scripts[n] && !/no test specified/.test(scripts[n]!));
    const commands: RepoCommands = {};
    commands.install = pm === 'npm' ? (has('package-lock.json') ? 'npm ci' : 'npm install') : pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : 'bun install';
    const lint = pick('lint', 'eslint');
    if (lint) commands.lint = run(lint);
    const tc = pick('typecheck', 'type-check', 'check-types', 'tsc', 'types');
    if (tc) commands.typecheck = run(tc);
    else if ((deps.typescript || has('tsconfig.json')) && has('tsconfig.json')) commands.typecheck = 'npx tsc --noEmit';
    const build = pick('build');
    if (build) commands.build = run(build);
    const test = pick('test', 'test:unit');
    if (test) commands.test = /^\s*ng\s+test\b/.test(scripts[test]!) && !/--watch[= ]false|--no-watch/.test(scripts[test]!) ? angularTestOnce(pm, scripts[test]!) : run(test);
    if (deps.vitest) commands.testSingle = 'npx vitest run {file} -t {name}';
    else if (deps.jest) commands.testSingle = 'npx jest {file} -t {name}';
    const fe = Object.keys(FRONTEND).filter((d) => deps[d]);
    const be = Object.keys(BACKEND).filter((d) => deps[d]);
    const full = Object.keys(deps).some((d) => FULLSTACK.has(d));
    const role: RepoRole = full || (fe.length && be.length) ? 'full-stack' : fe.length ? 'frontend' : be.length ? 'backend' : 'other';
    const framework = [...be.map((d) => BACKEND[d]!), ...fe.filter((d) => d !== 'vite').map((d) => FRONTEND[d]!)].join(' + ') || (fe.includes('vite') ? 'Vite' : undefined);
    if (framework) evidence.push(`dependencies: ${framework}`);
    return { language: deps.typescript || has('tsconfig.json') ? 'TypeScript' : 'JavaScript', ...(framework ? { framework } : {}), packageManager: pm, role, commands, evidence };
  }

  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    const text = `${read('pyproject.toml') ?? ''}\n${read('requirements.txt') ?? ''}\n${read('requirements-dev.txt') ?? ''}`.toLowerCase();
    const fw = /\bdjango\b/.test(text) ? 'Django' : /\bfastapi\b/.test(text) ? 'FastAPI' : /\bflask\b/.test(text) ? 'Flask' : undefined;
    const usesPoetry = /\[tool\.poetry\]/.test(text);
    const commands: RepoCommands = {
      install: usesPoetry ? 'poetry install' : has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .',
      ...(/\bruff\b/.test(text) ? { lint: 'ruff check .' } : /\bflake8\b/.test(text) ? { lint: 'flake8' } : {}),
      ...(/\bmypy\b/.test(text) ? { typecheck: 'mypy .' } : {}),
      test: 'pytest -q',
      testSingle: 'pytest -q {file} -k {name}',
    };
    evidence.push(has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt');
    return { language: 'Python', ...(fw ? { framework: fw } : {}), packageManager: usesPoetry ? 'poetry' : 'pip', role: fw ? 'backend' : 'other', commands, evidence };
  }

  if (has('go.mod')) {
    const mod = read('go.mod') ?? '';
    const fw = /gin-gonic\/gin/.test(mod) ? 'Gin' : /labstack\/echo/.test(mod) ? 'Echo' : /gofiber\/fiber/.test(mod) ? 'Fiber' : undefined;
    return { language: 'Go', ...(fw ? { framework: fw } : {}), packageManager: 'go', role: 'backend', commands: { install: 'go mod download', lint: 'go vet ./...', build: 'go build ./...', test: 'go test ./...', testSingle: 'go test ./... -run {name}' }, evidence: ['go.mod'] };
  }

  if (has('pom.xml')) {
    return { language: 'Java', framework: /spring-boot/.test(read('pom.xml') ?? '') ? 'Spring Boot' : 'Maven', packageManager: 'maven', role: 'backend', commands: { build: 'mvn -B -q -DskipTests package', test: 'mvn -B -q test', testSingle: 'mvn -B -q test -Dtest={name}' }, evidence: ['pom.xml'] };
  }
  if (has('build.gradle') || has('build.gradle.kts')) {
    const gw = has('gradlew') ? './gradlew' : 'gradle';
    return { language: has('build.gradle.kts') ? 'Kotlin' : 'Java', framework: 'Gradle', packageManager: 'gradle', role: 'backend', commands: { build: `${gw} build -x test`, test: `${gw} test`, testSingle: `${gw} test --tests {name}` }, evidence: ['build.gradle'] };
  }
  if (files.some((f) => /\.(csproj|sln)$/.test(f))) {
    return { language: 'C#', framework: '.NET', packageManager: 'dotnet', role: 'backend', commands: { install: 'dotnet restore', build: 'dotnet build --no-restore', test: 'dotnet test --no-restore', testSingle: 'dotnet test --filter {name}' }, evidence: ['.csproj'] };
  }
  if (has('Cargo.toml')) {
    return { language: 'Rust', packageManager: 'cargo', role: 'other', commands: { lint: 'cargo clippy -- -D warnings', build: 'cargo build', test: 'cargo test', testSingle: 'cargo test {name}' }, evidence: ['Cargo.toml'] };
  }
  return { language: 'Unknown', role: 'other', commands: {}, evidence: ['no known build file at the repo root'] };
}

/**
 * Angular's `ng test` watches for changes by default, so as a check it would never finish (CI=1 does
 * not stop Karma). Run it once, in headless Chrome, keeping the script's own options.
 */
function angularTestOnce(pm: string, script: string): string {
  const exec = pm === 'pnpm' ? 'pnpm exec' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bunx' : 'npx';
  const extra = script.replace(/^\s*ng\s+test\b/, '').replace(/\s*--browsers[= ]\S+/, '').trim();
  return `${exec} ng test${extra ? ` ${extra}` : ''} --watch=false --browsers=ChromeHeadless`;
}
