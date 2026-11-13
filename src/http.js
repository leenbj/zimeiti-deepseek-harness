/**
 * http.js — the plugin's own HTTP surface for its Settings page.
 *
 * The page is a dynamic client bundle, and a profile-installed bundle cannot add a Remote namespace
 * without importing a DSH package into this zero-dependency host half. A same-origin route on the
 * `webServer` service costs only a string lookup, so that is what the page talks to.
 *
 * Threat model: a loopback surface reachable by anything that can reach the GUI port. Therefore:
 *   - writes require `content-type: application/json` (a cross-origin HTML form cannot send it without
 *     a preflight, which is never answered), and the body is capped;
 *   - responses never contain a proxy password (the account projection carries `hasPassword`);
 *   - no filesystem browsing: the page sees account metadata, never profile directory contents.
 *
 * @module ego-publish/http
 */
import { MEDIA_DEFAULTS, publicAccount } from './accounts.js';
import { checkLogin, startLogin } from './actions.js';
import { EgoError } from './cdp.js';
import { CONFIG_DEFAULTS } from './config.js';
import { flowSummary, loadFlows } from './flows.js';
import { parseProxy, redactProxy, testProxy } from './proxy.js';
import { publicProxy, resolveAccountProxy } from './proxies.js';
import { refreshAccountPoints } from './points.js';
import { extractProxies, extractOne } from './provider.js';
import { runTask } from './tasks.js';

/** Paths this module owns. Registered `kind: 'exact'`. */
export const ROUTES = Object.freeze({
  STATUS: '/ego-publish/status',
  CONFIG: '/ego-publish/config',
  CONFIG_RESET: '/ego-publish/config/reset',
  ACCOUNTS: '/ego-publish/accounts',
  POINTS: '/ego-publish/accounts/points',
  CHECKS: '/ego-publish/checks',
  LOGIN: '/ego-publish/accounts/login',
  CHECK: '/ego-publish/accounts/check',
  SESSION: '/ego-publish/accounts/session',
  PROXY: '/ego-publish/proxy',
  PROXIES: '/ego-publish/proxies',
  PROXIES_EXTRACT: '/ego-publish/proxies/extract',
  FLOWS: '/ego-publish/flows',
  TASKS: '/ego-publish/tasks',
  SOURCES: '/ego-publish/dynamic-sources',
});

/** Cap on a request body. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Write one JSON response (never twice).
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  let body;
  try {
    body = Buffer.from(JSON.stringify(payload), 'utf8');
  } catch {
    status = 500;
    body = Buffer.from('{"ok":false,"error":{"code":"INTERNAL","message":"response could not be encoded"}}', 'utf8');
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** @param {string} code @param {string} message @param {Record<string, any>} [extra] */
function failure(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

/**
 * Read a JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ ok: true, value: Record<string, any> } | { ok: false, status: number, payload: any }>}
 */
function readJsonBody(req) {
  const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return Promise.resolve({ ok: false, status: 415, payload: failure('UNSUPPORTED_MEDIA_TYPE', 'writes require content-type: application/json') });
  }
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(result);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, status: 413, payload: failure('BODY_TOO_LARGE', 'request body is too large') });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return finish({ ok: true, value: {} });
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return finish({ ok: false, status: 400, payload: failure('BAD_JSON', 'body must be a JSON object') });
        }
        finish({ ok: true, value });
      } catch {
        finish({ ok: false, status: 400, payload: failure('BAD_JSON', 'body is not valid JSON') });
      }
    };
    const onError = () => finish({ ok: false, status: 400, payload: failure('BAD_REQUEST', 'request body could not be read') });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Build the routes for one plugin instance.
 * @param {{ ego: any, accounts: any, manager: any, settings: Record<string, any>, configStore: any,
 *           dataDir: string, pluginRoot: string, pluginVersion: string, log?: (line: string) => void }} deps
 */
