/**
 * ego.js — locate and describe the installed ego lite browser.
 *
 * ego lite ships as a Chromium fork; the executable is `ego.exe` (the app launcher/browser process) and
 * the CLI shim is `ego-browser.exe`. This plugin needs the browser executable, because it starts one
 * isolated instance per account instead of sharing the user's daily window.
 *
 * @module ego-publish/ego
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Candidate browser executables, highest priority first.
 * @param {{ egoPath?: string|null, env?: Record<string, string|undefined> }} input
 * @returns {Array<{ path: string, source: string }>}
 */
export function egoCandidates(input = {}) {
  const env = input.env ?? {};
  /** @type {Array<{ path: string, source: string }>} */
  const candidates = [];
  if (input.egoPath) candidates.push({ path: String(input.egoPath), source: 'config' });
  if (env.EGO_EXE) candidates.push({ path: env.EGO_EXE, source: 'env:EGO_EXE' });
  if (env.EGO_BROWSER_EXE) candidates.push({ path: env.EGO_BROWSER_EXE, source: 'env:EGO_BROWSER_EXE' });

  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const localAppData = env.LOCALAPPDATA ?? '';
  candidates.push({ path: join(programFiles, 'Citro Labs', 'ego lite', 'Application', 'ego.exe'), source: 'program-files' });
  if (localAppData) {
    candidates.push({ path: join(localAppData, 'Citro Labs', 'ego lite', 'Application', 'ego.exe'), source: 'local-appdata' });
    candidates.push({ path: join(localAppData, 'Programs', 'ego lite', 'Application', 'ego.exe'), source: 'local-programs' });
  }

  // The CLI shim lives next to a copy of ego.exe (`%USERPROFILE%\.local\share\ego\active_version_dir`).
  for (const dir of String(env.PATH ?? '').split(';')) {
    if (!dir) continue;
    const shim = join(dir.trim(), 'ego-browser.exe');
    if (!existsSync(shim)) continue;
    candidates.push({ path: join(directoryOf(shim), 'ego.exe'), source: 'ego-browser-shim' });
  }
  return candidates;
}

/** dirname that tolerates trailing separators. */
function directoryOf(filePath) {
  const normalized = filePath.replace(/[\\/]+$/, '');
  return dirname(normalized);
}

/**
 * Resolve the browser executable and report how it was found.
 * @param {{ egoPath?: string|null, env?: Record<string, string|undefined> }} input
 * @returns {{ path: string, source: string, exists: boolean, installedVersion: string|null, sizeBytes: number|null }}
 */
export function resolveEgo(input = {}) {
  const candidates = egoCandidates(input);
  let fallback = null;
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate.path)) continue;
      const stat = statSync(candidate.path);
      if (!stat.isFile() || stat.size < 100_000) continue;
      return {
        ...candidate,
        exists: true,
        installedVersion: readInstalledVersion(input.env ?? {}),
        sizeBytes: stat.size,
      };
    } catch {
      if (!fallback) fallback = { ...candidate, exists: false, installedVersion: null, sizeBytes: null };
    }
  }
  return fallback ?? {
    path: candidates[0]?.path ?? 'ego.exe',
    source: candidates[0]?.source ?? 'none',
    exists: false,
    installedVersion: null,
    sizeBytes: null,
  };
}

/**
 * Read the installed ego lite version from the app's default profile directory.
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
export function readInstalledVersion(env = {}) {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return null;
  try {
    const file = join(localAppData, 'Citro Labs', 'ego lite', 'User Data', 'Last Version');
    if (!existsSync(file)) return null;
    const value = readFileSync(file, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Read a profile directory's recorded Chromium version (written on first launch).
 * @param {string} profileDir
 * @returns {string|null}
 */
export function readProfileVersion(profileDir) {
  try {
    const file = join(profileDir, 'Last Version');
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
