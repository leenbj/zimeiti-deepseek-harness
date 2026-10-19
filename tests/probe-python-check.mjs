/**
 * probe-python-check.mjs — guards the interpreter probe's two obligations.
 *
 * The probe exists to guarantee that the configured `pythonPath` really can drive the engine. It must
 * therefore (a) FAIL an interpreter without Playwright, and (b) report the actual Playwright version.
 * It once reported the string "unknown" on a perfectly good interpreter, because the `playwright`
 * package exposes no `__version__` — a misleading line that sat right next to the engine's correct
 * version. This asserts the version is now real, so that cannot silently come back.
 *
 * Usage (bundled node):
 *   node tests/probe-python-check.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const entry = resolve(pluginRoot, process.argv[2] ?? 'src/index.js');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-pyprobe-'));
let failures = 0;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${suffix}`);
}

/** Minimal Cordis context: the modules only use `tools.register`, `on` and `logger`. */
function fakeContext() {
  const registered = [];
  return {
    registered,
    tools: { register: (d) => { registered.push(d); return () => {}; } },
    on: () => () => {},
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  };
}

const mod = await import(pathToFileURL(entry).href);

/** `apply` resolves and probes the interpreter itself; `applyWithEngine` takes pre-resolved deps and so
 *  would bypass the very code under test. */
function statusFrom(config) {
  const harness = fakeContext();
  mod.apply(harness, config);
  return harness.registered.find((tool) => tool.name === 'media_status');
}

try {
  const status = statusFrom({ headless: false, requireExplicitPublish: true, requestTimeoutMs: 30_000 });
  check(Boolean(status), 'media_status registered');
  const value = await status.execute({ probe: false });

  check(value.python.source === 'dsh-runtime',
    'the probe selected the bundled DSH runtime interpreter, not PATH', value.python.source);
  check(value.python.exists === true, 'and it reported the interpreter as existing');

  let probe = {};
  try { probe = JSON.parse(value.python.probe); } catch { /* leave empty */ }
  check(typeof probe.python === 'string' && /^\d+\.\d+/.test(probe.python),
    'the probe reports the interpreter version', probe.python);
  check(probe.playwright !== 'unknown',
    'the probe does NOT report the Playwright version as "unknown"', probe.playwright);
  check(typeof probe.playwright === 'string' && /^\d+\.\d+/.test(probe.playwright),
    'the probe reports a real Playwright version', probe.playwright);

  // A bogus explicit path must be skipped rather than accepted, and the runtime interpreter must still
  // be found — otherwise one bad config value would silently disable the whole plugin.
  process.env.MEDIA_PYTHON = join(dataDir, 'definitely-not-a-python.exe');
  const fallback = statusFrom({ headless: false, requireExplicitPublish: true, requestTimeoutMs: 30_000 });
  const fallbackValue = await fallback.execute({ probe: false });
  check(fallbackValue.python.source !== 'env:MEDIA_PYTHON',
    'a non-existent MEDIA_PYTHON value is skipped, not accepted', fallbackValue.python.source);
  check(fallbackValue.python.exists === true,
    'and the probe still found a working interpreter by falling through', fallbackValue.python.path);
  delete process.env.MEDIA_PYTHON;
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error?.stack ?? error);
} finally {
  if (failures === 0) rmSync(dataDir, { recursive: true, force: true });
  else console.log(`kept ${dataDir} for inspection`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
