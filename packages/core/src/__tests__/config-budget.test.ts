import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@tandem/shared';
import { ConfigError, effectiveSettings, loadConfig, seedSettings } from '../config.js';
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

  it('takes the Copilot budget from the environment only as a starting value: Settings decides after that', async () => {
    const c = loadConfig({ TANDEM_CREDITS_PER_TASK: '12', TANDEM_CREDITS_PER_DAY: '15', TANDEM_BUDGET_PER_DAY: '50' }, '/h', join);
    expect(c.overrides).toEqual({});
    expect(c.seeds).toEqual({ 'budget.perTaskCredits': 12, 'budget.perDayCredits': 15, 'budget.perDayPrompts': 50 });
    const store = new MemoryStore();
    expect(await seedSettings(store.settings, c.seeds)).toBe(true);
    expect((await store.settings.get()).budget).toMatchObject({ perTaskCredits: 12, perDayCredits: 15, perDayPrompts: 50 });
    // Changed in Settings: a restart with the same environment keeps the change.
    await store.settings.set({ ...(await store.settings.get()), budget: { ...(await store.settings.get()).budget, perTaskCredits: 20 } });
    expect(await seedSettings(store.settings, c.seeds)).toBe(false);
    expect((await store.settings.get()).budget.perTaskCredits).toBe(20);
  });

  it('refuses non-loopback hosts and bad numbers', () => {
    expect(() => loadConfig({ TANDEM_HOST: '0.0.0.0' }, '/h', join)).toThrow(/only listens on 127.0.0.1/);
    expect(() => loadConfig({ TANDEM_PORT: 'abc' }, '/h', join)).toThrow(ConfigError);
    expect(() => loadConfig({ TANDEM_PORT: '99999' }, '/h', join)).toThrow(/Invalid configuration/);
    expect(() => effectiveSettings(undefined, { 'limits.maxConcurrentBuilds': 0 })).toThrow();
  });
});

describe('budget', () => {
  const settings = async () => ({ ...DEFAULT_SETTINGS, budget: { perTaskPrompts: 2, perDayPrompts: 3, perRunModelCalls: 60, perTaskCredits: 25, perDayCredits: 75 } });
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
    expect(await b.summary('t1')).toEqual({ today: 3, perDay: 3, task: 2, perTask: 2, credits: { today: 30e-9, perDay: 75, task: 20e-9, perTask: 25 } });
  });

  it('starts a new day', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(Date.parse('2026-11-03T12:00:00Z'));
    await store.usage.add(use(undefined, '2026-11-01T12:00:00.000Z'));
    await store.usage.add(use(undefined, '2026-11-01T12:00:00.000Z'));
    await store.usage.add(use(undefined, '2026-11-01T12:00:00.000Z'));
    await new Budget(store, clock, settings).assertCanSend();
  });

  it('stops a task at its credit limit, and everything at the daily credit limit', async () => {
    const credits = async () => ({ ...DEFAULT_SETTINGS, budget: { perTaskPrompts: 100, perDayPrompts: 100, perRunModelCalls: 60, perTaskCredits: 2, perDayCredits: 3 } });
    const store = new MemoryStore();
    const clock = new FakeClock(Date.parse('2026-11-03T12:00:00Z'));
    const b = new Budget(store, clock, credits);
    expect(await b.remainingNanoAiu('t1')).toBe(2e9);
    expect(await b.remainingNanoAiu()).toBe(3e9);
    await store.usage.add({ ...use('t1', clock.iso()), nanoAiu: 1.5e9 });
    expect(await b.remainingNanoAiu('t1')).toBe(0.5e9);
    await b.assertCanSend('t1');
    await store.usage.add({ ...use('t1', clock.iso()), nanoAiu: 0.6e9 });
    await expect(b.assertCanSend('t1')).rejects.toThrow(/This task used its Copilot credits \(2.1 of 2\)/);
    expect(await b.limitMessage('t1')).toMatch(/this task reached its Copilot credit limit \(2.1 of 2\)/);
    expect(await b.remainingNanoAiu('t1')).toBe(0);
    // Another task still has room until the day runs out.
    expect(await b.remainingNanoAiu('t2')).toBeCloseTo(0.9e9);
    await store.usage.add({ ...use('t2', clock.iso()), nanoAiu: 1e9 });
    await expect(b.assertCanSend('t2')).rejects.toThrow(/Today's Copilot credits are used up \(3.1 of 3\)/);
    expect(await b.limitMessage('t2')).toMatch(/today's Copilot credits are used up/);
    expect((await b.summary('t1')).credits).toEqual({ today: 3.1, perDay: 3, task: 2.1, perTask: 2 });
  });
});
