import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.1 A and AA checks on the current page, in the current theme. */
export async function expectAccessible(page: Page, what: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = r.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join('\n    ')}`);
  expect(summary, `Accessibility problems on ${what}`).toEqual([]);
}

export async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('tandem-theme', t);
  }, theme);
}

/** Checks both themes for accessibility; with TANDEM_SCREENSHOTS=1 also saves both screenshots. */
export async function checkScreen(page: Page, name: string, o: { fullPage?: boolean } = {}) {
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.waitForTimeout(50);
    await expectAccessible(page, `${name} (${theme})`);
    if (process.env.TANDEM_SCREENSHOTS) {
      const dir = join(process.cwd(), 'docs', 'evidence', 'phase-3');
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `${name}-${theme}.jpg`), type: 'jpeg', quality: 80, fullPage: o.fullPage ?? false });
    }
  }
  await setTheme(page, 'light');
}

/** Pages must not throw or log errors. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (404|409|400)/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}
