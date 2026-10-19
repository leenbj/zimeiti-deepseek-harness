/**
 * config-http.js — the plugin's own HTTP surface for its Settings → Plugins page.
 *
 * Why HTTP and not a Remote/typert method: the client half is a *dynamic* bundle, and the application's
 * Client-callable Remote capability set is fixed at build time by explicit `/remote` value imports
 * (`@deepseek-ai/dsh-api-remotes` README: "the Client does not discover the Host's active Services or
 * Remote definitions at runtime"). A profile-installed bundle therefore cannot add its own namespace
 * without importing a DSH package into the host half — which would break this package's zero-dependency
 * property and stop the whole entry from activating. A same-origin HTTP route on the host `webServer`
 * service needs only `ctx.get('webServer')` (a string lookup) and a plain `(req, res)` function, so the
 * property survives. See README §"设置页" for the whole argument.
 *
 * Threat model: this is a loopback HTTP surface reachable by anything that can reach the GUI port, and by
 * any page the browser is showing (a cross-origin `fetch` would need CORS, which we never grant, but a
 * form-post or a same-origin script is a real path). Therefore the handler is **safe by construction**:
 *
 *   - it reads and writes ONLY the five keys in `CONFIG_KEYS`; unknown keys are refused, never stored,
 *     and never reach the effective config, so no request can add a key the rest of the plugin would
 *     later trust;
 *   - it never returns a filesystem path, an account, a credential, or any part of the data directory's
 *     contents — only the five values plus version/label strings;
 *   - writes require `content-type: application/json` (a cross-origin HTML form cannot send it without
 *     CORS preflight, which is never answered), and the body is capped at `MAX_BODY_BYTES`;
 *   - responses are `no-store`, and read-only GETs never mutate anything.
 *
 * Zero external imports: only `node:*` builtins.
 *
 * @module media-publish/config-http
 */

import { CONFIG_KEYS } from './config.js';

/** Exact paths this module owns. Registered `kind: 'exact'` — see the README's HTTP-matching note. */
export const CONFIG_ROUTES = Object.freeze({
  /** GET → every field with its effective value; POST → write user-layer values. */
  CONFIG: '/media-publish/config',
  /** POST → drop the user-layer override for the named fields. */
  RESET: '/media-publish/config/reset',
  /** GET → a deliberately cheap, path-free status block. Never starts the engine. */
  STATUS: '/media-publish/status',
});

/** Hard cap on a request body. A config write is a handful of scalars; anything larger is an attack. */
export const MAX_BODY_BYTES = 16 * 1024;

/** Refusal codes; the page shows `message`, tests assert `code`. */
export const HTTP_ERRORS = Object.freeze({
  METHOD: 'METHOD_NOT_ALLOWED',
  CONTENT_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  BAD_JSON: 'BAD_JSON',
  BAD_REQUEST: 'BAD_REQUEST',
  STALE: 'STALE_REVISION',
  INTERNAL: 'INTERNAL',
});

/**
 * Write one JSON response. Deliberately the only place in this module that touches `res`, and it refuses
 * to write twice: `@deepseek-ai/dsh-host-webserver` destroys the socket when a handler writes after the
 * headers are out, and a double write is exactly how that happens.
 *
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
    body = Buffer.from('{"ok":false,"error":{"code":"INTERNAL","message":"response could not be encoded"}}', 'utf8');
    status = 500;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Build a failure body.
 * @param {string} code
 * @param {string} message
 * @param {string} [field]
 */
function fail(code, message, field) {
  return { ok: false, error: { code, message, ...(field === undefined ? {} : { field }) } };
}

/**
 * Read and parse a JSON request body, honouring the size cap and the content-type requirement.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<{ ok: true, value: Record<string, unknown> }|{ ok: false, status: number, body: any }>}
 */
function readJsonBody(req, res) {
  const header = String(req.headers?.['content-type'] ?? '').toLowerCase();
  if (!header.startsWith('application/json')) {
    // Drain nothing and answer immediately: the body is untouched by design.
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
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(result);
    };
    function onData(/** @type {Buffer} */ chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        // Answer, then tear the socket down once the response has flushed, so a client streaming an
        // unbounded body cannot keep this handler buffering.
        res.once('finish', () => {
          try { req.destroy(); } catch { /* already gone */ }
        });
        finish({ ok: false, status: 413, body: fail(HTTP_ERRORS.BODY_TOO_LARGE, `request body exceeds ${MAX_BODY_BYTES} bytes`) });
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

/**
 * Reject a write body that carries a key other than the ones it is allowed to carry, so a typo or a
 * probe cannot be silently ignored.
 * @param {Record<string, unknown>} body
 * @param {string[]} allowed
 */
function rejectUnknownBodyKeys(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      return fail(HTTP_ERRORS.BAD_REQUEST, `request body carries unknown key "${key}" (allowed: ${allowed.join(', ')})`, key);
    }
  }
  return null;
}

/**
 * Build the route table this plugin registers on the host `webServer`.
 *
 * `status` is a thunk supplied by the plugin: it must stay cheap and path-free (no engine call, no
 * directory listing), because the page calls it on every open.
 *
 * @param {{ store: any, status: () => Record<string, unknown>, log?: (line: string) => void }} input
 * @returns {{ routes: Array<{ kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void> }>,
 *             handlers: Record<string, (req: any, res: any) => Promise<void>> }}
 */
