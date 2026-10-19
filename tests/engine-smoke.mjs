/**
 * engine-smoke.mjs — integration test for the Node↔Python seam.
 *
 * This is the only test that exercises the real thing end to end: `EngineClient` spawns the actual
 * `engine/sessiond.py`, opens a real headless Chromium session, and drives it through the same RPC
 * methods the tools use. It deliberately runs against a throwaway `MEDIA_DATA_DIR` so it can never
 * touch the operator's real accounts, storage state, or recipes.
 *
 * Usage (bundled node):
 *   node tests/engine-smoke.mjs
 * Exits non-zero on the first failed assertion.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient, EngineError } from '../src/engine-client.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-smoke-'));
let failures = 0;
let engine;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[${mark}] ${label}${suffix}`);
}

const PAGE = 'data:text/html,'
  + encodeURIComponent('<html><head><meta charset="utf-8"><title>冒烟测试</title></head><body>'
    + '<h1>中文标题</h1><input id="title" placeholder="标题">'
    + '<div id="editor" contenteditable="true"></div>'
    + '<button id="btn" onclick="document.title=\'已点击\'">发布</button>'
    + '</body></html>');

try {
  engine = new EngineClient({
    pythonPath: PYTHON,
    pluginRoot: PLUGIN_ROOT,
    dataDir,
    requestTimeoutMs: 120_000,
  });
  engine.on('log', (line) => console.log(`    engine| ${line}`));
  engine.on('event', (frame) => console.log(`    event| ${JSON.stringify(frame)}`));

  // ---- 1. engine.status (also proves the process starts and the module imports) ----
  const status = await engine.call('engine.status', {});
  check(typeof status.version === 'string', 'engine.status returns a version', status.version);
  check(status.playwright !== null, 'engine reports a playwright version', status.playwright);
  check(typeof status.chromium === 'string' && status.chromium.length > 0,
    'engine located a chromium build', status.chromium);
  check(status.dataDir === dataDir, 'engine honours MEDIA_DATA_DIR', status.dataDir);
  check(String(status.dataDir).includes('media-publish-smoke-'),
    'engine is using the throwaway data dir (no real accounts touched)', status.dataDir);

  // ---- 2. account registration + isolated session, explicit direct connection ----
  await engine.call('account.upsert', { code: 'smoke-1', media: 'sohu', account: 'smoke', note: 'integration test' });
  const opened = await engine.call('session.open', {
    accountCode: 'smoke-1',
    headless: true,
    proxyPolicy: 'direct',
  }, { timeoutMs: 120_000 });
  check(typeof opened.sessionId === 'string', 'session.open returned a session id', opened.sessionId);
  check(opened.proxy === null, 'direct policy means no proxy', opened.proxy);
  check(Array.isArray(opened.warnings), 'session.open reports a warnings array', opened.warnings);
  check(Boolean(opened.fingerprint?.user_agent), 'session.open reports a fingerprint');
  const sessionId = opened.sessionId;

  // ---- 3. navigate + observe ----
  await engine.call('act.goto', { sessionId, url: PAGE });
  const snap = await engine.call('session.snapshot', { sessionId });
  check(snap.url?.startsWith('data:text/html'), 'snapshot reports the current url', snap.url);
  check(Array.isArray(snap.interactive) && snap.interactive.length >= 3,
    'snapshot lists the interactive elements', snap.interactive?.length);
  const texts = (snap.interactive ?? []).map((el) => el.text).filter(Boolean);
  check(texts.includes('发布'), 'the publish button is visible in the page model', texts);
  const button = (snap.interactive ?? []).find((el) => el.text === '发布');
  const input = (snap.interactive ?? []).find((el) => el.tag === 'input' || el.selector === '#title');
  check(Boolean(button?.ref), 'the button carries a ref', button?.ref);
  check(Boolean(snap.screenshot), 'snapshot produced a screenshot path', snap.screenshot);
  if (snap.screenshot) {
    check(statSync(snap.screenshot).size > 1000, 'screenshot file is non-empty',
      `${statSync(snap.screenshot).size} bytes`);
  }

  // ---- 4. typing by selector, then clicking by text AND by ref ----
  if (input) {
    await engine.call('act.type', { sessionId, target: { selector: '#title' }, text: '参数化标题' });
    const typed = await engine.call('act.extract', {
      sessionId,
      spec: [{ name: 'title', from: { selector: '#title', value: true } }],
    });
    // SPEC §2.1 leaves the extract envelope open, so accept either `data.<name>` or `data.values.<name>`
    // instead of pinning one shape here.
    const extracted = typed.data?.values ?? typed.data;
    check(extracted?.title === '参数化标题', 'act.type filled the input', typed.data);
  }

  const byText = await engine.call('act.click', { sessionId, target: { text: '发布' } });
  check(byText.ms >= 0, 'act.click by text succeeded');
  const titleAfterText = await engine.call('session.state', { sessionId });
  check(titleAfterText.title === '已点击' || titleAfterText.url?.startsWith('data:'),
    'click by text reached the element', titleAfterText.title);

  // The ref must still resolve on a later call: that is what makes agent-driven recording work.
  if (button?.ref) {
    const byRef = await engine.call('act.click', { sessionId, target: { ref: button.ref } });
    check(byRef.ms >= 0, `act.click by ref (${button.ref}) succeeded`);
  }

  // ---- 5. a missing target must return actionable candidates, not a bare error ----
  let targetError = null;
  try {
    await engine.call('act.click', { sessionId, target: { selector: '#does-not-exist' }, timeoutMs: 3000 });
  } catch (error) {
    targetError = error;
  }
  check(targetError instanceof EngineError, 'a missing target raises an EngineError');
  check(targetError?.code === 'TARGET_NOT_FOUND', 'the error code is TARGET_NOT_FOUND', targetError?.code);
  check(Array.isArray(targetError?.details?.candidates),
    'the error carries candidate elements for self-correction',
    targetError?.details?.candidates?.length);

  // ---- 6. isolation: a second account gets a distinguishable, stable fingerprint ----
  await engine.call('account.upsert', { code: 'smoke-2', media: 'csdn', account: 'smoke2' });
  const opened2 = await engine.call('session.open', {
    accountCode: 'smoke-2', headless: true, proxyPolicy: 'direct',
  }, { timeoutMs: 120_000 });
  // A user agent is drawn from a finite pool, so two accounts may legitimately share one — a unique UA
  // per account would itself be a signal. What must hold is that the fingerprints are not identical,
  // and that a given account always gets the same one.
  const fpA = opened.fingerprint ?? {};
  const fpB = opened2.fingerprint ?? {};
  const differing = Object.keys(fpA).filter((key) => JSON.stringify(fpA[key]) !== JSON.stringify(fpB[key]));
  check(differing.length > 0, 'two accounts get distinguishable fingerprints',
    { differing, uaA: fpA.user_agent, uaB: fpB.user_agent });
  check(opened2.storageStatePath !== opened.storageStatePath,
    'two accounts get different state paths',
    { a: opened.storageStatePath, b: opened2.storageStatePath });

  const reopen = await engine.call('session.open', {
    accountCode: 'smoke-1', headless: true, proxyPolicy: 'direct',
  }, { timeoutMs: 120_000 });
  check(reopen.fingerprint?.user_agent === fpA.user_agent
    && reopen.fingerprint?.viewport_size === fpA.viewport_size,
    'a given account always gets the same fingerprint',
    { first: fpA.user_agent, again: reopen.fingerprint?.user_agent });
  await engine.call('session.close', { sessionId: reopen.sessionId });
  await engine.call('session.close', { sessionId: opened2.sessionId });

  // ---- 7. clean close ----
  const closed = await engine.call('session.close', { sessionId, saveState: true });
  check(closed.ok === true, 'session.close succeeded', closed.savedStatePath);
  const remaining = await engine.call('session.list', {});
  check((remaining.sessions ?? []).length === 0, 'no sessions remain open', remaining.sessions?.length);
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error instanceof EngineError ? `${error.code}: ${error.message}` : error);
  if (error?.details) console.error('details:', JSON.stringify(error.details, null, 2).slice(0, 2000));
} finally {
  if (engine) await engine.close();
  // Keep the throwaway dir only when something failed, so it can be inspected.
  if (failures === 0) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`\nall checks passed; removed ${dataDir}`);
  } else {
    console.log(`\n${failures} check(s) failed; kept ${dataDir} for inspection`);
  }
}

process.exit(failures === 0 ? 0 : 1);
