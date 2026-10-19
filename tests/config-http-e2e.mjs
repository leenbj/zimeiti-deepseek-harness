/**
 * config-http-e2e.mjs — end-to-end test of the plugin's Settings HTTP surface.
 *
 * This exists because the surface shipped twice with a defect that the earlier checks could not see:
 *   1. the routes were registered with a one-shot `ctx.get('webServer')` and were never installed (404);
 *   2. once that was fixed, the store was passed under the wrong property name, so every handler threw on
 *      its first statement and answered **500** — while `config-route-registration.mjs` still passed,
 *      because it only asserted that routes exist, never that they *work*.
 *
 * So this drives the real handlers, built by the real factory over a real config store, through fake
 * `req`/`res` objects, and asserts the actual status codes and bodies — success paths and every refusal.
 *
 * Usage (bundled node):
 *   node tests/config-http-e2e.mjs
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_ROUTES, HTTP_ERRORS, MAX_BODY_BYTES, createConfigHttp } from '../src/config-http.js';
import { createConfigStore } from '../src/config.js';

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-http-'));
let failures = 0;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
}

/** A minimal `IncomingMessage`: an emitter carrying method, url and headers. */
function fakeReq(method, contentType = 'application/json') {
  const req = new EventEmitter();
  req.method = method;
  req.url = '/';
  req.headers = contentType === null ? {} : { 'content-type': contentType };
  req.destroy = () => { req.destroyed = true; };
  return req;
}

/** A minimal `ServerResponse` recording what the handler wrote. */
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
  res.json = () => {
    try { return JSON.parse(res.raw); } catch { return null; }
  };
  return res;
}

