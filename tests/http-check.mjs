/**
 * http-check.mjs — exercises the Settings page's HTTP surface end to end without a browser.
 *
 * It builds the real host half (accounts, manager, config store) over a temporary data dir and calls the
 * route handlers with fake req/res objects. No ego window is launched, so it is fast and side-effect free.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const dataDir = mkdtempSync(join(tmpdir(), 'ego-publish-http-'));
process.env.EGO_PUBLISH_DATA_DIR = dataDir;

const { AccountStore } = await import('../src/accounts.js');
const { BrowserManager } = await import('../src/browser.js');
const { createConfigStore } = await import('../src/config.js');
const { resolveEgo } = await import('../src/ego.js');
const { createHttpRoutes, ROUTES } = await import('../src/http.js');
const { ProxyStore } = await import('../src/proxies.js');

const configStore = createConfigStore({ patch: {}, env: process.env, dataDir });
const settings = configStore.values();
const ego = resolveEgo({ env: process.env });
const accounts = new AccountStore({ dataDir });
const proxies = new ProxyStore({ dataDir });
const manager = new BrowserManager({ ego, dataDir, settings, accounts, proxies, log: () => {} });
const { routes } = createHttpRoutes({
  ego, accounts, proxies, manager, settings, configStore, dataDir,
  pluginRoot: join(import.meta.dirname, '..'), pluginVersion: '0.4.0-test', log: () => {},
});

function handlerFor(path) {
  const route = routes.find((item) => item.path === path);
  if (!route) throw new Error(`no route for ${path}`);
  return route.handler;
}

/** Fake request/response pair. */
function makeRequest(method, body, contentType = 'application/json') {
  const req = new EventEmitter();
  req.method = method;
  req.headers = body === undefined ? {} : { 'content-type': contentType };
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    headers: null,
    chunks: [],
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
  };
  setImmediate(() => {
    if (payload) req.emit('data', payload);
    req.emit('end');
  });
  return { req, res };
}

async function call(path, { method = 'GET', body, contentType } = {}) {
  const { req, res } = makeRequest(method, body, contentType);
  await handlerFor(path)(req, res);
  const text = Buffer.concat(res.chunks).toString('utf8');
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: res.statusCode, payload };
}

// 1. Status.
const status = await call(ROUTES.STATUS);
record('status route', status.status === 200 && status.payload.ok === true,
  `egoExists=${status.payload?.plugin?.egoExists} flows=${status.payload?.flows?.length}`);
record('status has media + config', (status.payload?.media?.length ?? 0) >= 4 && Boolean(status.payload?.config?.values) && Array.isArray(status.payload?.proxies),
  (status.payload?.media ?? []).map((item) => item.key).join(','));

// 2. Create an account, then a pool proxy, then assign it; the password must never come back.
const created = await call(ROUTES.ACCOUNTS, {
  method: 'POST',
  body: { op: 'upsert', code: 'ui-1', media: 'sohu', account: 'alice' },
});
record('account upsert', created.status === 200 && created.payload.ok === true && created.payload.account.code === 'ui-1',
  JSON.stringify(created.payload?.account?.proxy));

const added = await call(ROUTES.PROXIES, {
  method: 'POST',
  body: { op: 'add', label: 'HK-01', server: 'http://127.0.0.1:7890', username: 'u', password: 'p' },
});
const proxyId = added.payload?.proxy?.id;
record('proxy add', added.status === 200 && proxyId === 'p-1' && added.payload.proxy.hasAuth === true, JSON.stringify(added.payload?.proxy));
record('proxy password redacted', !JSON.stringify(added.payload).includes('"p"'), JSON.stringify(added.payload?.proxy));

const assigned = await call(ROUTES.PROXIES, { method: 'POST', body: { op: 'assign', code: 'ui-1', id: proxyId } });
record('proxy assigned', assigned.status === 200 && assigned.payload.account.proxyId === proxyId
  && assigned.payload.account.proxy.server === 'http://127.0.0.1:7890' && assigned.payload.account.proxySource === `pool:${proxyId}`,
  JSON.stringify(assigned.payload?.account?.proxy));

