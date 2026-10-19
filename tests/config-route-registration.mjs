/**
 * config-route-registration.mjs — regression test for the bug that made the Settings page 404 on every
 * call in a real deployment.
 *
 * The host half registered its HTTP surface with a one-shot `ctx.get('webServer')` at activation. In the
 * shipped Web composition the web server is provided *after* this plugin activates, so that lookup
 * returned `undefined`, no route was installed, and every request from the page fell through to the SPA
 * fallback and got a 404. Nothing failed loudly: activation order is a composition detail, so the plugin
 * could not tell that it had raced. The fix is `ctx.inject(['webServer'], …)`, which runs when the
 * service appears and re-runs if a composition replaces it.
 *
 * This asserts the behaviour that matters, in all three orderings:
 *   1. service provided LATER  → the callback registers every route (the regression);
 *   2. service already present → routes register immediately;
 *   3. a context with neither `inject` nor a service → no throw, no routes (a CLI/ACP deployment).
 * It also pins the exact paths and `kind: 'exact'`, since a wrong path is a silent 404 too.
 *
 * Usage (bundled node):
 *   node tests/config-route-registration.mjs
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONFIG_ROUTES } from '../src/config-http.js';
import { ACCOUNT_ROUTES } from '../src/accounts-http.js';

/** A minimal `IncomingMessage`. */
function fakeReq(method = 'GET') {
  const req = new EventEmitter();
  req.method = method;
  req.url = '/';
  req.headers = {};
  req.destroy = () => { req.destroyed = true; };
  return req;
}

/** A minimal `ServerResponse` that records what the handler wrote. */
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

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '..', process.argv[2] ?? 'src/index.js');
const EXPECTED = [...Object.values(CONFIG_ROUTES), ...Object.values(ACCOUNT_ROUTES)].sort();

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-routes-'));
let failures = 0;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
}

/** A recording web server: it keeps every registered route and can remove one. */
function fakeWebServer() {
  /** @type {Array<{ kind: string, path: string, handler: Function }>} */
  const routes = [];
  return {
    routes,
    register(route) {
      if (routes.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
        // The real service throws on a duplicate (kind, path).
        throw new Error(`duplicate route ${route.kind} ${route.path}`);
      }
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at >= 0) routes.splice(at, 1);
      };
    },
  };
}

/**
 * A context that models Cordis' service timing: `get` never waits, `inject` waits for a later `provide`.
 * @param {{ withInject?: boolean, service?: any }} [options]
 */
function fakeContext({ withInject = true, service = undefined } = {}) {
  const registered = [];
  /** @type {Map<string, any>} */
  const services = new Map();
  /** @type {Map<string, Function[]>} */
  const waiting = new Map();
  if (service) services.set('webServer', service);

  /** @param {string} key */
  const childFor = (key) => ({ ...ctx, [key]: services.get(key), effect: ctx.effect });

  const ctx = {
    registered,
    tools: { register: (definition) => { registered.push(definition); return () => {}; } },
    on: () => () => {},
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get: (key) => services.get(key),
  };
  if (withInject) {
    ctx.inject = (keys, callback) => {
      const key = Array.isArray(keys) ? keys[0] : keys;
      if (services.has(key)) {
        callback(childFor(key));
        return () => {};
      }
      const list = waiting.get(key) ?? [];
      list.push(callback);
      waiting.set(key, list);
      return () => {};
    };
  }
  return {
    ctx,
    /** Make a service available, as a later composition would. */
    provide(key, value) {
      services.set(key, value);
      const list = waiting.get(key) ?? [];
      waiting.delete(key);
      for (const callback of list) callback(childFor(key));
    },
  };
}

/** `apply` needs a resolved interpreter; the bundled runtime one is always there. */
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

/** @param {string} label @param {Array<{kind:string,path:string,handler:Function}>} routes */
function assertRoutes(label, routes, expectedCount) {
  check(routes.length === expectedCount,
    `${label}: ${expectedCount} route(s) registered`, routes.map((r) => r.path));
  const paths = routes.map((route) => route.path).sort();
  check(JSON.stringify(paths) === JSON.stringify(EXPECTED),
    `${label}: the exact paths are the ones the page calls`, paths);
  check(routes.every((route) => route.kind === 'exact'),
    `${label}: every route is kind 'exact' (a prefix route would also swallow sub-paths)`,
    routes.map((route) => route.kind));
  check(routes.every((route) => typeof route.handler === 'function'),
    `${label}: every route carries a handler`);
}

try {
  const mod = await import(pathToFileURL(entry).href);
  check(typeof mod.apply === 'function', 'index.js exports apply()');

  // ---- 1. the regression: the service is provided AFTER the plugin activates ----
  {
    const late = fakeWebServer();
    const { ctx, provide } = fakeContext({ withInject: true });
    ctx.get = () => undefined; // exactly what the broken version saw: nothing yet
    mod.apply(ctx, {});
    check(late.routes.length === 0, 'nothing is registered before the service exists');
    provide('webServer', late);
    assertRoutes('service provided later', late.routes, EXPECTED.length);
    check(ctx.registered.length === 10,
      'the tool surface still registered while waiting for the service', ctx.registered.length);

    // Registering is only half the story: the first attempt at this fix installed the routes but handed
    // the store over under the wrong property name, so the page got a 500 on every call while a
    // registration-only assertion stayed green. Drive the handler for real.
    const configRoute = late.routes.find((route) => route.path === CONFIG_ROUTES.CONFIG);
    const res = fakeRes();
    let handlerError = null;
    try {
      await configRoute.handler(fakeReq('GET'), res);
    } catch (error) {
      handlerError = error;
    }
    check(handlerError === null, 'the registered GET handler runs without throwing', handlerError?.message);
    check(res.statusCode === 200,
      'and answers 200 — the store reached the handler, not a 500', res.statusCode);
    let body = null;
    try { body = JSON.parse(res.raw); } catch { body = null; }
    check(body?.ok === true && Array.isArray(body.fields) && body.fields.length === 5,
      'and its body carries the five configuration fields', body?.fields?.length);
  }

  // ---- 2. the ordinary case: the service is already there ----
  {
    const early = fakeWebServer();
    const { ctx } = fakeContext({ withInject: true, service: early });
    mod.apply(ctx, {});
    assertRoutes('service already present', early.routes, EXPECTED.length);
  }

  // ---- 3. no web server at all (CLI/ACP): no throw, no routes ----
  {
    const { ctx } = fakeContext({ withInject: false });
    delete ctx.get;
    delete ctx.inject;
    let threw = null;
    try {
      mod.apply(ctx, {});
    } catch (error) {
      threw = error;
    }
    check(threw === null, 'a context without inject/get does not throw', threw?.message);
    check(ctx.registered.length === 10, 'and the tool surface still registers', ctx.registered.length);
  }

  // ---- 4. a web server without register() must not break activation ----
  {
    const { ctx, provide } = fakeContext({ withInject: true });
    mod.apply(ctx, {});
    let threw = null;
    try {
      provide('webServer', {});
    } catch (error) {
      threw = error;
    }
    check(threw === null, 'a service with no register() does not throw', threw?.message);
    check(ctx.registered.length === 10, 'and the tool surface survives it', ctx.registered.length);
  }
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error?.stack ?? error);
} finally {
  const keep = failures > 0 && existsSync(dataDir);
  if (!keep) rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
