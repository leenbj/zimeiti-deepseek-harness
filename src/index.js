/**
 * @dsh-plugin/ego-publish — agent-driven publishing on ego lite, with one isolated browser per account.
 *
 * Design in one paragraph: the installed ego lite binary is a Chromium fork. The plugin launches one ego
 * lite process per account, each with its own `--user-data-dir` (cookies and sign-in state) and its own
 * `--proxy-server` (exit IP), then drives it over CDP. That gives real account isolation and real proxy
 * isolation without a second browser engine, and it leaves the user's daily ego window untouched.
 *
 * The tool surface mirrors the media-publish plugin: status -> account -> proxy -> session -> observe ->
 * act -> flow -> publish, plus a script escape hatch and configuration.
 *
 * @module @dsh-plugin/ego-publish
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_DEFAULTS, createConfigStore, resolveBootstrapDataDir } from './config.js';
import { resolveEgo } from './ego.js';
import { AccountStore } from './accounts.js';
import { BrowserManager } from './browser.js';
import { ProxyStore } from './proxies.js';
import { refreshAllPoints } from './points.js';
import { CheckScheduler } from './checks.js';
import { extractOne } from './provider.js';
import { DynamicPool } from './dynamic-pool.js';
import { TaskStore } from './tasks.js';
import { SourceStore } from './sources.js';
import { createHttpRoutes } from './http.js';
import * as accountTool from './tools/account.js';
import * as actTool from './tools/act.js';
import * as common from './tools/common.js';
import * as configTool from './tools/config.js';
import * as flowTool from './tools/flow.js';
import * as observeTool from './tools/observe.js';
import * as proxyTool from './tools/proxy.js';
import * as publishTool from './tools/publish.js';
import * as scriptTool from './tools/script.js';
import * as sessionTool from './tools/session.js';
import * as statusTool from './tools/status.js';
import * as taskTool from './tools/task.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Package root — `flows/` lives next to `src/`. */
export const PLUGIN_ROOT = join(here, '..');

export const name = 'ego-publish';
export const inject = ['tools'];

/** Reported by `egolite_status`; notice a stale value after an upgrade. */
const PLUGIN_VERSION = '0.5.0';

/** Tool modules in prompt order: status first, then the workflow, then configuration. */
const MODULES = [
  statusTool, accountTool, proxyTool, sessionTool, observeTool, actTool,
  scriptTool, flowTool, publishTool, configTool, taskTool,
];

/**
 * Register this plugin's own HTTP surface for its Settings page.
 *
 * `webServer` is reached as a plain string service key, so the host half keeps its zero-DSH-import
 * property. The route is installed from `ctx.inject(['webServer'], …)` because the web server is
 * provided after this plugin activates in the shipped Web composition; a one-shot lookup would miss it.
 *
 * @param {any} ctx
 * @param {{ ego: any, accounts: any, manager: any, settings: Record<string, any>, configStore: any,
 *           dataDir: string, pluginRoot: string, pluginVersion: string }} deps
 * @param {(line: string) => void} log
 */
function registerWebRoutes(ctx, deps, log) {
  let routes = [];
  try {
    ({ routes } = createHttpRoutes({ ...deps, log }));
  } catch (error) {
    log(`could not build the settings HTTP surface (${error?.message ?? error})`);
    return;
  }
  if (!routes.length) return;

  const paths = routes.map((route) => route.path);
  const install = (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return null;
    const disposers = routes.map((route) => webServer.register(route));
    log(`settings routes registered: ${paths.join(', ')}`);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (error) {
          log(`removing a settings route failed: ${error?.message ?? error}`);
        }
      }
    };
  };

  if (typeof ctx?.inject !== 'function') {
    const immediate = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined;
    const dispose = install(immediate);
    if (dispose && typeof ctx.effect === 'function') ctx.effect(() => dispose, 'ego-publish: settings routes');
    return;
  }
  try {
    ctx.inject(['webServer'], (child) => {
      const dispose = install(child.webServer);
      if (!dispose) return;
      child.effect(() => dispose, 'ego-publish: settings routes');
    });
  } catch (error) {
    log(`waiting for the webServer service failed (${error?.message ?? error}); the settings page will be read-only`);
  }
}

/**
 * Tell a schema-driven Settings UI not to auto-generate a form for this plugin: its page is its own.
 * @param {any} ctx
 */
function registerSettingsPolicy(ctx) {
  if (typeof ctx?.inject !== 'function') return;
  try {
    ctx.inject(['settings'], (child) => {
      const effectHost = typeof child?.effect === 'function' ? child : (typeof ctx.effect === 'function' ? ctx : null);
      if (!effectHost || typeof child.settings?.configure !== 'function') return;
      effectHost.effect(
        () => child.settings.configure({ auto: false }, ctx.fiber),
        'ego-publish: this plugin ships its own settings page',
      );
    });
  } catch {
    /* a deployment without Settings simply has no settings page */
  }
}

