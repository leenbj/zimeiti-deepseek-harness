/**
 * accounts.js — the account registry and the platform defaults it validates against.
 *
 * An account is a publishing identity, not just a row: it owns one isolated ego browser profile
 * directory (cookies, localStorage, sign-in state) and, optionally, one network proxy. Two accounts
 * therefore never share a cookie jar or an exit IP just because they run on the same machine.
 *
 * @module ego-publish/accounts
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { now, readJson, writeJson } from './store.js';

/** Supported platforms and the URLs that make login/check useful out of the box. */
export const MEDIA_DEFAULTS = {
  sohu: {
    label: '搜狐号',
    loginUrl: 'https://mp.sohu.com/mpfe/v4/login',
    homeUrl: 'https://mp.sohu.com/mpfe/v4/contentManagement/first/page',
    loggedInUrlContains: 'contentManagement/first/page',
    loggedOutUrlContains: ['mpfe/v4/login', 'passport', 'sso'],
    loginMarkers: ['发布内容', '内容管理', '创作中心'],
  },
  toutiao: {
    label: '头条号',
    loginUrl: 'https://mp.toutiao.com/auth/page/login',
    homeUrl: 'https://mp.toutiao.com/profile_v4/index',
    loggedInUrlContains: 'profile_v4',
    loggedOutUrlContains: ['auth/page/login', 'passport'],
    loginMarkers: ['发布', '作品管理', '创作平台'],
  },
  csdn: {
    label: 'CSDN',
    loginUrl: 'https://passport.csdn.net/login',
    homeUrl: 'https://mp.csdn.net/mp_blog/manage/article',
    loggedInUrlContains: 'mp_blog',
    loggedOutUrlContains: ['passport.csdn.net', 'login'],
    loginMarkers: ['写文章', '内容管理', '发布'],
  },
  custom: {
    label: '自定义站点',
    loginUrl: '',
    homeUrl: '',
    loggedInUrlContains: '',
    loggedOutUrlContains: [],
    loginMarkers: [],
  },
};

/** Media keys accepted by the registry. */
export const MEDIA_KEYS = Object.keys(MEDIA_DEFAULTS);

/** Account code syntax: stable, filesystem-safe, used in profile directory names. */
export const CODE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

/**
 * Derive the points trend from the stored history.
 * `down` also covers "three samples, non-increasing" so a slow, steady decline is still flagged.
 * @param {Array<{ value: number }>} history
 */
export function pointsTrend(history) {
  if (!Array.isArray(history) || history.length < 2) return { trend: 'unknown', delta: 0 };
  const last = history[history.length - 1].value;
  const prev = history[history.length - 2].value;
  const delta = last - prev;
  let declining = false;
  if (history.length >= 3) {
    const [a, b, c] = history.slice(-3).map((item) => item.value);
    declining = a >= b && b >= c && a > c;
  }
  return { trend: delta < 0 || declining ? 'down' : delta > 0 ? 'up' : 'flat', delta };
}

/**
 * A copy of the registry without credentials.
 * @param {Record<string, any>} account
 */
export function publicAccount(account) {
  if (!account) return null;
  const proxy = account.proxy
    ? {
      server: account.proxy.server,
      hasAuth: Boolean(account.proxy.username || account.proxy.password),
      username: account.proxy.username ?? null,
    }
    : null;
  const points = account.points
    ? {
      ...account.points,
      ...pointsTrend(account.points.history),
      history: (account.points.history ?? []).slice(-20),
    }
    : null;
  return {
    code: account.code,
    media: account.media,
    label: MEDIA_DEFAULTS[account.media]?.label ?? account.media,
    account: account.account ?? '',
    note: account.note ?? '',
    loginUrl: account.loginUrl ?? '',
    homeUrl: account.homeUrl ?? '',
    profileDir: account.profileDir,
    hasProfile: existsSync(account.profileDir),
    proxy,
    proxyId: account.proxyId ?? null,
    proxyMode: account.proxyMode ?? 'static',
    points,
    lastLoginAt: account.lastLoginAt ?? null,
    lastCheck: account.lastCheck ?? null,
    createdAt: account.createdAt ?? null,
    updatedAt: account.updatedAt ?? null,
  };
}

/**
 * The accounts registry (`<dataDir>/accounts.json`).
 */
export class AccountStore {
  /**
   * @param {{ dataDir: string, log?: (line: string) => void }} input
   */
  constructor(input) {
    this.filePath = join(input.dataDir, 'accounts.json');
    this.dataDir = input.dataDir;
    this.log = input.log ?? (() => {});
    this.data = readJson(this.filePath, { version: 1, accounts: [] });
    if (!this.data || !Array.isArray(this.data.accounts)) this.data = { version: 1, accounts: [] };
  }

  save() {
    writeJson(this.filePath, this.data);
  }

  /** All account records, in insertion order. */
  list() {
    return this.data.accounts;
  }

  /** Public projection of all accounts. */
  listPublic() {
    return this.data.accounts.map(publicAccount);
  }

  /**
   * @param {string} code
   * @returns {Record<string, any> | null}
   */
  get(code) {
    return this.data.accounts.find((account) => account.code === code) ?? null;
  }

