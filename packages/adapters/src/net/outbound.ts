import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/*
 * Tandem's cloud connects only to public services on https. Addresses people type (a Jira site, a
 * repository's host) could otherwise point the server at itself, the cloud's metadata service or
 * the private network, and let a page read what answers there. Every address the name resolves to
 * must be public. Around the container, the egress rules of docs/DEPLOYMENT.md do the same.
 */

let publicOnly = false;

/** The web app turns this on at start; the local app and company runners reach whatever their computer can. */
export function restrictOutbound(on: boolean): void {
  publicOnly = on;
}
export const outboundRestricted = () => publicOnly;

const v4 = (ip: string) => ip.split('.').map(Number) as [number, number, number, number];

/** Private, loopback, link-local, shared (CGNAT), multicast and reserved addresses, IPv4 and IPv6. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = v4(ip);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (kind === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
  }
  return true;
}

/** Throws when the address may not be used from Tandem's cloud; does nothing elsewhere. */
export async function checkOutbound(url: string): Promise<void> {
  if (!publicOnly) return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${url} is not a web address.`);
  }
  if (u.protocol !== 'https:') throw new Error(`Tandem's cloud connects only over https (${u.host}).`);
  if (u.username || u.password) throw new Error('Put no user name or password in the address.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    throw new Error(`${u.hostname} could not be found.`);
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error(`${u.hostname} is a private or internal address. Tandem's cloud connects only to public services; use a company runner to reach your own network.`);
}
