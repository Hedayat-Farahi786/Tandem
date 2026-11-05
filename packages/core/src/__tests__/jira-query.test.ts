import { describe, expect, it } from 'vitest';
import { jiraQuery } from '../workflow/service.js';

describe('the Jira query a project imports with', () => {
  const ready = 'status = "Ready for AI"';
  it('is its own query when written by hand', () => {
    expect(jiraQuery({ jiraJql: ' labels = ai ', jiraProjectKey: 'SHOP' }, ready)).toBe('labels = ai');
  });
  it('is its Jira project with the ready status, when one is chosen', () => {
    expect(jiraQuery({ jiraProjectKey: 'SHOP' }, ready)).toBe('project = "SHOP" AND (status = "Ready for AI")');
    expect(jiraQuery({ jiraProjectKey: 'SH"OP' }, ready)).toBe('project = "SHOP" AND (status = "Ready for AI")');
  });
  it('is the ready status anywhere otherwise', () => {
    expect(jiraQuery({}, ready)).toBe(ready);
    expect(jiraQuery({ jiraJql: '  ', jiraProjectKey: '' }, ready)).toBe(ready);
  });
});
