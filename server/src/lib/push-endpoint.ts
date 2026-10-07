import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * A push endpoint is a URL the SERVER will POST to. The zod schema already
 * refuses IP literals and local names; this also resolves the hostname (every
 * address) and refuses any that land on a private, loopback, link-local,
 * unique-local or otherwise non-public address, and any port but 443. Push
 * services are public HTTPS hosts on the default port.
 */

/** True for an address a public push service could have. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicV4(address);
  if (family === 6) return isPublicV6(address);
  return false;
}

function isPublicV4(address: string): boolean {
  const [a, b, c] = address.split('.').map(Number);
  // this-net, private, loopback, multicast / reserved
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** Expands an IPv6 address to its eight 16-bit groups. */
function v6Groups(address: string): number[] | null {
  let addr = address.toLowerCase().split('%')[0];
  // Trailing dotted IPv4 (e.g. ::ffff:10.0.0.1) → two hex groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    addr = `${addr.slice(0, -v4[1].length)}${hi}:${lo}`;
  }
  const [head, tail] = addr.split('::');
  const parse = (part: string | undefined) =>
    part ? part.split(':').map((g) => parseInt(g, 16)) : [];
  const h = parse(head);
  const t = parse(tail);
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function isPublicV6(address: string): boolean {
  const g = v6Groups(address);
  if (!g) return false;
  if (g.every((x) => x === 0)) return false; // unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // loopback
  // IPv4-mapped / -compatible / NAT64: judge the embedded IPv4 address.
  const embedded = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isPublicV4(embedded);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPublicV4(embedded);
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return true;
}

export type HostLookup = (hostname: string) => Promise<{ address: string }[]>;

const systemLookup: HostLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Resolves the endpoint's host and accepts it only when it is on port 443
 * and EVERY address it resolves to is public. Resolution failures reject too.
 */
export async function isPublicPushEndpoint(
  raw: string,
  resolve: HostLookup = systemLookup,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) return false;
  let addresses: { address: string }[];
  try {
    addresses = await resolve(url.hostname);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address));
}
