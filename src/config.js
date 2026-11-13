/**
 * config.js — layered, validated configuration for the ego-publish plugin.
 *
 * Layer order (later wins): built-in defaults -> bundle patch row -> `<dataDir>/config.json` ->
 * environment. `dataDir` itself is bootstrap-only (patch/env/home default), because the config file
 * lives inside it; changing the data root is a composition change, not a runtime toggle.
 *
 * @module ego-publish/config
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readJson, writeJson } from './store.js';

/** Built-in defaults, also reported by `egolite_status`. */
export const CONFIG_DEFAULTS = {
  egoPath: null,
  browserPath: null,
  dataDir: null,
  requireExplicitPublish: true,
  idleCloseMinutes: 30,
  loginTimeoutSec: 300,
  actionTimeoutMs: 15000,
  navigationTimeoutMs: 60000,
  pointsRefreshMinutes: 0,
  linkCheckDelayMinutes: 60,
  proxyApiUrl: null,
  proxyApiWhitelist: true,
  proxyWhitelistKey: null,
  proxyWhitelistSign: null,
  dynamicProxyTtlMinutes: 3,
  headless: false,
  engine: 'ego',
  uaMode: 'real',
  preSubmitDwellMinSec: 20,
  preSubmitDwellMaxSec: 60,
  publishIntervalMinMinutes: 45,
  publishIntervalMaxMinutes: 150,
};

/** Closed vocabularies; kept out of the sets below so the validator can name the allowed values. */
const ENUMS = {
  engine: ['ego', 'playwright'],
  uaMode: ['real', 'spoofed'],
};

const STRING_OR_NULL = new Set(['egoPath', 'browserPath', 'dataDir', 'proxyApiUrl', 'proxyWhitelistKey', 'proxyWhitelistSign']);
const BOOLEANS = new Set(['requireExplicitPublish', 'headless', 'proxyApiWhitelist']);
const NUMBERS = new Set(['idleCloseMinutes', 'loginTimeoutSec', 'actionTimeoutMs', 'navigationTimeoutMs', 'pointsRefreshMinutes', 'linkCheckDelayMinutes', 'dynamicProxyTtlMinutes', 'preSubmitDwellMinSec', 'preSubmitDwellMaxSec', 'publishIntervalMinMinutes', 'publishIntervalMaxMinutes']);

/**
 * Resolve the bootstrap data root before any store exists.
 * @param {{ patch?: Record<string, any>, env?: Record<string, string|undefined>, homeDefault?: string }} input
 * @returns {string}
 */
export function resolveBootstrapDataDir(input = {}) {
  const patch = input.patch ?? {};
  const env = input.env ?? {};
  if (typeof patch.dataDir === 'string' && patch.dataDir.trim()) return patch.dataDir.trim();
  if (typeof env.EGO_PUBLISH_DATA_DIR === 'string' && env.EGO_PUBLISH_DATA_DIR.trim()) return env.EGO_PUBLISH_DATA_DIR.trim();
  return input.homeDefault ?? join(homedir(), '.dsh', 'ego-publish');
}

/**
 * Validate one configuration key/value pair.
 * @param {string} key
 * @param {unknown} value
 * @returns {{ ok: boolean, message?: string }}
 */
export function validateConfigValue(key, value) {
  if (!(key in CONFIG_DEFAULTS)) return { ok: false, message: `${key} is not a known configuration key` };
  if (ENUMS[key]) {
    return ENUMS[key].includes(value)
      ? { ok: true }
      : { ok: false, message: `${key} must be one of ${ENUMS[key].join(', ')}` };
  }
  if (STRING_OR_NULL.has(key)) {
    if (value !== null && typeof value !== 'string') return { ok: false, message: `${key} must be a string or null` };
    if (typeof value === 'string' && (key === 'egoPath' || key === 'browserPath') && !value.trim()) {
      return { ok: false, message: `${key} must not be empty` };
    }
    return { ok: true };
  }
  if (BOOLEANS.has(key)) {
    return typeof value === 'boolean' ? { ok: true } : { ok: false, message: `${key} must be a boolean` };
  }
  if (NUMBERS.has(key)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { ok: false, message: `${key} must be a non-negative number` };
    }
    return { ok: true };
  }
  return { ok: true };
}

