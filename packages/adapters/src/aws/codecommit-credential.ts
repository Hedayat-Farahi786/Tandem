import { createHash, createHmac } from 'node:crypto';

export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s, 'utf8').digest();

/**
 * The username and password git uses for CodeCommit over HTTPS, signed from AWS credentials (the
 * same SigV4 "GIT" signature the AWS CLI's credential helper and git-remote-codecommit compute), so
 * Tandem needs neither the AWS CLI nor Git credentials made in IAM. Valid for a few minutes.
 */
export function codeCommitGitCredential(keys: AwsKeys, region: string, host: string, path: string, now = new Date()): { username: string; password: string } {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  const date = timestamp.slice(0, 8);
  const p = path.startsWith('/') ? path : `/${path}`;
  const canonicalRequest = `GIT\n${p}\n\nhost:${host}\n\nhost\n`;
  const scope = `${date}/${region}/codecommit/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const key = hmac(hmac(hmac(hmac(`AWS4${keys.secretAccessKey}`, date), region), 'codecommit'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return { username: keys.sessionToken ? `${keys.accessKeyId}%${keys.sessionToken}` : keys.accessKeyId, password: `${timestamp}Z${signature}` };
}

/** "git-codecommit.eu-central-1.amazonaws.com" → "eu-central-1". */
export function codeCommitRegion(host: string): string | undefined {
  return /^git-codecommit(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(host)?.[1];
}
