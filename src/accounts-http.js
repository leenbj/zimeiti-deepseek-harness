/**
 * accounts-http.js — the account-management half of the plugin's Settings HTTP surface.
 *
 * The settings page is plugin-owned (see lib/client.js), so every control it offers needs a host-side
 * endpoint. This module serves the **发布账号** section: list accounts, create or edit one, remove one,
 * bind or clear a fixed proxy, and test the proxy an account is bound to.
 *
 * Deliberate properties, each asserted by tests/accounts-http-e2e.mjs:
 *
 *   - **No credential ever leaves this module.** A proxy password is accepted on the way in and never
 *     echoed back: the account projection is an explicit allow-list of fields, and the only thing said
 *     about a password is `hasPassword`. A test greps the whole serialised response for the password.
 *   - **Inputs are validated here, not only in the engine**, so a typo is answered with a specific 400
 *     instead of an engine round-trip; the engine stays the authority for anything it alone can check.
 *   - **Removal is explicit about its blast radius**: `purgeState` (deleting the stored login) must be
 *     asked for by name.
 *   - A handler that throws is answered as an explicit 500 with a code, never as the carrier's opaque 400.
 *
 * Zero external imports: only `node:*` builtins, keeping the host half free of DSH dependencies.
 *
 * @module media-publish/accounts-http
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { HTTP_ERRORS, MAX_BODY_BYTES } from './config-http.js';

/** Exact paths this module owns. Registered `kind: 'exact'`. */
export const ACCOUNT_ROUTES = Object.freeze({
  /** GET → the account list; POST → create or update one account. */
  ACCOUNTS: '/media-publish/accounts',
  /** POST → remove one account. */
  REMOVE: '/media-publish/accounts/remove',
  /** POST → bind a fixed proxy to one account, or clear it with `proxy: null`. */
  PROXY: '/media-publish/accounts/proxy',
  /** POST → probe the proxy bound to one account. */
  TEST_PROXY: '/media-publish/accounts/test-proxy',
  /** POST → start a sign-in (opens a headed window for a human); GET ?code= → poll its outcome. */
  LOGIN: '/media-publish/accounts/login',
  /** POST → verify the stored sign-in is still valid, without rewriting it. */
  CHECK: '/media-publish/accounts/check',
});

/** The only account code shape accepted, so a hostile or fat-fingered value cannot reach a path join. */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** Media the engine knows how to drive. */
export const ACCOUNT_MEDIA = Object.freeze(['sohu', 'toutiao', 'csdn']);

/**
 * The fields of one account that may be shown to a client. Anything not named here is dropped, so a new
 * engine field cannot leak by accident — the projection is an allow-list rather than a copy.
 * @param {any} account
 */
function projectAccount(account) {
  const proxy = account?.proxy ?? {};
  return {
    code: String(account?.code ?? ''),
    media: String(account?.media ?? ''),
    account: String(account?.account ?? ''),
    note: String(account?.note ?? ''),
    hasState: account?.hasState === true,
    hasSession: account?.hasSession === true,
    proxy: {
      bound: proxy.bound === true,
      // `server` is a host:port with no credentials by construction, but it is still passed through
      // `String()` so a non-string can never become an object in the response.
      server: proxy.server === null || proxy.server === undefined ? null : String(proxy.server),
      username: proxy.username === null || proxy.username === undefined ? null : String(proxy.username),
      hasPassword: proxy.hasPassword === true,
      expiresAt: proxy.expiresAt ?? null,
      source: proxy.source === null || proxy.source === undefined ? null : String(proxy.source),
    },
  };
}

/**
 * Build the account-management surface.
 *
 * @param {{ engine: any, dataDir?: string|null, log?: (line: string) => void }} input
 */
