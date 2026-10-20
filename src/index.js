/**
 * @dsh-plugin/media-publish 鈥?agent-driven browser publishing with account and proxy isolation.
 *
 * This half is deliberately thin: it owns configuration, the model-facing tool surface, the plugin-owned
 * Settings page's HTTP surface, and the lifecycle of a long-lived Python engine process
 * (`engine/sessiond.py`) that actually drives Playwright. The RPC contract between the two halves is
 * frozen in docs/SPEC.md.
 *
 * The file is pure wiring: resolve the layered config 鈫?build the {@link EngineClient} 鈫?hand
 * `{engine, settings, dataDir, python, pluginRoot, configStore}` to one `register(ctx, deps)` per tool
 * module under `src/tools/`. {@link applyWithEngine} is the injection seam the probe harness uses to
 * exercise every tool without spawning Python.
 *
 * @module @dsh-plugin/media-publish
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_DEFAULTS, createConfigStore, resolveBootstrapDataDir } from './config.js';
import { createConfigHttp } from './config-http.js';
import { createAccountsHttp } from './accounts-http.js';
import { EngineClient } from './engine-client.js';
import * as account from './tools/account.js';
import * as act from './tools/act.js';
import { createHandoffLog, log } from './tools/common.js';
import * as configTool from './tools/config.js';
import * as observe from './tools/observe.js';
import * as proxy from './tools/proxy.js';
import * as publish from './tools/publish.js';
import * as recipe from './tools/recipe.js';
import * as record from './tools/record.js';
import * as session from './tools/session.js';
import * as status from './tools/status.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Package root 鈥?`engine/` lives next to `src/`. */
export const PLUGIN_ROOT = resolve(here, '..');

export const name = 'media-publish';
export const inject = ['tools'];

/**
 * Version of the plugin, reported by `media_status`.
 *
 * This doubles as a staleness marker. The live composition caches imported modules, so if a
 * `media_status` result reports an older value than this constant, the running profile is still
 * executing a previous revision. See the reload notes in README.md.
 */
const PLUGIN_VERSION = '0.4.11';

/** The tool modules, in prompt order: status first, then the workflow they drive, then configuration. */
const MODULES = [status, account, proxy, session, observe, act, record, recipe, publish, configTool];

/**
 * Path of the interpreter bundled inside a DSH home directory.
 * @param {string} dshHome
 * @returns {string}
 */
function runtimePython(dshHome) {
  return join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');
}

/**
 * Resolve the Python interpreter that carries Playwright.
 *
 * The host process does not necessarily inherit `DSH_HOME` (it is set for tool subprocesses, not for the
 * Electron main process), so the runtime interpreter is also located relative to the user profile.
 *
 * @param {Record<string, any>} config - resolved plugin config.
 * @returns {{ path: string, source: string }[]} candidates in priority order.
 */
function pythonCandidates(config) {
  /** @type {Array<{ path: string, source: string }>} */
  const candidates = [];
  if (config.pythonPath) candidates.push({ path: String(config.pythonPath), source: 'config' });
  if (process.env.MEDIA_PYTHON) candidates.push({ path: process.env.MEDIA_PYTHON, source: 'env:MEDIA_PYTHON' });
  if (process.env.DSH_HOME) candidates.push({ path: runtimePython(process.env.DSH_HOME), source: 'dsh-runtime' });
  candidates.push({ path: runtimePython(join(homedir(), '.dsh')), source: 'dsh-runtime' });
  candidates.push({ path: 'python', source: 'PATH' });
  return candidates;
}

/**
 * Probe one interpreter for Playwright availability.
 *
 * Exit status alone is not trusted: the probe must also answer with the JSON it was asked for, so a
 * wrapper/stub `python` on PATH can never be accepted as "has Playwright" and then fail at spawn time.
 *
 * @param {string} pythonPath
 * @returns {{ ok: boolean, detail: string }}
 */
