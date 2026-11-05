import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests: the real server and built UI in test mode (scripted agent, local git
 * remotes, PR creation denied so the console-link path is used). No Copilot, no AWS.
 *
 *   pnpm build && pnpm test:e2e
 *   TANDEM_SCREENSHOTS=1 pnpm test:e2e     also writes docs/evidence/phase-3/*.png
 *
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE points at an existing Chromium when you'd rather not run
 * `npx playwright install chromium`.
 */
const port = Number(process.env.TANDEM_E2E_PORT ?? 4399);
// One fixed work folder (Playwright loads this config in more than one process, so a new temp
// folder per load would pile up). It's emptied before a run and removed after; failure traces
// are kept. TANDEM_E2E_DIR picks another folder, which is then left alone.
const own = !process.env.TANDEM_E2E_DIR;
const work = process.env.TANDEM_E2E_DIR ?? join(tmpdir(), 'tandem-e2e-ui');
process.env.TANDEM_E2E_WORK = work; // for setup.ts and teardown.ts
if (own) process.env.TANDEM_E2E_OWN_DIR = '1';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: 'e2e/web',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  globalTeardown: './e2e/support/teardown.ts',
  outputDir: join(work, 'results'),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'node e2e/support/serve.mjs',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { TANDEM_E2E_DIR: work, TANDEM_PORT: String(port), TANDEM_E2E_OWN_DIR: own ? '1' : '' },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