export function createConfigHttp({ store, status, log = () => {} }) {
  // Refuse to build the surface at all when the store is missing or shapeless. This is deliberate: the
  // caller once passed its store under a different property name (`configStore`), so `store` was
  // `undefined` and every handler threw on its first statement — the guard turned that into an opaque
  // **500 per request** and the real cause (a one-word mismatch) was invisible. Failing here instead makes
  // that mistake impossible to ship silently, because registration never succeeds and the log says why.
  const REQUIRED_STORE_METHODS = ['fields', 'revision', 'set', 'reset', 'warnings'];
  const missing = REQUIRED_STORE_METHODS.filter((name) => typeof store?.[name] !== 'function');
  if (missing.length) {
    throw new TypeError(
      `createConfigHttp needs a config store exposing ${REQUIRED_STORE_METHODS.join(', ')}; missing ${missing.join(', ')}`,
    );
  }

  /** GET /media-publish/config — the field list the page renders. */
  async function getConfig(req, res) {
    sendJson(res, 200, {
      ok: true,
      revision: store.revision(),
      fields: store.fields(),
      warnings: store.warnings(),
      applied: false,
    });
  }

  /** POST /media-publish/config — validate, persist, report the fields back so the page can re-render. */
  async function postConfig(req, res) {
    const body = await readJsonBody(req, res);
    if (!body.ok) {
      sendJson(res, body.status, body.body);
      return;
    }
    const unknown = rejectUnknownBodyKeys(body.value, ['values', 'revision']);
    if (unknown) {
      sendJson(res, 400, unknown);
      return;
    }
    const { values, revision } = body.value;
    if (values === undefined || values === null || typeof values !== 'object' || Array.isArray(values)) {
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, 'the body must be {"values": {<field>: <value>, ...}}'));
      return;
    }
    if (revision !== undefined) {
      if (!Number.isInteger(revision)) {
        sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, 'revision must be an integer when present', 'revision'));
        return;
      }
      if (revision !== store.revision()) {
        // Stale write: another page (or the agent) changed the file since this page read it. Refuse and
        // hand back the current state rather than silently clobbering the other writer.
        sendJson(res, 409, {
          ...fail(HTTP_ERRORS.STALE, `revision ${revision} is stale; the current revision is ${store.revision()}`),
          revision: store.revision(),
          fields: store.fields(),
        });
        return;
      }
    }
    const result = store.set(values);
    if (!result.ok) {
      sendJson(res, 400, { ...fail(HTTP_ERRORS.BAD_REQUEST, result.message, result.field), fields: store.fields() });
      return;
    }
    log(`config write accepted: ${result.changed.join(', ') || 'no field changed'} (revision ${result.revision})`);
    sendJson(res, 200, {
      ok: true,
      revision: result.revision,
      changed: result.changed,
      applied: true,
      fields: store.fields(),
      warnings: store.warnings(),
    });
  }

  /** POST /media-publish/config/reset — drop the user-layer override for the named fields. */
  async function postReset(req, res) {
    const body = await readJsonBody(req, res);
    if (!body.ok) {
      sendJson(res, body.status, body.body);
      return;
    }
    const unknown = rejectUnknownBodyKeys(body.value, ['names', 'revision']);
    if (unknown) {
      sendJson(res, 400, unknown);
      return;
    }
    const { names, revision } = body.value;
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, 'the body must be {"names": ["<field>", ...]}', 'names'));
      return;
    }
    if (names.some((name) => !CONFIG_KEYS.includes(name))) {
      const bad = names.find((name) => !CONFIG_KEYS.includes(name));
      sendJson(res, 400, fail(HTTP_ERRORS.BAD_REQUEST, `unknown configuration field "${String(bad)}"`, String(bad)));
      return;
    }
    if (revision !== undefined && revision !== store.revision()) {
      sendJson(res, 409, {
        ...fail(HTTP_ERRORS.STALE, `revision ${revision} is stale; the current revision is ${store.revision()}`),
        revision: store.revision(),
        fields: store.fields(),
      });
      return;
    }
    const result = store.reset(names);
    if (!result.ok) {
      sendJson(res, 400, { ...fail(HTTP_ERRORS.BAD_REQUEST, result.message, result.field), fields: store.fields() });
      return;
    }
    log(`config reset accepted: ${result.changed.join(', ') || 'nothing was overridden'} (revision ${result.revision})`);
    sendJson(res, 200, {
      ok: true,
      revision: result.revision,
      changed: result.changed,
      applied: true,
      fields: store.fields(),
      warnings: store.warnings(),
    });
  }

  /** GET /media-publish/status — cheap, path-free, never starts the engine. */
  async function getStatus(req, res) {
    let extra;
    try {
      extra = status();
    } catch (error) {
      extra = { error: String(error?.message ?? error) };
    }
    sendJson(res, 200, { ok: true, revision: store.revision(), status: extra ?? {}, warnings: store.warnings() });
  }

  /**
   * Wrap a handler so nothing escapes into the web server. An uncaught throw would be answered as an
   * opaque 400 by the carrier, which would hide a real bug; here it becomes an explicit 500 with a
   * generic message (no internals leak) and one log line.
   */
  function guarded(name, handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        log(`config route ${name} threw: ${error?.stack ?? error}`);
        sendJson(res, 500, fail(HTTP_ERRORS.INTERNAL, 'the plugin could not handle this request; see the plugin log'));
      }
    };
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

  /** @type {Record<string, (req: any, res: any) => Promise<void>>} */
  const handlers = {
    [CONFIG_ROUTES.CONFIG]: guarded('config', methodOnly(['GET', 'POST'], async (req, res) => {
      if (String(req.method).toUpperCase() === 'GET') await getConfig(req, res);
      else await postConfig(req, res);
    })),
    [CONFIG_ROUTES.RESET]: guarded('config/reset', methodOnly(['POST'], postReset)),
    [CONFIG_ROUTES.STATUS]: guarded('status', methodOnly(['GET'], getStatus)),
  };

  return {
    handlers,
    routes: Object.entries(handlers).map(([path, handler]) => ({ kind: /** @type {const} */ ('exact'), path, handler })),
  };
}
