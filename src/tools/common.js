/**
 * tools/common.js — shared plumbing for the `egolite_*` tools.
 *
 * Shapes tool results into one envelope, keeps logging off stdout, and resolves an account plus a live
 * page in one step so every page-level tool reads the same way.
 *
 * @module ego-publish/tools/common
 */
import { dirname } from 'node:path';

import { EgoError } from '../cdp.js';
import { renderValue } from '../tool-kit.js';

/** Per-call ceilings. They are guidance for the model, not enforcement. */
export const TIMEOUT = {
  STATUS_MS: 30_000,
  OPEN_MS: 120_000,
  OBSERVE_MS: 60_000,
  ACT_MS: 120_000,
  LOGIN_MS: 660_000,
  PUBLISH_MS: 1_200_000,
  SCRIPT_MS: 300_000,
  PROXY_MS: 60_000,
  CHECK_MS: 180_000,
};

/** Keys whose value is a credential and must never reach the model. */
const SECRET_KEYS = new Set(['password', 'passwd', 'pass', 'pwd']);

/**
 * Debug logger that never writes to stdout.
 * @param {any} ctx
 * @returns {(line: string) => void}
 */
export function log(ctx) {
  return (line) => {
    try {
      ctx?.logger?.('ego-publish')?.debug?.(String(line));
    } catch {
      /* logging must never break a tool call */
    }
  };
}

/**
 * Deep-copy a value with credentials removed and JSON losslessness preserved.
 * @param {unknown} value
 * @param {number} [depth]
 */
export function sanitize(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') return null;
    return value;
  }
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = sanitize(value[index], depth + 1);
      items.push(item === undefined ? null : item);
    }
    return items;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  let hadSecret = false;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      hadSecret = hadSecret || Boolean(item);
      continue;
    }
    const cleaned = sanitize(item, depth + 1);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  if (hadSecret && out.hasPassword === undefined) out.hasPassword = true;
  return out;
}

/**
 * Build the common success envelope.
 * @param {string} message
 * @param {Record<string, any>} [data]
 * @param {{ nextSteps?: string[], [key: string]: any }} [extra]
 */
export function ok(message, data = {}, extra = {}) {
  return sanitize({ ok: true, message, data, ...extra });
}

/**
 * Throw a stable coded error.
 * @param {string} code
 * @param {string} message
 * @param {Record<string, any>} [details]
 */
export function fail(code, message, details = {}) {
  throw new EgoError(code, message, details);
}

/**
 * Render an envelope with one headline plus the payload.
 * @param {string} headline
 * @param {Record<string, any>} value
 * @returns {Array<{type:'text',text:string}>}
 */
export function renderEnvelope(headline, value) {
  return renderValue(headline, value);
}

/**
 * Resolve an account, or fail with a model-actionable message.
 * @param {import('../accounts.js').AccountStore} accounts
 * @param {string} code
 */
export function requireAccount(accounts, code) {
  const account = accounts.get(code);
  if (!account) {
    fail('ACCOUNT_NOT_FOUND', `no account with code "${code}"`, {
      hint: 'Call egolite_account {op:"upsert", code:"a-1", media:"sohu", account:"<login name>"} first.',
      known: accounts.list().map((item) => item.code),
    });
  }
  return account;
}

/**
 * Open (or reuse) the account browser and return its page.
 * @param {import('../browser.js').BrowserManager} manager
 * @param {string} code
 * @param {{ headless?: boolean }} [options]
 */
export async function openPage(manager, code, options = {}) {
  const session = await manager.open(code, options);
  return { session, page: session.page };
}

/** Path helpers kept here so tools never import node:path just for a join. */
export function pluginDirOf(filePath) {
  return dirname(filePath);
}

/** Convenience: a compact one-line description of an error. */
export function errorText(error) {
  const code = error?.code ?? 'ERROR';
  return `${code}: ${error?.message ?? error}`;
}
