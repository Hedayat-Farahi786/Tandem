import { describe, expect, it } from 'vitest';
import { safeRunnerHeaders } from '../hosted/runner-hub.js';

describe('answers from a company runner', () => {
  it('keeps data types, and never lets an answer act as a page or script on the web app', () => {
    expect(safeRunnerHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'tandem_session=stolen', 'Access-Control-Allow-Origin': '*' })).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    });
    for (const type of ['text/html', 'application/javascript', 'text/javascript', 'application/xhtml+xml', 'text/xml']) expect(safeRunnerHeaders({ 'content-type': type })['content-type']).toBe('application/octet-stream');
    expect(safeRunnerHeaders({})['content-type']).toBe('application/octet-stream');
    expect(safeRunnerHeaders({ 'content-type': 'text/event-stream; charset=utf-8' })).toMatchObject({ 'x-accel-buffering': 'no' });
    expect(safeRunnerHeaders({ 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="a.csv"' })).toMatchObject({ 'content-disposition': 'attachment; filename="a.csv"' });
  });
});
