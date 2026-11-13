/**
 * cdp.js — a minimal, dependency-free Chrome DevTools Protocol client and page facade.
 *
 * ego lite is a Chromium fork. Instead of driving it through the `ego-browser` CLI (which only ever
 * talks to the single running app instance), this plugin starts one ego browser per account with its
 * own `--user-data-dir` and `--proxy-server`, then talks to that instance over CDP. That is what makes
 * account isolation and a per-account exit IP real rather than cosmetic: separate profile directories
 * own separate cookie jars, and the proxy is a launch argument of that instance alone.
 *
 * Only node: builtins are used. Node's global `WebSocket` carries the protocol frames.
 *
 * @module ego-publish/cdp
 */

/** An error carrying a stable code the tool layer can surface. */
export class EgoError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, any>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EgoError';
    this.code = code;
    this.details = details;
  }
}

/**
 * GET a JSON document with a short timeout.
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
export async function getJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the OS for a free loopback TCP port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    // Lazy import keeps this module usable in a plain Node test without side effects.
    import('node:net').then(({ createServer }) => {
      const server = createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() => (port ? resolve(port) : reject(new Error('could not allocate a port'))));
      });
    }, reject);
  });
}

/** Sleep helper. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A tiny event emitter. */
class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      try {
        handler(payload);
      } catch {
        /* listeners must never break the protocol loop */
      }
    }
  }
}

/**
 * One CDP connection to a browser target (the browser-level WebSocket).
 */
