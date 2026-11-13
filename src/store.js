/**
 * store.js — small, dependency-free persistence helpers.
 *
 * Every registry file this plugin owns is JSON written atomically (temp file + rename) so a crash or a
 * concurrent tool call can never leave a half-written accounts/proxies/flows file behind.
 *
 * @module ego-publish/store
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Read JSON, returning `fallback` when the file is missing or unparsable.
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Write JSON atomically, creating parent directories.
 * @param {string} filePath
 * @param {unknown} value
 */
export function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

/** Ensure a directory exists and return it. */
export function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

/** Join and ensure. */
export function ensureSubdir(root, ...parts) {
  return ensureDir(join(root, ...parts));
}

/** A filesystem-safe timestamp such as 20261029-162501. */
export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** ISO timestamp. */
export function now() {
  return new Date().toISOString();
}