function probeInterpreter(pythonPath) {
  // Two things must both hold, so the probe keeps proving what it always proved:
  //   * `import playwright` (and the async API the engine actually uses) is a HARD requirement 鈥?a bare
  //     top-level import so a failure exits non-zero and the candidate is rejected;
  //   * the version comes from distribution metadata, because the `playwright` package does not expose
  //     `__version__`. The old `getattr(playwright, "__version__", "unknown")` reported "unknown" even
  //     on a perfectly good interpreter, which then sat next to the engine's correct version and looked
  //     like a broken install.
  const code = [
    'import sys, json',
    'import playwright',
    'import playwright.async_api',
    'import importlib.metadata as md',
    'try:',
    '    version = md.version("playwright")',
    'except Exception:',
    '    version = getattr(playwright, "__version__", None)',
    'print(json.dumps({"python": sys.version.split()[0], "playwright": version}))',
  ].join('\n');
  const result = spawnSync(pythonPath, ['-c', code], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (result.error) return { ok: false, detail: `${result.error.code ?? 'ERROR'}: ${result.error.message}` };
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim().split('\n').slice(-2).join(' | ');
    return { ok: false, detail: `exit ${result.status}: ${stderr || 'no output'}` };
  }
  const stdout = String(result.stdout ?? '').trim();
  try {
    const parsed = JSON.parse(stdout);
    // Require the full payload, not just a version string: a wrapper or stub `python` on PATH could
    // print anything, and it must not be accepted as "has Playwright" and then fail at spawn time.
    // The `playwright` KEY must be present; its value may be null if metadata lookup failed.
    if (!parsed || typeof parsed.python !== 'string' || !('playwright' in parsed)) {
      throw new Error('unexpected payload');
    }
  } catch (error) {
    return { ok: false, detail: `probe did not return the expected JSON (${error.message}): ${stdout.slice(0, 160) || 'no output'}` };
  }
  return { ok: true, detail: stdout };
}

/**
 * Pick the first interpreter that actually imports Playwright.
 * @param {Record<string, any>} config - resolved plugin config.
 * @returns {{ path: string, source: string, exists: boolean, probe: string }}
 */
function resolvePython(config) {
  let fallback = null;
  for (const candidate of pythonCandidates(config)) {
    const onPath = candidate.source === 'PATH';
    if (!onPath && !existsSync(candidate.path)) continue;
    const probed = probeInterpreter(candidate.path);
    if (probed.ok) return { ...candidate, exists: true, probe: probed.detail };
    fallback ??= { ...candidate, exists: !onPath, probe: probed.detail };
  }
  return fallback ?? { path: 'python', source: 'PATH', exists: false, probe: 'no candidate interpreter could be probed' };
}

/**
 * Resolve the runtime data root holding accounts, storage state, recipes and runs.
 * @param {Record<string, any>} config - resolved plugin config.
 * @returns {string}
 */
function resolveDataDir(config) {
  if (config.dataDir) return String(config.dataDir);
  if (process.env.MEDIA_DATA_DIR) return process.env.MEDIA_DATA_DIR;
  return join(homedir(), '.dsh', 'media-publish');
}

/**
 * Engines already wired to a composition, so re-registering the same client cannot double-subscribe.
 * @type {WeakSet<object>}
 */
const WIRED_ENGINES = new WeakSet();

/**
 * Wire one engine's log/handoff events to the composition, exactly once per engine.
 *
 * The `handoff` subscription keeps the last handoff per session so every tool's failure text can quote
 * the engine's real reason instead of a generic "a human is needed". A configuration change that moves
 * the data root or the interpreter replaces the engine, and that new engine is wired through here again.
 *
 * @param {any} engine
 * @param {(line: string) => void} debug
 * @param {any} handoffs
 */
function wireEngine(engine, debug, handoffs) {
  if (!engine || typeof engine.on !== 'function' || WIRED_ENGINES.has(engine)) return;
  WIRED_ENGINES.add(engine);
  engine.on('log', (line) => debug(`[engine] ${line}`));
  engine.on('handoff', (data) => {
    handoffs.record(data);
    debug(`handoff ${data?.sessionId ?? '?'}: ${data?.reason ?? '?'} ${data?.hint ?? ''}`);
  });
}

