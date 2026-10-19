/**
 * config.js — the plugin's own configuration store, with an explicit layer precedence.
 *
 * Why this exists: the plugin owns five behaviour knobs, and the GUI's Settings → Plugins page lets an
 * operator change them one at a time. The native `@deepseek-ai/dsh-settings` form is Config-derived and
 * exposes only fields a plugin declares with `.volatile()` on a `@deepseek-ai/schemastery` schema — and
 * this package deliberately imports no DSH package at all (a bare import in the host half makes the whole
 * entry fail to activate, see README §"为什么插件是零运行时依赖"). So the page is plugin-owned, and this
 * module is the authoritative store it reads and writes through.
 *
 * Effective value order, lowest to highest:
 *
 *   1. built-in defaults                      (`CONFIG_DEFAULTS`)
 *   2. environment                            (`MEDIA_PYTHON`, `MEDIA_DATA_DIR` — preserved behaviour)
 *   3. the bundle patch config                (`cordis.patch.yml`'s row `config`)
 *   4. the user's explicit GUI choice         (`<bootstrapDataDir>/config.json`)
 *
 * Layer 4 wins because it is the operator's deliberate, per-field action; the patch stays the
 * deployment-level default so an upgrade that restates the patch never silently reverts a GUI choice.
 *
 * One bootstrap subtlety, deliberate and documented: `config.json` lives in the **bootstrap** data root
 * (layer 1–3 only), never in the effective one. Otherwise `dataDir` would define the location of the file
 * that defines `dataDir`. Setting `dataDir` in the GUI therefore moves accounts/recipes/runs, and leaves
 * the config file where it is.
 *
 * Zero external imports: only `node:*` builtins.
 *
 * @module media-publish/config
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Name of the user config file inside the bootstrap data root. */
export const CONFIG_FILE_NAME = 'config.json';

/** Format version written into the file; a reader tolerates its absence. */
export const CONFIG_FILE_VERSION = 1;

/** Where an effective value came from, highest layer that supplied it. */
export const CONFIG_SOURCES = Object.freeze({
  DEFAULT: 'default',
  ENV: 'env',
  PATCH: 'patch',
  FILE: 'config-file',
});

/** Every field the store owns. Anything not in here can never be read or written through it. */
export const CONFIG_KEYS = Object.freeze([
  'pythonPath', 'dataDir', 'headless', 'requireExplicitPublish', 'requestTimeoutMs',
]);

/** Defaults for everything the bundle patch may omit. Also layer 1 of the precedence. */
export const CONFIG_DEFAULTS = Object.freeze({
  pythonPath: null,
  dataDir: null,
  headless: false,
  requireExplicitPublish: true,
  requestTimeoutMs: 120_000,
});

/** Smallest accepted `requestTimeoutMs`; below this every engine call would race its own startup. */
export const MIN_TIMEOUT_MS = 1_000;
/** Largest accepted `requestTimeoutMs` (one hour); beyond this a hung call holds a session forever. */
export const MAX_TIMEOUT_MS = 3_600_000;

/**
 * True when a string carries no control character. Every path-ish value is checked, because a newline in
 * a path would corrupt the config file and a NUL would be rejected deeper down with a worse message.
 * @param {string} text
 */
function plainText(text) {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(text);
}

/**
 * A path field: `null`, or a non-empty absolute path. Relative paths are refused rather than resolved,
 * because the plugin's working directory is the package root and the operator's intent is never that.
 * @param {string} label
 * @param {(text: string) => string|null} extra - extra check, returns a message or null.
 * @returns {(value: unknown) => { ok: true, value: string|null }|{ ok: false, message: string }}
 */
function pathField(label, extra) {
  return (value) => {
    if (value === null || value === undefined || value === '') return { ok: true, value: null };
    if (typeof value !== 'string') {
      return { ok: false, message: `${label} must be null or a string (got ${describe(value)})` };
    }
    const text = value.trim();
    if (!text) return { ok: true, value: null };
    if (text.length > 4096) return { ok: false, message: `${label} is longer than 4096 characters` };
    if (!plainText(text)) return { ok: false, message: `${label} must not contain control characters` };
    const complaint = extra(text);
    if (complaint) return { ok: false, message: complaint };
    return { ok: true, value: text };
  };
}

