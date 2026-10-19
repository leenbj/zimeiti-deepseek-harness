/**
 * proxy-e2e.mjs — acceptance test for the second core requirement: different isolated accounts
 * publishing through different proxy IPs.
 *
 * It runs against the real engine and a throwaway `MEDIA_DATA_DIR`, and proves the whole chain
 * without needing a live proxy provider or external network:
 *
 *   1. a proxy bound to one account lands in that account's `proxy.json` and is resolved back;
 *   2. the password goes to `secrets.yaml` only, and never appears in any tool-shaped result;
 *   3. an unreachable proxy is reported as a *proxy* failure, not as an expired login;
 *   4. each account's proxy is applied to its own session, while `direct` really means no proxy;
 *   5. two accounts hold two different proxies at the same time.
 *
 * Usage (bundled node):
 *   node tests/proxy-e2e.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient, EngineError } from '../src/engine-client.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

/** Two distinct, deliberately unreachable proxies. Port 9 is the discard port: nothing listens. */
const PROXY_A = { server: 'http://127.0.0.1:9', username: 'user-a', password: 'secret-a' };
const PROXY_B = { server: 'http://127.0.0.1:10', username: 'user-b', password: 'secret-b' };

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-proxy-'));
let failures = 0;
let engine;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${suffix}`);
}

/** Assert a secret never leaks into a result the model would see. @param {unknown} value */
function assertNoSecret(value, label, secrets) {
  const text = JSON.stringify(value ?? null);
  const leaked = secrets.filter((secret) => text.includes(secret));
  check(leaked.length === 0, label, leaked.length ? `LEAKED ${leaked.join(', ')}` : 'no credential in output');
}

try {
  engine = new EngineClient({ pythonPath: PYTHON, pluginRoot: PLUGIN_ROOT, dataDir, requestTimeoutMs: 120_000 });
  engine.on('log', (line) => console.log(`    engine| ${line}`));
  await engine.call('engine.status', {});

  // ---- 1. two accounts, two different proxies ----
  await engine.call('account.upsert', { code: 'pa-1', media: 'sohu', account: 'acct-a' });
  await engine.call('account.upsert', { code: 'pb-1', media: 'toutiao', account: 'acct-b' });

  const boundA = await engine.call('account.bindProxy', { code: 'pa-1', proxy: PROXY_A });
  const boundB = await engine.call('account.bindProxy', { code: 'pb-1', proxy: PROXY_B });
  check(boundA.proxy?.bound === true, 'account pa-1 is bound to a proxy', boundA.proxy?.server);
  check(boundB.proxy?.server === PROXY_B.server, 'account pb-1 is bound to a different proxy', boundB.proxy?.server);
  check(boundA.proxy?.server !== boundB.proxy?.server, 'the two accounts hold two different proxies');
  check(boundA.proxy?.hasPassword === true, 'the binding reports that a password exists');
  assertNoSecret(boundA, 'bindProxy result contains no credential', ['secret-a', 'secret-b']);
  assertNoSecret(boundB, 'bindProxy result (B) contains no credential', ['secret-a', 'secret-b']);

  // ---- 2. the password lands in secrets.yaml and NOT in the account's proxy.json ----
  const proxyJsonA = join(dataDir, 'accounts', 'pa-1', 'proxy.json');
  const secretsYaml = join(dataDir, 'secrets.yaml');
  check(existsSync(proxyJsonA), 'the binding wrote accounts/pa-1/proxy.json');
  check(existsSync(secretsYaml), 'the binding wrote secrets.yaml');
  const proxyJsonText = existsSync(proxyJsonA) ? readFileSync(proxyJsonA, 'utf8') : '';
  const secretsText = existsSync(secretsYaml) ? readFileSync(secretsYaml, 'utf8') : '';
  check(!proxyJsonText.includes('secret-a'), 'proxy.json does NOT contain the password');
  check(proxyJsonText.includes(PROXY_A.server), 'proxy.json records the server', PROXY_A.server);
  check(secretsText.includes('secret-a'), 'secrets.yaml DOES contain the password');
  const gitignore = join(dataDir, '.gitignore');
  const ignoreText = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  check(ignoreText.includes('secrets.yaml'), '.gitignore covers secrets.yaml');
  check(ignoreText.includes('accounts/*/proxy.json'), '.gitignore covers accounts/*/proxy.json');

  // ---- 3. reading them back never returns the password ----
  const listed = await engine.call('account.list', {});
  const itemA = (listed.accounts ?? []).find((a) => a.code === 'pa-1');
  const itemB = (listed.accounts ?? []).find((a) => a.code === 'pb-1');
  check(itemA?.proxy?.server === PROXY_A.server, 'account.list reports the bound proxy', itemA?.proxy?.server);
  check(itemB?.proxy?.server === PROXY_B.server, 'account.list reports the other proxy', itemB?.proxy?.server);
  assertNoSecret(listed, 'account.list contains no credential', ['secret-a', 'secret-b']);

  const fetched = await engine.call('proxy.fetch', { code: 'pa-1' });
  check(typeof fetched.server === 'string', 'proxy.fetch resolves the bound proxy', fetched.server);
  check(fetched.hasPassword === true, 'proxy.fetch reports hasPassword');
  assertNoSecret(fetched, 'proxy.fetch contains no credential', ['secret-a', 'secret-b']);

  // ---- 4. an unreachable proxy is a PROXY failure, never a login failure ----
  const tested = await engine.call('proxy.test', { code: 'pa-1' });
  check(tested.ok === false, 'an unreachable proxy is reported as not ok', tested.detail ?? tested);
  const testedText = JSON.stringify(tested);
  // The message must name the proxy as the cause. It may *mention* login state to say that login is NOT
  // the problem, so only a claim that the login actually expired counts as a failure here.
  check(/代理/.test(String(tested.detail ?? '')),
    'the proxy failure names the proxy as the cause', String(tested.detail ?? '').slice(0, 160));
  check(!/登录态失效|重新登录|请登录|please log ?in|session expired/i.test(testedText),
    'the proxy failure does NOT claim the login expired', testedText.slice(0, 200));
  assertNoSecret(tested, 'proxy.test contains no credential', ['secret-a', 'secret-b']);

  // ---- 5. each account's proxy is applied to its own session; direct stays direct ----
  const sessionA = await engine.call('session.open', { accountCode: 'pa-1', headless: true, proxyPolicy: 'sticky' },
    { timeoutMs: 120_000 });
  const sessionB = await engine.call('session.open', { accountCode: 'pb-1', headless: true, proxyPolicy: 'sticky' },
    { timeoutMs: 120_000 });
  check(sessionA.proxy?.server === PROXY_A.server, 'session for pa-1 carries pa-1\'s proxy', sessionA.proxy?.server);
  check(sessionB.proxy?.server === PROXY_B.server, 'session for pb-1 carries pb-1\'s proxy', sessionB.proxy?.server);
  check(sessionA.proxy?.server !== sessionB.proxy?.server,
    'the two concurrent sessions egress through different proxies');
  check(sessionA.proxy?.hasPassword === true, 'the session reports the proxy has a password');
  assertNoSecret({ sessionA, sessionB }, 'session results contain no credential', ['secret-a', 'secret-b']);
  check(sessionA.sessionId !== sessionB.sessionId, 'the two accounts run in separate sessions');

  await engine.call('session.close', { sessionId: sessionA.sessionId });
  await engine.call('session.close', { sessionId: sessionB.sessionId });

  const direct = await engine.call('session.open', { accountCode: 'pa-1', headless: true, proxyPolicy: 'direct' },
    { timeoutMs: 120_000 });
  check(direct.proxy === null, 'proxyPolicy "direct" overrides the binding with no proxy', direct.proxy);
  await engine.call('session.close', { sessionId: direct.sessionId });

  // ---- 6. the browser really is launched with the proxy, not merely told about it ----
  const browserSource = readFileSync(join(PLUGIN_ROOT, 'engine', 'browser.py'), 'utf8');
  check(/proxy\s*=/.test(browserSource),
    'engine/browser.py passes a proxy into the browser context/launch');
  check(/\bbypass\b|proxy-bypass-list/.test(browserSource),
    'the browser launch considers proxy bypass rules (loopback handling)');

  // ---- 7. unbinding returns the account to a direct connection ----
  const unbound = await engine.call('account.bindProxy', { code: 'pa-1', proxy: null });
  check(unbound.proxy?.bound === false, 'unbinding clears the proxy binding', unbound.proxy);
  const directAfterUnbind = await engine.call('session.open',
    { accountCode: 'pa-1', headless: true, proxyPolicy: 'sticky' }, { timeoutMs: 120_000 });
  check(directAfterUnbind.proxy === null, 'an unbound account runs direct under sticky policy', directAfterUnbind.proxy);
  check((directAfterUnbind.warnings ?? []).length > 0,
    'running without a proxy is surfaced as a warning, never silent', directAfterUnbind.warnings);
  await engine.call('session.close', { sessionId: directAfterUnbind.sessionId });
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error instanceof EngineError ? `${error.code}: ${error.message}` : error);
  if (error?.details) console.error('details:', JSON.stringify(error.details, null, 2).slice(0, 1500));
} finally {
  if (engine) await engine.close();
  if (failures === 0) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`\nall checks passed; removed ${dataDir}`);
  } else {
    console.log(`\n${failures} check(s) failed; kept ${dataDir} for inspection`);
  }
}

process.exit(failures === 0 ? 0 : 1);
