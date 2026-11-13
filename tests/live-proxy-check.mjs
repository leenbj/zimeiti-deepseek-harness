/**
 * live-proxy-check.mjs — proves per-account proxy routing and environment isolation through the
 * plugin's own live Settings routes (the running Harness), not through a private instance.
 *
 * It starts a loopback HTTP proxy that answers `http://ip.ego.test/` with a marker IP, creates two
 * accounts through `/ego-publish/accounts`, opens both through `/ego-publish/accounts/session`, then
 * uses CDP against each returned debugging port to read what the account browser actually sees.
 *
 * Run: node tests/live-proxy-check.mjs   (the Harness must be running with the plugin installed)
 */
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CdpConnection, TargetSession, sleep } from '../src/cdp.js';

const BASE = process.env.EGO_LIVE_BASE || 'http://127.0.0.1:57437';
const FAKE_IP = '203.0.113.7';
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- a counting proxy that also serves the fake IP page -------------------------------------------
const seen = [];
const proxy = http.createServer((request, response) => {
  seen.push(`HTTP ${request.url}`);
  if (String(request.url).includes('ip.ego.test')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body><pre id="ip">${FAKE_IP}</pre></body></html>`);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('proxy-ok');
});
proxy.on('connect', (request, clientSocket, head) => {
  seen.push(`CONNECT ${request.url}`);
  const text = String(request.url);
  const index = text.lastIndexOf(':');
  const host = text.slice(0, index);
  const port = Number(text.slice(index + 1));
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
});
const proxyPort = await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
console.log(`proxy on 127.0.0.1:${proxyPort}`);

// ---- live plugin routes ---------------------------------------------------------------------------
async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}
async function get(path) {
  const response = await fetch(`${BASE}${path}`);
  return response.json();
}

const status = await get('/ego-publish/status');
record('live plugin reachable', status.ok === true && status.plugin?.version === '0.4.0', `version=${status.plugin?.version}`);

const created = await post('/ego-publish/accounts', {
  op: 'upsert',
  code: 'live-a',
  media: 'custom',
  account: 'A',
  homeUrl: 'http://ip.ego.test/',
  loginUrl: 'http://ip.ego.test/',
});
record('account A created', created.ok === true, JSON.stringify(created.account?.proxy));

const addedProxy = await post('/ego-publish/proxies', {
  op: 'add',
  label: 'live-proxy',
  server: `http://127.0.0.1:${proxyPort}`,
});
const liveProxyId = addedProxy.proxy?.id;
record('proxy added to pool', addedProxy.ok === true && Boolean(liveProxyId), JSON.stringify(addedProxy.proxy));

const assigned = await post('/ego-publish/proxies', { op: 'assign', code: 'live-a', id: liveProxyId });
record('proxy assigned to account', assigned.ok === true
  && assigned.account?.proxyId === liveProxyId
  && assigned.account?.proxy?.server === `http://127.0.0.1:${proxyPort}`, JSON.stringify(assigned.account?.proxy));
const createdB = await post('/ego-publish/accounts', {
  op: 'upsert',
  code: 'live-b',
  media: 'custom',
  account: 'B',
  homeUrl: 'http://ip.ego.test/',
  loginUrl: 'http://ip.ego.test/',
});
record('account B created direct', createdB.ok === true && createdB.account?.proxy === null, 'proxy=null');

async function open(code) {
  const payload = await post('/ego-publish/accounts/session', { op: 'open', code });
  if (!payload.ok) throw new Error(`open ${code} failed: ${payload.error?.message}`);
  const session = (payload.sessions || []).find((item) => item.accountCode === code);
  if (!session?.port) throw new Error(`no debugging port for ${code}`);
  return session;
}

const sessionA = await open('live-a');
const sessionB = await open('live-b');
record('both browsers opened', Boolean(sessionA.port && sessionB.port), `A=${sessionA.port} B=${sessionB.port}`);

// ---- read the page through each account browser ----------------------------------------------------
async function readPage(port, url) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const connection = await CdpConnection.connect(info.webSocketDebuggerUrl, { timeoutMs: 15000 });
  const createdTarget = await connection.send('Target.createTarget', { url: 'about:blank' });
  const attached = await connection.send('Target.attachToTarget', { targetId: createdTarget.targetId, flatten: true });
  const page = new TargetSession(connection, createdTarget.targetId, attached.sessionId, { actionTimeoutMs: 15000, navigationTimeoutMs: 30000 });
  const navigation = await page.send('Page.navigate', { url }).catch((error) => ({ errorText: String(error?.message ?? error) }));
  await sleep(1200);
  const text = await page.evaluate('document.body ? document.body.innerText : ""').catch(() => '');
  await page.close().catch(() => {});
  connection.close();
  return { errorText: navigation?.errorText ?? null, text: String(text) };
}

const pageA = await readPage(sessionA.port, 'http://ip.ego.test/');
record('account A exits through its proxy', pageA.text.includes(FAKE_IP), JSON.stringify(pageA).slice(0, 200));
record('proxy saw account A traffic', seen.some((line) => line.includes('ip.ego.test')), seen.slice(0, 4).join(' | '));

const pageB = await readPage(sessionB.port, 'http://ip.ego.test/');
record('account B does not resolve the fake host', Boolean(pageB.errorText) || !pageB.text.includes(FAKE_IP), JSON.stringify(pageB).slice(0, 160));

// ---- environment isolation at the OS level --------------------------------------------------------
function egoCommandLines(fragment) {
  const script = `Get-CimInstance Win32_Process -Filter "Name='ego.exe'" | Where-Object { $_.CommandLine -match '${fragment}' } | Select-Object -ExpandProperty CommandLine`;
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000 });
    return output.split(/\r?\n/).filter((line) => line.trim().startsWith('"')).map((line) => line.trim());
  } catch {
    return [];
  }
}

const commandA = egoCommandLines('profiles\\\\live-a').join('\n');
const commandB = egoCommandLines('profiles\\\\live-b').join('\n');
record('A runs with its own user-data-dir', /--user-data-dir=[^ ]*live-a/.test(commandA), commandA.slice(0, 160));
record('A runs with the account proxy', commandA.includes(`--proxy-server=http://127.0.0.1:${proxyPort}`), commandA.slice(0, 200));
record('B runs with its own user-data-dir', /--user-data-dir=[^ ]*live-b/.test(commandB), commandB.slice(0, 160));
record('B runs without a proxy flag', commandB.length > 0 && !commandB.includes('--proxy-server'), commandB.slice(0, 160));
record('A and B use different profiles', Boolean(commandA) && Boolean(commandB) && commandA !== commandB);

const profileRoot = join(homedir(), '.dsh', 'ego-publish', 'profiles');
record('profiles live in separate directories', existsSync(join(profileRoot, 'live-a')) && existsSync(join(profileRoot, 'live-b')),
  `${join(profileRoot, 'live-a')} | ${join(profileRoot, 'live-b')}`);

// ---- cleanup --------------------------------------------------------------------------------------
await post('/ego-publish/accounts/session', { op: 'close', code: 'live-a' });
await post('/ego-publish/accounts/session', { op: 'close', code: 'live-b' });
await post('/ego-publish/accounts', { op: 'remove', code: 'live-a', removeProfile: true });
await post('/ego-publish/accounts', { op: 'remove', code: 'live-b', removeProfile: true });
if (liveProxyId) await post('/ego-publish/proxies', { op: 'remove', id: liveProxyId });
await new Promise((resolve) => proxy.close(resolve));
await sleep(300);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
