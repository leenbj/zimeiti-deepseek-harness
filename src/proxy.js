/**
 * proxy.js — per-account proxy parsing, a local authenticating relay, and an exit-IP probe.
 *
 * Chromium accepts one `--proxy-server` per browser instance and ignores credentials embedded in that
 * URL. So an authenticated upstream proxy is fronted by a tiny loopback relay started by this plugin:
 * the browser talks plain HTTP to 127.0.0.1, and the relay adds `Proxy-Authorization` on every CONNECT
 * and forwarded request. Plain (credential-free) proxies are passed through untouched.
 *
 * @module ego-publish/proxy
 */
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

import { EgoError } from './cdp.js';

/**
 * Parse a proxy descriptor.
 * @param {string | { server: string, username?: string, password?: string } | null | undefined} input
 * @returns {{ url: string, protocol: string, host: string, port: number, username: string, password: string } | null}
 */
export function parseProxy(input) {
  if (!input) return null;
  let server = typeof input === 'string' ? input : input?.server;
  if (typeof server !== 'string' || !server.trim()) {
    throw new EgoError('INVALID_PROXY', 'proxy.server is required (for example http://127.0.0.1:7890)');
  }
  server = server.trim();
  if (!/^[a-z0-9+.-]+:\/\//i.test(server)) server = `http://${server}`;
  let url;
  try {
    url = new URL(server);
  } catch {
    throw new EgoError('INVALID_PROXY', `cannot parse the proxy server "${server}"`);
  }
  const protocol = url.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks4', 'socks5', 'socks'].includes(protocol)) {
    throw new EgoError('INVALID_PROXY', `unsupported proxy protocol "${protocol}" (use http, https or socks5)`);
  }
  const port = Number(url.port || (protocol === 'https' ? 443 : 1080));
  if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new EgoError('INVALID_PROXY', `the proxy server "${server}" needs a valid host and port`);
  }
  const username = (typeof input === 'object' ? input?.username : undefined) || decodeURIComponent(url.username || '');
  const password = (typeof input === 'object' ? input?.password : undefined) || decodeURIComponent(url.password || '');
  return { url: `${protocol}://${url.hostname}:${port}`, protocol, host: url.hostname, port, username, password };
}

/** True when the value already came out of `parseProxy`. */
function isParsedProxy(value) {
  return Boolean(value && typeof value === 'object' && value.host && value.port && value.url && !value.server);
}

/**
 * A proxy record that is safe to show the model (never includes the password).
 * @param {string | object | null | undefined} input
 */
export function redactProxy(input) {
  const parsed = (() => {
    try {
      return isParsedProxy(input) ? input : parseProxy(input);
    } catch {
      return null;
    }
  })();
  if (!parsed) return null;
  return {
    server: parsed.url,
    protocol: parsed.protocol,
    hasAuth: Boolean(parsed.username || parsed.password),
    username: parsed.username || null,
    source: typeof input === 'object' && input?.source ? String(input.source) : null,
  };
}

/** True when the proxy needs a relay because it carries credentials. */
export function needsRelay(parsed) {
  return Boolean(parsed && (parsed.username || parsed.password));
}

/**
 * Start a loopback relay in front of an authenticated upstream proxy.
 *
 * The returned `url` is what `--proxy-server` should receive. When the proxy has no credentials the
 * upstream URL is returned directly and `close()` is a no-op.
 *
 * @param {string | object} input
 * @returns {Promise<{ url: string, close: () => Promise<void>, relayed: boolean }>}
 */