/**
 * Register the ego-publish tool surface.
 *
 * @param {any} ctx - registrant context carrying the tool registry.
 * @param {Record<string, any>} [config] - configuration from the bundle patch row.
 */
export function apply(ctx, config = {}) {
  const dataDir = resolveBootstrapDataDir({ patch: config ?? {}, env: process.env });
  const configStore = createConfigStore({ patch: config ?? {}, env: process.env, dataDir });
  const settings = configStore.values();
  const log = common.log(ctx);

  // One mutable object every tool closes over: a later `egolite_config set egoPath` re-resolves in place,
  // so a destructured reference in a tool module still sees the new executable.
  const ego = resolveEgo({ egoPath: settings.egoPath, env: process.env });
  const accounts = new AccountStore({ dataDir, log });
  const proxies = new ProxyStore({ dataDir });
  const dynamics = new DynamicPool({ ttlMinutes: () => Number(configStore.values().dynamicProxyTtlMinutes) || 3 });
  const tasks = new TaskStore({ dataDir });
  const sources = new SourceStore({ dataDir });
  if (!sources.list().length && settings.proxyApiUrl) {
    try { sources.upsert({ label: '神龙', url: settings.proxyApiUrl }); } catch { /* invalid legacy URL */ }
  }
  const manager = new BrowserManager({
    ego, dataDir, settings, accounts, proxies, log,
    dynamicProxy: async (code) => {
      const one = await extractOne({ configStore, log, sources });
      dynamics.add(code, one);
      return one;
    },
  });
  const checks = new CheckScheduler({ dataDir, manager, accounts, configStore, log });

  const deps = {
    ego,
    accounts,
    proxies,
    manager,
    checks,
    dynamics,
    tasks,
    sources,
    settings,
    dataDir,
    configStore,
    pluginRoot: PLUGIN_ROOT,
    pluginVersion: PLUGIN_VERSION,
    pluginName: name,
    log,
  };

  for (const module of MODULES) {
    try {
      module.register(ctx, deps);
    } catch (error) {
      throw new Error(`ego-publish could not register ${module.register?.name ?? 'a tool module'}: ${error?.message ?? error}`);
    }
  }

  registerSettingsPolicy(ctx);
  registerWebRoutes(ctx, deps, log);

  // Re-resolve the executable when egoPath changes; a browser that is already running keeps its old path.
  const unsubscribe = configStore.subscribe((values, meta) => {
    if (meta.changed.includes('pointsRefreshMinutes')) schedulePointsRefresh();
    if (!meta.changed.includes('egoPath')) return;
    Object.assign(deps.ego, resolveEgo({ egoPath: values.egoPath, env: process.env }));
    log(`config change: egoPath -> ${deps.ego.source}:${deps.ego.path} (exists=${deps.ego.exists})`);
  });

  // Idle cleanup: a publishing account does not need a browser window open forever.
  const sweeper = setInterval(() => {
    void manager.sweepIdle().catch((error) => log(`idle sweep failed: ${error?.message ?? error}`));
  }, 60_000);
  sweeper.unref?.();

  // Points watchdog: fetch 积分 on a schedule so the page can show a falling trend before publishing.
  let pointsTimer = null;
  let pointsFirstRun = null;
  function schedulePointsRefresh() {
    if (pointsTimer) clearInterval(pointsTimer);
    if (pointsFirstRun) clearTimeout(pointsFirstRun);
    pointsTimer = null;
    pointsFirstRun = null;
    const minutes = Number(configStore.values().pointsRefreshMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const run = () => {
      void refreshAllPoints({ manager, accounts, log })
        .then((results) => {
          const updated = results.filter((result) => result.points).length;
          if (results.length) log(`points refresh: ${updated}/${results.length} Sohu account(s) updated`);
        })
        .catch((error) => log(`points refresh failed: ${error?.message ?? error}`));
    };
    pointsFirstRun = setTimeout(run, 20_000);
    pointsFirstRun.unref?.();
    pointsTimer = setInterval(run, minutes * 60_000);
    pointsTimer.unref?.();
  }
  schedulePointsRefresh();
  // Re-arm publish checks that were waiting when the process stopped.
  checks.rearmAll();

  const dispose = () => {
    clearInterval(sweeper);
    if (pointsTimer) clearInterval(pointsTimer);
    if (pointsFirstRun) clearTimeout(pointsFirstRun);
    checks.dispose();
    try {
      unsubscribe();
    } catch {
      /* best effort */
    }
    void manager.closeAll().catch((error) => log(`closing account browsers failed: ${error?.message ?? error}`));
  };
  if (typeof ctx.on === 'function') ctx.on('dispose', dispose);
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'ego-publish: account browsers and idle sweeper');
    } catch {
      /* the dispose hook above is enough */
    }
  }

  log(
    `ego-publish ${PLUGIN_VERSION}: ${MODULES.length} tools registered — dataDir=${dataDir}`
    + ` ego=${ego.source}:${ego.path} (exists=${ego.exists})`,
  );
  return deps;
}

/** Re-exported so tests can build the same defaults the plugin uses. */
export { CONFIG_DEFAULTS };