export function createAccountsHttp({ engine, dataDir = null, log = () => {} }) {
  if (!engine || typeof engine.call !== 'function') {
    // Same reasoning as the config surface: refuse at construction rather than answer 500 per request.
    throw new TypeError('createAccountsHttp needs an engine exposing call()');
  }

  /**
   * The stored sign-in of one account, read straight from disk.
   *
   * This is what makes "the login is kept" and "accounts are isolated" *observable* rather than promised:
   * each account owns its own file under its own directory, and the page shows that file's size and
   * modification time. Reading it needs no engine call, so it works even while the engine is busy.
   *
   * @param {string} code
   */
  function stateInfo(code) {
    if (!dataDir) return null;
    const file = join(dataDir, 'accounts', code, 'storage_state.json');
    try {
      if (!existsSync(file)) return { path: file, exists: false, bytes: 0, modifiedAt: null };
      const info = statSync(file);
      return {
        path: file,
        // Two bytes is an empty JSON object; the engine uses the same threshold for `hasState`.
        exists: info.size > 2,
        bytes: info.size,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
      };
    } catch (error) {
      return { path: file, exists: false, bytes: 0, modifiedAt: null, error: String(error?.message ?? error) };
    }
  }

  /**
   * Sign-ins that are waiting for a human, keyed by account code.
   *
   * A sign-in opens a headed browser and waits up to roughly ten minutes for someone to scan a code, so
   * the HTTP request that starts it must return immediately — the page polls {@link jobInfo} instead.
   */
  const loginJobs = new Map();

  /** Describe one sign-in job for the polling endpoint. */
  function jobInfo(code) {
    const job = loginJobs.get(code);
    if (!job) return { code, status: 'idle', startedAt: null, finishedAt: null, message: null };
    return {
      code,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
      message: job.message ?? null,
    };
  }

  /** Write one JSON response; the only place in this module that touches `res`. */
  function sendJson(res, status, payload) {
    let body;
    try {
      body = JSON.stringify(payload);
    } catch (error) {
      body = JSON.stringify({ ok: false, error: { code: HTTP_ERRORS.INTERNAL, message: `response was not serialisable: ${error?.message ?? error}` } });
      status = 500;
    }
    try {
      if (!res.headersSent) {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
          'cache-control': 'no-store',
        });
      }
      res.end(body);
    } catch {
      // The carrier destroys the socket when a handler writes after the headers went out; writing twice is
      // the only way to get here, and there is nothing useful left to do.
    }
  }

  /** A refusal body. */
  function fail(code, message, field) {
    return { ok: false, error: field ? { code, message, field } : { code, message } };
  }

  /**
   * Read a JSON body, capped and content-type gated.
   * @returns {Promise<{ ok: true, value: any } | { ok: false, status: number, body: any }>}
   */
  function readJsonBody(req) {
    const header = String(req.headers?.['content-type'] ?? '').toLowerCase();
    if (!header.startsWith('application/json')) {
      return Promise.resolve({
        ok: false,
        status: 415,
        body: fail(HTTP_ERRORS.CONTENT_TYPE, 'writes require content-type: application/json'),
      });
    }
    return new Promise((resolve) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        req.off?.('data', onData);
        req.off?.('end', onEnd);
        req.off?.('error', onError);
        resolve(result);
      };
      function onData(chunk) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          chunks.length = 0;
          resolve({ ok: false, status: 413, body: fail(HTTP_ERRORS.BODY_TOO_LARGE, `request body exceeds ${MAX_BODY_BYTES} bytes`) });
          return;
        }
        chunks.push(chunk);
      }
      function onEnd() {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) {
          finish({ ok: true, value: {} });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          finish({ ok: false, status: 400, body: fail(HTTP_ERRORS.BAD_JSON, `request body is not valid JSON: ${error.message}`) });
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish({ ok: false, status: 400, body: fail(HTTP_ERRORS.BAD_REQUEST, 'request body must be a JSON object') });
          return;
        }
        finish({ ok: true, value: parsed });
      }
      function onError(error) {
        finish({ ok: false, status: 400, body: fail(HTTP_ERRORS.BAD_REQUEST, `request stream failed: ${error.code ?? error.message}`) });
      }
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    });
  }

  /** Enforce the method, answering 405 with an `allow` header. */
  function methodOnly(allowed, handler) {
    return async (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase();
      if (!allowed.includes(method)) {
        if (!res.headersSent) res.setHeader('allow', allowed.join(', '));
        sendJson(res, 405, fail(HTTP_ERRORS.METHOD, `${method} is not allowed here; use ${allowed.join(' or ')}`));
        return;
      }
      await handler(req, res);
    };
  }

  /**
   * Map an engine failure onto an HTTP status, keeping the engine's own code visible.
   * @param {any} error
   */
  function engineFailure(error) {
    const code = String(error?.code ?? 'INTERNAL');
    const status = code === 'BAD_REQUEST' || code === 'PARAM_MISSING' ? 400
      : code === 'SESSION_NOT_FOUND' || code === 'TARGET_NOT_FOUND' ? 404
        : code === 'PROXY_UNAVAILABLE' || code === 'LOGIN_REQUIRED' ? 409
          : code === 'TIMEOUT' ? 504
            : 500;
    return { status, body: fail(code, String(error?.message ?? error), error?.details?.field) };
  }

  /** Reject unknown keys so a typo cannot be silently ignored. */
  function unknownKeys(body, allowed) {
    const extra = Object.keys(body).filter((key) => !allowed.includes(key));
    if (!extra.length) return null;
    return fail(HTTP_ERRORS.BAD_REQUEST, `unexpected ${extra.length === 1 ? 'key' : 'keys'}: ${extra.join(', ')}`, extra[0]);
  }

  /** Validate a code and return a message, or null when it is acceptable. */
  function codeComplaint(value) {
    if (typeof value !== 'string' || !value.trim()) return 'code is required';
    const code = value.trim();
    if (!CODE_PATTERN.test(code)) {
      return 'code must be 1-32 characters of letters, digits, dot, underscore or hyphen, and start with a letter or digit';
    }
    return null;
  }

  /** GET /accounts — the list, projected through the allow-list, plus each account's stored sign-in. */
  async function getAccounts(req, res) {
    const result = await engine.call('account.list', {});
    const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
    sendJson(res, 200, {
      ok: true,
      accounts: accounts.map((account) => {
        const code = String(account?.code ?? '');
        return { ...projectAccount(account), state: stateInfo(code) };
      }),
      media: ACCOUNT_MEDIA,
      count: accounts.length,
    });
  }

  /**
   * POST /accounts/login — start a sign-in and return at once.
   *
   * The engine's `account.login` does not resolve until the human has finished (it opens a headed window
   * and waits), so this deliberately does **not** await it. The page then polls GET with `?code=`.
   */
  async function postLogin(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, body.body);
      return;
    }
    const unknown = unknownKeys(body.value, ['code']);
    if (unknown) {
      sendJson(res, 400, unknown);
      return;
    }
    const complaint = codeComplaint(body.value.code);
    if (complaint) {
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, complaint, 'code'));
      return;
    }
    const code = String(body.value.code).trim();
    const existing = loginJobs.get(code);
    if (existing && existing.status === 'running') {
      sendJson(res, 409, fail(HTTP_ERRORS.BAD_REQUEST, `a sign-in for ${code} is already waiting for a human`));
      return;
    }
    const job = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, message: null };
    loginJobs.set(code, job);
    void engine.call('account.login', { code }, { timeoutMs: 660_000 })
      .then((result) => {
        job.status = 'done';
        job.message = String(result?.label ?? '');
      })
      .catch((error) => {
        job.status = 'failed';
        job.message = `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`;
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
      });
    log(`sign-in started for ${code}: a browser window is waiting for a human`);
    sendJson(res, 200, {
      ok: true,
      code,
      started: true,
      hint: 'A browser window is open — finish signing in there, then reload this list.',
    });
  }

  /** GET /accounts/login?code=… — poll one sign-in's outcome, with its stored-file state. */
  async function getLoginStatus(req, res) {
    const url = String(req.url ?? '');
    const query = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : new URLSearchParams();
    const code = query.get('code');
    if (code) {
      const complaint = codeComplaint(code);
      if (complaint) {
        sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, complaint, 'code'));
        return;
      }
      sendJson(res, 200, { ok: true, job: jobInfo(code), state: stateInfo(code) });
      return;
    }
    sendJson(res, 200, { ok: true, jobs: [...loginJobs.keys()].map(jobInfo) });
  }

  /**
   * POST /accounts/check — verify a stored sign-in still works.
   *
   * The engine's `account.checkLogin` reads the platform without rewriting `storage_state`, so checking
   * cannot damage a good login. It navigates, so it is slower than the other reads.
   */
  async function postCheck(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, body.body);
      return;
    }
    const unknown = unknownKeys(body.value, ['code']);
    if (unknown) {
      sendJson(res, 400, unknown);
      return;
    }
    const complaint = codeComplaint(body.value.code);
    if (complaint) {
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, complaint, 'code'));
      return;
    }
    const code = String(body.value.code).trim();
    try {
      const result = await engine.call('account.checkLogin', { code }, { timeoutMs: 180_000 });
      sendJson(res, 200, {
        ok: true,
        code,
        loggedIn: result?.loggedIn === true,
        status: result?.status ?? null,
        url: result?.url ?? null,
        title: result?.title ?? null,
        reasons: Array.isArray(result?.reasons) ? result.reasons : [],
        state: stateInfo(code),
      });
    } catch (error) {
      const failure = engineFailure(error);
      sendJson(res, failure.status, failure.body);
    }
  }

  /** POST /accounts — create or update one account. */
  async function postAccount(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, body.body);
      return;
    }
    const unknown = unknownKeys(body.value, ['code', 'media', 'account', 'note']);
    if (unknown) {
      sendJson(res, 400, unknown);
      return;
    }
    const complaint = codeComplaint(body.value.code);
    if (complaint) {
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, complaint, 'code'));
      return;
    }
    if (body.value.media !== undefined && !ACCOUNT_MEDIA.includes(String(body.value.media))) {
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, `media must be one of ${ACCOUNT_MEDIA.join(', ')}`, 'media'));
      return;
    }
    const code = String(body.value.code).trim();
    const params = {
      code,
      // An update that omits `media` keeps the existing one, so editing just the note cannot drop a platform.
      media: body.value.media === undefined ? undefined : String(body.value.media),
      account: body.value.account === undefined ? '' : String(body.value.account),
      note: body.value.note === undefined ? '' : String(body.value.note),
    };
    if (params.media === undefined) delete params.media;
    try {
      const result = await engine.call('account.upsert', params, { timeoutMs: 60_000 });
      log(`account upserted: ${code}`);
      sendJson(res, 200, {
        ok: true,
        code,
        account: result?.account ? projectAccount(result.account) : null,
        warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      });
    } catch (error) {
      // Omitting `media` is legitimate when UPDATING an account (the platform it already has is kept);
      // the engine refuses it only when CREATING one, with PARAM_MISSING 'media'. Sending that through
      // verbatim left the operator reading an engine message that said nothing about what to do, so it is
      // translated here. (An earlier attempt asked the engine twice, listing accounts first to guess
      // whether this was a create — that mis-fired whenever the listing did not include the account.)
      if (String(error?.code ?? '') === 'PARAM_MISSING' && /media/i.test(String(error?.message ?? ''))) {
        sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST,
          `media is required when creating a new account (choose one of ${ACCOUNT_MEDIA.join(', ')})`,
          'media'));
        return;
      }
      const failure = engineFailure(error);
      sendJson(res, failure.status, failure.body);
    }
  }

  /** POST /accounts/remove — remove one account, optionally purging its stored login. */
  async function postRemove(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, body.body);
      return;
    }
    const unknown = unknownKeys(body.value, ['code', 'purgeState']);
    if (unknown) {
      sendJson(res, 400, unknown);
      return;
    }
    const complaint = codeComplaint(body.value.code);
    if (complaint) {
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, complaint, 'code'));
      return;
    }
    if (body.value.purgeState !== undefined && typeof body.value.purgeState !== 'boolean') {
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, 'purgeState must be true or false', 'purgeState'));
      return;
    }
    const code = String(body.value.code).trim();
    try {
      const result = await engine.call('account.remove',
        { code, purgeState: body.value.purgeState === true }, { timeoutMs: 60_000 });
      log(`account removed: ${code}${body.value.purgeState === true ? ' (login state purged)' : ''}`);
      sendJson(res, 200, { ok: true, code, removed: true, purged: body.value.purgeState === true, result: result ?? null });
    } catch (error) {
      const failure = engineFailure(error);
      sendJson(res, failure.status, failure.body);
    }
  }

  /** POST /accounts/proxy — bind a fixed proxy to one account, or clear it with `proxy: null`. */
  async function postProxy(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, body.body);
      return;
    }
    const unknown = unknownKeys(body.value, ['code', 'proxy']);
    if (unknown) {
      sendJson(res, 400, unknown);
      return;
    }
    const complaint = codeComplaint(body.value.code);
    if (complaint) {
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, complaint, 'code'));
      return;
    }
    const code = String(body.value.code).trim();
    const input = body.value.proxy;
    /** @type {any} */
    let proxy = null;
    if (input !== null && input !== undefined) {
      if (typeof input !== 'object' || Array.isArray(input)) {
        sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, 'proxy must be an object or null', 'proxy'));
        return;
      }
      const extra = Object.keys(input).filter((key) => !['server', 'username', 'password'].includes(key));
      if (extra.length) {
        sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, `unexpected proxy key: ${extra.join(', ')}`, extra[0]));
        return;
      }
      if (typeof input.server !== 'string' || !input.server.trim()) {
        sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, 'proxy.server is required (e.g. http://host:port)', 'proxy.server'));
        return;
      }
      proxy = { server: input.server.trim() };
      if (input.username !== undefined && input.username !== null && String(input.username) !== '') {
        proxy.username = String(input.username);
      }
      // The password travels inward only. Nothing below this line ever returns it.
      if (input.password !== undefined && input.password !== null && String(input.password) !== '') {
        proxy.password = String(input.password);
      }
    }
    try {
      const result = await engine.call('account.bindProxy', { code, proxy }, { timeoutMs: 60_000 });
      log(`account proxy ${proxy ? 'bound' : 'cleared'}: ${code}`);
      sendJson(res, 200, {
        ok: true,
        code,
        bound: proxy !== null,
        account: result?.account ? projectAccount(result.account) : null,
      });
    } catch (error) {
      const failure = engineFailure(error);
      sendJson(res, failure.status, failure.body);
    }
  }

  /** POST /accounts/test-proxy — probe the proxy an account is bound to. */
  async function postTestProxy(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, body.body);
      return;
    }
    const unknown = unknownKeys(body.value, ['code']);
    if (unknown) {
      sendJson(res, 400, unknown);
      return;
    }
    const complaint = codeComplaint(body.value.code);
    if (complaint) {
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, complaint, 'code'));
      return;
    }
    const code = String(body.value.code).trim();
    try {
      const result = await engine.call('proxy.test', { code }, { timeoutMs: 120_000 });
      sendJson(res, 200, { ok: true, code, result: result ?? null });
    } catch (error) {
      // PROXY_UNAVAILABLE must stay itself: an unreachable proxy is not an expired login.
      const failure = engineFailure(error);
      sendJson(res, failure.status, failure.body);
    }
  }

  /** Wrap a handler so a throw becomes an explicit 500 instead of the carrier's opaque 400. */
  function guarded(name, handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        log(`accounts route ${name} failed: ${error?.stack ?? error}`);
        if (!res.headersSent) {
          sendJson(res, 500, fail(HTTP_ERRORS.INTERNAL, String(error?.message ?? error)));
        }
      }
    };
  }

  /** @type {Record<string, (req: any, res: any) => Promise<void>>} */
  const handlers = {
    [ACCOUNT_ROUTES.ACCOUNTS]: guarded('accounts', methodOnly(['GET', 'POST'], async (req, res) => {
      if (String(req.method).toUpperCase() === 'GET') await getAccounts(req, res);
      else await postAccount(req, res);
    })),
    [ACCOUNT_ROUTES.REMOVE]: guarded('accounts/remove', methodOnly(['POST'], postRemove)),
    [ACCOUNT_ROUTES.PROXY]: guarded('accounts/proxy', methodOnly(['POST'], postProxy)),
    [ACCOUNT_ROUTES.TEST_PROXY]: guarded('accounts/test-proxy', methodOnly(['POST'], postTestProxy)),
    [ACCOUNT_ROUTES.LOGIN]: guarded('accounts/login', methodOnly(['GET', 'POST'], async (req, res) => {
      if (String(req.method).toUpperCase() === 'GET') await getLoginStatus(req, res);
      else await postLogin(req, res);
    })),
    [ACCOUNT_ROUTES.CHECK]: guarded('accounts/check', methodOnly(['POST'], postCheck)),
  };

  return {
    handlers,
    routes: Object.entries(handlers).map(([path, handler]) => ({ kind: /** @type {const} */ ('exact'), path, handler })),
  };
}