export function createHttpRoutes(deps) {
  const log = deps.log ?? (() => {});
  const { ego, accounts, manager, settings, configStore, dataDir, pluginRoot, pluginVersion, proxies } = deps;

  /** The proxy an account actually launches with, redacted for the page. */
  function resolvedProxy(account) {
    const resolved = resolveAccountProxy(account, proxies);
    if (!resolved) return { proxy: null, proxyId: account.proxyId ?? null, proxySource: null };
    return {
      proxy: {
        server: resolved.server,
        hasAuth: Boolean(resolved.username || resolved.password),
        username: resolved.username ?? null,
      },
      proxyId: account.proxyId ?? null,
      proxySource: resolved.source,
    };
  }

  /** Public account row with the pool-resolved proxy attached. */
  function accountView(account) {
    const base = publicAccount(account);
    if (!base) return null;
    return { ...base, ...resolvedProxy(account) };
  }

  function accountList() {
    return accounts.list().map(accountView);
  }

  /** @param {Record<string, any>} patch */
  function accountProjection(patch = {}) {
    const account = accounts.get(patch.code);
    if (!account) return null;
    return { ...accountView(account), ...patch, profileVersion: patch.profileVersion ?? null };
  }

  function proxyList() {
    const usage = accounts.proxyUsage();
    return proxies.listPublic(usage);
  }

  /** Credentials never leave the host: the saved extraction URL is reported as "***". */
  function publicValues(values) {
    return {
      ...values,
      proxyApiUrl: values.proxyApiUrl ? '***' : null,
      proxyWhitelistKey: values.proxyWhitelistKey ? '***' : null,
      proxyWhitelistSign: values.proxyWhitelistSign ? '***' : null,
    };
  }

  function statusPayload() {
    const flows = loadFlows({ pluginRoot, dataDir }).map(flowSummary);
    return {
      ok: true,
      plugin: {
        version: pluginVersion,
        egoPath: ego.path,
        egoExists: ego.exists,
        egoSource: ego.source,
        installedVersion: ego.installedVersion ?? null,
        dataDir,
        configFile: configStore.filePath,
      },
      config: { values: publicValues(settings), sources: configStore.sources(), defaults: CONFIG_DEFAULTS },
      accounts: accountList(),
      proxies: proxyList(),
      checks: deps.checks ? deps.checks.list().slice(-10) : [],
      dynamic: deps.dynamics ? deps.dynamics.snapshot() : null,
      tasks: deps.tasks ? deps.tasks.list() : [],
      dynamicSources: deps.sources ? deps.sources.list().map(({ id, label, createdAt, updatedAt }) => ({ id, label, url: '***', createdAt, updatedAt })) : [],
      sessions: manager.list(),
      flows,
      media: Object.entries(MEDIA_DEFAULTS).map(([key, value]) => ({ key, label: value.label })),
    };
  }

  // ---- handlers -----------------------------------------------------------------------------------

  async function getStatus(req, res) {
    sendJson(res, 200, statusPayload());
  }

  async function getConfig(req, res) {
    sendJson(res, 200, {
      ok: true,
      values: publicValues(settings),
      sources: configStore.sources(),
      defaults: CONFIG_DEFAULTS,
    });
  }

  async function postConfig(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    const values = { ...body.value.values };
    for (const key of ['proxyApiUrl', 'proxyWhitelistKey', 'proxyWhitelistSign']) {
      if (values[key] === '***' || values[key] === '') delete values[key];
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return sendJson(res, 400, failure('BAD_REQUEST', 'values must be an object'));
    }
    if ('dataDir' in values) {
      return sendJson(res, 400, failure('DATADIR_FIXED', 'dataDir is fixed by the bundle patch; change it there and restart'));
    }
    const outcome = configStore.set(values);
    if (!outcome.ok) return sendJson(res, 400, failure('INVALID_CONFIG', outcome.message ?? 'invalid configuration'));
    return sendJson(res, 200, { ok: true, values: publicValues(outcome.values), changed: outcome.changed });
  }

  async function postConfigReset(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    const names = Array.isArray(body.value.names) ? body.value.names : undefined;
    const values = configStore.reset(names);
    return sendJson(res, 200, { ok: true, values });
  }

  async function getAccounts(req, res) {
    sendJson(res, 200, {
      ok: true,
      accounts: accountList(),
      proxies: proxyList(),
      media: Object.entries(MEDIA_DEFAULTS).map(([key, value]) => ({ key, label: value.label })),
    });
  }

  async function postAccounts(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    const input = body.value;
    if (input.op === 'remove') {
      const record = accounts.get(String(input.code ?? ''));
      if (!record) return sendJson(res, 404, failure('ACCOUNT_NOT_FOUND', `no account with code "${input.code}"`));
      await manager.close(record.code).catch(() => {});
      const outcome = accounts.remove(record.code, { removeProfile: input.removeProfile === true });
      return sendJson(res, 200, { ok: true, removed: outcome.removed, profileDeleted: outcome.profileDeleted });
    }
    if (input.op !== 'upsert') return sendJson(res, 400, failure('INVALID_OP', 'op must be upsert or remove'));
    if (typeof input.code !== 'string' || !input.code.trim()) {
      return sendJson(res, 400, failure('INVALID_ACCOUNT_CODE', 'code is required'));
    }
    try {
      if (input.proxy !== undefined && input.proxy !== null) parseProxy(input.proxy);
      if (input.proxyId) {
        if (!proxies.get(String(input.proxyId))) return sendJson(res, 404, failure('PROXY_NOT_FOUND', `no proxy with id "${input.proxyId}"`));
      }
      const record = accounts.upsert({
        code: input.code,
        media: input.media,
        account: input.account,
        note: input.note,
        loginUrl: input.loginUrl,
        homeUrl: input.homeUrl,
        proxy: input.proxy,
        proxyId: input.proxyId,
        proxyMode: input.proxyMode,
      });
      if (record.proxyMode === 'dynamic' && deps.dynamics) {
        try {
          const one = await extractOne({ configStore, log, sources: deps.sources });
          deps.dynamics.add(record.code, one);
        } catch (error) {
          log(`dynamic proxy pre-extract for ${record.code} failed: ${error?.message ?? error}`);
        }
      }
      return sendJson(res, 200, { ok: true, account: accountProjection({ code: record.code }), proxies: proxyList(), dynamic: deps.dynamics ? deps.dynamics.snapshot() : null });
    } catch (error) {
      if (error instanceof EgoError) return sendJson(res, 400, failure(error.code, error.message));
      return sendJson(res, 400, failure(error?.code ?? 'BAD_REQUEST', String(error?.message ?? error)));
    }
  }

  async function postLogin(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    try {
      const outcome = await startLogin({ manager, accounts, settings }, { code: String(body.value.code ?? ''), loginUrl: body.value.loginUrl });
      return sendJson(res, 200, { ok: true, ...outcome, accounts: accountList(), sessions: manager.list() });
    } catch (error) {
      const code = error?.code ?? 'LOGIN_FAILED';
      return sendJson(res, code === 'ACCOUNT_NOT_FOUND' ? 404 : 400, failure(code, String(error?.message ?? error)));
    }
  }

  async function postCheck(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    try {
      const outcome = await checkLogin({ manager, accounts, settings }, { code: String(body.value.code ?? '') });
      return sendJson(res, 200, { ok: true, ...outcome, accounts: accountList(), sessions: manager.list() });
    } catch (error) {
      const code = error?.code ?? 'CHECK_FAILED';
      return sendJson(res, code === 'ACCOUNT_NOT_FOUND' ? 404 : 400, failure(code, String(error?.message ?? error)));
    }
  }

  async function postPoints(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    const code = String(body.value.code ?? '');
    try {
      const points = await refreshAccountPoints({ manager, accounts, log }, code);
      return sendJson(res, 200, {
        ok: true,
        points,
        account: accountProjection({ code }),
        accounts: accountList(),
      });
    } catch (error) {
      const status = error?.code === 'ACCOUNT_NOT_FOUND' ? 404 : 400;
      return sendJson(res, status, failure(error?.code ?? 'POINTS_FAILED', String(error?.message ?? error)));
    }
  }

  async function getChecks(req, res) {
    sendJson(res, 200, { ok: true, checks: deps.checks ? deps.checks.list() : [] });
  }

  async function postChecks(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    if (!deps.checks) return sendJson(res, 400, failure('CHECKS_UNAVAILABLE', 'the check scheduler is not running'));
    const input = body.value;
    try {
      const account = accounts.get(String(input.accountCode ?? ''));
      if (!account) return sendJson(res, 404, failure('ACCOUNT_NOT_FOUND', `no account with code "${input.accountCode}"`));
      const scheduled = deps.checks.schedule({
        accountCode: account.code,
        url: input.url,
        title: input.title,
        flowId: 'manual',
        delayMinutes: input.delayMinutes,
      });
      if (input.runNow === true) {
        const record = await deps.checks.runNow(scheduled.id);
        return sendJson(res, 200, { ok: true, scheduled, check: record, accounts: accountList() });
      }
      return sendJson(res, 200, { ok: true, scheduled });
    } catch (error) {
      return sendJson(res, 400, failure(error?.code ?? 'CHECK_FAILED', String(error?.message ?? error)));
    }
  }

  async function postProxiesExtract(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    try {
      const result = await extractProxies({ configStore, proxies, log, sources: deps.sources }, { count: Number(body.value.count) || 1, sourceId: body.value.sourceId });
      return sendJson(res, 200, { ok: true, ...result, proxies: proxyList() });
    } catch (error) {
      return sendJson(res, 400, failure(error?.code ?? 'PROXY_EXTRACT_FAILED', String(error?.message ?? error)));
    }
  }

  async function getTasks(req, res) {
    sendJson(res, 200, { ok: true, tasks: deps.tasks ? deps.tasks.list() : [] });
  }

  async function postTasks(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    if (!deps.tasks) return sendJson(res, 400, failure('TASKS_UNAVAILABLE', 'task store is not ready'));
    const input = body.value;
    try {
      if (input.op === 'save') {
        const task = deps.tasks.upsert(input);
        return sendJson(res, 200, { ok: true, task, tasks: deps.tasks.list() });
      }
      if (input.op === 'remove') {
        const removed = deps.tasks.remove(String(input.id ?? ''));
        if (!removed) return sendJson(res, 404, failure('TASK_NOT_FOUND', `no task with id "${input.id}"`));
        return sendJson(res, 200, { ok: true, removed: true, tasks: deps.tasks.list() });
      }
      if (input.op === 'run') {
        const outcome = await runTask({ manager, accounts, proxies, tasks: deps.tasks, settings, log }, String(input.id ?? ''));
        return sendJson(res, 200, { ok: true, ...outcome });
      }
      return sendJson(res, 400, failure('INVALID_OP', 'op must be save, remove or run'));
    } catch (error) {
      return sendJson(res, 400, failure(error?.code ?? 'TASK_FAILED', String(error?.message ?? error)));
    }
  }

  async function getSources(req, res) {
    sendJson(res, 200, { ok: true, sources: deps.sources ? deps.sources.list().map(({ id, label, createdAt, updatedAt }) => ({ id, label, url: '***', createdAt, updatedAt })) : [] });
  }

  async function postSources(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    const input = body.value;
    try {
      if (input.op === 'remove') {
        const removed = deps.sources.remove(String(input.id ?? ''));
        if (!removed) return sendJson(res, 404, failure('SOURCE_NOT_FOUND', `no source with id "${input.id}"`));
        return sendJson(res, 200, { ok: true, removed: true });
      }
      const source = deps.sources.upsert({ id: input.id, label: input.label, url: input.url });
      return sendJson(res, 200, { ok: true, source: { id: source.id, label: source.label, url: '***' } });
    } catch (error) {
      return sendJson(res, 400, failure(error?.code ?? 'SOURCE_FAILED', String(error?.message ?? error)));
    }
  }

  async function postSession(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    const code = String(body.value.code ?? '');
    try {
      if (body.value.op === 'close') {
        const outcome = await manager.close(code);
        return sendJson(res, 200, { ok: true, ...outcome, sessions: manager.list() });
      }
      if (body.value.op === 'probe') {
        const connectivity = await manager.probeConnectivity(code);
        return sendJson(res, 200, { ok: true, connectivity, sessions: manager.list() });
      }
      if (body.value.op !== 'open') return sendJson(res, 400, failure('INVALID_OP', 'op must be open, close or probe'));
      const session = await manager.open(code);
      return sendJson(res, 200, {
        ok: true,
        session: {
          accountCode: session.code,
          pid: session.pid,
          url: await session.page.url().catch(() => null),
          title: await session.page.title().catch(() => null),
          proxy: session.proxyUrl,
          connectivity: session.connectivity ?? null,
        },
        sessions: manager.list(),
      });
    } catch (error) {
      return sendJson(res, 400, failure(error?.code ?? 'SESSION_FAILED', String(error?.message ?? error)));
    }
  }

  /** Legacy per-account proxy route kept for older callers; the pool route is the primary one. */
  async function postProxy(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    const input = body.value;
    const account = accounts.get(String(input.code ?? ''));
    if (!account) return sendJson(res, 404, failure('ACCOUNT_NOT_FOUND', `no account with code "${input.code}"`));
    try {
      if (input.op === 'set') {
        let entry = input.id ? proxies.get(String(input.id)) : null;
        if (!entry) {
          entry = proxies.add({ label: input.label || `账号 ${account.code}`, server: input.server, username: input.username, password: input.password });
        }
        accounts.setProxyId(account.code, entry.id);
        await manager.close(account.code).catch(() => {});
        return sendJson(res, 200, {
          ok: true,
          account: accountProjection({ code: account.code }),
          proxy: publicProxy(entry, [account.code]),
          proxies: proxyList(),
          sessions: manager.list(),
        });
      }
      if (input.op === 'clear') {
        accounts.setProxyId(account.code, null);
        await manager.close(account.code).catch(() => {});
        return sendJson(res, 200, { ok: true, account: accountProjection({ code: account.code }), proxies: proxyList(), sessions: manager.list() });
      }
      if (input.op === 'test') {
        const target = input.id ? proxies.get(String(input.id)) : null;
        const proxy = input.server
          ? { server: input.server, username: input.username, password: input.password }
          : (target ?? resolveAccountProxy(account, proxies));
        if (!proxy) return sendJson(res, 400, failure('NO_PROXY', 'this account has no proxy to test'));
        const result = await testProxy(proxy, { timeoutMs: Number(input.timeoutMs) || 20000 });
        if (target) proxies.markTest(target.id, { ip: result.ip, latencyMs: result.latencyMs });
        return sendJson(res, 200, { ok: true, result, proxy: redactProxy(proxy), proxies: proxyList() });
      }
      return sendJson(res, 400, failure('INVALID_OP', 'op must be set, clear or test'));
    } catch (error) {
      return sendJson(res, 400, failure(error?.code ?? 'PROXY_FAILED', String(error?.message ?? error)));
    }
  }

  async function getProxies(req, res) {
    sendJson(res, 200, { ok: true, proxies: proxyList(), accounts: accountList() });
  }

  /** Pool CRUD + assignment + probe. */
  async function postProxies(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, body.payload);
    const input = body.value;
    try {
      if (input.op === 'add') {
        const entry = proxies.add({ label: input.label, server: input.server, username: input.username, password: input.password });
        return sendJson(res, 200, { ok: true, proxy: publicProxy(entry, []), proxies: proxyList() });
      }
      if (input.op === 'update') {
        const entry = proxies.update(String(input.id ?? ''), {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.server !== undefined ? { server: input.server } : {}),
          ...(input.username !== undefined ? { username: input.username } : {}),
          ...(input.password !== undefined ? { password: input.password } : {}),
        });
        const affected = accounts.proxyUsage()[entry.id] ?? [];
        for (const code of affected) await manager.close(code).catch(() => {});
        return sendJson(res, 200, { ok: true, proxy: publicProxy(entry, affected), proxies: proxyList(), sessions: manager.list() });
      }
      if (input.op === 'remove') {
        const id = String(input.id ?? '');
        const entry = proxies.get(id);
        if (!entry) return sendJson(res, 404, failure('PROXY_NOT_FOUND', `no proxy with id "${id}"`));
        const affected = accounts.clearProxyId(id);
        for (const code of affected) await manager.close(code).catch(() => {});
        proxies.remove(id);
        return sendJson(res, 200, { ok: true, removed: true, affected, proxies: proxyList(), accounts: accountList(), sessions: manager.list() });
      }
      if (input.op === 'assign') {
        const account = accounts.get(String(input.code ?? ''));
        if (!account) return sendJson(res, 404, failure('ACCOUNT_NOT_FOUND', `no account with code "${input.code}"`));
        const id = input.id === null || input.id === '' ? null : String(input.id);
        if (id !== null && !proxies.get(id)) return sendJson(res, 404, failure('PROXY_NOT_FOUND', `no proxy with id "${id}"`));
        accounts.setProxyId(account.code, id);
        await manager.close(account.code).catch(() => {});
        return sendJson(res, 200, {
          ok: true,
          account: accountProjection({ code: account.code }),
          proxies: proxyList(),
          sessions: manager.list(),
        });
      }
      if (input.op === 'test') {
        let entry = null;
        let proxy = null;
        if (input.id) {
          entry = proxies.get(String(input.id));
          if (!entry) return sendJson(res, 404, failure('PROXY_NOT_FOUND', `no proxy with id "${input.id}"`));
          proxy = entry;
        } else if (input.server) {
          proxy = { server: input.server, username: input.username, password: input.password };
        } else {
          return sendJson(res, 400, failure('NO_PROXY', 'pass id or server'));
        }
        const result = await testProxy(proxy, { timeoutMs: Number(input.timeoutMs) || 20000 });
        if (entry) proxies.markTest(entry.id, { ip: result.ip, latencyMs: result.latencyMs });
        return sendJson(res, 200, { ok: true, result, proxy: redactProxy(proxy), proxies: proxyList() });
      }
      return sendJson(res, 400, failure('INVALID_OP', 'op must be add, update, remove, assign or test'));
    } catch (error) {
      return sendJson(res, error?.code === 'PROXY_NOT_FOUND' ? 404 : 400, failure(error?.code ?? 'PROXY_FAILED', String(error?.message ?? error)));
    }
  }

  async function getFlows(req, res) {
    const flows = loadFlows({ pluginRoot, dataDir }).map(flowSummary);
    sendJson(res, 200, { ok: true, flows });
  }

  // ---- route table --------------------------------------------------------------------------------

  const exactRoute = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      log(`ego-publish route error: ${error?.stack ?? error}`);
      sendJson(res, 500, failure('INTERNAL', 'the plugin could not handle this request; see the plugin log'));
    }
  };

  /** @type {Array<{ kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void> }>} */
  const routes = [
    { kind: 'exact', path: ROUTES.STATUS, handler: exactRoute(getStatus) },
    { kind: 'exact', path: ROUTES.FLOWS, handler: exactRoute(getFlows) },
    { kind: 'exact', path: ROUTES.SOURCES, handler: exactRoute(async (req, res) => {
      if (String(req.method).toUpperCase() === 'GET') return getSources(req, res);
      if (String(req.method).toUpperCase() === 'POST') return postSources(req, res);
      return sendJson(res, 405, failure('METHOD_NOT_ALLOWED', 'GET or POST only'));
    }) },
    { kind: 'exact', path: ROUTES.TASKS, handler: exactRoute(async (req, res) => {
      if (String(req.method).toUpperCase() === 'GET') return getTasks(req, res);
      if (String(req.method).toUpperCase() === 'POST') return postTasks(req, res);
      return sendJson(res, 405, failure('METHOD_NOT_ALLOWED', 'GET or POST only'));
    }) },
    { kind: 'exact', path: ROUTES.CONFIG, handler: exactRoute(async (req, res) => {
      if (String(req.method).toUpperCase() === 'GET') return getConfig(req, res);
      if (String(req.method).toUpperCase() === 'POST') return postConfig(req, res);
      return sendJson(res, 405, failure('METHOD_NOT_ALLOWED', 'GET or POST only'));
    }) },
    { kind: 'exact', path: ROUTES.CONFIG_RESET, handler: exactRoute(postConfigReset) },
    { kind: 'exact', path: ROUTES.ACCOUNTS, handler: exactRoute(async (req, res) => {
      if (String(req.method).toUpperCase() === 'GET') return getAccounts(req, res);
      if (String(req.method).toUpperCase() === 'POST') return postAccounts(req, res);
      return sendJson(res, 405, failure('METHOD_NOT_ALLOWED', 'GET or POST only'));
    }) },
    { kind: 'exact', path: ROUTES.LOGIN, handler: exactRoute(postLogin) },
    { kind: 'exact', path: ROUTES.POINTS, handler: exactRoute(postPoints) },
    { kind: 'exact', path: ROUTES.CHECKS, handler: exactRoute(async (req, res) => {
      if (String(req.method).toUpperCase() === 'GET') return getChecks(req, res);
      if (String(req.method).toUpperCase() === 'POST') return postChecks(req, res);
      return sendJson(res, 405, failure('METHOD_NOT_ALLOWED', 'GET or POST only'));
    }) },
    { kind: 'exact', path: ROUTES.CHECK, handler: exactRoute(postCheck) },
    { kind: 'exact', path: ROUTES.SESSION, handler: exactRoute(postSession) },
    { kind: 'exact', path: ROUTES.PROXY, handler: exactRoute(postProxy) },
    { kind: 'exact', path: ROUTES.PROXIES_EXTRACT, handler: exactRoute(postProxiesExtract) },
    { kind: 'exact', path: ROUTES.PROXIES, handler: exactRoute(async (req, res) => {
      if (String(req.method).toUpperCase() === 'GET') return getProxies(req, res);
      if (String(req.method).toUpperCase() === 'POST') return postProxies(req, res);
      return sendJson(res, 405, failure('METHOD_NOT_ALLOWED', 'GET or POST only'));
    }) },
  ];

  return { routes, statusPayload };
}