/**
 * Register the whole tool surface against an already-built engine, and wire that engine's log/handoff
 * events to the composition. Registers `media_status`, `media_account`, `media_proxy`, `media_session`,
 * `media_observe`, `media_act`, `media_record`, `media_recipe`, `media_publish` and `media_config`.
 *
 * Each tool module registers through a thin proxy context that captures the registry's own disposer, so
 * {@link applyWithEngine}'s `reloadTools()` can rebuild the surface after a configuration change moves the
 * data root or the interpreter. Without that, the Node-side half would keep reading the old
 * `<dataDir>/recipes` while the engine had already restarted on the new one.
 *
 * @param {any} ctx - registrant context carrying the tool registry.
 * @param {{ engine: any, settings: Record<string, any>, dataDir: string, python: Record<string, any>,
 *           pluginRoot: string, pluginVersion?: string, handoffs?: any, configStore?: any }} deps
 * @returns {any} the deps actually used (handy for tests), plus `reloadTools`/`disposeTools`.
 */
export function applyWithEngine(ctx, deps) {
  const configStore = deps.configStore
    ?? createConfigStore({ patch: deps.settings ?? {}, bootstrapDataDir: deps.dataDir });
  const resolved = {
    pluginVersion: PLUGIN_VERSION,
    handoffs: createHandoffLog(),
    ...deps,
    configStore,
    // The live effective values: one object, mutated in place by the store, so a GUI write or a
    // `media_config set` is visible to the very next tool call without re-registering anything.
    settings: configStore.values(),
  };
  const { engine, handoffs } = resolved;
  const debug = log(ctx);
  debug(`media-publish ${PLUGIN_VERSION}: ${MODULES.length} tools registered 鈥?dataDir=${resolved.dataDir}`
    + ` python=${resolved.python?.source ?? '?'}:${resolved.python?.path ?? '?'}`);
  wireEngine(engine, debug, handoffs);

  /** Register every module, collecting the registry's disposers so the surface can be rebuilt. */
  function registerAll() {
    /** @type {Array<() => void>} */
    const disposers = [];
    const registeringCtx = {
      logger: (name) => ctx.logger?.(name),
      on: (...args) => ctx.on?.(...args),
      tools: {
        register(definition) {
          const dispose = ctx.tools.register(definition);
          if (typeof dispose === 'function') disposers.push(dispose);
          return dispose;
        },
      },
    };
    for (const module of MODULES) module.register(registeringCtx, resolved);
    return disposers;
  }

  let toolDisposers = registerAll();

  /**
   * Dispose and re-register the tool surface. The old registrations go first: a tool name must never be
   * registered twice, and a failed re-registration is reported rather than silently leaving no tools.
   */
  resolved.reloadTools = () => {
    const previous = toolDisposers;
    toolDisposers = [];
    for (const dispose of previous) {
      try {
        dispose();
      } catch (error) {
        debug(`tool disposer threw: ${error?.message ?? error}`);
      }
    }
    try {
      toolDisposers = registerAll();
      return { ok: true, tools: MODULES.length };
    } catch (error) {
      debug(`re-registering the tool surface after a config change failed: ${error?.stack ?? error}`);
      return { ok: false, message: String(error?.message ?? error) };
    }
  };

  return resolved;
}

/**
 * Register `ctx.settings.configure({ auto: false }, ctx.fiber)` in an optional `ctx.inject(['settings'],
 * ...)` child, exactly as `@deepseek-ai/dsh-settings` documents for a plugin that ships its own page.
 *
 * The child names the plugin fiber the policy belongs to, a late-loading or replaced Settings service
 * picks the policy up, and the plugin runs without Settings. The policy does not remove configuration
 * reads or writes; it tells a schema-driven client not to auto-generate a form for this plugin, because
 * this plugin's page is its own.
 *
 * @param {any} ctx
 */
function registerSettingsPolicy(ctx) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['settings'], (child) => {
    const effectHost = typeof child?.effect === 'function' ? child : (typeof ctx.effect === 'function' ? ctx : null);
    if (!effectHost || typeof child.settings?.configure !== 'function') return;
    effectHost.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'media-publish: this plugin ships its own settings page',
    );
  });
}

