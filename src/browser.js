/**
 * browser.js — one isolated ego lite browser instance per account.
 *
 * Each account gets its own `--user-data-dir` (so cookies and sign-in state are owned by that account
 * alone, and survive restarts), its own remote-debugging port and, when configured, its own
 * `--proxy-server`. The plugin never touches the user's daily ego window: it launches sibling
 * instances of the same installed browser.
 *
 * @module ego-publish/browser
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CdpConnection, EgoError, TargetSession, freePort, getJson, sleep } from './cdp.js';
import { readProfileVersion } from './ego.js';
import { ensureDir, writeJson } from './store.js';
import { parseProxy, startProxyRelay } from './proxy.js';
import { resolveAccountProxy } from './proxies.js';

/** How long a cold ego lite start may take before it is declared failed. */
const START_TIMEOUT_MS = 60000;

/**
 * Manages the account browser instances.
 */
export class BrowserManager {
  /**
   * @param {{ ego: { path: string, exists: boolean, source: string }, dataDir: string,
   *           settings: Record<string, any>, accounts: any, log?: (line: string) => void }} input
   */
  constructor(input) {
    this.ego = input.ego;
    this.dataDir = input.dataDir;
    this.settings = input.settings;
    this.accounts = input.accounts;
    this.proxies = input.proxies ?? null;
    this.dynamicProxy = input.dynamicProxy ?? null;
    this.log = input.log ?? (() => {});
    /** @type {Map<string, Record<string, any>>} */
    this.sessions = new Map();
    /** @type {Map<string, Promise<Record<string, any>>>} */
    this.opening = new Map();
  }

  /** Open (or reuse) the browser for an account. */
  async open(code, options = {}) {
    const existing = this.sessions.get(code);
    if (existing && await this.#alive(existing)) {
      const ttlMs = Math.max(1, Number(this.settings.dynamicProxyTtlMinutes ?? 3)) * 60_000;
      if (existing.dynamicProxy && Date.now() - existing.dynamicProxyAt > ttlMs) {
        this.log(`dynamic proxy for ${code} expired; relaunching with a fresh IP`);
        await this.#dispose(existing);
      } else {
        existing.lastUsedAt = Date.now();
        return existing;
      }
    }
    if (existing) await this.#dispose(existing);

    const pending = this.opening.get(code);
    if (pending) return pending;

    const promise = this.#launch(code, options).finally(() => this.opening.delete(code));
    this.opening.set(code, promise);
    return promise;
  }

  /** Get a live session without launching one. */
  get(code) {
    return this.sessions.get(code) ?? null;
  }

  /** Public status of every managed session. */
  list() {
    return [...this.sessions.values()].map((session) => ({
      accountCode: session.code,
      pid: session.pid,
      port: session.port,
      url: session.page?.lastUrl ?? null,
      proxy: session.proxyUrl ?? null,
      proxySource: session.proxySource ?? null,
      connectivity: session.connectivity ?? null,
      startedAt: new Date(session.startedAt).toISOString(),
      idleSeconds: Math.round((Date.now() - session.lastUsedAt) / 1000),
      profileDir: session.profileDir,
      profileVersion: session.profileVersion ?? null,
    }));
  }

