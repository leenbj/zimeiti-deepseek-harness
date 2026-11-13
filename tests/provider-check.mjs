/**
 * provider-check.mjs — Shenlong extraction against a local mock (no real credentials needed).
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const dataDir = mkdtempSync(join(tmpdir(), 'ego-publish-provider-'));
const { ProxyStore } = await import('../src/proxies.js');
const { extractProxies } = await import('../src/provider.js');

let mode = 'ok';
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/ip') {
    if (mode === 'error') return res.end(JSON.stringify({ code: 203, msg: '请求KEY异常' }));
    return res.end(JSON.stringify({ code: 200, data: [{ ip: '1.2.3.4', port: 8080, expire: 300, city: '上海', isp: '电信' }] }));
  }
  if (url.pathname === '/white/add') return res.end(JSON.stringify({ code: 200, msg: 'ok' }));
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const configStore = {
  values: () => ({
    proxyApiUrl: `http://127.0.0.1:${port}/ip?key=k&sign=s&pattern=json`,
    proxyApiWhitelist: false,
  }),
};
const proxies = new ProxyStore({ dataDir });

const first = await extractProxies({ configStore, proxies, log: () => {} }, { count: 1 });
record('extract adds a pool entry', first.added.length === 1 && first.added[0].server === 'http://1.2.3.4:8080',
  JSON.stringify(first.added));
const again = await extractProxies({ configStore, proxies, log: () => {} }, { count: 1 });
record('duplicate server is skipped', again.added.length === 0 && proxies.list().length === 1);

mode = 'error';
let error = null;
try { await extractProxies({ configStore, proxies, log: () => {} }, { count: 1 }); } catch (caught) { error = caught; }
record('provider error is surfaced', error?.code === 'PROXY_API_ERROR' && /203/.test(error.message), error?.message);

server.close();
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