export async function startProxyRelay(input) {
  const parsed = isParsedProxy(input) ? input : parseProxy(input);
  if (!parsed) throw new EgoError('INVALID_PROXY', 'a proxy is required');
  if (parsed.protocol.startsWith('socks')) {
    if (needsRelay(parsed)) {
      throw new EgoError('PROXY_UNSUPPORTED', 'SOCKS proxies with a username/password are not supported; use an HTTP proxy instead');
    }
    return { url: parsed.url, close: async () => {}, relayed: false };
  }
  if (!needsRelay(parsed)) {
    return { url: parsed.url, close: async () => {}, relayed: false };
  }
  if (parsed.protocol !== 'http') {
    throw new EgoError('PROXY_UNSUPPORTED', 'only plain HTTP proxies can carry credentials through the local relay');
  }

  const authorization = `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')}`;
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    return socket;
  };

  const server = http.createServer((request, response) => {
    if (!/^https?:\/\//i.test(String(request.url))) {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('ego-publish proxy relay expects an absolute-form HTTP request');
      return;
    }
    let target;
    try {
      target = new URL(String(request.url));
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('bad request URL');
      return;
    }
    const upstream = http.request({
      host: parsed.host,
      port: parsed.port,
      method: request.method,
      path: String(request.url),
      headers: {
        ...request.headers,
        host: target.host,
        'proxy-authorization': authorization,
        'proxy-connection': 'keep-alive',
      },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('upstream proxy error');
    });
    request.pipe(upstream);
  });

  server.on('connect', (request, clientSocket, head) => {
    const authority = String(request.url ?? '');
    const [host, portText] = splitAuthority(authority);
    const port = Number(portText || 443);
    if (!host || !Number.isInteger(port)) {
      clientSocket.destroy();
      return;
    }
    track(clientSocket);
    const upstream = track(net.connect(parsed.port, parsed.host));
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.on('connect', () => {
      upstream.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: ${authorization}\r\nProxy-Connection: keep-alive\r\n\r\n`,
      );
    });
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > 64 * 1024) fail();
        return;
      }
      settled = true;
      upstream.removeListener('data', onData);
      const header = buffer.slice(0, end).toString('latin1');
      const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(header)?.[1] ?? 0);
      if (status !== 200) {
        clientSocket.end(`HTTP/1.1 ${status || 502} Upstream Proxy Error\r\n\r\n`);
        upstream.destroy();
        return;
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buffer.slice(end + 4);
      if (rest.length) clientSocket.write(rest);
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    };
    upstream.on('data', onData);
    upstream.on('error', fail);
    clientSocket.on('error', fail);
    clientSocket.on('close', () => upstream.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) throw new EgoError('PROXY_RELAY_FAILED', 'the local proxy relay did not bind a port');

  return {
    url: `http://127.0.0.1:${port}`,
    relayed: true,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve(undefined));
      setTimeout(resolve, 1500).unref?.();
    }),
  };
}

/** Split `host:port` (IPv6 literals included). */
function splitAuthority(authority) {
  const text = String(authority).trim();
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return ['', ''];
    return [text.slice(1, end), text.slice(end + 2)];
  }
  const index = text.lastIndexOf(':');
  if (index < 0) return [text, ''];
  return [text.slice(0, index), text.slice(index + 1)];
}

