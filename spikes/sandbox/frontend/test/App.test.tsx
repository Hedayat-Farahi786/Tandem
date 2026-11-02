import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { App } from '../src/App';
import { fetchGreeting } from '../src/api';

afterEach(cleanup);

describe('App', () => {
  it('shows the greeting from the API', async () => {
    render(<App load={() => Promise.resolve({ message: 'Hello, world' })} />);
    expect((await screen.findByTestId('greeting')).textContent).toBe('Hello, world');
  });

  it('shows an error when the API fails', async () => {
    render(<App load={() => Promise.reject(new Error('boom'))} />);
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
  });
});

describe('fetchGreeting', () => {
  it('calls the greeting endpoint', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ message: 'Hello, Ada' }), { status: 200 });
    }) as typeof fetch;
    await expect(fetchGreeting('Ada', fake)).resolves.toEqual({ message: 'Hello, Ada' });
    expect(calls).toEqual(['/api/greeting?name=Ada']);
  });
});