const pool = await call(ROUTES.PROXIES);
record('pool shows assignment', pool.payload.proxies.length === 1 && pool.payload.proxies[0].assigned.includes('ui-1'),
  JSON.stringify(pool.payload?.proxies?.[0]?.assigned));

// Points trend: a steady decline is "down" even when the last two samples are equal.
const { pointsTrend } = await import('../src/accounts.js');
record('points trend down', pointsTrend([{ value: 50 }, { value: 48 }, { value: 46 }]).trend === 'down');
record('points trend flat', pointsTrend([{ value: 45 }, { value: 45 }]).trend === 'flat');
record('points trend up', pointsTrend([{ value: 40 }, { value: 45 }]).trend === 'up');
record('points trend unknown', pointsTrend([{ value: 45 }]).trend === 'unknown');

// 3. Config write + read back.
const configWrite = await call(ROUTES.CONFIG, { method: 'POST', body: { values: { idleCloseMinutes: 7, requireExplicitPublish: false } } });
record('config write', configWrite.status === 200 && configWrite.payload.values.idleCloseMinutes === 7,
  JSON.stringify(configWrite.payload?.changed));
const configRead = await call(ROUTES.CONFIG);
record('config read', configRead.payload?.values?.requireExplicitPublish === false);
const dataDirWrite = await call(ROUTES.CONFIG, { method: 'POST', body: { values: { dataDir: 'C:/x' } } });
record('dataDir rejected', dataDirWrite.status === 400 && dataDirWrite.payload.error.code === 'DATADIR_FIXED', dataDirWrite.payload?.error?.code);

// 4. Proxy validation, removal (accounts fall back to direct), and the legacy route.
const badProxy = await call(ROUTES.PROXIES, { method: 'POST', body: { op: 'add', server: 'not a proxy' } });
record('invalid proxy rejected', badProxy.status === 400 && badProxy.payload.error.code === 'INVALID_PROXY', badProxy.payload?.error?.code);
const removedProxy = await call(ROUTES.PROXIES, { method: 'POST', body: { op: 'remove', id: proxyId } });
record('proxy remove clears assignment', removedProxy.status === 200
  && removedProxy.payload.affected.includes('ui-1')
  && removedProxy.payload.accounts[0].proxy === null
  && removedProxy.payload.accounts[0].proxyId === null);
const legacySet = await call(ROUTES.PROXY, { method: 'POST', body: { op: 'set', code: 'ui-1', server: 'http://127.0.0.1:7891' } });
record('legacy set adds + assigns', legacySet.status === 200 && Boolean(legacySet.payload.account.proxyId), JSON.stringify(legacySet.payload?.account?.proxy));
const cleared = await call(ROUTES.PROXY, { method: 'POST', body: { op: 'clear', code: 'ui-1' } });
record('proxy clear', cleared.status === 200 && cleared.payload.account.proxy === null);

// 5. Wrong content type is refused (the cross-origin form guard).
const wrongType = await call(ROUTES.ACCOUNTS, { method: 'POST', body: { op: 'remove', code: 'ui-1' }, contentType: 'text/plain' });
record('content-type guard', wrongType.status === 415, String(wrongType.status));

// 6. Flows + removal.
const flows = await call(ROUTES.FLOWS);
record('flows route', flows.payload.ok === true && flows.payload.flows.length >= 3, flows.payload?.flows?.map((flow) => flow.id).join(','));
const removed = await call(ROUTES.ACCOUNTS, { method: 'POST', body: { op: 'remove', code: 'ui-1' } });
record('account remove', removed.status === 200 && removed.payload.removed === true);

await manager.closeAll();
await new Promise((resolve) => setTimeout(resolve, 200));
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
