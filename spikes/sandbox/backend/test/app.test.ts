import { describe, expect, it } from 'vitest';
import { buildApp, greeting } from '../src/app.js';

describe('greeting', () => {
  it('greets the world by default', () => {
    expect(greeting()).toEqual({ message: 'Hello, world' });
  });

  it('greets a named person', () => {
    expect(greeting('  Ada ')).toEqual({ message: 'Hello, Ada' });
  });
});

describe('GET /api/greeting', () => {
  it('returns a greeting', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/greeting?name=Ada' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Hello, Ada' });
    await app.close();
  });
});