/**
 * A JSON-ish type name for an error message, so a refusal says what it got rather than "invalid".
 * @param {unknown} value
 */
export function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Field descriptors: the single source of truth for validation, the GUI page's labels, the tool's
 * description and the `media_config` output. `applies` says when a change reaches running work:
 *   - `live`            the next tool call uses it (the knob is read per call);
 *   - `engine-restart`  the running engine process is closed and the next call starts a new one.
 */
export const CONFIG_FIELDS = Object.freeze([
  Object.freeze({
    name: 'pythonPath',
    type: 'string|null',
    applies: 'engine-restart',
    default: null,
    label: { zh: 'Python 解释器路径', en: 'Python interpreter path' },
    description: {
      zh: '装有 Playwright 的解释器。留空 = 按「DSH 运行时自带 → PATH」探测；只写命令名（如 python）也按 PATH 解析。',
      en: 'The interpreter that has Playwright. Empty = probe the DSH runtime interpreter, then PATH; a bare command name such as "python" is resolved on PATH.',
    },
    validate: pathField('pythonPath', (text) => {
      // A bare command name is resolved on PATH and cannot be checked here; a real path must exist,
      // otherwise the operator has almost certainly made a mistake and the engine would fail at spawn.
      const looksLikePath = text.includes('/') || text.includes('\\');
      if (looksLikePath && !existsSync(text)) return `pythonPath does not exist: ${text}`;
      return null;
    }),
  }),
  Object.freeze({
    name: 'dataDir',
    type: 'string|null',
    applies: 'engine-restart',
    default: null,
    label: { zh: '运行时数据目录', en: 'Runtime data root' },
    description: {
      zh: '账号、登录态、recipe、run 的根目录。留空 = %USERPROFILE%\\.dsh\\media-publish（或 MEDIA_DATA_DIR）。必须是绝对路径。',
      en: 'Root for accounts, login state, recipes and runs. Empty = %USERPROFILE%\\.dsh\\media-publish (or MEDIA_DATA_DIR). Must be absolute.',
    },
    validate: pathField('dataDir', (text) => {
      if (!isAbsolute(text)) return `dataDir must be an absolute path (got "${text}")`;
      if (existsSync(text) && !statSync(text).isDirectory()) return `dataDir exists but is not a directory: ${text}`;
      return null;
    }),
  }),
  Object.freeze({
    name: 'headless',
    type: 'boolean',
    applies: 'live',
    default: false,
    label: { zh: '默认无头浏览器', en: 'Default to headless browsers' },
    description: {
      zh: '会话/回放的默认值（调用方仍可用 headless 参数覆盖）。头条号会静默拦截无头发布，所以默认 false。',
      en: 'Default for session open and replay; a caller may still pass headless explicitly. Toutiao silently blocks headless publishes, so the default is false.',
    },
    validate: (value) => (typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, message: `headless must be true or false (got ${describe(value)})` }),
  }),
  Object.freeze({
    name: 'requireExplicitPublish',
    type: 'boolean',
    applies: 'live',
    default: true,
    label: { zh: '真发需显式确认', en: 'Require an explicit real publish' },
    description: {
      zh: '为 true 时，dryRun:false 的真发布会额外给出 REAL PUBLISH 告警。注意真正的闸门是 dryRun 默认为 true，与本项无关。',
      en: 'When true, a real publish (dryRun:false) also carries a REAL PUBLISH warning. The actual gate is that dryRun defaults to true; this field only adds the warning.',
    },
    validate: (value) => (typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, message: `requireExplicitPublish must be true or false (got ${describe(value)})` }),
  }),
  Object.freeze({
    name: 'requestTimeoutMs',
    type: 'integer',
    applies: 'engine-restart',
    default: 120_000,
    label: { zh: '引擎请求超时（毫秒）', en: 'Engine request timeout (ms)' },
    description: {
      zh: `单次引擎请求的默认上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}。长回放改用每次调用自己的超时。`,
      en: `Default ceiling for one engine request, ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}. Long replays pass their own per-call timeout.`,
    },
    validate: (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, message: `requestTimeoutMs must be a number (got ${describe(value)})` };
      }
      if (!Number.isInteger(value)) return { ok: false, message: `requestTimeoutMs must be a whole number of milliseconds (got ${value})` };
      if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
        return { ok: false, message: `requestTimeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} (got ${value})` };
      }
      return { ok: true, value };
    },
  }),
]);

