/**
 * proxies.js — a reusable proxy pool that accounts can share.
 *
 * Entries are stored once in `<dataDir>/proxies.json` and an account points at one by `proxyId`, so the
 * same proxy can be assigned to several account windows and re-pointed without retyping credentials.
 * Legacy inline `account.proxy` values keep working: resolution falls back to them when no `proxyId` is
 * set (or the referenced entry is gone).
 *
 * @module ego-publish/proxies
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { EgoError } from './cdp.js';
import { parseProxy, redactProxy } from './proxy.js';
import { now, readJson, writeJson } from './store.js';

/**
 * Validate a proxy descriptor before it reaches the pool.
 * @param {{ server?: string, username?: string, password?: string }} input
 */
function validateProxy(input) {
  const parsed = parseProxy(input);
  if (!parsed) throw new EgoError('INVALID_PROXY', 'a proxy server is required');
  return {
    server: parsed.url,
    username: parsed.username || '',
    password: parsed.password || '',
  };
}

/**
 * A redacted projection of one pool entry.
 * @param {Record<string, any>} entry
 * @param {string[]} [assigned]
 */
export function publicProxy(entry, assigned = []) {
  if (!entry) return null;
  return {
    id: entry.id,
    label: entry.label || entry.id,
    server: entry.server,
    hasAuth: Boolean(entry.username || entry.password),
    username: entry.username || null,
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
    lastTest: entry.lastTest ?? null,
    assigned,
  };
}

/**
 * Resolve the proxy an account actually uses at launch time.
 * @param {Record<string, any>} account
 * @param {{ get: (id: string) => Record<string, any> | null }} store
 * @returns {{ server: string, username?: string, password?: string, source: string } | null}
 */
export function resolveAccountProxy(account, store) {
  if (account?.proxyId) {
    const entry = store?.get?.(account.proxyId);
    if (entry) {
      return {
        server: entry.server,
        ...(entry.username ? { username: entry.username } : {}),
        ...(entry.password ? { password: entry.password } : {}),
        source: `pool:${entry.id}`,
      };
    }
  }
  const inline = account?.proxy;
  if (inline && inline.server) {
    return {
      server: inline.server,
      ...(inline.username ? { username: inline.username } : {}),
      ...(inline.password ? { password: inline.password } : {}),
      source: 'inline',
    };
  }
  return null;
}

/**
 * The proxy pool (`<dataDir>/proxies.json`).
 */
export class ProxyStore {
  /** @param {{ dataDir: string }} input */
  constructor(input) {
    this.filePath = join(input.dataDir, 'proxies.json');
    this.data = readJson(this.filePath, { version: 1, proxies: [] });
    if (!this.data || !Array.isArray(this.data.proxies)) this.data = { version: 1, proxies: [] };
  }

  save() {
    writeJson(this.filePath, this.data);
  }

  /** Raw entries (contain credentials; never hand these to the model). */
  list() {
    return this.data.proxies;
  }

  /** @param {string} id */
  get(id) {
    return this.data.proxies.find((entry) => entry.id === id) ?? null;
  }

  /** @param {Record<string, string[]>} assignments */
  listPublic(assignments = {}) {
    return this.data.proxies.map((entry) => publicProxy(entry, assignments[entry.id] ?? []));
  }

  #nextId() {
    let index = this.data.proxies.length + 1;
    const taken = new Set(this.data.proxies.map((entry) => entry.id));
    while (taken.has(`p-${index}`)) index += 1;
    return `p-${index}`;
  }

  /**
   * Add a pool entry.
   * @param {{ label?: string, server: string, username?: string, password?: string }} input
   */
  add(input) {
    const valid = validateProxy(input);
    const timestamp = now();
    const entry = {
      id: this.#nextId(),
      label: String(input.label ?? '').trim() || valid.server,
      ...valid,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastTest: null,
    };
    this.data.proxies.push(entry);
    this.save();
    return entry;
  }

  /**
   * Update one entry. Omitted credential fields keep their current value; pass an empty string to clear.
   * @param {string} id
   * @param {{ label?: string, server?: string, username?: string, password?: string }} patch
   */
  update(id, patch) {
    const entry = this.get(id);
    if (!entry) throw new EgoError('PROXY_NOT_FOUND', `no proxy with id "${id}"`);
    const merged = {
      server: patch.server ?? entry.server,
      username: patch.username ?? entry.username,
      password: patch.password ?? entry.password,
    };
    const valid = validateProxy(merged);
    entry.server = valid.server;
    entry.username = valid.username;
    entry.password = valid.password;
    if (patch.label !== undefined) entry.label = String(patch.label).trim() || valid.server;
    entry.updatedAt = now();
    entry.lastTest = null;
    this.save();
    return entry;
  }

  /** @param {string} id */
  remove(id) {
    const index = this.data.proxies.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.data.proxies.splice(index, 1);
    this.save();
    return true;
  }

  /**
   * Record the result of an exit-IP probe.
   * @param {string} id
   * @param {{ ip: string|null, latencyMs: number, at?: string }} result
   */
  markTest(id, result) {
    const entry = this.get(id);
    if (!entry) return null;
    entry.lastTest = { ok: true, ip: result.ip, latencyMs: result.latencyMs, at: result.at ?? now() };
    this.save();
    return entry;
  }

  /** Utilities used by the status route and the page. */
  get fileExists() {
    return existsSync(this.filePath);
  }
}