export class CdpConnection extends Emitter {
  /**
   * @param {WebSocket} socket
   */
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: any, method: string}>} */
    this.pending = new Map();
    this.closed = false;
    this.lastError = null;
    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new EgoError('CDP_CLOSED', `the browser connection closed while waiting for ${entry.method}`, {
          lastError: this.lastError,
        }));
      }
      this.pending.clear();
      this.emit('close', {});
    });
    socket.addEventListener('error', () => {
      this.lastError = 'websocket error';
    });
  }

  /**
   * Connect to a browser-level WebSocket URL.
   * @param {string} wsUrl
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<CdpConnection>}
   */
  static async connect(wsUrl, options = {}) {
    if (typeof WebSocket !== 'function') {
      throw new EgoError('NO_WEBSOCKET', 'this Node.js runtime has no global WebSocket; ego-publish needs Node 22 or newer');
    }
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new EgoError('CDP_CONNECT_TIMEOUT', 'timed out connecting to the browser CDP socket')), options.timeoutMs ?? 15000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(undefined);
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new EgoError('CDP_CONNECT_FAILED', `cannot open the browser CDP socket at ${wsUrl}`));
      }, { once: true });
    });
    return new CdpConnection(socket);
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new EgoError('CDP_ERROR', `${entry.method}: ${message.error.message ?? 'protocol error'}`, {
          cdpCode: message.error.code,
          data: message.error.data,
        }));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      this.emit(message.method, { params: message.params ?? {}, sessionId: message.sessionId ?? null });
      this.emit('*', message);
    }
  }

  /**
   * Send one protocol command.
   * @param {string} method
   * @param {Record<string, any>} [params]
   * @param {string} [sessionId]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId, options = {}) {
    if (this.closed) return Promise.reject(new EgoError('CDP_CLOSED', 'the browser connection is closed'));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? 30000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EgoError('CDP_TIMEOUT', `${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new EgoError('CDP_SEND_FAILED', `${method}: ${error?.message ?? error}`));
      }
    });
  }

  /**
   * Wait for one protocol event.
   * @param {string} method
   * @param {{ sessionId?: string, timeoutMs?: number, predicate?: (params: any) => boolean }} [options]
   * @returns {Promise<any>}
   */
  waitForEvent(method, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new EgoError('CDP_EVENT_TIMEOUT', `did not observe ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.on(method, ({ params, sessionId }) => {
        if (options.sessionId && sessionId !== options.sessionId) return;
        if (options.predicate && !options.predicate(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      if (this.closed) {
        clearTimeout(timer);
        off();
        reject(new EgoError('CDP_CLOSED', `the browser connection closed before ${method}`));
      }
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * In-page helper source. It is prepended to every evaluated expression, so each call is self-contained
 * and the page is not polluted with globals.
 */
const PAGE_HELPERS = String.raw`
var __ego = (function () {
  function visible(el) {
    if (!el || !el.isConnected) return false;
    var style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number(style.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function docs() {
    var out = [document];
    (function walk(doc, depth) {
      if (depth > 4) return;
      var frames = doc.querySelectorAll('iframe,frame');
      for (var i = 0; i < frames.length; i++) {
        try {
          var inner = frames[i].contentDocument;
          if (inner) { out.push(inner); walk(inner, depth + 1); }
        } catch (e) { /* cross-origin frame: not reachable from here */ }
      }
    })(document, 0);
    return out;
  }
  function pageRect(el) {
    var r = el.getBoundingClientRect();
    var box = { x: r.left, y: r.top, w: r.width, h: r.height };
    var win = el.ownerDocument.defaultView;
    while (win && win.frameElement) {
      var fr = win.frameElement.getBoundingClientRect();
      box.x += fr.left; box.y += fr.top;
      win = win.parent;
    }
    return box;
  }
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + String(el.id).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var index = 1;
      for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === node.tagName) index++;
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      node = parent;
    }
    return parts.join(' > ');
  }
  function ownText(el) {
    var out = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var child = el.childNodes[i];
      if (child.nodeType === 3) out += child.nodeValue;
      else if (child.nodeType === 1) out += ' ';
    }
    return out.replace(/\s+/g, ' ').trim();
  }
  function kind(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      return type === 'checkbox' || type === 'radio' ? type : 'input';
    }
    if (tag === 'textarea') return 'textarea';
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return 'contenteditable';
    return tag;
  }
  function describe(el, how) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var box = pageRect(el);
    return {
      found: true,
      via: how,
      tag: el.tagName.toLowerCase(),
      kind: kind(el),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      selector: cssPath(el),
      rect: box
    };
  }
  function find(cfg) {
    var list = docs();
    cfg = cfg || {};
    if (cfg.frame) {
      var frameDoc = docOfFrame(cfg.frame);
      if (!frameDoc) return { found: false, reason: 'frame not reachable: ' + cfg.frame };
      list = [frameDoc];
    }
    if (cfg.selector) {
      for (var d = 0; d < list.length; d++) {
        var nodes;
        try { nodes = list[d].querySelectorAll(cfg.selector); } catch (e) { return { found: false, reason: 'invalid selector: ' + cfg.selector }; }
        if (!nodes.length) continue;
        var chosen = null;
        for (var n = 0; n < nodes.length; n++) { if (visible(nodes[n])) { chosen = nodes[n]; break; } }
        return describe(chosen || nodes[0], 'selector');
      }
      return { found: false, reason: 'selector matched nothing: ' + cfg.selector };
    }
    if (cfg.text) {
      var want = String(cfg.text);
      var lower = want.toLowerCase();
      var candidates = [];
      for (var di = 0; di < list.length; di++) {
        var all = list[di].querySelectorAll('button,a,label,li,span,div,p,input,textarea,[role],[contenteditable="true"]');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (!visible(el)) continue;
          var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 160) continue;
          var own = ownText(el);
          var hit = cfg.exact ? (text === want || own === want) : (text.toLowerCase().indexOf(lower) >= 0);
          if (!hit) continue;
          var rect = el.getBoundingClientRect();
          var interactive = /^(button|a|label|input|textarea|select)$/.test(el.tagName.toLowerCase()) || el.getAttribute('role');
          candidates.push({ el: el, own: own === want, area: rect.width * rect.height, interactive: interactive ? 1 : 0, exact: text === want ? 1 : 0 });
        }
      }
      candidates.sort(function (a, b) {
        return (b.own - a.own) || (b.exact - a.exact) || (b.interactive - a.interactive) || (a.area - b.area);
      });
      if (candidates.length) return describe(candidates[0].el, 'text');
      return { found: false, reason: 'no visible element contains the text: ' + want };
    }
    return { found: false, reason: 'no selector or text given' };
  }
  function interactive() {
    var list = docs();
    var out = [];
    var seen = {};
    for (var d = 0; d < list.length; d++) {
      var nodes = list[d].querySelectorAll('a,button,input,textarea,select,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[contenteditable="true"]');
      for (var i = 0; i < nodes.length && out.length < 120; i++) {
        var el = nodes[i];
        if (!visible(el)) continue;
        var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        var name = text || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || '';
        if (!name) continue;
        if (name.length > 80) name = name.slice(0, 80);
        var key = el.tagName + '|' + name + '|' + Math.round(el.getBoundingClientRect().top);
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({
          tag: el.tagName.toLowerCase(),
          kind: kind(el),
          text: name,
          selector: cssPath(el),
          rect: pageRect(el)
        });
      }
    }
    return out;
  }
  function query(selector) {
    var list = docs();
    for (var i = 0; i < list.length; i++) {
      try {
        var el = list[i].querySelector(selector);
        if (el) return el;
      } catch (e) { /* invalid selector in this document */ }
    }
    return null;
  }
  function docOfFrame(frameSelector) {
    var frame = query(frameSelector);
    if (!frame) return null;
    try {
      var win = frame.contentWindow;
      return (frame.contentDocument || (win && win.document)) || null;
    } catch (e) {
      return null;
    }
  }
  return { find: find, interactive: interactive, docs: docs, query: query, frameDoc: docOfFrame };
})();
`;

/**
 * A page (target) session: every method runs against one attached tab.
 */
export class TargetSession {
  /**
   * @param {CdpConnection} connection
   * @param {string} targetId
   * @param {string} sessionId
   * @param {{ actionTimeoutMs?: number, navigationTimeoutMs?: number }} [options]
   */
  constructor(connection, targetId, sessionId, options = {}) {
    this.connection = connection;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.actionTimeoutMs = options.actionTimeoutMs ?? 15000;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 60000;
    this.lastRefs = [];
  }

  send(method, params = {}, options = {}) {
    return this.connection.send(method, params, this.sessionId, options);
  }

  /**
   * Evaluate an expression in the page, optionally with a JSON argument.
   * @param {string | ((arg: any) => any)} expressionOrFn
   * @param {unknown} [argument]
   * @param {{ awaitPromise?: boolean, timeoutMs?: number }} [options]
   * @returns {Promise<any>}
   */
  async evaluate(expressionOrFn, argument, options = {}) {
    const text = typeof expressionOrFn === 'function' ? `(${expressionOrFn.toString()})` : String(expressionOrFn);
    const source = argument === undefined
      ? `${PAGE_HELPERS}\n;${text}`
      : `${PAGE_HELPERS}\n;(${text})(${JSON.stringify(argument)})`;
    const result = await this.send('Runtime.evaluate', {
      expression: source,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: true,
      userGesture: true,
    }, { timeoutMs: options.timeoutMs ?? this.actionTimeoutMs });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text ?? 'unknown page exception';
      throw new EgoError('EVAL_FAILED', `page evaluation failed: ${detail}`, { expression: text.slice(0, 300) });
    }
    return result.result?.value;
  }

  /** Current URL. */
  async url() {
    return this.evaluate('location.href');
  }

  /** Current title. */
  async title() {
    return this.evaluate('document.title');
  }

  /** Body text, trimmed. */
  async text(limit = 4000) {
    const value = await this.evaluate(`(document.body && document.body.innerText || '').slice(0, ${Number(limit) || 4000})`);
    return String(value ?? '');
  }

  /**
   * Resolve a target descriptor to an element record.
   * @param {{ selector?: string, text?: string, exact?: boolean }} target
   */
  async find(target) {
    const cfg = {
      selector: target?.selector,
      text: target?.text,
      exact: target?.exact === true,
      frame: target?.frame,
    };
    const record = await this.evaluate(`__ego.find(${JSON.stringify(cfg)})`);
    if (!record || !record.found) {
      throw new EgoError('TARGET_NOT_FOUND', String(record?.reason ?? 'target not found'), { target: cfg });
    }
    return record;
  }

  /**
   * Focus a field without changing its value.
   * @param {{ selector?: string, text?: string, frame?: string }} target
   */
  async focus(target) {
    const cfg = { selector: target?.selector, text: target?.text, exact: target?.exact === true, frame: target?.frame };
    const result = await this.evaluate((descriptor) => {
      const found = __ego.find(descriptor);
      if (!found.found) return { ok: false, reason: found.reason };
      const scope = descriptor.frame ? __ego.frameDoc(descriptor.frame) : null;
      const el = scope ? scope.querySelector(found.selector) : __ego.query(found.selector);
      if (!el) return { ok: false, reason: 'element disappeared' };
      el.focus();
      return { ok: true, selector: found.selector, kind: found.kind };
    }, cfg);
    if (!result?.ok) throw new EgoError('TARGET_NOT_FOUND', result?.reason ?? 'could not focus the field', { target: cfg });
    return result;
  }

  /**
   * Navigate and wait until the document is complete (plus an optional settle delay).
   * @param {string} url
   * @param {{ timeoutMs?: number, settleMs?: number, waitUntil?: 'commit'|'domcontentloaded'|'load' }} [options]
   */
  async goto(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.navigationTimeoutMs;
    const result = await this.send('Page.navigate', { url }, { timeoutMs });
    if (result.errorText) {
      throw new EgoError('NAV_FAILED', `navigation to ${url} failed: ${result.errorText}`, { url, errorText: result.errorText });
    }
    await this.waitForLoadState(options.waitUntil ?? 'load', { timeoutMs });
    if (options.settleMs) await sleep(options.settleMs);
    return { url: await this.url().catch(() => url), frameId: result.frameId ?? null };
  }

  /**
   * Wait until document.readyState reaches a state.
   * @param {'commit'|'domcontentloaded'|'load'} state
   */
  async waitForLoadState(state = 'load', options = {}) {
    const wanted = state === 'commit' ? 'interactive' : state === 'domcontentloaded' ? 'interactive' : 'complete';
    const deadline = Date.now() + (options.timeoutMs ?? this.navigationTimeoutMs);
    while (Date.now() < deadline) {
      try {
        const ready = await this.evaluate('document.readyState', undefined, { timeoutMs: 2000 });
        if (wanted === 'interactive' ? ready !== 'loading' : ready === 'complete') return true;
      } catch {
        /* the document may be mid-navigation; retry */
      }
      await sleep(200);
    }
    throw new EgoError('LOAD_TIMEOUT', `the page did not reach readyState ${wanted} in time`, { state });
  }

  /**
   * Poll a condition until it holds.
   * @param {{ selector?: string, text?: string, urlContains?: string, expression?: string }} check
   * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
   * @returns {Promise<{ matched: boolean, detail?: any }>}
   */
  async waitFor(check, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.actionTimeoutMs;
    const intervalMs = options.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        if (check.urlContains !== undefined) {
          const url = await this.url();
          if (String(url).includes(String(check.urlContains))) return { matched: true, value: url };
          last = `url is ${url}`;
        } else if (check.selector !== undefined) {
          const found = await this.evaluate(`__ego.find(${JSON.stringify({ selector: check.selector })}).found`);
          if (found) return { matched: true };
          last = `selector not present: ${check.selector}`;
        } else if (check.text !== undefined) {
          const found = await this.evaluate(`__ego.find(${JSON.stringify({ text: check.text })}).found`);
          if (found) return { matched: true };
          last = `text not present: ${check.text}`;
        } else if (check.expression !== undefined) {
          const value = await this.evaluate(check.expression);
          if (value) return { matched: true, value };
          last = `expression is falsy: ${check.expression}`;
        } else {
          throw new EgoError('INVALID_CHECK', 'waitFor needs one of urlContains, selector, text or expression');
        }
      } catch (error) {
        if (error instanceof EgoError && ['INVALID_CHECK', 'EVAL_FAILED'].includes(error.code)) throw error;
        last = error?.message ?? String(error);
      }
      await sleep(intervalMs);
    }
    throw new EgoError('WAIT_TIMEOUT', `condition not met within ${timeoutMs}ms${last ? ` (${last})` : ''}`, { check, timeoutMs });
  }

  /**
   * Click an element with real mouse input at its page coordinates.
   * @param {{ selector?: string, text?: string, exact?: boolean }} target
   * @param {{ timeoutMs?: number, button?: 'left'|'right'|'middle', clickCount?: number, force?: boolean }} [options]
   */
  async click(target, options = {}) {
    const record = await this.#withWait(target, options.timeoutMs ?? this.actionTimeoutMs);
    const rect = record.rect;
    const x = Math.round(rect.x + rect.w / 2);
    const y = Math.round(rect.y + rect.h / 2);
    const button = options.button ?? 'left';
    const clickCount = options.clickCount ?? 1;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, { timeoutMs: 5000 });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, clickCount, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4,
    }, { timeoutMs: 5000 });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, clickCount,
    }, { timeoutMs: 5000 });
    return { clicked: record.selector || record.text, x, y, kind: record.kind };
  }

  /**
   * Focus a field and replace its contents with `value`.
   * @param {{ selector?: string, text?: string }} target
   * @param {string} value
   * @param {{ timeoutMs?: number, mode?: 'fill'|'type'|'paste', minDelayMs?: number, maxDelayMs?: number }} [options]
   */
  async fill(target, value, options = {}) {
    await this.#withWait(target, options.timeoutMs ?? this.actionTimeoutMs);
    const cfg = { selector: target?.selector, text: target?.text, exact: target?.exact === true, frame: target?.frame };
    const focused = await this.evaluate((descriptor) => {
      const found = __ego.find(descriptor);
      if (!found.found) return { ok: false, reason: found.reason };
      const scope = descriptor.frame ? __ego.frameDoc(descriptor.frame) : null;
      const el = scope ? scope.querySelector(found.selector) : __ego.query(found.selector);
      if (!el) return { ok: false, reason: 'element disappeared' };
      el.focus();
      if (el.isContentEditable) {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        const selection = el.ownerDocument.defaultView.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else if (typeof el.select === 'function') {
        el.select();
      }
      return { ok: true, kind: found.kind, selector: found.selector };
    }, cfg);
    if (!focused?.ok) throw new EgoError('TARGET_NOT_FOUND', focused?.reason ?? 'could not focus the field', { target });
    const record = { selector: focused.selector, kind: focused.kind, text: target.text, frame: cfg.frame };
    const mode = options.mode ?? 'fill';
    if (mode === 'type') {
      // A human paints a title key by key; the jitter is what a keystroke timeline looks like.
      await this.typeChars(String(value), options);
    } else if (mode === 'paste') {
      // Real users copy the body and paste it, so fire a genuine paste event and only fall back to an
      // atomic insert when the editor ignores synthetic clipboard data.
      await this.pasteInto(record, String(value));
    } else if (focused.kind === 'contenteditable') {
      // Rich-text editors (Quill, ProseMirror, CKEditor) expect real key input paragraph by paragraph;
      // a single insertText with embedded newlines is silently flattened by several of them.
      await this.typeText(String(value));
    } else {
      await this.send('Input.insertText', { text: String(value) }, { timeoutMs: this.actionTimeoutMs });
    }
    const verified = await this.evaluate((descriptor) => {
      const scope = descriptor.frame ? __ego.frameDoc(descriptor.frame) : null;
      const el = scope ? scope.querySelector(descriptor.selector) : __ego.query(descriptor.selector);
      if (!el) return { ok: false };
      const actual = el.isContentEditable ? el.innerText : el.value;
      return { ok: true, value: String(actual == null ? '' : actual) };
    }, { selector: record.selector, frame: record.frame });
    if (verified?.ok && !String(verified.value).includes(String(value).slice(0, Math.min(24, String(value).length)))) {
      // Some frameworks ignore insertText; fall back to the native setter + input/change events.
      await this.evaluate(({ descriptor, text }) => {
        const found = __ego.find(descriptor);
        if (!found.found) return false;
        const scope = descriptor.frame ? __ego.frameDoc(descriptor.frame) : null;
        const el = scope ? scope.querySelector(descriptor.selector) : __ego.query(descriptor.selector);
        if (!el) return false;
        if (el.isContentEditable) {
          el.textContent = text;
        } else {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(el, text);
          else el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return true;
      }, { descriptor: { selector: record.selector, frame: record.frame }, text: String(value) });
    }
    return { filled: record.selector || record.text, kind: record.kind, length: String(value).length };
  }

  /**
   * Type text with real key input; newlines become Enter presses.
   * @param {string} text
   * @param {{ delayMs?: number }} [options]
   */
  async typeText(text, options = {}) {
    const lines = String(text).split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]) await this.send('Input.insertText', { text: lines[index] }, { timeoutMs: this.actionTimeoutMs });
      if (index < lines.length - 1) await this.press('Enter');
      if (options.delayMs) await sleep(options.delayMs);
    }
    return { typed: String(text).length };
  }

  /**
   * Type one character at a time with jittered pauses, which is what a keyboard timeline looks like.
   * @param {string} text
   * @param {{ minDelayMs?: number, maxDelayMs?: number }} [options]
   */
  async typeChars(text, options = {}) {
    const chars = Array.from(String(text));
    const min = Math.max(0, Number(options.minDelayMs ?? 45));
    const max = Math.max(min, Number(options.maxDelayMs ?? 140));
    const started = Date.now();
    for (const ch of chars) {
      if (ch === '\n') {
        await this.press('Enter');
      } else {
        await this.send('Input.insertText', { text: ch }, { timeoutMs: this.actionTimeoutMs });
      }
      await sleep(min + Math.floor(Math.random() * (max - min + 1)));
    }
    return { typed: chars.length, mode: 'type', ms: Date.now() - started };
  }

  /**
   * Insert a block of text the way a paste lands: in one instant, one block per blank-line-separated
   * paragraph.
   *
   * A synthetic `ClipboardEvent` is deliberately NOT used. Quill (the Sohu editor) accepts it but
   * flattens the whole payload into a single `<p>` with `<br>` line breaks, which changes the article
   * structure; a real clipboard paste cannot be produced from page script at all. Inserting paragraph
   * by paragraph keeps real paragraph nodes and is still instantaneous, so the result is what a paste
   * looks like to the platform — without the structural damage.
   *
   * @param {{ selector: string, frame?: string }} record
   * @param {string} value
   */
  async pasteInto(record, value) {
    const paragraphs = String(value).split(/\n{2,}/);
    for (let index = 0; index < paragraphs.length; index += 1) {
      if (index > 0) await this.press('Enter');
      const text = paragraphs[index].replace(/\n/g, ' ').trim();
      if (text) await this.send('Input.insertText', { text }, { timeoutMs: this.actionTimeoutMs });
    }
    return { pasted: true, paragraphs: paragraphs.length };
  }

  /**
   * Press a key or a `+`-joined chord (e.g. Enter, Tab, Control+A).
   * @param {string} chord
   */
  async press(chord) {
    const parts = String(chord).split('+').map((part) => part.trim()).filter(Boolean);
    const keyName = parts.pop() ?? 'Enter';
    const modifiers = parts.reduce((mask, part) => {
      const name = part.toLowerCase();
      if (name === 'alt') return mask | 1;
      if (name === 'control' || name === 'ctrl') return mask | 2;
      if (name === 'meta' || name === 'cmd' || name === 'command') return mask | 4;
      if (name === 'shift') return mask | 8;
      return mask;
    }, 0);
    const key = keyFor(keyName);
    const base = { modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, { timeoutMs: 5000 });
    if (key.text && modifiers === 0) {
      await this.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: key.text, unmodifiedText: key.text }, { timeoutMs: 5000 });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, { timeoutMs: 5000 });
    return { pressed: chord };
  }

  /**
   * Scroll the page.
   * @param {{ deltaY?: number, deltaX?: number }} [options]
   */
  async scroll(options = {}) {
    const deltaY = options.deltaY ?? 600;
    const deltaX = options.deltaX ?? 0;
    const viewport = await this.evaluate('({ w: innerWidth, h: innerHeight })');
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round((viewport?.w ?? 800) / 2),
      y: Math.round((viewport?.h ?? 600) / 2),
      deltaX,
      deltaY,
    }, { timeoutMs: 10000 });
    await sleep(250);
    return { scrolled: deltaY };
  }

  /**
   * Select an option by value, label or index.
   * @param {{ selector?: string, text?: string }} target
   * @param {string | number} value
   */
  async selectOption(target, value) {
    const record = await this.find(target);
    const outcome = await this.evaluate(({ descriptor, value }) => {
      const scope = descriptor.frame ? __ego.frameDoc(descriptor.frame) : null;
      const el = scope ? scope.querySelector(descriptor.selector) : __ego.query(descriptor.selector);
      if (!el) return { ok: false, reason: 'select disappeared' };
      const options = [...el.options];
      let chosen = null;
      if (typeof value === 'number') chosen = options[value] ?? null;
      else chosen = options.find((option) => option.value === value) || options.find((option) => option.textContent?.trim() === value) || null;
      if (!chosen) return { ok: false, reason: 'no matching option' };
      el.value = chosen.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: chosen.value, label: chosen.textContent?.trim() };
    }, { descriptor: { selector: record.selector, frame: target?.frame }, value });
    if (!outcome?.ok) throw new EgoError('SELECT_FAILED', outcome?.reason ?? 'could not select the option', { target, value });
    return outcome;
  }

  /**
   * Set files on an <input type=file>.
   * @param {{ selector?: string }} target
   * @param {string | string[]} files absolute paths
   */
  async upload(target, files) {
    const record = await this.find(target);
    const document = await this.send('DOM.getDocument', { depth: -1 });
    let nodeId = 0;
    try {
      const found = await this.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: record.selector });
      nodeId = found.nodeId;
    } catch {
      nodeId = 0;
    }
    if (!nodeId) {
      // Falling back to the element's own node through Runtime is not possible; report clearly.
      throw new EgoError('UPLOAD_UNSUPPORTED', 'could not resolve the file input through the DOM domain', { selector: record.selector });
    }
    const list = Array.isArray(files) ? files : [files];
    await this.send('DOM.setFileInputFiles', { nodeId, files: list });
    return { uploaded: list, selector: record.selector };
  }

  /**
   * Capture a PNG screenshot to an absolute path.
   * @param {string} path
   * @param {{ fullPage?: boolean }} [options]
   */
  async screenshot(path, options = {}) {
    let clip;
    let captureBeyondViewport = false;
    if (options.fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics', {});
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size) {
        clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
        captureBeyondViewport = true;
      }
    }
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip, captureBeyondViewport } : {}),
    }, { timeoutMs: 30000 });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    return path;
  }

  /** Describe visible interactive elements; refs are stable selectors for this page state. */
  async describeInteractive() {
    const items = await this.evaluate('__ego.interactive()');
    const list = Array.isArray(items) ? items : [];
    this.lastRefs = list.map((item, index) => ({
      ref: `e${index + 1}`,
      selector: item.selector,
      text: item.text,
      kind: item.kind,
      tag: item.tag,
    }));
    return this.lastRefs.map((item) => ({
      ref: item.ref,
      tag: item.tag,
      kind: item.kind,
      text: item.text,
      selector: item.selector,
    }));
  }

  /** Resolve a ref from the last describeInteractive() call. */
  ref(refId) {
    return this.lastRefs.find((item) => item.ref === refId) ?? null;
  }

  /**
   * Internal: wait for a target to appear, then return its element record.
   * @param {{ selector?: string, text?: string, exact?: boolean }} target
   * @param {number} timeoutMs
   */
  async #withWait(target, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        return await this.find(target);
      } catch (error) {
        lastError = error;
        await sleep(200);
      }
    }
    throw lastError ?? new EgoError('TARGET_NOT_FOUND', 'target not found', { target });
  }

  /** Close this tab. */
  async close() {
    try {
      await this.send('Page.close', {}, { timeoutMs: 5000 });
    } catch {
      /* the tab may already be gone */
    }
  }
}

/**
 * Map a key name to CDP key fields.
 * @param {string} name
 */
function keyFor(name) {
  const table = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  };
  const lowered = name.toLowerCase();
  if (table[lowered]) return table[lowered];
  if (/^f\d{1,2}$/.test(lowered)) {
    const number = Number(lowered.slice(1));
    return { key: `F${number}`, code: `F${number}`, keyCode: 111 + number };
  }
  if (name.length === 1) {
    const upper = name.toUpperCase();
    return { key: name, code: /[A-Z]/.test(upper) ? `Key${upper}` : `Digit${name}`, keyCode: upper.charCodeAt(0), text: name };
  }
  return { key: name, code: name, keyCode: 0 };
}