/** Field descriptor by name, or `undefined` for a key the store does not own. */
const FIELD_BY_NAME = new Map(CONFIG_FIELDS.map((field) => [field.name, field]));

/**
 * Validate one value for one known field.
 * @param {string} name
 * @param {unknown} value
 * @returns {{ ok: true, value: unknown }|{ ok: false, message: string }}
 */
export function validateField(name, value) {
  const field = FIELD_BY_NAME.get(name);
  if (!field) return { ok: false, message: `unknown configuration field "${String(name)}"` };
  return field.validate(value);
}

/**
 * Read `<bootstrapDataDir>/config.json` tolerantly. A missing file is the normal first-run case; a
 * malformed or partly unknown file never throws and never contributes an unknown key.
 *
 * @param {string} filePath
 * @returns {{ values: Record<string, unknown>, warnings: string[], exists: boolean, revision: number }}
 */
export function readConfigFile(filePath) {
  /** @type {Record<string, unknown>} */
  const values = {};
  /** @type {string[]} */
  const warnings = [];
  if (!existsSync(filePath)) return { values, warnings, exists: false, revision: 0 };
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    return { values, warnings: [`config.json is unreadable (${error.code ?? error.message}); using the layers below it`], exists: true, revision: 0 };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { values, warnings: [`config.json is not valid JSON (${error.message}); using the layers below it`], exists: true, revision: 0 };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { values, warnings: ['config.json must contain a JSON object; using the layers below it'], exists: true, revision: 0 };
  }
  // Accept both the written envelope {version, values} and a bare map of field values (hand edits).
  const body = raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values) ? raw.values : raw;
  let revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  for (const [key, candidate] of Object.entries(body)) {
    if (key === 'version' || key === 'revision') continue;
    if (!FIELD_BY_NAME.has(key)) {
      warnings.push(`config.json ignores unknown key "${key}"`);
      continue;
    }
    const checked = validateField(key, candidate);
    if (!checked.ok) {
      warnings.push(`config.json ignores ${key}: ${checked.message}`);
      continue;
    }
    values[key] = checked.value;
  }
  return { values, warnings, exists: true, revision };
}

/**
 * Write the user layer atomically (temp file + rename), so a crash mid-write cannot leave a half file
 * that the next read would have to reject.
 *
 * @param {string} filePath
 * @param {Record<string, unknown>} values - only owned keys are written.
 * @param {number} revision
 */
export function writeConfigFile(filePath, values, revision) {
  /** @type {Record<string, unknown>} */
  const body = {};
  for (const key of CONFIG_KEYS) if (values[key] !== undefined) body[key] = values[key];
  const payload = `${JSON.stringify({ version: CONFIG_FILE_VERSION, revision, values: body }, null, 2)}\n`;
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  writeFileSync(temp, payload, 'utf8');
  renameSync(temp, filePath);
  return filePath;
}

/**
 * The bootstrap data root: defaults ← environment ← patch, i.e. every layer except `config.json` itself.
 * This is where the config file lives, which is what keeps `dataDir` from defining its own location.
 *
 * @param {{ patch?: Record<string, any>, env?: Record<string, string|undefined>, homeDefault: string }} input
 * @returns {string}
 */