/**
 * Register this plugin's own HTTP surface for its Settings page.
 *
 * `webServer` is reached as a plain string service key, so the host half keeps its zero-DSH-import
 * property 鈥?which is the whole reason the page talks HTTP instead of a Remote namespace. A profile with
 * no web server at all (a CLI or ACP deployment) simply gets no route, and the page says so rather than
 * rendering a form that cannot save.
 *
 * **Why this waits instead of looking once.** A one-shot `ctx.get('webServer')` at activation returned
 * `undefined` in the shipped Web composition, because the web server is provided *after* this plugin
 * activates; the routes were then never installed and every call from the page got the SPA fallback's
 * **404**. Nothing failed loudly 鈥?activation order is a composition detail, so the plugin had no way to
 * know it had raced. `ctx.inject(['webServer'], 鈥?` is the correct form: it runs the callback when the
 * service becomes available and re-runs it if a later composition replaces that service.
 *
 * @param {any} ctx
 * @param {{ configStore: any, status: () => Record<string, unknown>, log: (line: string) => void }} input
 */
function registerConfigRoutes(ctx, input) {
  // Build the surface BEFORE touching the service, and pass the store under the exact name
  // `createConfigHttp` destructures. Getting that name wrong is what produced a 500 on every request from
  // the page: `store` was undefined, so each handler threw on its first statement. `createConfigHttp` now
  // throws on a shapeless store, and this catch keeps a settings-page problem from taking the tool surface
  // down with it.
  let routes = [];
  try {
    ({ routes } = createConfigHttp({ store: input.configStore, status: input.status, log: input.log }));
  } catch (error) {
    input.log(`could not build the configuration HTTP surface (${error?.message ?? error})`);
  }
  // The account surface is built the same way and merged into one registration, so the page has a single
  // origin to talk to and the two halves fail independently: a broken account projection still leaves the
  // environment fields editable.
  try {
    const { routes: accountRoutes } = createAccountsHttp({
      engine: input.engine,
      // The page reports each account's stored sign-in straight from disk; the effective data root is what
      // decides where those files live, so it is read here rather than at construction time.
      dataDir: typeof input.dataDir === 'function' ? input.dataDir() : (input.dataDir ?? null),
      log: input.log,
    });
    routes = routes.concat(accountRoutes);
  } catch (error) {
    input.log(`could not build the account HTTP surface (${error?.message ?? error})`);
  }
  if (!routes.length) {
    input.log('no plugin settings routes could be built; the settings page will be read-only');
    return [];
  }
  const paths = routes.map((route) => route.path);

  /**
   * Install every route on one resolved web server.
   * @param {any} webServer
   * @returns {(() => void)|null} a disposer removing all of them, or null when there is nothing to install.
   */
  function install(webServer) {
    if (!webServer || typeof webServer.register !== 'function') return null;
    const disposers = routes.map((route) => webServer.register(route));
    input.log(`plugin settings routes registered: ${paths.join(', ')}`);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (error) {
          input.log(`removing a config route failed: ${error?.message ?? error}`);
        }
      }
    };
  }

  // A context without `inject` (the probe harness) cannot wait, so fall back to the immediate lookup.
  if (typeof ctx?.inject !== 'function') {
    const immediate = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined;
    const dispose = install(immediate);
    if (!dispose) {
      input.log('no webServer service in this composition: the plugin settings page will be read-only');
      return paths;
    }
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'media-publish: plugin settings routes');
    return paths;
  }

  try {
    ctx.inject(['webServer'], (child) => {
      const dispose = install(child.webServer);
      if (!dispose) {
        input.log('the webServer service exposes no register(): the plugin settings page will be read-only');
        return;
      }
      child.effect(() => dispose, 'media-publish: plugin settings routes');
    });
  } catch (error) {
    // Registering a settings route must never take the tool surface down with it.
    input.log(`waiting for the webServer service failed (${error?.message ?? error}); the plugin settings page will be read-only`);
  }
  return paths;
}

