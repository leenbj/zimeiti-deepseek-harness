/**
 * account-login-http-e2e.mjs — end-to-end test of signing in *through the settings page*, and of the two
 * claims the operator cares about most: that the login is **kept**, and that accounts are **isolated**.
 *
 * Three things are proven here that the account CRUD test does not cover:
 *
 *   1. **Starting a sign-in does not block.** A sign-in opens a headed window and waits up to ten minutes
 *      for a human, so the POST must return immediately and the page must poll. The stub returns a promise
 *      this test resolves by hand, so an implementation that awaited it would hang — the call is raced
 *      against a timeout and fails if the request does not come back.
 *   2. **The stored login is visible.** The handler reads `accounts/<code>/storage_state.json` from disk, so
 *      the page can show a real byte count and timestamp instead of a claim.
 *   3. **Two accounts never share a file.** The paths reported for two accounts are asserted to differ.
 *
 * Usage (bundled node):
 *   node tests/account-login-http-e2e.mjs
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ACCOUNT_ROUTES, createAccountsHttp } from '../src/accounts-http.js';

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-login-http-'));
let failures = 0;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
}

function fakeReq(method = 'GET', url = '/', contentType = 'application/json') {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': contentType };
  req.destroy = () => {};
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.statusCode = null;
  res.headers = {};
  res.raw = '';
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; return res; };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headersSent = true;
    if (headers) for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v;
    return res;
  };
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.raw += String(chunk);
    res.emit('finish');
    return res;
  };
  return res;
}

function fakeEngine(answers = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(params);
      return answer ?? {};
    },
  };
}

async function call(handler, options = {}) {
  const { method = 'GET', url = '/', contentType = 'application/json', body } = options;
  const req = fakeReq(method, url, contentType);
  const res = fakeRes();
  const pending = handler(req, res);
  if (body !== undefined) {
    const text = JSON.stringify(body);
    setImmediate(() => {
      req.emit('data', Buffer.from(text, 'utf8'));
      req.emit('end');
    });
  }
  await pending;
  let json = null;
  try { json = JSON.parse(res.raw); } catch { json = null; }
  return { res, status: res.statusCode, json, raw: res.raw };
}

/** Reject after `ms`, so a blocking implementation fails instead of hanging the whole test. */
function timeout(ms, label) {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    timer.unref?.();
  });
}