export function resolveBootstrapDataDir({ patch = {}, env = process.env, homeDefault }) {
  for (const candidate of [patch.dataDir, env.MEDIA_DATA_DIR, homeDefault]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return homeDefault;
}

/**
 * Build the live configuration store.
 *
 * `values()` always returns the SAME object, mutated in place: the whole tool surface holds one reference
 * to it, so a write through the GUI or through `media_config` changes what the next tool call reads
 * without re-registering anything.
 *
 * @param {{ patch?: Record<string, any>, bootstrapDataDir: string, env?: Record<string, string|undefined> }} input
 */
export function createConfigStore({ patch = {}, bootstrapDataDir, env = process.env }) {
  const filePath = join(bootstrapDataDir, CONFIG_FILE_NAME);

  /** Normalized patch layer: only owned keys, already type-checked, so a bad patch value cannot win. */
  const patchValues = /** @type {Record<string, unknown>} */ ({});
  const patchWarnings = [];
  for (const key of CONFIG_KEYS) {
    if (patch[key] === undefined) continue;
    const checked = validateField(key, patch[key]);
    if (checked.ok) patchValues[key] = checked.value;
    else patchWarnings.push(`the bundle patch config ignores ${key}: ${checked.message}`);
  }

  /** Environment layer, matching the precedence the resolver had before this module existed. */
  const envValues = /** @type {Record<string, unknown>} */ ({});
  if (env.MEDIA_PYTHON) envValues.pythonPath = String(env.MEDIA_PYTHON);
  if (env.MEDIA_DATA_DIR) envValues.dataDir = String(env.MEDIA_DATA_DIR);

  const file = readConfigFile(filePath);
  const userValues = { ...file.values };
  /** @type {string[]} */
  const fileWarnings = [...file.warnings];
  let revision = file.revision;

  /** @type {Record<string, unknown>} */
  const effective = {};
  /** @type {Record<string, string>} */
  const sources = {};
  /** @type {Array<(effective: Record<string, unknown>, meta: { changed: string[] }) => void>} */
  const listeners = [];

  function recompute(changed = CONFIG_KEYS) {
    for (const key of CONFIG_KEYS) {
      const layers = [
        [CONFIG_SOURCES.DEFAULT, CONFIG_DEFAULTS[key]],
        [CONFIG_SOURCES.ENV, envValues[key]],
        [CONFIG_SOURCES.PATCH, patchValues[key]],
        [CONFIG_SOURCES.FILE, userValues[key]],
      ];
      let winner = CONFIG_DEFAULTS[key];
      let from = CONFIG_SOURCES.DEFAULT;
      // `null` means "not configured" for the two path fields, so a layer holding null simply does not
      // win — the layer beneath it stays authoritative. That is also why clearing a path override is
      // `reset` (delete the user-layer key) rather than storing a null: it restores the patch value.
      for (const [source, candidate] of layers) {
        if (candidate === undefined || candidate === null) continue;
        winner = candidate;
        from = source;
      }
      effective[key] = winner;
      sources[key] = from;
    }
    for (const listener of listeners) listener(effective, { changed });
  }

  recompute();

  /**
   * Write the user layer, leaving a stranded temp file behind on failure rather than a half-written
   * `config.json` (the temp file is removed on a best-effort basis).
   * @returns {{ ok: true }|{ ok: false, message: string }}
   */
  function persistFile() {
    try {
      writeConfigFile(filePath, userValues, revision);
      return { ok: true };
    } catch (error) {
      try {
        if (existsSync(`${filePath}.tmp`)) rmSync(`${filePath}.tmp`, { force: true });
      } catch {
        /* the failed write is the error worth reporting, not the cleanup */
      }
      return { ok: false, message: `could not write ${CONFIG_FILE_NAME}: ${error.code ?? error.message}` };
    }
  }

  /**
   * Apply a new user layer transactionally: the file is written first and `revision` is rolled back with
   * it, so a refused write changes **nothing** observable — not the file, not `revision()`, not
   * `values()`/`fields()`. Getting this wrong made a failed write leave a revision that did not exist on
   * disk (defeating the stale-write check) and a `userValues` that disagreed with the effective values.
   *
   * @param {Record<string, unknown>} next - the complete new user layer.
   * @param {string[]} changed - the fields that actually differ, in `CONFIG_KEYS` order.
   */
  function commit(next, changed) {
    const snapshot = { ...userValues };
    const before = revision;
    const pending = next;
    for (const key of Object.keys(userValues)) delete userValues[key];
    Object.assign(userValues, pending);
    revision = before + 1;
    const written = persistFile();
    if (!written.ok) {
      for (const key of Object.keys(userValues)) delete userValues[key];
      Object.assign(userValues, snapshot);
      revision = before;
      return { ok: false, message: written.message };
    }
    recompute(changed);
    return { ok: true, revision, changed: [...changed] };
  }

  return {
    /** Where the user layer is written; also the only path this module ever writes. */
    filePath,
    /** Warnings from reading/validating the user file and the patch layer, newest file read included. */
    warnings() {
      return [...patchWarnings, ...fileWarnings];
    },
    /** The live effective values object — the SAME reference for the lifetime of the store. */
    values() {
      return effective;
    },
    /** Where one effective value came from. */
    sourceOf(name) {
      return sources[name] ?? CONFIG_SOURCES.DEFAULT;
    },
    revision() {
      return revision;
    },
    /** The effective runtime data root (never the config file's own directory). */
    dataDir() {
      return effective.dataDir ?? bootstrapDataDir;
    },
    bootstrapDataDir() {
      return bootstrapDataDir;
    },
    /** Every field with its effective value, its default and the layer it came from. */
    fields() {
      return CONFIG_FIELDS.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        description: field.description,
        applies: field.applies,
        default: field.default,
        value: effective[field.name] === undefined ? null : effective[field.name],
        effectiveFrom: sources[field.name] ?? CONFIG_SOURCES.DEFAULT,
        overridden: sources[field.name] === CONFIG_SOURCES.FILE,
      }));
    },
    /**
     * Validate and persist a set of user-layer values.
     * @param {Record<string, unknown>} input
     * @returns {{ ok: true, revision: number, changed: string[] }|{ ok: false, message: string, field?: string }}
     */
    set(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'values must be a JSON object of configuration fields' };
      }
      const keys = Object.keys(input);
      if (!keys.length) return { ok: false, message: 'values is empty: nothing to change' };
      for (const key of keys) {
        if (!FIELD_BY_NAME.has(key)) {
          return { ok: false, message: `unknown configuration field "${key}"`, field: key };
        }
      }
      const next = { ...userValues };
      for (const key of keys) {
        const checked = validateField(key, input[key]);
        if (!checked.ok) return { ok: false, message: checked.message, field: key };
        // `null`/'' on a path field clears the user override for that field instead of storing a null.
        if ((key === 'pythonPath' || key === 'dataDir') && checked.value === null) delete next[key];
        else next[key] = checked.value;
      }
      const changed = CONFIG_KEYS.filter((key) => !Object.is(userValues[key], next[key]));
      if (!changed.length) return { ok: true, revision, changed: [] };
      return commit(next, changed);
    },
    /**
     * Drop the user-layer override for the named fields, restoring the layer beneath.
     * @param {string[]} names
     * @returns {{ ok: true, revision: number, changed: string[] }|{ ok: false, message: string, field?: string }}
     */
    reset(names) {
      if (!Array.isArray(names) || !names.length) {
        return { ok: false, message: 'names must be a non-empty array of configuration field names' };
      }
      for (const name of names) {
        if (!FIELD_BY_NAME.has(name)) return { ok: false, message: `unknown configuration field "${String(name)}"`, field: String(name) };
      }
      const next = { ...userValues };
      for (const name of names) delete next[name];
      const changed = CONFIG_KEYS.filter((key) => !Object.is(userValues[key], next[key]));
      if (!changed.length) return { ok: true, revision, changed: [] };
      return commit(next, changed);
    },
    /** Re-read the user layer from disk (used by tests and after an external edit). */
    reload() {
      const next = readConfigFile(filePath);
      fileWarnings.length = 0;
      fileWarnings.push(...next.warnings);
      for (const key of Object.keys(userValues)) delete userValues[key];
      Object.assign(userValues, next.values);
      revision = Math.max(revision, next.revision);
      recompute();
      return { revision, warnings: [...patchWarnings, ...fileWarnings] };
    },
    /**
     * Subscribe to a change of the effective values. Returns the unsubscribe function.
     * @param {(effective: Record<string, unknown>, meta: { changed: string[] }) => void} listener
     */
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
}
