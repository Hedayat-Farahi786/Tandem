import { describe, expect, it } from 'vitest';
import { reasonOf } from './git.js';

describe('git failure reasons', () => {
  it("keeps the reason and drops git's progress chatter", () => {
    const stderr = [
      "Cloning into bare repository '/home/u/.tandem/mirrors/codecommit-eu-central-1/shop.git'...",
      '',
      "Your session has expired. Please reauthenticate using 'aws login'.",
      "fatal: could not read Username for 'https://git-codecommit.eu-central-1.amazonaws.com/v1/repos/shop': terminal prompts disabled",
    ].join('\n');
    expect(reasonOf(stderr)).toBe("Your session has expired. Please reauthenticate using 'aws login'.");
    expect(reasonOf('remote: Counting objects: 5\nfatal: repository not found')).toBe('fatal: repository not found');
  });
});