try {
  // ---- the stored login files, written by hand so their size and isolation are checkable ----
  const stateA = join(dataDir, 'accounts', 'a-1', 'storage_state.json');
  mkdirSync(join(dataDir, 'accounts', 'a-1'), { recursive: true });
  writeFileSync(stateA, JSON.stringify({ cookies: [{ name: 'sid', value: 'A-SECRET-COOKIE' }], origins: [] }), 'utf8');
  check(!statSync(stateA).isDirectory() && statSync(stateA).size > 2, 'the a-1 sign-in file exists on disk');

  /** The sign-in promise is resolved by this test, never by the stub. */
  let releaseLogin = null;
  const loginPromise = new Promise((resolve) => { releaseLogin = resolve; });
  const engine = fakeEngine({
    'account.list': () => ({
      accounts: [
        { code: 'a-1', media: 'sohu', account: '搜狐号主号', note: '', hasState: true, hasSession: false, proxy: { bound: false } },
        { code: 'b-1', media: 'toutiao', account: '头条号主号', note: '', hasState: false, hasSession: false, proxy: { bound: false } },
      ],
    }),
    'account.login': () => loginPromise,
    'account.checkLogin': { ok: true, loggedIn: true, status: 'ok', url: 'https://mp.sohu.com/x', title: '工作台', reasons: [] },
  });
  const { handlers, routes } = createAccountsHttp({ engine, dataDir, log: () => {} });
  check(routes.length === 6 && routes.every((route) => route.kind === 'exact'),
    'six exact account routes are built (list/upsert/remove/proxy/test/sign-in/check)',
    routes.map((route) => route.path));

  // ---- 1. the stored login is visible, per account, and the paths differ ----
  const list = await call(handlers[ACCOUNT_ROUTES.ACCOUNTS], { method: 'GET' });
  check(list.status === 200, 'GET /accounts answers 200', list.status);
  const a = list.json?.accounts?.find((account) => account.code === 'a-1');
  const b = list.json?.accounts?.find((account) => account.code === 'b-1');
  check(a?.state?.exists === true && a.state.bytes > 2,
    'the signed-in account reports a real stored file with its size', a?.state);
  check(typeof a?.state?.modifiedAt === 'string' && !Number.isNaN(Date.parse(a.state.modifiedAt)),
    'and when it was last written', a?.state?.modifiedAt);
  check(String(a?.state?.path ?? '').includes(join('accounts', 'a-1', 'storage_state.json')),
    'and the path names that account', a?.state?.path);
  check(b?.state?.exists === false, 'the other account reports no stored login', b?.state);
  check(a?.state?.path !== b?.state?.path, 'the two accounts do NOT share a file — isolation is visible');
  check(!list.raw.includes('A-SECRET-COOKIE'), 'and reading the list never echoes a stored cookie value');

  // ---- 2. starting a sign-in returns at once ----
  engine.calls.length = 0;
  let started = null;
  try {
    started = await Promise.race([
      call(handlers[ACCOUNT_ROUTES.LOGIN], { method: 'POST', body: { code: 'b-1' } }),
      timeout(3000, 'POST /accounts/login must not wait for the human'),
    ]);
  } catch (error) {
    check(false, 'POST /accounts/login returns without waiting for the sign-in to finish', error?.message);
  }
  if (started) {
    check(started.status === 200 && started.json?.started === true,
      'the sign-in starts and the request returns immediately', started.json);
    check(engine.calls.some((entry) => entry.method === 'account.login' && entry.params?.code === 'b-1'),
      'and account.login was invoked for that account');
  }

  // ---- 3. polling reports progress, then the outcome ----
  const running = await call(handlers[ACCOUNT_ROUTES.LOGIN], { method: 'GET', url: '/?code=b-1' });
  check(running.status === 200 && running.json?.job?.status === 'running',
    'polling reports the sign-in as running', running.json?.job);
  check(running.json?.state?.exists === false,
    'and still shows no stored file while it waits', running.json?.state);

  const second = await call(handlers[ACCOUNT_ROUTES.LOGIN], { method: 'POST', body: { code: 'b-1' } });
  check(second.status === 409,
    'starting the same sign-in twice is refused rather than opening a second window', second.json?.error);

  releaseLogin({ ok: true, code: 'b-1', label: '头条号主号' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const finished = await call(handlers[ACCOUNT_ROUTES.LOGIN], { method: 'GET', url: '/?code=b-1' });
  check(finished.json?.job?.status === 'done', 'once the human finishes, polling reports done', finished.json?.job);
  check(typeof finished.json?.job?.finishedAt === 'string', 'with a finish timestamp', finished.json?.job?.finishedAt);

  // ---- a failed sign-in is reported, not swallowed ----
  const failing = createAccountsHttp({
    engine: fakeEngine({ 'account.login': Object.assign(new Error('window was closed'), { code: 'TIMEOUT' }) }),
    dataDir,
    log: () => {},
  });
  const failingStarted = await Promise.race([
    call(failing.handlers[ACCOUNT_ROUTES.LOGIN], { method: 'POST', body: { code: 'c-1' } }),
    timeout(3000, 'a failing sign-in must still return at once'),
  ]);
  check(failingStarted.status === 200, 'a sign-in that will fail still starts immediately', failingStarted.status);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const failed = await call(failing.handlers[ACCOUNT_ROUTES.LOGIN], { method: 'GET', url: '/?code=c-1' });
  check(failed.json?.job?.status === 'failed', 'and polling reports it as failed', failed.json?.job);
  check(String(failed.json?.job?.message ?? '').includes('TIMEOUT'),
    'keeping the engine code visible', failed.json?.job?.message);

  // ---- 4. checking a login ----
  const checked = await call(handlers[ACCOUNT_ROUTES.CHECK], { method: 'POST', body: { code: 'a-1' } });
  check(checked.status === 200 && checked.json?.loggedIn === true,
    'POST /accounts/check reports the stored sign-in as still valid', checked.json);
  check(checked.json?.state?.exists === true, 'and returns the stored file it verified', checked.json?.state);

  const checkUnreachable = createAccountsHttp({
    engine: fakeEngine({ 'account.checkLogin': Object.assign(new Error('browser failed'), { code: 'NAVIGATION_FAILED' }) }),
    dataDir,
    log: () => {},
  });
  const checkFailed = await call(checkUnreachable.handlers[ACCOUNT_ROUTES.CHECK], { method: 'POST', body: { code: 'a-1' } });
  check(checkFailed.status === 500, 'a failing check is reported as an error, not as logged out', checkFailed.status);
  check(checkFailed.json?.error?.code === 'NAVIGATION_FAILED', 'with its engine code', checkFailed.json?.error?.code);

  // ---- refusals ----
  const noCode = await call(handlers[ACCOUNT_ROUTES.LOGIN], { method: 'POST', body: {} });
  check(noCode.status === 400, 'a sign-in without a code is refused', noCode.json?.error);
  const badCode = await call(handlers[ACCOUNT_ROUTES.LOGIN], { method: 'POST', body: { code: '../x' } });
  check(badCode.status === 400, 'a sign-in with a path-ish code is refused', badCode.json?.error);
  const unknownKey = await call(handlers[ACCOUNT_ROUTES.CHECK], { method: 'POST', body: { code: 'a-1', force: true } });
  check(unknownKey.status === 400, 'an unexpected key is refused', unknownKey.json?.error);
  const wrongMethod = await call(handlers[ACCOUNT_ROUTES.CHECK], { method: 'GET' });
  check(wrongMethod.status === 405, 'GET on the check route is refused with 405', wrongMethod.status);
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error?.stack ?? error);
} finally {
  if (failures === 0) rmSync(dataDir, { recursive: true, force: true });
  else console.log(`kept ${dataDir} for inspection`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
