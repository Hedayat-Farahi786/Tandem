/** API client: JSON, the per-launch token on writes, and plain error messages. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const token = () => document.querySelector<HTMLMetaElement>('meta[name="tandem-token"]')?.content ?? '';

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Tandem-Token': token() } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch {
    throw new ApiError(0, 'Tandem is not reachable. Check that it is still running (pnpm tandem), then try again.');
  }
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text) as unknown; } catch { return text; } })() : undefined;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? `Request failed (${res.status}).`);
  return data as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export async function fetchText(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw new ApiError(res.status, `Could not load ${path} (${res.status}).`);
  return res.text();
}
