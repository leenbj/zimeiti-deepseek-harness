/**
 * session-persistence-e2e.mjs — proves the answer to the operator's real question: "if I sign in once,
 * can I keep using that account in its isolated environment, like an anti-detect browser?"
 *
 * The claim is that a login survives across sessions because it is written to that account's own
 * `storage_state.json` (cookies + localStorage) and restored on the next open — and that it is NOT
 * visible to any other account. Neither half can be tested against a real platform without credentials,
 * so this stands up a local HTTP "platform" and drives the real engine through the whole loop:
 *
 *   1. sign in at /login (cookie set by the server, plus a localStorage entry);
 *   2. close with saveState → that account's state file is written and non-trivial;
 *   3. open a NEW session for the same account → the page still reports authenticated, and the
 *      localStorage entry is back — i.e. the login survived;
 *   4. open a session for a DIFFERENT account → the same URL reports NOT authenticated, and its
 *      localStorage is empty — i.e. nothing leaked between accounts;
 *   5. a close with saveState:false must not touch the state file (the read-only check path).
 *
 * Usage (bundled node):
 *   node tests/session-persistence-e2e.mjs
 */
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient, EngineError } from '../src/engine-client.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-persist-'));
let failures = 0;
let engine;
let server;
let baseUrl = '';

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${suffix}`);
}

/** @param {string} code */
function statePathFor(code) {
  return join(dataDir, 'accounts', code, 'storage_state.json');
}

/**
 * A stand-in platform whose session lives in a cookie, with an extra localStorage marker so both halves
 * of a Playwright storage_state are exercised.
 */
function startPlatform() {
  return new Promise((ok) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const cookie = String(req.headers.cookie ?? '');
      const match = /sid=([^;]+)/.exec(cookie);
      const user = match ? decodeURIComponent(match[1]) : null;

      if (url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>登录</title></head><body>
          <h1>登录</h1>
          <input id="user" placeholder="账号"><input id="pass" placeholder="密码" type="password">
          <button id="go" type="button">登录</button>
          <script>
            document.getElementById('go').addEventListener('click', async () => {
              const user = document.getElementById('user').value;
              await fetch('/_login', {method:'POST', headers:{'content-type':'application/json'},
                body: JSON.stringify({user})});
              // A client-side marker: proves localStorage is part of the saved/restored state too.
              localStorage.setItem('profile', user || 'none');
              location.href = '/dashboard';
            });
          </script></body></html>`);
        return;
      }
      if (url.pathname === '/_login' && req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          let name = 'nobody';
          try { name = JSON.parse(raw).user || 'nobody'; } catch { /* keep default */ }
          res.writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': `sid=${encodeURIComponent(name)}; Path=/; HttpOnly=false`,
          });
          res.end('{"ok":true}');
        });
        return;
      }
      if (url.pathname === '/dashboard') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>工作台</title></head><body>
          <div id="state">${user ? `已登录：${user}` : '未登录'}</div></body></html>`);
        return;
      }
      if (url.pathname === '/whoami') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ authed: Boolean(user), user, cookie: Boolean(match) }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      ok();
    });
  });
}

/** Read a value out of the page in the active session. */
async function evalIn(sessionId, expression) {
  const result = await engine.call('act.eval', { sessionId, expression });
  const data = result?.data ?? {};
  // `act.eval` answers `{result, serializable, purpose, escapeHatch, ms}`. Use hasOwnProperty rather
  // than `??`, because a legitimate `null` result must come back as null, not as the whole envelope.
  return Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : data;
}

try {
  await startPlatform();
  engine = new EngineClient({ pythonPath: PYTHON, pluginRoot: PLUGIN_ROOT, dataDir, requestTimeoutMs: 180_000 });
  engine.on('log', (line) => console.log(`    engine| ${line}`));
  await engine.call('engine.status', {});
  await engine.call('account.upsert', { code: 'sp-1', media: 'sohu', account: 'persist alpha' });
  await engine.call('account.upsert', { code: 'sp-2', media: 'sohu', account: 'persist beta' });

  // ---- 1. sign in for real, in an isolated session ----
  const first = await engine.call('session.open',
    { accountCode: 'sp-1', headless: true, proxyPolicy: 'direct' }, { timeoutMs: 120_000 });
  const sessionA = first.sessionId;
  check(!existsSync(statePathFor('sp-1')), 'the account starts with no saved state');

  await engine.call('act.goto', { sessionId: sessionA, url: `${baseUrl}/login` });
  await engine.call('act.type', { sessionId: sessionA, target: { selector: '#user' }, text: 'alpha' });
  await engine.call('act.type', { sessionId: sessionA, target: { selector: '#pass' }, text: 'pw-not-real' });
  await engine.call('act.click', { sessionId: sessionA, target: { text: '登录', role: 'button' } });
  await engine.call('act.waitFor', { sessionId: sessionA, for: { urlContains: '/dashboard' }, timeoutMs: 20_000 });
  const signedIn = await evalIn(sessionA, "() => document.body.innerText");
  check(String(signedIn).includes('已登录：alpha'),
    'the stand-in platform accepted the sign-in', String(signedIn).slice(0, 80));

  // ---- 2. closing persists the login to that account's own file ----
  const closed = await engine.call('session.close', { sessionId: sessionA, saveState: true });
  check(existsSync(statePathFor('sp-1')), 'closing with saveState wrote the account state file', closed.savedStatePath);
  const before = statSync(statePathFor('sp-1'));
  check(before.size > 100, 'the saved state is non-trivial', `${before.size} bytes`);
  const savedText = (await import('node:fs')).readFileSync(statePathFor('sp-1'), 'utf8');
  check(savedText.includes('sid'), 'the saved state contains the session cookie name');
  check(savedText.includes('profile'), 'the saved state also contains the localStorage origin entry');

  // ---- 3. a brand-new session for the same account is still signed in ----
  const second = await engine.call('session.open',
    { accountCode: 'sp-1', headless: true, proxyPolicy: 'direct' }, { timeoutMs: 120_000 });
  const sessionB = second.sessionId;
  await engine.call('act.goto', { sessionId: sessionB, url: `${baseUrl}/whoami` });
  const who = await evalIn(sessionB, "() => document.body.innerText");
  let parsed = {};
  try { parsed = JSON.parse(String(who)); } catch { /* leave empty */ }
  check(parsed.authed === true,
    'a NEW session for the same account is still authenticated — the login survived', parsed);
  check(parsed.user === 'alpha', 'and it is the same user', parsed.user);
  const restoredLocal = await evalIn(sessionB, "() => window.localStorage.getItem('profile')");
  check(restoredLocal === 'alpha',
    'the localStorage marker was restored too, not just the cookie', restoredLocal);

  // ---- 4. nothing leaks to another account ----
  const other = await engine.call('session.open',
    { accountCode: 'sp-2', headless: true, proxyPolicy: 'direct' }, { timeoutMs: 120_000 });
  const sessionC = other.sessionId;
  await engine.call('act.goto', { sessionId: sessionC, url: `${baseUrl}/whoami` });
  const whoOther = await evalIn(sessionC, "() => document.body.innerText");
  let parsedOther = {};
  try { parsedOther = JSON.parse(String(whoOther)); } catch { /* leave empty */ }
  check(parsedOther.authed === false,
    'a DIFFERENT account is NOT authenticated on the same URL — no session leak', parsedOther);
  const otherLocal = await evalIn(sessionC, "() => window.localStorage.getItem('profile')");
  check(otherLocal === null,
    'the other account does not see the first account localStorage — no state leak', otherLocal);
  check(second.storageStatePath !== other.storageStatePath,
    'the two accounts keep separate state files',
    { a: second.storageStatePath, b: other.storageStatePath });

  // ---- 5. a read-only close must not rewrite the saved state ----
  await engine.call('session.close', { sessionId: sessionC, saveState: false });
  const mid = statSync(statePathFor('sp-1'));
  await engine.call('session.close', { sessionId: sessionB, saveState: false });
  const after = statSync(statePathFor('sp-1'));
  check(after.mtimeMs === mid.mtimeMs && after.size === mid.size,
    'closing with saveState:false left the account state file untouched',
    { before: mid.mtimeMs, after: after.mtimeMs });

  // ---- 6. an explicit save after further activity updates the file ----
  const third = await engine.call('session.open',
    { accountCode: 'sp-1', headless: true, proxyPolicy: 'direct' }, { timeoutMs: 120_000 });
  await engine.call('act.goto', { sessionId: third.sessionId, url: `${baseUrl}/dashboard` });
  await engine.call('act.eval', { sessionId: third.sessionId, expression: "() => localStorage.setItem('lastVisit', 'yes')" });
  await engine.call('session.close', { sessionId: third.sessionId, saveState: true });
  const finalText = (await import('node:fs')).readFileSync(statePathFor('sp-1'), 'utf8');
  check(finalText.includes('lastVisit'),
    'a later explicit save persists new state — so the profile keeps evolving with the account');
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error instanceof EngineError ? `${error.code}: ${error.message}` : error);
  if (error?.details) console.error('details:', JSON.stringify(error.details, null, 2).slice(0, 1200));
} finally {
  if (engine) await engine.close();
  if (server) await new Promise((ok) => server.close(ok));
  if (failures === 0) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`\nall checks passed; removed ${dataDir}`);
  } else {
    console.log(`\n${failures} check(s) failed; kept ${dataDir} for inspection`);
  }
}

process.exit(failures === 0 ? 0 : 1);