/**
 * Register the media-publish tool surface on the calling composition.
 *
 * @param {any} ctx - registrant context carrying the tool registry.
 * @param {Record<string, any>} [config] - configuration from the bundle patch row.
 */
export function apply(ctx, config = {}) {
  const bootstrapDataDir = resolveBootstrapDataDir({
    patch: config ?? {},
    env: process.env,
    homeDefault: join(homedir(), '.dsh', 'media-publish'),
  });
  const configStore = createConfigStore({ patch: config ?? {}, bootstrapDataDir, env: process.env });
  const settings = configStore.values();

  const dataDir = resolveDataDir(settings);
  const python = resolvePython(settings);

  const engine = new EngineClient({
    pythonPath: python.path,
    pluginRoot: PLUGIN_ROOT,
    dataDir,
    requestTimeoutMs: settings.requestTimeoutMs,
  });

  const debug = log(ctx);
  const resolved = applyWithEngine(ctx, {
    engine,
    settings,
    configStore,
    dataDir,
    python,
    pluginRoot: PLUGIN_ROOT,
  });

  registerSettingsPolicy(ctx);

  /** Read-only, cheap and path-free: the page calls this on every open, so it must not start the engine. */
  const statusThunk = () => ({
    pluginVersion: PLUGIN_VERSION,
    engineRunning: engine.running === true,
    engineExitCount: Number.isInteger(engine.exitedCount) ? engine.exitedCount : null,
    pythonSource: python.source,
    pythonExists: python.exists === true,
    pythonProbe: python.probe,
    dataDirIsDefault: settings.dataDir === null || settings.dataDir === undefined,
    configFileWritable: existsSync(dirname(configStore.filePath)),
  });
  registerConfigRoutes(ctx, {
    configStore,
    status: statusThunk,
    log: debug,
    engine,
    // A function, not a value: changing `dataDir` through the page moves where sign-ins are stored.
    dataDir: () => resolveDataDir(settings),
  });

  /**
   * Push a configuration change into running work.
   *
   * `headless` and `requireExplicitPublish` need nothing here: the tools read them from the live
   * `settings` object per call. The other three reach the engine process, so it is reconfigured and 鈥?   * when the interpreter or the data root moved 鈥?closed, so the next engine call starts a fresh process
   * with the new options. The tool surface is then rebuilt so the Node-side readers (recipe catalogue,
   * `proxies.yaml`, run directories) agree with the engine about which data root is in force.
   *
   * @param {string[]} changed
   */
  async function reconfigure(changed) {
    const nextDataDir = resolveDataDir(settings);
    const needsToolReload = changed.some((name) => ['pythonPath', 'dataDir', 'requestTimeoutMs'].includes(name));
    if (changed.includes('pythonPath')) {
      const probed = resolvePython(settings);
      resolved.python = probed;
      debug(`config change: pythonPath 鈫?${probed.source}:${probed.path} (exists=${probed.exists})`);
    }
    if (nextDataDir !== resolved.dataDir) {
      resolved.dataDir = nextDataDir;
      debug(`config change: dataDir 鈫?${nextDataDir}`);
    }
    try {
      await engine.reconfigure({
        pythonPath: resolved.python.path,
        dataDir: resolved.dataDir,
        requestTimeoutMs: settings.requestTimeoutMs,
      });
    } catch (error) {
      debug(`engine.reconfigure failed: ${error?.message ?? error}`);
    }
    if (needsToolReload) {
      const outcome = resolved.reloadTools();
      if (!outcome.ok) debug(`tool surface reload failed: ${outcome.message}`);
    }
  }

  const unsubscribe = configStore.subscribe((_values, meta) => {
    void reconfigure(meta.changed ?? []);
  });

  // The engine is a child process; it must not outlive the composition that owns it.
  ctx.on('dispose', () => {
    try {
      unsubscribe();
    } catch {
      /* the subscription is best-effort at teardown */
    }
    void engine.close();
  });

  return resolved;
}

/** Re-exported so tests and the probe harness can build the same defaults the plugin uses. */
export { CONFIG_DEFAULTS };
