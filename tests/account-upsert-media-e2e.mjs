/**
 * account-upsert-media-e2e.mjs — the `media` contract of POST /media-publish/accounts.
 *
 * This exists because creating an account through the settings page ended in the engine's bare
 * `missing required param 'media'`. The cause was a contract hole, not a typo: omitting `media` is
 * meaningful when UPDATING an account ("keep the platform it already has"), but it is an error when
 * CREATING one — and the request was passed straight through, so the operator saw an engine message that
 * explained nothing about what to do.
 *
 * The rule now is: a media-less request is allowed, and the ENGINE decides — it refuses only when the
 * account does not exist yet. These cases pin that down, and make sure the engine's verdict is translated
 * into words an operator can act on rather than forwarded raw.
 *
 * Usage (bundled node):
 *   node tests/account-upsert-media-e2e.mjs
 */
import { EventEmitter } from 'node:events';

import { ACCOUNT_ROUTES, createAccountsHttp } from '../src/accounts-http.js';

let failures = 0;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
}

function fakeReq(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = '/';
  req.headers = { 'content-type': 'application/json' };
  req.destroy = () => {};
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
      req.emit('end');
    });
  }
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.statusCode = null;
  res.raw = '';
  res.setHeader = () => res;
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; return res; };
  res.end = (chunk) => { if (chunk != null) res.raw += String(chunk); res.emit('finish'); return res; };
  return res;
}

/** @param {Record<string, unknown>} answers method → value | Error | (params) => value */
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

async function post(handler, body) {
  const res = fakeRes();
  await handler(fakeReq('POST', body), res);
  let json = null;
  try { json = JSON.parse(res.raw); } catch { json = null; }
  return { status: res.statusCode, json, raw: res.raw };
}

/** What the engine raises when a media-less create reaches it. */
const missingMedia = Object.assign(new Error("missing required param 'media'"), { code: 'PARAM_MISSING' });
const upserted = { account: { code: 'a-3', media: 'sohu', account: 'y', note: '', hasState: false } };

try {
  const { routes } = createAccountsHttp({ engine: fakeEngine({}), dataDir: null, log: () => {} });
  check(routes.length === 6, 'the account routes are built', routes.length);

  // ---- 1. creating without a platform: the engine refuses, and the refusal is translated ----
  const engine = fakeEngine({ 'account.upsert': missingMedia });
  const { handlers } = createAccountsHttp({ engine, dataDir: null, log: () => {} });
  const created = await post(handlers[ACCOUNT_ROUTES.ACCOUNTS], { code: 'a-3', account: 'y', note: '' });
  check(created.status === 400, 'a new account without a platform is refused with 400', created.status);
  check(created.json?.error?.field === 'media', 'the refusal names the media field', created.json?.error);
  check(/media is required/i.test(String(created.json?.error?.message ?? '')),
    'and explains it in words rather than repeating the engine', created.json?.error?.message);
  check(!/missing required param/i.test(String(created.json?.error?.message ?? '')),
    'the raw engine wording is not forwarded');
  check(/sohu/.test(String(created.json?.error?.message ?? ''))
    && /csdn/.test(String(created.json?.error?.message ?? '')),
    'and lists the platforms the operator may choose', created.json?.error?.message);
  const upsertCall = engine.calls.find((entry) => entry.method === 'account.upsert');
  check(Boolean(upsertCall), 'the engine was asked, so its verdict is what decides');
  check(upsertCall && !('media' in upsertCall.params),
    'and the omitted media stayed omitted (an update must keep the existing platform)', upsertCall?.params);

  // ---- 2. updating an existing account may omit it ----
  const engine2 = fakeEngine({ 'account.upsert': upserted });
  const { handlers: handlers2 } = createAccountsHttp({ engine: engine2, dataDir: null, log: () => {} });
  const updated = await post(handlers2[ACCOUNT_ROUTES.ACCOUNTS], { code: 'a-2', account: 'renamed', note: 'n' });
  check(updated.status === 200, 'updating an existing account without media is accepted', {
    status: updated.status, error: updated.json?.error,
  });

  // ---- 3. supplying a platform always works ----
  const engine3 = fakeEngine({ 'account.upsert': upserted });
  const { handlers: handlers3 } = createAccountsHttp({ engine: engine3, dataDir: null, log: () => {} });
  const withMedia = await post(handlers3[ACCOUNT_ROUTES.ACCOUNTS], { code: 'a-3', media: 'sohu', note: '' });
  check(withMedia.status === 200, 'a new account with a platform is accepted', withMedia.status);
  const call3 = engine3.calls.find((entry) => entry.method === 'account.upsert');
  check(call3?.params?.media === 'sohu', 'and the platform reaches the engine', call3?.params?.media);

  // ---- 4. an unrelated engine failure is NOT dressed up as a missing platform ----
  const engine4 = fakeEngine({
    'account.upsert': Object.assign(new Error('browser blew up'), { code: 'NAVIGATION_FAILED' }),
  });
  const { handlers: handlers4 } = createAccountsHttp({ engine: engine4, dataDir: null, log: () => {} });
  const otherFailure = await post(handlers4[ACCOUNT_ROUTES.ACCOUNTS], { code: 'a-9', note: '' });
  check(otherFailure.status === 500, 'an unrelated engine failure keeps its own status', otherFailure.status);
  check(otherFailure.json?.error?.code === 'NAVIGATION_FAILED',
    'and its own code', otherFailure.json?.error?.code);
  check(!/media is required/i.test(String(otherFailure.json?.error?.message ?? '')),
    'and is not mislabelled as a missing platform');

  // ---- 5. an unknown platform is still rejected outright ----
  const engine5 = fakeEngine({ 'account.upsert': upserted });
  const { handlers: handlers5 } = createAccountsHttp({ engine: engine5, dataDir: null, log: () => {} });
  const badMedia = await post(handlers5[ACCOUNT_ROUTES.ACCOUNTS], { code: 'a-4', media: 'weibo' });
  check(badMedia.status === 400, 'an unknown platform is refused', badMedia.status);
  check(!engine5.calls.some((entry) => entry.method === 'account.upsert'),
    'and nothing is sent to the engine for it');
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error?.stack ?? error);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
