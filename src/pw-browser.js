/**
 * pw-browser.js — the Playwright backend.
 *
 * Playwright owns the launch (persistent profile + per-account proxy + viewport/DPR/UA/timezone) and
 * exposes a raw CDP session for the page and for the browser. `PwConnection` adapts those sessions to
 * the exact `send(method, params, sessionId, options)` contract that `TargetSession` and
 * `BrowserManager` already speak, so the 800+ lines of page logic and every tool keep working
 * unchanged.
 *
 * @module ego-publish/pw-browser
 */
import { EgoError } from './cdp.js';

/**
 * Browser-side stealth + per-account surfaces.
 * Everything here has to stay self-consistent: the values it reports must match the context options
 * Playwright was launched with.
 *
 * @param {ReturnType<import('./fingerprint.js').deriveFingerprint>} fp
 */
export function buildInitScript(fp) {
  return `(() => {
  const FP = ${JSON.stringify({
    locale: fp.locale,
    languages: fp.languages,
    platform: fp.platform,
    cores: fp.cores,
    memory: fp.memory,
    gpuVendor: fp.gpuVendor,
    gpuRenderer: fp.gpuRenderer,
    seed: fp.seed,
  })};
  const def = (obj, prop, getter) => {
    try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (e) {}
  };

  // 1) automation flag
  def(Navigator.prototype, 'webdriver', () => undefined);

  // 2) language / platform / hardware
  def(navigator, 'languages', () => FP.languages.slice());
  def(navigator, 'language', () => FP.locale);
  def(navigator, 'platform', () => FP.platform);
  def(navigator, 'vendor', () => 'Google Inc.');
  def(navigator, 'hardwareConcurrency', () => FP.cores);
  def(navigator, 'deviceMemory', () => FP.memory);
  def(navigator, 'maxTouchPoints', () => 0);

  // 3) plugins — empty under automation is a classic tell
  try {
    const mk = (name, filename, desc) => {
      const plugin = Object.create(Plugin.prototype || Object.prototype);
      const mime = Object.create(MimeType.prototype || Object.prototype);
      Object.defineProperties(mime, {
        type: { value: 'application/pdf', enumerable: true },
        suffixes: { value: 'pdf', enumerable: true },
        description: { value: 'Portable Document Format', enumerable: true },
        enabledPlugin: { value: plugin, enumerable: true },
      });
      Object.defineProperties(plugin, {
        name: { value: name, enumerable: true },
        filename: { value: filename, enumerable: true },
        description: { value: desc, enumerable: true },
        length: { value: 1, enumerable: true },
        0: { value: mime, enumerable: true },
        item: { value: (i) => (i === 0 ? mime : null) },
        namedItem: { value: (n) => (n === 'application/pdf' ? mime : null) },
      });
      return plugin;
    };
    const plugins = [
      mk('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      mk('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      mk('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    const arr = Object.create(PluginArray.prototype || Object.prototype);
    plugins.forEach((p, i) => Object.defineProperty(arr, i, { value: p, enumerable: true }));
    Object.defineProperties(arr, {
      length: { value: plugins.length },
      item: { value: (i) => plugins[i] || null },
      namedItem: { value: (n) => plugins.find((p) => p.name === n) || null },
      refresh: { value: () => undefined },
    });
    def(navigator, 'plugins', () => arr);
  } catch (e) {}

  // 4) chrome.runtime — missing under automation
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function () {}, sendMessage: function () {},
      id: undefined, OnInstalledReason: {}, PlatformArch: {}, PlatformOs: {},
    };
  }

  // 5) WebGL vendor/renderer strings
  const patchGL = (proto) => {
    if (!proto || !proto.getParameter) return;
    const orig = proto.getParameter;
    proto.getParameter = function (pname) {
      if (pname === 37445) return FP.gpuVendor;
      if (pname === 37446) return FP.gpuRenderer;
      if (pname === 7936) return FP.gpuVendor;
      if (pname === 7937) return FP.gpuRenderer;
      return orig.apply(this, arguments);
    };
  };
  patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  // 6) deterministic canvas noise — same account always produces the same bitmap
  try {
    let s = FP.seed >>> 0;
    const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const bump = (data) => {
      if (!data || data.length < 8) return;
      const i = ((FP.seed % (data.length / 4)) | 0) * 4;
      data[i] = (data[i] + 1 + ((rand() * 2) | 0)) & 0xff;
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      try {
        if (this.width >= 16 && this.height >= 16) {
          const g = this.getContext('2d');
          if (g) {
            const img = g.getImageData(0, 0, this.width, this.height);
            bump(img.data);
            g.putImageData(img, 0, 0);
          }
        }
      } catch (e) {}
      return origToDataURL.apply(this, arguments);
    };
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function () {
      const out = origGetImageData.apply(this, arguments);
      try { bump(out.data); } catch (e) {}
      return out;
    };
  } catch (e) {}
})();`;
}

