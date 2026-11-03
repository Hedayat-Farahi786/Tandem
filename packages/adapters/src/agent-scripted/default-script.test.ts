import { describe, expect, it } from 'vitest';
import { scriptedSize } from './default-script.js';

describe('scriptedSize', () => {
  it('keeps a two-part request as one change', () => {
    const s = scriptedSize("Add a GET /health endpoint returning {status: 'ok'} and show the status on the main page.");
    expect(s.estimatedLines).toBe(90);
    expect(s.proposedSplit).toEqual([]);
  });

  it('splits three or more features, one part each, the first owning the criteria', () => {
    const s = scriptedSize('Add a GET /health endpoint, a metrics dashboard, CSV export of orders and also email alerts when the service is down.');
    expect(s.features).toEqual(['Add a GET /health endpoint', 'a metrics dashboard', 'CSV export of orders', 'email alerts when the service is down']);
    expect(s.estimatedLines).toBe(880);
    expect(s.proposedSplit.map((p) => p.title)).toEqual(['Add a GET /health endpoint', 'A metrics dashboard', 'CSV export of orders', 'Email alerts when the service is down']);
    expect(s.proposedSplit.map((p) => p.criteria)).toEqual([[1, 2], [], [], []]);
  });
});

describe('scripted request chat', () => {
  it('drafts what the owner asked for, not always the health endpoint', async () => {
    const { titleFrom } = await import('./default-script.js');
    expect(titleFrom('Please let customers download their invoices as a PDF from their account page.')).toBe('Let customers download their invoices as a PDF from…');
    expect(titleFrom('Dark mode for the dashboard')).toBe('Dark mode for the dashboard');
  });
});
