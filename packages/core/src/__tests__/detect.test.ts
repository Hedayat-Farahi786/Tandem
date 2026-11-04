import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectProject } from '../detect.js';

const sandbox = join(import.meta.dirname, '..', '..', '..', '..', 'spikes', 'sandbox');
function listFiles(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (f === 'node_modules' || f === 'dist') return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? listFiles(p, root) : [relative(root, p).split('\\').join('/')];
  });
}
const fromDir = (dir: string) => detectProject(listFiles(dir), (p) => {
  try {
    return readFileSync(join(dir, p), 'utf8');
  } catch {
    return undefined;
  }
});
const fromMap = (m: Record<string, string>) => detectProject(Object.keys(m), (p) => m[p]);

describe('repo detection', () => {
  it('detects the three sandbox templates', () => {
    expect(fromDir(join(sandbox, 'backend'))).toMatchObject({
      language: 'TypeScript',
      framework: 'Fastify',
      packageManager: 'npm',
      role: 'backend',
      commands: { install: 'npm ci', lint: 'npm run lint', typecheck: 'npm run typecheck', build: 'npm run build', test: 'npm test', testSingle: 'npx vitest run {file} -t {name}' },
    });
    expect(fromDir(join(sandbox, 'frontend'))).toMatchObject({ role: 'frontend', framework: 'React', commands: { test: 'npm test', build: 'npm run build' } });
    expect(fromDir(join(sandbox, 'fullstack'))).toMatchObject({ role: 'full-stack', framework: 'Fastify + React' });
  });

  it("runs Angular's watch-mode tests once, headless, so a check can finish", () => {
    const ng = (test: string, lock: Record<string, string> = { 'package-lock.json': '' }) => fromMap({ 'package.json': JSON.stringify({ scripts: { test }, dependencies: { '@angular/core': '19' } }), ...lock }).commands.test;
    expect(ng('ng test')).toBe('npx ng test --watch=false --browsers=ChromeHeadless');
    expect(ng('ng test --code-coverage --browsers=Chrome')).toBe('npx ng test --code-coverage --watch=false --browsers=ChromeHeadless');
    expect(ng('ng test', { 'pnpm-lock.yaml': '' })).toBe('pnpm exec ng test --watch=false --browsers=ChromeHeadless');
    // Already a single run: the script is used as it is.
    expect(ng('ng test --watch=false')).toBe('npm test');
  });

  it('handles pnpm, yarn, Next.js and missing scripts', () => {
    expect(fromMap({ 'package.json': JSON.stringify({ scripts: { test: 'jest', 'type-check': 'tsc' }, dependencies: { next: '15' }, devDependencies: { jest: '29', typescript: '5' } }), 'pnpm-lock.yaml': '' })).toMatchObject({
      packageManager: 'pnpm',
      role: 'full-stack',
      framework: 'Next.js',
      commands: { install: 'pnpm install --frozen-lockfile', typecheck: 'pnpm run type-check', test: 'pnpm run test', testSingle: 'npx jest {file} -t {name}' },
    });
    const y = fromMap({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'echo "Error: no test specified" && exit 1' }, dependencies: { express: '4' } }), 'yarn.lock': '', 'tsconfig.json': '{}' });
    expect(y).toMatchObject({ packageManager: 'yarn', role: 'backend', framework: 'Express', commands: { install: 'yarn install --frozen-lockfile', lint: 'yarn lint', typecheck: 'npx tsc --noEmit' } });
    expect(y.commands.test).toBeUndefined();
    expect(fromMap({ 'package.json': '{bad' }).evidence).toContain('package.json could not be parsed');
    expect(fromMap({ 'package.json': '{"packageManager":"pnpm@10.0.0"}' }).packageManager).toBe('pnpm');
  });

  it('detects Python, Go, Java, Gradle, .NET and Rust', () => {
    expect(fromMap({ 'pyproject.toml': '[project]\ndependencies=["fastapi"]\n[tool.ruff]\n[tool.mypy]', 'app/main.py': '' })).toMatchObject({ language: 'Python', framework: 'FastAPI', role: 'backend', commands: { install: 'pip install -e .', lint: 'ruff check .', typecheck: 'mypy .', test: 'pytest -q' } });
    expect(fromMap({ 'requirements.txt': 'django\nflake8' })).toMatchObject({ framework: 'Django', commands: { install: 'pip install -r requirements.txt', lint: 'flake8' } });
    expect(fromMap({ 'pyproject.toml': '[tool.poetry]\nname="x"' })).toMatchObject({ packageManager: 'poetry', role: 'other', commands: { install: 'poetry install' } });
    expect(fromMap({ 'go.mod': 'module x\nrequire github.com/gin-gonic/gin v1' })).toMatchObject({ language: 'Go', framework: 'Gin', commands: { test: 'go test ./...' } });
    expect(fromMap({ 'pom.xml': '<artifactId>spring-boot-starter</artifactId>' })).toMatchObject({ language: 'Java', framework: 'Spring Boot' });
    expect(fromMap({ 'build.gradle.kts': '', gradlew: '' })).toMatchObject({ language: 'Kotlin', commands: { test: './gradlew test' } });
    expect(fromMap({ 'src/App.csproj': '' })).toMatchObject({ language: 'C#', commands: { test: 'dotnet test --no-restore' } });
    expect(fromMap({ 'Cargo.toml': '' })).toMatchObject({ language: 'Rust', commands: { build: 'cargo build' } });
    expect(fromMap({ 'README.md': '' })).toMatchObject({ language: 'Unknown', commands: {} });
  });
});
