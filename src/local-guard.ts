import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Lowercase a host and strip IPv6 brackets: "[::1]" and "::1" compare equal. */
function normalizeHost(host: string) {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/** The hostname part of a Host header, without the port. */
export function hostnameOf(hostHeader: string | undefined) {
  if (!hostHeader) return "";
  const value = hostHeader.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  return normalizeHost(bracketed ? bracketed[1] : value.replace(/:\d+$/, ""));
}

function isIpv6Loopback(address: string) {
  if (/^::ffff:127\./.test(address)) return true;
  const [head, tail] = address.includes("::") ? address.split("::") : [address, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(8 - left.length - right.length, 0)).fill("0"), ...right];
  return groups.length === 8 && groups.slice(0, 7).every((group) => /^0+$/.test(group)) && /^0*1$/.test(groups[7]);
}

/** localhost (any case), any 127.0.0.0/8 address, or ::1 in any spelling. */
export function isLoopbackHost(host: string) {
  const h = normalizeHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  if (isIP(h) === 6) return isIpv6Loopback(h);
  return false;
}

/**
 * Whether the Host check applies: the bind address resolves to a loopback
 * address (127.1 and 2130706433 do), or it cannot be resolved (fail closed).
 * Binding to a non-loopback address such as 0.0.0.0 is an explicit opt-in.
 */
export async function bindNeedsHostGuard(
  bindHost: string,
  resolve: (host: string, options: { all: true }) => Promise<Array<{ address: string }>> = lookup,
): Promise<boolean> {
  const host = normalizeHost(bindHost);
  if (isLoopbackHost(host)) return true;
  if (isIP(host)) return false;
  try {
    const addresses = await resolve(host, { all: true });
    return addresses.length === 0 || addresses.some((entry) => isLoopbackHost(entry.address));
  } catch {
    return true;
  }
}
