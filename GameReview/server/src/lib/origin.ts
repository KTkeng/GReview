/**
 * Same-origin protection for local write operations (design §12).
 * Reads may omit Origin (local CLI probes); browser writes must come from this
 * machine on the configured backend port. No CORS headers are ever emitted.
 */

import { AppError } from './errors';

export interface OriginRequest {
  method: string;
  origin?: string;
  host?: string;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Strip an optional `:port` from a Host header without accepting userinfo,
 * paths, commas or anything else spoofable. IPv6 literals must be bracketed.
 */
function hostnameOf(host: string): string | null {
  const value = host.trim();
  if (!value) return null;
  if (value.startsWith('[')) {
    const match = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(value);
    return match ? match[1].toLowerCase() : null;
  }
  const match = /^([^:/\s\\@,]+)(?::(\d{1,5}))?$/.exec(value);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Host header check against DNS rebinding: an arbitrary domain that resolves to
 * 127.0.0.1 must not be able to address this local service. The port is not
 * part of the check because dev proxies and test servers use ephemeral ports,
 * but the hostname itself must be an explicit loopback name.
 */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = hostnameOf(host);
  return hostname !== null && ALLOWED_HOSTNAMES.has(hostname);
}

/**
 * Check an explicit Origin value. Only the two exact local origins for the
 * configured port are accepted: `http://127.0.0.1:<port>` and
 * `http://localhost:<port>`. HTTPS, IPv6 literals, credentials, paths, query
 * strings and any other spelling are rejected outright (review R5 minor).
 * A missing Origin is NOT allowed here: write operations must prove they come
 * from this machine (design §12). Read helpers decide separately whether an
 * absent Origin is acceptable.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  const expectedPort = Number.isFinite(port) ? Math.trunc(port) : 53821;
  return origin === `http://127.0.0.1:${expectedPort}` || origin === `http://localhost:${expectedPort}`;
}

/**
 * Write operations (POST/PUT/PATCH/DELETE) require an explicit, allow-listed
 * Origin. Requests without Origin are rejected with 403, matching the design
 * rule that writes only accept the configured local origin.
 */
export function allowWrite(req: OriginRequest, port: number = 53821): boolean {
  if (!WRITE_METHODS.has(req.method.toUpperCase())) return true;
  return isAllowedOrigin(req.origin, port);
}

export function allowRead(req: OriginRequest, _port?: number): boolean {
  const method = req.method.toUpperCase();
  if (WRITE_METHODS.has(method)) return allowWrite(req, _port ?? 53821);
  // GET/HEAD/OPTIONS may be local CLI requests without Origin, but a present
  // cross-site Origin is still rejected for consistency and CSRF hardening.
  if (!req.origin) return true;
  return isAllowedOrigin(req.origin, _port ?? 53821);
}

export function originMiddleware(port: number) {
  return (req: { method: string; headers: Record<string, unknown> }, _res: unknown, next: (err?: unknown) => void) => {
    const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
    if (!isAllowedHost(host)) {
      next(new AppError('FORBIDDEN', `Host ${host ?? '(缺少)'} 不在本机允许列表`));
      return;
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (WRITE_METHODS.has(req.method.toUpperCase()) && !allowWrite({ method: req.method, origin }, port)) {
      next(new AppError('FORBIDDEN', `Origin ${origin} 不在本机允许列表`));
      return;
    }
    next();
  };
}