/** HTTP status line + body from a raw socket, used by the exit-IP probe. */
function readHttpResponse(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new EgoError('PROXY_TIMEOUT', `the proxy did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(new EgoError('PROXY_TEST_FAILED', `proxy connection error: ${error?.message ?? error}`));
    };
    const onClose = () => {
      cleanup();
      if (buffer.length) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd >= 0) {
          resolve({
            status: Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(buffer.slice(0, headerEnd).toString('latin1'))?.[1] ?? 0),
            headers: {},
            body: buffer.slice(headerEnd + 4),
          });
          return;
        }
      }
      reject(new EgoError('PROXY_TEST_FAILED', 'the proxy closed the connection before sending a response'));
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const head = buffer.slice(0, headerEnd).toString('latin1');
      const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(head)?.[1] ?? 0);
      const headers = {};
      for (const line of head.split('\r\n').slice(1)) {
        const index = line.indexOf(':');
        if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      const body = buffer.slice(headerEnd + 4);
      const length = Number(headers['content-length'] ?? 0);
      const chunked = /chunked/i.test(headers['transfer-encoding'] ?? '');
      const bodyText = body.toString('latin1');
      const chunkedDone = chunked && /(?:^|\r\n)0\r\n\r\n$/.test(bodyText);
      // A CONNECT reply (and any unlabelled empty body) has neither header: its body is empty and
      // complete the moment the header block ends.
      const complete = length > 0 ? body.length >= length : (chunked ? chunkedDone : true);
      if (!complete) return; // keep reading
      cleanup();
      resolve({ status, headers, body });
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * Probe a proxy: connect through it, request an IP echo endpoint over TLS, and report the exit IP.
 *
 * @param {string | object} input
 * @param {{ timeoutMs?: number, url?: string }} [options]
 * @returns {Promise<{ ok: boolean, ip: string|null, latencyMs: number, server: string, detail?: string }>}
 */
export async function testProxy(input, options = {}) {
  const parsed = isParsedProxy(input) ? input : parseProxy(input);
  if (!parsed) throw new EgoError('INVALID_PROXY', 'a proxy is required');
  if (parsed.protocol.startsWith('socks')) {
    throw new EgoError('PROXY_UNSUPPORTED', 'exit-IP probes support HTTP proxies only; SOCKS can still be used by the browser');
  }
  // A domestic echo endpoint on purpose: these pools are mainland residential proxies, and most of
  // them cannot reach api.ipify.org (Cloudflare) at all — the failure there looks identical to a dead
  // proxy ("CONNECT aborted"), which made every healthy proxy report as unreachable.
  const target = new URL(options.url ?? 'https://myip.ipip.net');
  const timeoutMs = options.timeoutMs ?? 20000;
  const started = Date.now();

  /** @type {net.Socket} */
  const socket = await new Promise((resolve, reject) => {
    const connection = net.connect(parsed.port, parsed.host);
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new EgoError('PROXY_TIMEOUT', `cannot reach the proxy ${parsed.url} within ${timeoutMs}ms`));
    }, timeoutMs);
    connection.once('connect', () => {
      clearTimeout(timer);
      const authorization = parsed.username || parsed.password
        ? 'Basic ' + Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')
        : '';
      const lines = [
        `CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1`,
        `Host: ${target.hostname}:${target.port || 443}`,
      ];
      if (authorization) lines.push(`Proxy-Authorization: ${authorization}`);
      lines.push('Proxy-Connection: keep-alive', '', '');
      connection.write(lines.join('\r\n'));
      resolve(connection);
    });
    connection.once('error', (error) => {
      clearTimeout(timer);
      reject(new EgoError('PROXY_UNREACHABLE', `cannot connect to the proxy ${parsed.url}: ${error?.message ?? error}`));
    });
  });

  const tunnel = await readHttpResponse(socket, timeoutMs);
  if (tunnel.status !== 200) {
    socket.destroy();
    const hint = tunnel.status === 407 ? ' (the proxy rejected the username/password)' : '';
    throw new EgoError('PROXY_REJECTED', `the proxy answered CONNECT with HTTP ${tunnel.status}${hint}`, { status: tunnel.status });
  }

  const secure = await new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false }, () => resolve(tlsSocket));
    tlsSocket.once('error', (error) => reject(new EgoError('PROXY_TLS_FAILED', `TLS through the proxy failed: ${error?.message ?? error}`)));
  });
  const path = `${target.pathname || '/'}${target.search || ''}`;
  secure.write(`GET ${path} HTTP/1.1\r\nHost: ${target.hostname}\r\nUser-Agent: ego-publish/0.1\r\nAccept: application/json, text/plain\r\nConnection: close\r\n\r\n`);
  const response = await readHttpResponse(secure, timeoutMs);
  secure.destroy();
  const text = response.body.toString('utf8');
  let ip = null;
  try {
    const parsedBody = JSON.parse(text);
    ip = parsedBody.ip ?? parsedBody.origin ?? null;
  } catch {
    const match = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(text);
    ip = match ? match[1] : null;
  }
  if (!ip) {
    throw new EgoError('PROXY_PROBE_FAILED', `the proxy answered HTTP ${response.status} without an IP: ${text.slice(0, 160)}`);
  }
  return { ok: true, ip, latencyMs: Date.now() - started, server: parsed.url };
}
