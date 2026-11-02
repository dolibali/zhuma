/** A member-only HTTP carrier in front of the ORIGINAL loopback CLI. No owner admission. */
import { createServer, request } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { MEMBER_ROUTE_TUPLES } from './member-routes.mjs';

const routes = new Set(MEMBER_ROUTE_TUPLES.map(([method, path]) => `${method} ${path}`));
const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'forwarded',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  'x-real-ip',
]);
const protectedHeaders = new Set(['host', 'origin', 'cookie', 'authorization', 'content-length']);
function headersOf(headers) {
  const extra = new Set(
    String(headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((v) => v.trim()),
  );
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopHeaders.has(name) && !extra.has(name)),
  );
}

export function memberRequestAllowed(method, target) {
  if (
    typeof target !== 'string' ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    /[\\\u0000-\u0020\u007f]/u.test(target)
  )
    return false;
  const rawPath = target.split('?')[0];
  // Product paths contain no escapes. Reject normalization ambiguities before URL parsing.
  if (rawPath.includes('%') || rawPath.includes('#')) return false;
  try {
    const url = new URL(target, 'http://member.invalid');
    return (
      url.pathname === rawPath &&
      !url.hash &&
      !url.searchParams.has('token') &&
      routes.has(`${method} ${rawPath}`)
    );
  } catch {
    return false;
  }
}

/** The upstream destination is always fixed loopback; Host/Origin are never rewritten. */
export function createMemberGateway({ host, port, operatorPort, authorities, ready = () => true }) {
  const allowed = new Set(authorities);
  const active = new Set();
  const server = createServer(async (req, res) => {
    const deny = (status) => {
      res.writeHead(status, { 'cache-control': 'no-store', connection: 'close' });
      res.end();
    };
    const connection = String(req.headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((v) => v.trim());
    if (connection.some((name) => protectedHeaders.has(name))) return deny(400);
    for (const header of ['host', 'origin']) {
      if (
        req.rawHeaders.filter((_v, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === header)
          .length > 1
      )
        return deny(400);
    }
    if (typeof req.headers.host !== 'string' || !allowed.has(req.headers.host)) return deny(403);
    if (!memberRequestAllowed(req.method, req.url)) return deny(404);
    if (!ready()) return deny(503);
    const abort = new AbortController();
    active.add(abort);
    const disconnected = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', disconnected);
    const forwarded = headersOf(req.headers);
    delete forwarded.authorization;
    if (typeof forwarded.cookie === 'string')
      forwarded.cookie = forwarded.cookie
        .split(';')
        .filter((part) => !part.trim().startsWith('dsh-auth-'))
        .join(';');
    const upstream = request({
      hostname: '127.0.0.1',
      port: operatorPort,
      method: req.method,
      path: req.url,
      headers: forwarded,
      signal: abort.signal,
    });
    // Do not impose a shorter timeout on the original file/planning/SSE handlers.
    upstream.setTimeout(0);
    const incoming = new Promise((resolve, reject) => {
      upstream.once('response', resolve);
      upstream.once('error', reject);
    });
    try {
      // pipe preserves backpressure without pipeline destroying the client socket on early 413.
      req.pipe(upstream);
      const response = await incoming;
      res.writeHead(response.statusCode ?? 502, headersOf(response.headers));
      await pipeline(response, res, { signal: abort.signal });
      // A server may intentionally answer 413 before the upload ends. Dispose the carrier only.
      if (!req.readableEnded) {
        req.unpipe(upstream);
        upstream.destroy();
        req.resume();
      }
    } catch {
      if (!res.headersSent && !res.destroyed) deny(502);
      else if (!res.writableEnded) res.destroy();
    } finally {
      req.unpipe(upstream);
      abort.abort();
      active.delete(abort);
      res.off('close', disconnected);
    }
  });
  server.requestTimeout = 0;
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  });
  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        for (const request of active) request.abort();
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