/**
 * Pick only known keys from a raw object.
 * @param {Record<string, any>} raw
 * @returns {Record<string, any>}
 */
function pickKnown(raw) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    if (raw && raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

/**
 * Create the configuration store.
 *
 * @param {{ patch?: Record<string, any>, env?: Record<string, string|undefined>, dataDir: string }} input
 * @returns {{
 *   filePath: string,
 *   values: () => Record<string, any>,
 *   sources: () => Record<string, string>,
 *   set: (patch: Record<string, any>) => { ok: boolean, changed: string[], values: Record<string, any>, message?: string },
 *   reset: (keys?: string[]) => Record<string, any>,
 *   subscribe: (fn: (values: Record<string, any>, meta: { changed: string[] }) => void) => () => void,
 * }}
 */
export function createConfigStore(input) {
  const filePath = join(input.dataDir, 'config.json');
  const env = input.env ?? {};
  const patch = pickKnown(input.patch ?? {});
  const fileValues = pickKnown(readJson(filePath, {}));

  /** Effective values (mutated in place so live readers see a change immediately). */
  const values = { ...CONFIG_DEFAULTS };
  /** @type {Record<string, string>} */
  const origins = {};
  for (const key of Object.keys(CONFIG_DEFAULTS)) origins[key] = 'default';

  for (const [key, value] of Object.entries(patch)) {
    values[key] = value;
    origins[key] = 'patch';
  }
  for (const [key, value] of Object.entries(fileValues)) {
    values[key] = value;
    origins[key] = 'file';
  }
  if (typeof env.EGO_EXE === 'string' && env.EGO_EXE.trim()) {
    values.egoPath = env.EGO_EXE.trim();
    origins.egoPath = 'env:EGO_EXE';
  }
  if (typeof env.EGO_PUBLISH_REQUIRE_EXPLICIT === 'string') {
    values.requireExplicitPublish = env.EGO_PUBLISH_REQUIRE_EXPLICIT !== '0';
    origins.requireExplicitPublish = 'env';
  }

  /** @type {Set<(values: Record<string, any>, meta: { changed: string[] }) => void>} */
  const listeners = new Set();

  function notify(changed) {
    for (const listener of [...listeners]) {
      try {
        listener(values, { changed });
      } catch {
        /* a subscriber must never break a configuration write */
      }
    }
  }

  function set(patchInput) {
    const changed = [];
    for (const [key, value] of Object.entries(patchInput ?? {})) {
      const verdict = validateConfigValue(key, value);
      if (!verdict.ok) return { ok: false, changed: [], values, message: verdict.message };
      if (values[key] !== value) {
        values[key] = value;
        origins[key] = 'file';
        changed.push(key);
      }
    }
    if (changed.length) {
      writeJson(filePath, pickKnown({ ...readJson(filePath, {}), ...values }));
      notify(changed);
    }
    return { ok: true, changed, values };
  }

  function reset(keys) {
    const target = keys && keys.length ? keys : Object.keys(CONFIG_DEFAULTS);
    /** @type {Record<string, any>} */
    const stored = readJson(filePath, {});
    for (const key of target) {
      delete stored[key];
      values[key] = CONFIG_DEFAULTS[key];
      origins[key] = 'default';
    }
    writeJson(filePath, pickKnown(stored));
    notify(target);
    return values;
  }

  return {
    filePath,
    values: () => values,
    sources: () => ({ ...origins }),
    set,
    reset,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** True when the config file exists and its directory is writable. */
export function configFileState(filePath) {
  return { exists: existsSync(filePath), writable: (() => {
    try {
      writeJson(filePath, readJson(filePath, {}));
      return true;
    } catch {
      return false;
    }
  })() };
}