  /**
   * Open a hidden tab in an existing account browser, so background reads (points) never move the
   * page the human is looking at.
   * @param {string} code
   * @returns {Promise<{ page: any, close: () => Promise<void> }>}
   */
  async createBackgroundPage(code) {
    const session = this.sessions.get(code);
    if (!session) throw new EgoError('SESSION_NOT_FOUND', `no open browser for "${code}"`);
    if (session.pw?.context) {
      // Playwright tracks its own targets; a real tab is cheaper and safer than Target.createTarget.
      const pwPage = await session.pw.context.newPage();
      const sessionId = `pw-bg-${Date.now().toString(36)}`;
      await session.cdp.attachPage(pwPage, sessionId);
      const page = new TargetSession(session.cdp, sessionId, sessionId, {
        actionTimeoutMs: this.settings.actionTimeoutMs,
        navigationTimeoutMs: this.settings.navigationTimeoutMs,
      });
      return {
        page,
        close: async () => {
          session.cdp.detachPage(sessionId);
          await pwPage.close().catch(() => {});
        },
      };
    }
    const created = await session.cdp.send('Target.createTarget', { url: 'about:blank', background: true });
    const attached = await session.cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const page = new TargetSession(session.cdp, created.targetId, attached.sessionId, {
      actionTimeoutMs: this.settings.actionTimeoutMs,
      navigationTimeoutMs: this.settings.navigationTimeoutMs,
    });
    return {
      page,
      close: async () => {
        try {
          await session.cdp.send('Target.closeTarget', { targetId: created.targetId });
        } catch {
          /* already closed */
        }
      },
    };
  }

  /** Close one account browser and free its relay. */
  async close(code) {
    const session = this.sessions.get(code);
    if (!session) return { closed: false, code };
    this.sessions.delete(code);
    await this.#dispose(session);
    return { closed: true, code };
  }

  /** Close every managed browser (plugin teardown). */
  async closeAll() {
    const codes = [...this.sessions.keys()];
    for (const code of codes) await this.close(code);
    return codes;
  }

  /** Close browsers idle for longer than `idleCloseMinutes`. */
  async sweepIdle() {
    const minutes = Number(this.settings.idleCloseMinutes ?? 0);
    const limit = minutes > 0 ? minutes * 60_000 : Infinity;
    const dynamicTtl = Math.max(1, Number(this.settings.dynamicProxyTtlMinutes ?? 3)) * 60_000;
    const closed = [];
    for (const [code, session] of [...this.sessions]) {
      const idleExpired = Date.now() - session.lastUsedAt >= limit;
      const dynamicExpired = Boolean(session.dynamicProxy) && Date.now() - session.dynamicProxyAt > dynamicTtl;
      if (!idleExpired && !dynamicExpired) continue;
      await this.close(code);
      closed.push(code);
      this.log(`closed account browser ${code} (${dynamicExpired ? 'dynamic proxy expired' : `${minutes} min idle`})`);
    }
    return closed;
  }

  /**
   * Launch a browser instance and attach a fresh tab.
   * @param {string} code
   * @param {{ headless?: boolean, proxyPolicy?: 'account'|'direct', size?: { width: number, height: number } }} options
   */
  async #launch(code, options) {
    const customBrowser = String(this.settings.browserPath ?? '').trim();
    if (!customBrowser && !this.ego.exists) {
      throw new EgoError('EGO_NOT_FOUND', `cannot find the ego lite executable (looked via ${this.ego.source}: ${this.ego.path})`, {
        hint: 'Set config.egoPath to the full path of ego.exe, or install ego lite.',
      });
    }
    const account = this.accounts.get(code);
    if (!account) throw new EgoError('ACCOUNT_NOT_FOUND', `no account with code "${code}"`, { code });

    const profileDir = account.profileDir ?? join(this.dataDir, 'profiles', code);
    ensureDir(profileDir);
    // ego lite asks a brand-new user-data-dir to finish onboarding and refuses CLI/CDP control until
    // then. The installed app records completion in this file; seeding it lets an account profile be
    // created entirely by the plugin.
    const onboardingFile = join(profileDir, 'ego_config.json');
    if (!existsSync(onboardingFile)) writeJson(onboardingFile, { not_first_run: true });