  /**
   * Create or update an account.
   * @param {Record<string, any>} input
   * @returns {Record<string, any>}
   */
  upsert(input) {
    const code = String(input.code ?? '').trim().toLowerCase();
    if (!CODE_PATTERN.test(code)) {
      const error = new Error(`invalid account code "${code}": use lowercase letters, digits, '_', '.' or '-' (max 32 chars)`);
      error.code = 'INVALID_ACCOUNT_CODE';
      throw error;
    }
    const media = String(input.media ?? 'custom');
    if (!MEDIA_KEYS.includes(media)) {
      const error = new Error(`invalid media "${media}": use one of ${MEDIA_KEYS.join(', ')}`);
      error.code = 'INVALID_MEDIA';
      throw error;
    }
    const defaults = MEDIA_DEFAULTS[media];
    const existing = this.get(code);
    const profileDir = join(this.dataDir, 'profiles', code);
    const timestamp = now();
    const record = existing ?? {
      code,
      profileDir,
      createdAt: timestamp,
      lastLoginAt: null,
      lastCheck: null,
      proxy: null,
      proxyId: null,
    };
    record.media = media;
    record.account = String(input.account ?? record.account ?? '');
    record.note = String(input.note ?? record.note ?? '');
    record.loginUrl = String(input.loginUrl ?? record.loginUrl ?? defaults.loginUrl);
    record.homeUrl = String(input.homeUrl ?? record.homeUrl ?? defaults.homeUrl);
    if (input.proxy !== undefined) {
      record.proxy = input.proxy === null ? null : normalizeProxyRecord(input.proxy);
    }
    if (input.proxyId !== undefined) {
      record.proxyId = input.proxyId === null || input.proxyId === '' ? null : String(input.proxyId);
      // Assigning "direct" must really go direct, even if a legacy inline proxy is still stored.
      if (record.proxyId === null) record.proxy = null;
    }
    if (input.proxyMode !== undefined) {
      record.proxyMode = input.proxyMode === 'dynamic' ? 'dynamic' : 'static';
    }
    record.updatedAt = timestamp;
    if (!existing) this.data.accounts.push(record);
    this.save();
    return record;
  }

  /**
   * Remove an account; optionally delete its whole browser profile (cookies and login state).
   * @param {string} code
   * @param {{ removeProfile?: boolean }} [options]
   * @returns {{ removed: boolean, profileDeleted: boolean, profileDir: string }}
   */
  remove(code, options = {}) {
    const index = this.data.accounts.findIndex((account) => account.code === code);
    if (index < 0) return { removed: false, profileDeleted: false, profileDir: '' };
    const [record] = this.data.accounts.splice(index, 1);
    this.save();
    let profileDeleted = false;
    if (options.removeProfile && record.profileDir && existsSync(record.profileDir)) {
      try {
        rmSync(record.profileDir, { recursive: true, force: true });
        profileDeleted = true;
      } catch (error) {
        this.log(`could not delete the profile ${record.profileDir}: ${error?.message ?? error}`);
      }
    }
    return { removed: true, profileDeleted, profileDir: record.profileDir ?? '' };
  }

  /**
   * Update bookkeeping fields without touching identity.
   * @param {string} code
   * @param {Record<string, any>} patch
   */
  touch(code, patch) {
    const record = this.get(code);
    if (!record) return null;
    Object.assign(record, patch, { updatedAt: now() });
    this.save();
    return record;
  }

  /**
   * Point one account at a pool proxy (or at direct with null).
   * @param {string} code
   * @param {string|null} proxyId
   */
  setProxyId(code, proxyId) {
    const record = this.get(code);
    if (!record) return null;
    record.proxyId = proxyId === null || proxyId === '' ? null : String(proxyId);
    if (record.proxyId === null) record.proxy = null;
    record.updatedAt = now();
    this.save();
    return record;
  }

  /**
   * Drop every reference to a removed pool proxy, falling those accounts back to direct.
   * @param {string} proxyId
   * @returns {string[]} the account codes that were re-pointed
   */
  clearProxyId(proxyId) {
    const affected = [];
    for (const record of this.data.accounts) {
      if (record.proxyId !== proxyId) continue;
      record.proxyId = null;
      record.proxy = null;
      record.updatedAt = now();
      affected.push(record.code);
    }
    if (affected.length) this.save();
    return affected;
  }

  /** Map proxy id -> account codes using it. */
  proxyUsage() {
    /** @type {Record<string, string[]>} */
    const usage = {};
    for (const record of this.data.accounts) {
      const id = record.proxyId;
      if (!id) continue;
      (usage[id] ??= []).push(record.code);
    }
    return usage;
  }

  /**
   * Store the latest points sample (and history) for one account.
   * @param {string} code
   * @param {Record<string, any>} points
   */
  mergePoints(code, points) {
    const record = this.get(code);
    if (!record) return null;
    record.points = points;
    record.updatedAt = now();
    this.save();
    return record;
  }
}

/**
 * Validate and normalize a proxy record before it is stored.
 * @param {{ server?: string, username?: string, password?: string } | string} input
 */
export function normalizeProxyRecord(input) {
  const server = typeof input === 'string' ? input : input?.server;
  if (typeof server !== 'string' || !server.trim()) {
    const error = new Error('proxy.server is required');
    error.code = 'INVALID_PROXY';
    throw error;
  }
  const username = typeof input === 'object' ? String(input.username ?? '') : '';
  const password = typeof input === 'object' ? String(input.password ?? '') : '';
  return {
    server: server.trim(),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}
