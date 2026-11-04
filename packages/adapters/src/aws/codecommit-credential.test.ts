import { describe, expect, it } from 'vitest';
import { codeCommitGitCredential, codeCommitRegion } from './codecommit-credential.js';

describe('CodeCommit git credentials', () => {
  it('signs exactly as botocore does (git-remote-codecommit and the AWS CLI helper)', () => {
    // Reference: botocore SigV4Auth over "GIT\n<path>\n\nhost:<host>\n\nhost\n" at 2026-11-04T12:00:00Z.
    const c = codeCommitGitCredential({ accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', sessionToken: 'FwoGZXIvYXdzEXAMPLETOKEN' }, 'eu-central-1', 'git-codecommit.eu-central-1.amazonaws.com', '/v1/repos/my-repo', new Date('2026-11-04T12:00:00.000Z'));
    expect(c).toEqual({ username: 'AKIAABCDEFGHIJKLMNOP%FwoGZXIvYXdzEXAMPLETOKEN', password: '20261104T120000Z76cef1304a905c765d7e2e4744a4b43cd77ed30ee7e0ac94c39c2522199fbf89' });
  });
  it('reads the region from the git host', () => {
    expect(codeCommitRegion('git-codecommit.eu-central-1.amazonaws.com')).toBe('eu-central-1');
    expect(codeCommitRegion('github.com')).toBeUndefined();
  });
});
