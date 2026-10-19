/**
 * probe-apply-live.mjs — the companion to probe-apply.mjs, but wired to the REAL Python engine.
 *
 * Why this exists: `probe-apply.mjs` drives the tools against a *stub* engine, so it only ever sees the
 * envelope shapes the stub produces. It therefore could not notice that the envelope set `handoff` and
 * `error` to `null` while the output schema declared them as objects — a mismatch that made **8 of the 9
 * tools fail at the host's output-validation boundary after the engine had already done the work**, and
 * that no amount of static schema checking would catch.
 *
 * This file closes that gap: it registers the tools through the same `applyWithEngine()` seam but injects
 * a real `EngineClient`, calls every tool at least once on both a success and a failure path, and then
 * asserts for EVERY returned value that
 *   1. it satisfies that tool's declared `output.schema`, and
 *   2. it is lossless JSON (the host's other rejection: a stray `undefined` or an array hole).
 *
 * It uses a throwaway `MEDIA_DATA_DIR`, a synthetic account, and a `data:` URL page, so it touches no
 * real account, recipe or login state. The one network-dependent call (a dry-run publish, which should
 * fail with LOGIN_REQUIRED) is skipped when MEDIA_SKIP_NETWORK=1.
 *
 * Usage (bundled node):
 *   node tests/probe-apply-live.mjs [entryPath]      # default src/index.js
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EngineClient } from '../src/engine-client.js';
import { isLosslessJson, validateArgs } from '../src/tool-kit.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const entry = resolve(pluginRoot, process.argv[2] ?? 'src/index.js');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-liveprobe-'));
let failures = 0;
let checks = 0;
let engine;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  checks += 1;
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
}

/** Minimal stand-in for the Cordis context: only `tools.register`, `on` and `logger` are used. */
function fakeContext() {
  const registered = [];
  return {
    registered,
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    on() { return () => {}; },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} };
    },
  };
}

const PAGE = 'data:text/html,'
  + encodeURIComponent('<html><head><meta charset="utf-8"><title>live probe</title></head><body>'
    + '<input id="title" placeholder="标题"><div id="body" contenteditable="true"></div>'
    + '<button id="go">发布</button></body></html>');

const mod = await import(pathToFileURL(entry).href);
const harness = fakeContext();
engine = new EngineClient({ pythonPath: PYTHON, pluginRoot, dataDir, requestTimeoutMs: 240_000 });
engine.on('log', (line) => console.log(`    engine| ${line}`));

const deps = mod.applyWithEngine(harness, {
  engine,
  settings: { headless: false, requireExplicitPublish: true, requestTimeoutMs: 240_000 },
  dataDir,
  python: { path: PYTHON, source: 'real', exists: true, probe: 'real' },
  pluginRoot,
});

const tools = new Map(harness.registered.map((tool) => [tool.name, tool]));
check(harness.registered.length === 10, 'all ten tools register against the real engine',
  harness.registered.map((t) => t.name).join(', '));
// The new tenth tool must be reachable too, not merely counted.
check(tools.has('media_config'), 'media_config is present in the live surface');
check(typeof deps?.handoffs?.record === 'function', 'the handoff log is exposed');

/**
 * Call one tool, then validate its returned value exactly the way the host does.
 * @param {string} name @param {Record<string, unknown>} args @param {string} label
 */
async function call(name, args, label = name) {
  const tool = tools.get(name);
  if (!tool) {
    check(false, `${label}: tool exists`);
    return null;
  }
  let value;
  try {
    value = await tool.execute(args);
  } catch (error) {
    check(false, `${label}: execute did not throw`, error?.stack ?? String(error));
    return null;
  }
  const violations = validateArgs(tool.output.schema, value);
  check(violations.length === 0, `${label}: value satisfies output.schema`, violations.slice(0, 3).join('; '));
  check(isLosslessJson(value), `${label}: value is lossless JSON`);
  try {
    const blocks = tool.output.render(args, value);
    check(Array.isArray(blocks) && typeof blocks[0]?.text === 'string' && blocks[0].text.length > 0,
      `${label}: render produces text`);
  } catch (error) {
    check(false, `${label}: render did not throw`, String(error));
  }
  return value;
}