/**
 * Adapts Playwright CDP sessions to the CdpConnection contract.
 */
export class PwConnection {
  /**
   * @param {{ browser?: any, context: any, log?: (line: string) => void }} input
   */
  constructor(input) {
    this.browser = input.browser ?? null;
    this.context = input.context;
    this.log = input.log ?? (() => {});
    /** @type {Map<string, any>} */
    this.pageSessions = new Map();
    /** @type {any} */
    this.browserSession = null;
    this.closed = false;
    this.listeners = new Map();
  }

  async init() {
    if (this.browser) {
      try {
        this.browserSession = await this.browser.newBrowserCDPSession();
      } catch (error) {
        this.log(`browser-level CDP unavailable: ${error?.message ?? error}`);
      }
    }
    return this;
  }

  /**
   * @param {any} page Playwright Page
   * @param {string} sessionId logical session id used by TargetSession
   */
  async attachPage(page, sessionId) {
    const session = await this.context.newCDPSession(page);
    this.pageSessions.set(sessionId, session);
    return session;
  }

  detachPage(sessionId) {
    this.pageSessions.delete(sessionId);
  }

  #route(method, sessionId) {
    if (/^(Target|Browser)\./.test(method)) {
      if (this.browserSession) return this.browserSession;
    }
    if (sessionId && this.pageSessions.has(sessionId)) return this.pageSessions.get(sessionId);
    const first = this.pageSessions.values().next();
    return first.done ? null : first.value;
  }

  /**
   * @param {string} method
   * @param {Record<string, any>} [params]
   * @param {string} [sessionId]
   * @param {{ timeoutMs?: number }} [options]
   */
  async send(method, params = {}, sessionId, options = {}) {
    if (this.closed) throw new EgoError('CDP_CLOSED', 'the browser connection is closed');
    const target = this.#route(method, sessionId);
    if (!target) throw new EgoError('CDP_NO_SESSION', `no CDP session available for ${method}`);
    const timeoutMs = Number(options.timeoutMs ?? 30000);
    const call = target.send(method, params);
    call.catch(() => {});
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new EgoError('CDP_TIMEOUT', `${method} did not answer within ${timeoutMs}ms`, { method })), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  waitForEvent() {
    return Promise.reject(new EgoError('CDP_UNSUPPORTED', 'waitForEvent is not available on the Playwright backend'));
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) ?? []) {
      try { handler(payload); } catch { /* listener errors stay local */ }
    }
  }

  close() {
    this.closed = true;
    for (const session of this.pageSessions.values()) {
      try { session.detach?.().catch?.(() => {}); } catch { /* ignore */ }
    }
    this.pageSessions.clear();
    try { this.browserSession?.detach?.().catch?.(() => {}); } catch { /* ignore */ }
    this.browserSession = null;
  }
}

/**
 * Launch one isolated persistent context for an account.
 *
 * @param {{
 *   egoPath: string, profileDir: string, headless: boolean, proxyUrl: string|null,
 *   fingerprint: ReturnType<import('./fingerprint.js').deriveFingerprint>,
 *   settings: Record<string, any>, log?: (line: string) => void,
 * }} input
 */
export async function launchPlaywrightContext(input) {
  const { chromium } = await import('playwright');
  const fp = input.fingerprint;
  const log = input.log ?? (() => {});
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--lang=zh-CN',
  ];

  const context = await chromium.launchPersistentContext(input.profileDir, {
    executablePath: input.egoPath,
    headless: Boolean(input.headless),
    viewport: fp.viewport,
    deviceScaleFactor: fp.deviceScaleFactor,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    userAgent: fp.userAgent,
    proxy: input.proxyUrl ? { server: input.proxyUrl } : undefined,
    args,
    timeout: Number(input.settings.navigationTimeoutMs ?? 60000),
  });

  await context.addInitScript({ content: buildInitScript(fp) });

  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();
  const browser = context.browser?.() ?? null;
  const connection = new PwConnection({ browser, context, log });
  await connection.init();
  const sessionId = 'pw-main';
  await connection.attachPage(page, sessionId);
  log(`playwright context ready for ${fp.code} (viewport ${fp.viewport.width}x${fp.viewport.height}, dpr ${fp.deviceScaleFactor})`);

  return {
    context,
    browser,
    page,
    connection,
    sessionId,
    pid: (() => {
      try { return browser?.process?.()?.pid ?? null; } catch { return null; }
    })(),
    userAgent: await page.evaluate(() => navigator.userAgent).catch(() => fp.userAgent),
  };
}