/**
 * Invoke one handler with an optional JSON body, letting the handler attach its listeners first.
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
  return { req, res, status: res.statusCode, json: res.json() };
}

try {
  // ---- the guard that makes today's mistake impossible to ship again ----
  let guardError = null;
  try {
    createConfigHttp({ store: undefined, status: () => ({}), log: () => {} });
  } catch (error) {
    guardError = error;
  }
  check(guardError instanceof TypeError,
    'a shapeless store is refused at construction, not turned into a 500 per request', guardError?.message);
  check(String(guardError?.message ?? '').includes('store'),
    'and the refusal names the missing dependency', guardError?.message);

  const patch = { headless: false, requireExplicitPublish: true, requestTimeoutMs: 120000 };
  const store = createConfigStore({ patch, bootstrapDataDir: dataDir });
  const configFile = store.filePath;
  const { handlers, routes } = createConfigHttp({
    store,
    status: () => ({ pluginVersion: 'test-version', engineRunning: false }),
    log: () => {},
  });

  check(routes.length === 3 && routes.every((route) => typeof route.handler === 'function'),
    'three routes are built, each with a handler', routes.map((route) => route.path));
  check(!existsSync(configFile), 'no user config file exists before the first write');

  // ---- GET /config ----
  const get1 = await call(handlers[CONFIG_ROUTES.CONFIG], { method: 'GET' });
  check(get1.status === 200, 'GET /config answers 200', get1.status);
  check(get1.json?.ok === true, 'and its body says ok', get1.json?.ok);
  check(Array.isArray(get1.json?.fields) && get1.json.fields.length === 5,
    'and it carries all five fields', get1.json?.fields?.length);
  check(get1.json?.revision === 0, 'and the current revision', get1.json?.revision);
  check(get1.json?.fields?.every((f) => typeof f.effectiveFrom === 'string'),
    'each field reports which layer it came from');
  check(get1.res.headers['content-type']?.includes('application/json'),
    'and the response is typed as JSON', get1.res.headers['content-type']);

  // ---- POST /config: a real write ----
  const post1 = await call(handlers[CONFIG_ROUTES.CONFIG], {
    method: 'POST', body: { values: { headless: true }, revision: 0 },
  });
  check(post1.status === 200, 'POST /config answers 200 for a valid write', post1.status);
  check(post1.json?.ok === true && post1.json?.changed?.includes('headless'),
    'and reports which field changed', post1.json?.changed);
  check(post1.json?.revision === 1, 'and the new revision', post1.json?.revision);
  check(store.values().headless === true, 'the effective value changed in the live store');
  check(existsSync(configFile), 'the user config file was created on disk', configFile);
  const onDisk = JSON.parse(readFileSync(configFile, 'utf8'));
  check(onDisk.values?.headless === true, 'and it records the written value', onDisk.values);
  check(onDisk.version === 1, 'with a format version', onDisk.version);
  const headlessField = post1.json?.fields?.find((f) => f.name === 'headless');
  check(headlessField?.overridden === true && headlessField?.effectiveFrom === 'config-file',
    'and the returned field says the user layer now wins', headlessField);

  // ---- a stale revision must be refused AND must not write ----
  const before = readFileSync(configFile, 'utf8');
  const stale = await call(handlers[CONFIG_ROUTES.CONFIG], {
    method: 'POST', body: { values: { headless: false }, revision: 0 },
  });
  check(stale.status === 409, 'a stale revision answers 409', stale.status);
  check(stale.json?.error?.code === HTTP_ERRORS.STALE, 'with the STALE_REVISION code', stale.json?.error?.code);
  check(readFileSync(configFile, 'utf8') === before,
    'and a refused stale write leaves the config file byte-identical');
  check(store.values().headless === true, 'and the live value is untouched', store.values().headless);

  // ---- refusals ----
  const wrongType = await call(handlers[CONFIG_ROUTES.CONFIG], {
    method: 'POST', body: { values: { headless: 'yes' } },
  });
  check(wrongType.status === 400, 'a wrongly typed value answers 400', wrongType.status);
  check(String(wrongType.json?.error?.message ?? '').includes('headless'),
    'and the message names the field', wrongType.json?.error?.message);

  const unknownField = await call(handlers[CONFIG_ROUTES.CONFIG], {
    method: 'POST', body: { values: { nope: 1 } },
  });
  check(unknownField.status === 400, 'an unknown field answers 400', unknownField.status);
  check(readFileSync(configFile, 'utf8') === before,
    'and an unknown field leaves the config file byte-identical');

  const badContentType = await call(handlers[CONFIG_ROUTES.CONFIG], {
    method: 'POST', contentType: 'text/plain', rawBody: '{"values":{}}',
  });
  check(badContentType.status === 415, 'a wrong content type answers 415', badContentType.status);
  check(badContentType.json?.error?.code === HTTP_ERRORS.CONTENT_TYPE,
    'with the UNSUPPORTED_MEDIA_TYPE code', badContentType.json?.error?.code);

  const badJson = await call(handlers[CONFIG_ROUTES.CONFIG], {
    method: 'POST', rawBody: '{not json',
  });
  check(badJson.status === 400, 'malformed JSON answers 400', badJson.status);
  check(badJson.json?.error?.code === HTTP_ERRORS.BAD_JSON, 'with the BAD_JSON code', badJson.json?.error?.code);

  // An oversized body must be refused AND the response must still arrive (the socket is torn down only
  // after it flushes, per the host web server's contract).
  const huge = await call(handlers[CONFIG_ROUTES.CONFIG], {
    method: 'POST', rawBody: `{"values":{"headless":true},"pad":"${'x'.repeat(MAX_BODY_BYTES + 64)}"}`,
  });
  check(huge.status === 413, 'an oversized body answers 413 (and the response still arrives)', huge.status);
  check(huge.json?.error?.code === HTTP_ERRORS.BODY_TOO_LARGE, 'with the BODY_TOO_LARGE code', huge.json?.error?.code);

  // ---- method enforcement ----
  const wrongMethod = await call(handlers[CONFIG_ROUTES.CONFIG], { method: 'DELETE' });
  check(wrongMethod.status === 405, 'an unsupported method answers 405', wrongMethod.status);
  check(String(wrongMethod.res.headers.allow ?? '').includes('GET'),
    'and the allow header lists the supported ones', wrongMethod.res.headers.allow);

  const resetWrongMethod = await call(handlers[CONFIG_ROUTES.RESET], { method: 'GET' });
  check(resetWrongMethod.status === 405, 'GET on /reset answers 405', resetWrongMethod.status);

  // ---- GET /status ----
  const status = await call(handlers[CONFIG_ROUTES.STATUS], { method: 'GET' });
  check(status.status === 200, 'GET /status answers 200', status.status);
  check(status.json?.status?.pluginVersion === 'test-version',
    'and carries the injected status block', status.json?.status);

  // ---- POST /reset restores the layer beneath ----
  const reset = await call(handlers[CONFIG_ROUTES.RESET], {
    method: 'POST', body: { names: ['headless'], revision: 1 },
  });
  check(reset.status === 200, 'POST /config/reset answers 200', reset.status);
  check(store.values().headless === false, 'and the value falls back to the patch layer', store.values().headless);
  const resetField = reset.json?.fields?.find((f) => f.name === 'headless');
  check(resetField?.overridden === false && resetField?.effectiveFrom === 'patch',
    'and the field reports the patch as its source again', resetField);

  const resetStale = await call(handlers[CONFIG_ROUTES.RESET], {
    method: 'POST', body: { names: ['headless'], revision: 0 },
  });
  check(resetStale.status === 409, 'a stale revision on /reset also answers 409', resetStale.status);

  const resetUnknown = await call(handlers[CONFIG_ROUTES.RESET], {
    method: 'POST', body: { names: ['nope'] },
  });
  check(resetUnknown.status === 400, 'an unknown name on /reset answers 400', resetUnknown.status);

  // The whole surface must survive a handler that throws, answering 500 rather than killing the process.
  const throwing = createConfigHttp({
    store: { ...store, fields: () => { throw new Error('boom'); } },
    status: () => ({}),
    log: () => {},
  });
  const boom = await call(throwing.handlers[CONFIG_ROUTES.CONFIG], { method: 'GET' });
  check(boom.status === 500, 'a handler that throws answers 500 instead of crashing', boom.status);
  check(boom.json?.error?.code === HTTP_ERRORS.INTERNAL, 'with the INTERNAL code', boom.json?.error?.code);
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error?.stack ?? error);
} finally {
  if (failures === 0) rmSync(dataDir, { recursive: true, force: true });
  else console.log(`kept ${dataDir} for inspection`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