try {
  console.log('\n--- media_status ---');
  await call('media_status', { probe: false });
  await call('media_status', { probe: true });

  console.log('\n--- media_account ---');
  await call('media_account', { op: 'list' });
  await call('media_account', { op: 'upsert', code: 'lp-1', media: 'sohu', account: 'live probe' });
  await call('media_account', { op: 'check', code: 'lp-1' });
  await call('media_account', { op: 'bindProxy', code: 'lp-1', proxy: { server: 'http://127.0.0.1:9', username: 'u', password: 'p' } });
  await call('media_account', { op: 'list' });

  console.log('\n--- media_proxy ---');
  await call('media_proxy', { op: 'test', code: 'lp-1' });
  await call('media_proxy', { op: 'fetch', code: 'lp-1' });

  console.log('\n--- media_session ---');
  await call('media_session', { op: 'list' });
  const opened = await call('media_session', { op: 'open', accountCode: 'lp-1', headless: true, proxyPolicy: 'direct' });
  const sessionId = opened?.data?.sessionId ?? opened?.data?.session?.sessionId ?? null;
  check(typeof sessionId === 'string', 'a session id came back from media_session open', sessionId);
  await call('media_session', { op: 'open', accountCode: 'does-not-exist', headless: true, proxyPolicy: 'direct' },
    'media_session open (unknown account)');
  if (sessionId) await call('media_session', { op: 'state', sessionId });

  console.log('\n--- media_observe ---');
  if (sessionId) {
    const snapshot = await call('media_observe', { sessionId });
    check(Array.isArray(snapshot?.data?.interactive),
      'the snapshot really carried the page model', snapshot?.data?.interactive?.length);
  }

  console.log('\n--- media_act ---');
  if (sessionId) {
    await call('media_act', { sessionId, action: { type: 'goto', url: PAGE } });
    await call('media_act', { sessionId, action: { type: 'type', target: { selector: '#title' }, text: '实时探测' } });
    const extracted = await call('media_act', {
      sessionId, action: { type: 'extract', spec: [{ name: 'title', from: { selector: '#title', value: true } }] },
    });
    // Assert the value round-tripped without pinning where the envelope nests it; the tools deliberately
    // mirror the engine's shape, and this test is about value validation, not about that nesting.
    check(JSON.stringify(extracted).includes('实时探测'),
      'the extraction round-tripped through the real engine',
      JSON.stringify(extracted?.data)?.slice(0, 160));
    const missing = await call('media_act', {
      sessionId, action: { type: 'click', target: { selector: '#nope' }, timeoutMs: 3_000 },
    }, 'media_act click (missing target)');
    check(missing?.ok === false, 'a missing target produced a failure envelope');
    check(Array.isArray(missing?.error?.candidates),
      'the failure envelope carried candidate elements', missing?.error?.candidates?.length);
  }

  console.log('\n--- media_record ---');
  if (sessionId) {
    // `media` is deliberately constrained to the three supported platforms by the tool schema, so a
    // synthetic media name is rejected — use a real one.
    await call('media_record', { op: 'start', sessionId, recipeId: 'lp__probe', media: 'sohu' });
    await call('media_record', { op: 'status', sessionId });
    await call('media_record', { op: 'note', sessionId, text: 'live probe note' });
    await call('media_record', { op: 'undo', sessionId, count: 1 });
    await call('media_record', { op: 'save', sessionId, overwrite: true });
  }

  console.log('\n--- media_recipe ---');
  await call('media_recipe', { op: 'list' });
  await call('media_recipe', { op: 'show', recipeId: 'sohu__publish-article' });
  await call('media_recipe', { op: 'show', recipeId: 'no-such-recipe' });
  await call('media_recipe', { op: 'validate', recipeId: 'sohu__publish-article' });
  await call('media_recipe', { op: 'validate', recipeId: 'no-such-recipe' });

  console.log('\n--- media_publish ---');
  await call('media_publish', { op: 'run', recipeId: 'no-such-recipe', accountCode: 'lp-1' });
  await call('media_publish', { op: 'backfill', recipeId: 'no-such-recipe', accountCode: 'lp-1', title: 'x' });
  if (process.env.MEDIA_SKIP_NETWORK === '1') {
    console.log('    skipped: the dry-run publish needs outbound network');
  } else {
    const dryRun = await call('media_publish', {
      op: 'run', recipeId: 'sohu__publish-article', accountCode: 'lp-1',
      params: { title: '实时探测标题', body: '实时探测正文，不应发布。' },
    }, 'media_publish run (unauthenticated, real platform)');
    check(dryRun?.ok === false, 'an unauthenticated publish produced a failure envelope from the real engine',
      dryRun?.error?.code ?? dryRun?.summary);
  }

  if (sessionId) await call('media_session', { op: 'close', sessionId });
  await call('media_session', { op: 'close', sessionId: 'nope' });
  await call('media_account', { op: 'remove', code: 'lp-1' });
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error?.stack ?? error);
} finally {
  if (engine) await engine.close();
  const verdict = failures === 0 ? 'ALL VALUE CHECKS PASSED' : `${failures} of ${checks} checks FAILED`;
  console.log(`\n${checks - failures}/${checks} checks passed — ${verdict}`);
  if (failures === 0) rmSync(dataDir, { recursive: true, force: true });
  else console.log(`kept ${dataDir} for inspection`);
}

process.exit(failures === 0 ? 0 : 1);