    const assignedProxy = await (async () => {
      if (options.proxyOverride) return options.proxyOverride;
      if (options.forceDynamic || account.proxyMode === 'dynamic') {
        if (!this.dynamicProxy) throw new EgoError('DYNAMIC_PROXY_UNAVAILABLE', 'dynamic proxy provider is not configured');
        return this.dynamicProxy(account.code);
      }
      return resolveAccountProxy(account, this.proxies);
    })();
    const parsedProxy = options.proxyPolicy === 'direct' ? null : parseProxy(assignedProxy);
    /** @type {{ url: string, close: Function, relayed: boolean } | null} */
    let relay = null;
    let proxyUrl = null;
    if (parsedProxy) {
      relay = await startProxyRelay(parsedProxy);
      proxyUrl = relay.url;
    }
    const proxySource = assignedProxy?.source ?? (account.proxyMode === 'dynamic' ? 'dynamic' : null);

    // The Playwright backend owns the launch itself: persistent profile + proxy + viewport/DPR/UA
    // become launch options instead of command-line flags.
    if (String(this.settings.engine ?? 'ego') === 'playwright') {
      return this.#launchPlaywright({ code, account, profileDir, headless: options.headless, proxyUrl, proxySource, assignedProxy, relay });
    }

    const port = await freePort();
    const headless = options.headless ?? Boolean(this.settings.headless);
    const size = options.size ?? { width: 1360, height: 920 };
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--lang=zh-CN',
      `--window-size=${size.width},${size.height}`,
    ];
    if (headless) args.push('--headless=new');
    if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);

    this.log(`launching ego for ${code}: ${this.ego.path} (port ${port}${proxyUrl ? `, proxy ${proxyUrl}` : ', direct'})`);
    const child = spawn(this.ego.path, args, {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const stderrLines = [];
    child.stdout?.on('data', (chunk) => this.log(`[ego ${code}] ${String(chunk).trim().slice(0, 500)}`));
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (!text) return;
      stderrLines.push(text);
      while (stderrLines.length > 30) stderrLines.shift();
      this.log(`[ego ${code}] ${text.slice(0, 500)}`);
    });

    let exited = false;
    child.on('exit', () => {
      exited = true;
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    let version = null;
    while (Date.now() < deadline) {
      if (exited) {
        if (relay) await relay.close();
        throw new EgoError('EGO_START_FAILED', `ego lite exited before its debugging port opened`, {
          code,
          stderr: stderrLines.slice(-8),
        });
      }
      try {
        version = await getJson(`http://127.0.0.1:${port}/json/version`, 1500);
        break;
      } catch {
        await sleep(300);
      }
    }
    if (!version) {
      await this.#killChild(child);
      if (relay) await relay.close();
      throw new EgoError('EGO_START_TIMEOUT', `ego lite did not expose CDP on port ${port} within ${START_TIMEOUT_MS}ms`, {
        code,
        stderr: stderrLines.slice(-8),
      });
    }

    const connection = await CdpConnection.connect(version.webSocketDebuggerUrl, { timeoutMs: 15000 });
    const attached = await this.#attachPage(connection);
    const page = new TargetSession(connection, attached.targetId, attached.sessionId, {
      actionTimeoutMs: Number(this.settings.actionTimeoutMs ?? 15000),
      navigationTimeoutMs: Number(this.settings.navigationTimeoutMs ?? 60000),
    });
    // A cold ego profile can be busy with its internal welcome/update pages for a second after the
    // debugging port opens; a slow domain enable must not fail an otherwise healthy browser.
    await enableDomain(page, 'Page.enable');
    await enableDomain(page, 'Runtime.enable');
    await enableDomain(page, 'DOM.enable');

    // The fresh profile may have opened its welcome/whats-new pages; this instance belongs to the
    // plugin, so leave only the tab the plugin drives.
    await this.#closeOtherTabs(connection, attached.targetId).catch(() => {});

    const session = {
      code,
      account,
      pid: child.pid,
      child,
      port,
      profileDir,
      profileVersion: readProfileVersion(profileDir),
      proxyUrl,
      proxySource,
      dynamicProxy: (account.proxyMode === 'dynamic' || options.forceDynamic) && !options.proxyOverride ? assignedProxy : null,
      dynamicProxyAt: Date.now(),
      relay,
      cdp: connection,
      page,
      targetId: attached.targetId,
      sessionId: attached.sessionId,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      stderr: stderrLines,
      browser: version.Browser ?? null,
      connectivity: null,
    };
    this.sessions.set(code, session);
    this.log(`ego ready for ${code}: ${version.Browser ?? 'ego'} pid=${child.pid}`);
    // Populate the page's status badge. A failure here must never fail the open itself.
    await this.probeConnectivity(code).catch(() => {});
    return session;
  }

  /**
   * Launch one account through Playwright: same profile directory, but the fingerprint, proxy and
   * window geometry are context options rather than flags, which is what makes per-account
   * fingerprint isolation possible.
   *
   * @param {{ code: string, account: any, profileDir: string, headless?: boolean,
   *           proxyUrl: string|null, proxySource: string|null, assignedProxy: any, relay: any }} input
   */
  async #launchPlaywright(input) {
    const { deriveFingerprint } = await import('./fingerprint.js');
    const { launchPlaywrightContext } = await import('./pw-browser.js');
    const settings = this.settings;
    const chromeMajor = String(this.ego?.installedVersion ?? '').split('.')[0] || '156';
    const fingerprint = deriveFingerprint(input.code, { uaMode: String(settings.uaMode ?? 'real'), chromeMajor });
    const headless = input.headless ?? Boolean(settings.headless);
    // Which Chromium build actually runs. `browserPath` lets the account browsers be a real
    // Chrome install instead of ego.exe; profile directories stay compatible when the versions match.
    const executablePath = String(settings.browserPath ?? '').trim() || this.ego.path;

    let launched;
    try {
      launched = await launchPlaywrightContext({
        egoPath: executablePath,
        profileDir: input.profileDir,
        headless,
        proxyUrl: input.proxyUrl,
        fingerprint,
        settings,
        log: this.log,
      });
    } catch (error) {
      if (input.relay) await input.relay.close().catch(() => {});
      throw new EgoError('PW_START_FAILED', `Playwright could not start the account browser: ${error?.message ?? error}`, {
        code: input.code,
        hint: 'Check that playwright is installed and that egoPath points at a working ego.exe.',
      });
    }

    const page = new TargetSession(launched.connection, 'pw-main', launched.sessionId, {
      actionTimeoutMs: Number(settings.actionTimeoutMs ?? 15000),
      navigationTimeoutMs: Number(settings.navigationTimeoutMs ?? 60000),
    });
    const session = {
      code: input.code,
      account: input.account,
      engine: 'playwright',
      pid: launched.pid,
      child: null,
      port: null,
      profileDir: input.profileDir,
      profileVersion: readProfileVersion(input.profileDir),
      proxyUrl: input.proxyUrl,
      proxySource: input.proxySource,
      dynamicProxy: (input.account.proxyMode === 'dynamic') && !input.assignedProxy?.manual ? input.assignedProxy : null,
      dynamicProxyAt: Date.now(),
      relay: input.relay,
      cdp: launched.connection,
      page,
      targetId: 'pw-main',
      sessionId: launched.sessionId,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      stderr: [],
      browser: `Playwright ${launched.userAgent ?? ''}`.trim(),
      connectivity: null,
      pw: { context: launched.context, browser: launched.browser, fingerprint },
    };
    this.sessions.set(input.code, session);
    this.log(`playwright ready for ${input.code}: slot ${fingerprint.slot} ${fingerprint.viewport.width}x${fingerprint.viewport.height} dpr ${fingerprint.deviceScaleFactor}`);
    await this.probeConnectivity(input.code).catch(() => {});
    return session;
  }

  /**
   * Check that this account's browser can actually reach the network (through its proxy when one is
   * assigned). A tiny image load works from any page, including about:blank, and needs no CORS.
   * @param {string} code
   * @returns {Promise<{ ok: boolean, latencyMs: number, target: string, checkedAt: string, error?: string }>}
   */
  async probeConnectivity(code) {
    const session = this.sessions.get(code);
    if (!session) throw new EgoError('SESSION_NOT_FOUND', `no open browser for "${code}"`);
    const target = 'https://www.baidu.com/favicon.ico';
    const started = Date.now();
    let value;
    try {
      value = await session.page.evaluate(`new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 6000);
        const img = new Image();
        img.onload = () => { clearTimeout(timer); resolve({ ok: true }); };
        img.onerror = () => { clearTimeout(timer); resolve({ ok: false, error: 'network error' }); };
        img.src = ${JSON.stringify(target)} + '?ts=' + Date.now();
      })`, undefined, { timeoutMs: 9000 });
    } catch (error) {
      value = { ok: false, error: String(error?.message ?? error) };
    }
    const connectivity = {
      ok: value?.ok === true,
      latencyMs: Date.now() - started,
      target,
      checkedAt: new Date().toISOString(),
      ...(value?.error ? { error: value.error } : {}),
    };
    session.connectivity = connectivity;
    session.lastUsedAt = Date.now();
    return connectivity;
  }

  /**
   * Create and attach the tab the plugin drives, retrying a cold browser that is not answering yet.
   * @param {CdpConnection} connection
   * @returns {Promise<{ targetId: string, sessionId: string }>}
   */
  async #attachPage(connection) {
    /** @type {any} */
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const created = await connection.send('Target.createTarget', { url: 'about:blank' }, undefined, { timeoutMs: 10000 });
        const attached = await connection.send('Target.attachToTarget', { targetId: created.targetId, flatten: true }, undefined, { timeoutMs: 10000 });
        return { targetId: created.targetId, sessionId: attached.sessionId };
      } catch (error) {
        lastError = error;
        await sleep(400);
      }
    }
    throw lastError;
  }

  /**
   * @param {CdpConnection} connection
   * @param {string} keepTargetId
   */
  async #closeOtherTabs(connection, keepTargetId) {
    const { targetInfos } = await connection.send('Target.getTargets', {});
    for (const info of targetInfos ?? []) {
      if (info.targetId === keepTargetId) continue;
      if (info.type !== 'page') continue;
      await connection.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    }
  }

  /** @param {Record<string, any>} session */
  async #alive(session) {
    try {
      await session.cdp.send('Browser.getVersion', {}, undefined, { timeoutMs: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /** @param {Record<string, any>} session */
  async #dispose(session) {
    if (session.pw?.context) {
      try {
        await session.pw.context.close();
      } catch {
        /* the browser may already be gone */
      }
      try {
        session.cdp.close();
      } catch {
        /* ignore */
      }
      if (session.relay) {
        try {
          await session.relay.close();
        } catch {
          /* best effort */
        }
      }
      return;
    }
    try {
      await session.cdp.send('Browser.close', {}, undefined, { timeoutMs: 5000 });
    } catch {
      /* fall through to the process kill */
    }
    await sleep(400);
    if (session.child && session.child.exitCode === null) {
      await this.#killChild(session.child);
    }
    try {
      session.cdp.close();
    } catch {
      /* already closed */
    }
    if (session.relay) {
      try {
        await session.relay.close();
      } catch {
        /* best effort */
      }
    }
  }

  /** @param {import('node:child_process').ChildProcess} child */
  async #killChild(child) {
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(300);
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') {
      const { spawn: spawnProcess } = await import('node:child_process');
      const killer = spawnProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => {});
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Enable one CDP domain on a freshly attached page, retrying a cold renderer.
 * @param {TargetSession} page
 * @param {string} method
 */
async function enableDomain(page, method) {
  /** @type {any} */
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.send(method, {}, { timeoutMs: 10000 });
      return;
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError;
}
