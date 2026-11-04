import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { App, makeQueryClient } from '../App';

type Handler = (body: unknown, url: URL) => unknown;

/** A fake Tandem API: routes "METHOD /path" (exact) or "METHOD /prefix*" to handlers. */
export function mockApi(routes: Record<string, Handler | object | string | null>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:4399');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const key = `${method} ${url.pathname}`;
    const route = routes[`${key}${url.search}`] ?? routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (route === undefined) return new Response(JSON.stringify({ error: `No mock for ${key}` }), { status: 404 });
    const value = typeof route === 'function' ? await (route as Handler)(body, url) : route;
    if (value instanceof Response) return value;
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export function renderApp(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App client={makeQueryClient()} initialPath={path} />);
}

/** A wide screen: the task's details open beside the conversation, as on a desktop. */
export function wideScreen() {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: /min-width/.test(q), media: q, addEventListener() {}, removeEventListener() {} }));
}
