/**
 * isolation.mjs — proves the two guarantees that make this plugin more than a wrapper:
 *
 *   1. each account has its own cookie jar that survives a browser restart;
 *   2. each account leaves through its own proxy, and only that account uses it.
 *
 * It runs a loopback HTTP proxy that counts CONNECT tunnels, binds it to one account, and checks the
 * traffic. Run with the DSH bundled Node: `node tests/isolation.mjs`.
 */
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** A counting, optionally authenticating, forwarding proxy. */
function startProxy({ requireAuth = null } = {}) {
  const seen = [];
  const server = http.createServer((request, response) => {
    if (requireAuth) {
      const header = request.headers['proxy-authorization'];
      if (header !== requireAuth) {
        response.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
        response.end();
        return;
      }
      seen.push(`HTTP ${request.url} auth=ok`);
    } else {
      seen.push(`HTTP ${request.url}`);
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('proxy-ok');
  });
  server.on('connect', (request, clientSocket) => {
    const header = request.headers['proxy-authorization'];
    if (requireAuth && header !== requireAuth) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      return;
    }
    seen.push(`CONNECT ${request.url}${requireAuth ? ' auth=ok' : ''}`);
    const index = String(request.url).lastIndexOf(':');
    const host = String(request.url).slice(0, index);
    const port = Number(String(request.url).slice(index + 1));
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      seen,
      close: () => new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
        setTimeout(done, 1500).unref?.();
      }),
    }));
  });
}

const dataDir = mkdtempSync(join(tmpdir(), 'ego-publish-iso-'));
process.env.EGO_PUBLISH_DATA_DIR = dataDir;
setTimeout(() => {
  console.error('WATCHDOG: isolation test exceeded 180s');
  process.exit(3);
}, 180000).unref();

const { BrowserManager } = await import('../src/browser.js');
const { AccountStore } = await import('../src/accounts.js');
const { resolveEgo } = await import('../src/ego.js');
const { parseProxy, testProxy } = await import('../src/proxy.js');

const settings = { actionTimeoutMs: 15000, navigationTimeoutMs: 60000, idleCloseMinutes: 0 };
const ego = resolveEgo({ env: process.env });
const accounts = new AccountStore({ dataDir });
const manager = new BrowserManager({ ego, dataDir, settings, accounts, log: () => {} });

const proxy = await startProxy();

accounts.upsert({ code: 'acct-a', media: 'custom', proxy: { server: `http://127.0.0.1:${proxy.port}` } });
accounts.upsert({ code: 'acct-b', media: 'custom' });

// 1. Account A leaves through the proxy.
const a1 = await manager.open('acct-a');
await a1.page.goto('https://example.com', { timeoutMs: 45000, waitUntil: 'domcontentloaded' });
record('account A uses its proxy', proxy.seen.some((line) => line.startsWith('CONNECT example.com:443')), proxy.seen.slice(0, 3).join(' | '));

// 2. Account B goes direct: the proxy must not see its navigation host.
const b1 = await manager.open('acct-b');
await b1.page.goto('https://example.org', { timeoutMs: 45000, waitUntil: 'domcontentloaded' });
record('account B goes direct', !proxy.seen.some((line) => line.includes('example.org')), `proxy saw ${proxy.seen.filter((line) => line.includes('example.org')).length} example.org tunnels`);

// 3. Cookies are per account and survive a restart.
await a1.page.evaluate('document.cookie = "ego_isolation=A; path=/; max-age=3600"');
const aCookieNow = await a1.page.evaluate('document.cookie');
const bCookieNow = await b1.page.evaluate('document.cookie');
record('account A set its cookie', String(aCookieNow).includes('ego_isolation=A'), String(aCookieNow).slice(0, 120));
record('account B cannot see it', !String(bCookieNow).includes('ego_isolation'), String(bCookieNow).slice(0, 120));

// Give Chromium a moment to flush the cookie jar before the clean shutdown.
await new Promise((resolve) => setTimeout(resolve, 1500));
await manager.close('acct-a');
await manager.close('acct-b');

const a2 = await manager.open('acct-a');
const a2goto = await a2.page.goto('https://example.com', { timeoutMs: 45000, waitUntil: 'domcontentloaded' }).catch((error) => ({ error: String(error?.message ?? error) }));
const aCookieAfterRestart = await a2.page.evaluate('document.cookie');
record('cookie survives a browser restart', String(aCookieAfterRestart).includes('ego_isolation=A'), `${JSON.stringify(a2goto).slice(0, 80)} cookie=${String(aCookieAfterRestart).slice(0, 120)}`);
await manager.closeAll();

// 4. Authenticated proxy: the relay adds credentials; the probe reports an exit IP.
const authProxy = await startProxy({ requireAuth: `Basic ${Buffer.from('user:secret').toString('base64')}` });
let probeError = null;
let probe = null;
try {
  probe = await testProxy({ server: `http://user:secret@127.0.0.1:${authProxy.port}` }, { url: 'https://api.ipify.org?format=json', timeoutMs: 20000 });
} catch (error) {
  probeError = error;
}
record('authenticated proxy probe', Boolean(probe?.ip), probe ? `ip=${probe.ip} ${probe.latencyMs}ms` : String(probeError?.message));
record('relay injected credentials', authProxy.seen.some((line) => line.includes('auth=ok')), authProxy.seen.slice(0, 2).join(' | '));

// 5. A browser behind an authenticated proxy: the relay must add the credentials for real traffic.
accounts.upsert({ code: 'acct-c', media: 'custom', proxy: { server: `http://user:secret@127.0.0.1:${authProxy.port}` } });
const c1 = await manager.open('acct-c');
await c1.page.goto('https://example.com', { timeoutMs: 45000, waitUntil: 'domcontentloaded' }).catch(() => null);
record('browser uses the auth relay', authProxy.seen.some((line) => line.includes('example.com:443') && line.includes('auth=ok')), authProxy.seen.slice(0, 4).join(' | '));
await manager.close('acct-c');

// 6. Parse/reject proxy descriptors.
record('rejects a bad proxy', (() => {
  try {
    parseProxy('not a proxy');
    return false;
  } catch {
    return true;
  }
})());

await authProxy.close();
await proxy.close();
await new Promise((resolve) => setTimeout(resolve, 500));
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* browser may still hold a file */ }

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
// ego lite keeps child processes alive; force the exit so a failed assertion cannot hang the run.
setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
