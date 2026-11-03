import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@tandem/shared';
import { ConfigError, effectiveSettings, loadConfig } from '../config.js';
import { Budget, BudgetError } from '../budget.js';
import { FakeClock, MemoryStore } from '../testing/index.js';

describe('config', () => {
  it('has safe defaults', () => {
    const c = loadConfig({}, '/home/u', join);
    expect(c).toMatchObject({ home: join('/home/u', '.tandem'), host: '127.0.0.1', port: 4317, logLevel: 'info', agent: 'copilot', overrides: {} });
  });

  it('reads overrides from the environment', () => {
    const c = loadConfig({ TANDEM_PORT: '5000', TANDEM_HOME: '/data/t', COPILOT_GH_HOST: 'acme.ghe.com', TANDEM_AWS_PROFILE: 'work', TANDEM_MAX_CONCURRENT_BUILDS: '2', TANDEM_AGENT: 'scripted' }, '/h', join);
    expect(c.port).toBe(5000);
    expect(c.home).toBe('/data/t');
    expect(c.agent).toBe('scripted');
    const s = effectiveSettings(DEFAULT_SETTINGS, c.overrides);
    expect(s.copilot.host).toBe('acme.ghe.com');
    expect(s.aws.profile).toBe('work');
    expect(s.limits.maxConcurrentBuilds).toBe(2);
    expect(s.limits.maxConcurrentReadOnly).toBe(2);
  });

  it('refuses non-loopback hosts and bad numbers', () => {
    expect(() => loadConfig({ TANDEM_HOST: '0.0.0.0' }, '/h', join)).toThrow(/only listens on 127.0.0.1/);
    expect(() => loadConfig({ TANDEM_PORT: 'abc' }, '/h', join)).toThrow(ConfigError);
    expect(() => loadConfig({ TANDEM_PORT: '99999' }, '/h', join)).toThrow(/Invalid configuration/);
    expect(() => effectiveSettings(undefined, { 'limits.maxConcurrentBuilds': 0 })).toThrow();
  });
});

describe('budget', () => {
  const settings = async () => ({ ...DEFAULT_SETTINGS, budget: { perTaskPrompts: 2, perDayPrompts: 3, perRunModelCalls: 60 } });
  const use = (taskId: string | undefined, at: string) => ({ id: Math.random().toString(), ...(taskId ? { taskId } : {}), runKind: 'build' as const, model: 'm', prompts: 1, modelCalls: 3, nanoAiu: 10, at });

  it('stops a task at its limit and everything at the daily limit', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(Date.parse('2026-11-03T12:00:00Z'));
    const b = new Budget(store, clock, settings);
    await b.assertCanSend('t1');
    await store.usage.add(use('t1', clock.iso()));
    await store.usage.add(use('t1', clock.iso()));
    await expect(b.assertCanSend('t1')).rejects.toThrow(/This task used its Copilot limit \(2 of 2/);
    await b.assertCanSend('t2');
    await store.usage.add(use(undefined, clock.iso()));
    await expect(b.assertCanSend('t2')).rejects.toBeInstanceOf(BudgetError);
    await expect(b.assertCanSend()).rejects.toThrow(/Today's Copilot limit/);
    expect(await b.summary('t1')).toEqual({ today: 3, perDay: 3, task: 2, perTask: 2 });
  });

  it('starts a new day', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(Date.parse('2026-11-03T12:00:00Z'));
    await store.usage.add(use(undefined, '2026-11-01T12:00:00.000Z'));
    await store.usage.add(use(undefined, '2026-11-01T12:00:00.000Z'));
    await store.usage.add(use(undefined, '2026-11-01T12:00:00.000Z'));
    await new Budget(store, clock, settings).assertCanSend();
  });
});
