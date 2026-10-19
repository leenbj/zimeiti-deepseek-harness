/**
 * accounts-http-e2e.mjs — end-to-end test of the account-management HTTP surface.
 *
 * The settings page can only manage accounts through these endpoints, so each one is driven for real with
 * fake `req`/`res` objects and a recording engine stub, and the assertions are about what the operator
 * would actually get: the list, the refusals, and — most importantly — that **no credential ever comes
 * back**. The stub deliberately returns a `proxy.password` field the engine does not currently send, so
 * the test fails if the projection ever stops being an allow-list.
 *
 * Usage (bundled node):
 *   node tests/accounts-http-e2e.mjs
 */
import { EventEmitter } from 'node:events';

import { ACCOUNT_ROUTES, ACCOUNT_MEDIA, createAccountsHttp } from '../src/accounts-http.js';
import { HTTP_ERRORS } from '../src/config-http.js';

const SECRET = 'sup3r-secret-proxy-password';
let failures = 0;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
}

function fakeReq(method = 'GET', contentType = 'application/json') {
  const req = new EventEmitter();
  req.method = method;
  req.url = '/';
  req.headers = contentType === null ? {} : { 'content-type': contentType };
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

/** An engine stub that records every call and answers from a table. */
function fakeEngine(answers = {}) {
  /** @type {Array<{ method: string, params: any }>} */
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

/**
 * Invoke one handler with an optional JSON body.
 * @param {(req: any, res: any) => Promise<void>} handler
 * @param {{ method?: string, contentType?: string|null, body?: unknown, rawBody?: string }} [options]
 */
async function call(handler, options = {}) {
  const { method = 'GET', contentType = 'application/json', body, rawBody } = options;
  const req = fakeReq(method, contentType);
  const res = fakeRes();
  const pending = handler(req, res);
  if (body !== undefined || rawBody !== undefined) {
    const text = rawBody !== undefined ? rawBody : JSON.stringify(body);
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

/** The engine's own account shape, plus a password field the engine never sends — the projection must drop it. */
const ENGINE_ACCOUNTS = {
  'account.list': {
    accounts: [
      {
        code: 'a-1', media: 'sohu', account: '搜狐号主号', note: '每日限 5 篇',
        hasState: false, hasSession: false,
        proxy: { bound: true, server: 'http://127.0.0.1:8080', username: 'u1', password: SECRET, hasPassword: true, expiresAt: null, source: 'static:0' },
      },
      { code: 'b-1', media: 'toutiao', account: '头条号主号', note: '', hasState: false, hasSession: false, proxy: { bound: false } },
    ],
  },
};

try {
  // ---- construction guard ----
  let guardError = null;
  try { createAccountsHttp({}); } catch (error) { guardError = error; }
  check(guardError instanceof TypeError, 'a missing engine is refused at construction', guardError?.message);

  const engine = fakeEngine(ENGINE_ACCOUNTS);
  const { handlers, routes } = createAccountsHttp({ engine, log: () => {} });
  check(routes.length === 6 && routes.every((route) => route.kind === 'exact' && typeof route.handler === 'function'),
    'six exact routes are built with handlers', routes.map((route) => route.path));

  // ---- list ----
  const list = await call(handlers[ACCOUNT_ROUTES.ACCOUNTS], { method: 'GET' });
  check(list.status === 200, 'GET /accounts answers 200', list.status);
  check(list.json?.ok === true && list.json?.count === 2, 'and reports both accounts', list.json?.count);
  check(Array.isArray(list.json?.media) && list.json.media.join() === ACCOUNT_MEDIA.join(),
    'and offers the accepted media list for the form', list.json?.media);
  const first = list.json?.accounts?.[0];
  check(first?.code === 'a-1' && first?.media === 'sohu' && first?.account === '搜狐号主号',
    'each account carries the fields the table renders', first);
  check(first?.proxy?.bound === true && first?.proxy?.server === 'http://127.0.0.1:8080',
    'and its proxy summary', first?.proxy);
  check(first?.proxy?.hasPassword === true, 'a bound password is reported as presence only');
  // The single most important assertion here: a credential must never cross this boundary.
  check(!list.raw.includes(SECRET), 'the response body contains NO proxy password');
  check(!JSON.stringify(list.json).includes('password') || !list.raw.includes(SECRET),
    'and no password value appears anywhere in it');
  const surprising = Object.keys(first?.proxy ?? {}).filter((key) => !['bound', 'server', 'username', 'hasPassword', 'expiresAt', 'source'].includes(key));
  check(surprising.length === 0, 'the proxy projection is an allow-list', surprising);
  check(engine.calls.some((entry) => entry.method === 'account.list'), 'the list came from account.list');

  // ---- create / update ----
  engine.calls.length = 0;
  const created = await call(handlers[ACCOUNT_ROUTES.ACCOUNTS], {
    method: 'POST', body: { code: 'c-3', media: 'csdn', account: 'CSDN 账号三', note: '测试号' },
  });
  check(created.status === 200, 'POST /accounts creates an account', created.status);
  const upsert = engine.calls.find((entry) => entry.method === 'account.upsert');
  check(upsert?.params?.code === 'c-3' && upsert?.params?.media === 'csdn'
    && upsert?.params?.account === 'CSDN 账号三' && upsert?.params?.note === '测试号',
    'and forwards every field to account.upsert', upsert?.params);

  engine.calls.length = 0;
  const edited = await call(handlers[ACCOUNT_ROUTES.ACCOUNTS], {
    method: 'POST', body: { code: 'c-3', note: '只改备注' },
  });
  check(edited.status === 200, 'an edit without `media` is accepted', edited.status);
  const editCall = engine.calls.find((entry) => entry.method === 'account.upsert');
  check(editCall?.params?.media === undefined,
    'and omits `media` so editing a note cannot drop the platform', editCall?.params);

  // ---- refusals ----
  for (const [label, body, field] of [
    ['a missing code', { media: 'sohu' }, 'code'],
    ['a code with a path separator', { code: '../evil', media: 'sohu' }, 'code'],
    ['an unknown media', { code: 'x-1', media: 'weibo' }, 'media'],
    ['a non-string code', { code: 42, media: 'sohu' }, 'code'],
  ]) {
    const refused = await call(handlers[ACCOUNT_ROUTES.ACCOUNTS], { method: 'POST', body });
    check(refused.status === 400 && refused.json?.error?.field === field,
      `${label} answers 400 naming the field`, { status: refused.status, error: refused.json?.error });
  }
  const unknownKey = await call(handlers[ACCOUNT_ROUTES.ACCOUNTS], {
    method: 'POST', body: { code: 'x-1', media: 'sohu', admin: true },
  });
  check(unknownKey.status === 400, 'an unexpected key answers 400 rather than being ignored', unknownKey.json?.error);
  const wrongType = await call(handlers[ACCOUNT_ROUTES.ACCOUNTS], {
    method: 'POST', contentType: 'text/plain', rawBody: '{}',
  });
  check(wrongType.status === 415, 'a wrong content type answers 415', wrongType.status);
  const badMethod = await call(handlers[ACCOUNT_ROUTES.ACCOUNTS], { method: 'DELETE' });
  check(badMethod.status === 405 && String(badMethod.res.headers.allow ?? '').includes('GET'),
    'an unsupported method answers 405 with allow', { status: badMethod.status, allow: badMethod.res.headers.allow });

  // ---- remove ----
  engine.calls.length = 0;
  const removed = await call(handlers[ACCOUNT_ROUTES.REMOVE], {
    method: 'POST', body: { code: 'c-3', purgeState: true },
  });
  check(removed.status === 200, 'POST /accounts/remove removes an account', removed.status);
  const removeCall = engine.calls.find((entry) => entry.method === 'account.remove');
  check(removeCall?.params?.code === 'c-3' && removeCall?.params?.purgeState === true,
    'and forwards purgeState explicitly', removeCall?.params);
  const removeBadFlag = await call(handlers[ACCOUNT_ROUTES.REMOVE], {
    method: 'POST', body: { code: 'c-3', purgeState: 'yes' },
  });
  check(removeBadFlag.status === 400, 'a non-boolean purgeState is refused', removeBadFlag.json?.error);

  // ---- bind / clear a proxy ----
  engine.calls.length = 0;
  const bound = await call(handlers[ACCOUNT_ROUTES.PROXY], {
    method: 'POST', body: { code: 'a-1', proxy: { server: 'http://proxy.example:9000', username: 'user9', password: SECRET } },
  });
  check(bound.status === 200 && bound.json?.bound === true, 'POST /accounts/proxy binds a proxy', bound.json);
  const bindCall = engine.calls.find((entry) => entry.method === 'account.bindProxy');
  check(bindCall?.params?.code === 'a-1' && bindCall?.params?.proxy?.server === 'http://proxy.example:9000',
    'and forwards the server', bindCall?.params);
  check(bindCall?.params?.proxy?.password === SECRET, 'and passes the password inward to the engine');
  check(!bound.raw.includes(SECRET), 'while the response still contains no password');

  engine.calls.length = 0;
  const cleared = await call(handlers[ACCOUNT_ROUTES.PROXY], { method: 'POST', body: { code: 'a-1', proxy: null } });
  check(cleared.status === 200 && cleared.json?.bound === false, 'proxy:null clears the binding', cleared.json);
  check(engine.calls.find((entry) => entry.method === 'account.bindProxy')?.params?.proxy === null,
    'and forwards a null proxy');

  const noServer = await call(handlers[ACCOUNT_ROUTES.PROXY], { method: 'POST', body: { code: 'a-1', proxy: { username: 'u' } } });
  check(noServer.status === 400 && noServer.json?.error?.field === 'proxy.server',
    'a proxy without a server is refused', noServer.json?.error);
  const proxyExtra = await call(handlers[ACCOUNT_ROUTES.PROXY], {
    method: 'POST', body: { code: 'a-1', proxy: { server: 'http://h:1', country: 'us' } },
  });
  check(proxyExtra.status === 400, 'an unexpected proxy key is refused', proxyExtra.json?.error);

  // ---- test a proxy ----
  const tested = await call(handlers[ACCOUNT_ROUTES.TEST_PROXY], { method: 'POST', body: { code: 'a-1' } });
  check(tested.status === 200, 'POST /accounts/test-proxy answers 200', tested.status);

  const unavailable = createAccountsHttp({
    engine: fakeEngine({ 'proxy.test': Object.assign(new Error('proxy is unreachable'), { code: 'PROXY_UNAVAILABLE' }) }),
    log: () => {},
  });
  const unreachable = await call(unavailable.handlers[ACCOUNT_ROUTES.TEST_PROXY], { method: 'POST', body: { code: 'a-1' } });
  check(unreachable.status === 409, 'an unreachable proxy answers 409', unreachable.status);
  check(unreachable.json?.error?.code === 'PROXY_UNAVAILABLE',
    'and keeps PROXY_UNAVAILABLE rather than looking like an expired login', unreachable.json?.error?.code);

  // ---- an engine crash must not become an opaque carrier error ----
  const broken = createAccountsHttp({
    engine: fakeEngine({ 'account.list': Object.assign(new Error('engine exploded'), { code: 'INTERNAL' }) }),
    log: () => {},
  });
  const exploded = await call(broken.handlers[ACCOUNT_ROUTES.ACCOUNTS], { method: 'GET' });
  check(exploded.status === 500, 'an engine failure answers 500', exploded.status);
  check(exploded.json?.error?.code === 'INTERNAL', 'with the INTERNAL code', exploded.json?.error?.code);

  const throwing = createAccountsHttp({
    engine: { call: async () => { throw new TypeError('unexpected shape'); } },
    log: () => {},
  });
  const typeError = await call(throwing.handlers[ACCOUNT_ROUTES.ACCOUNTS], { method: 'GET' });
  check(typeError.status === 500, 'a handler that throws answers 500 instead of crashing', typeError.status);
  check(typeError.json?.error?.code === HTTP_ERRORS.INTERNAL, 'with the INTERNAL code', typeError.json?.error?.code);
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error?.stack ?? error);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
