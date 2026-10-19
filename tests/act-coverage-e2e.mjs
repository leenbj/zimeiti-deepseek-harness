/**
 * act-coverage-e2e.mjs — verifies every documented `media_act` action type end to end.
 *
 * `probe-apply.mjs` only exercised 4 of the 13 types (goto/click/type/extract). The untested nine
 * include the two the shipped recipes depend on most: `dispatch`, because 搜狐's 创作声明 radio only
 * responds to a native event stream, and `frame`, because CSDN's CKEditor4 body lives in an iframe.
 * A forwarding bug in either would first show up during a live recording, which is the worst place to
 * discover it.
 *
 * So each type is driven through the tool against a real browser and a real page, and this test asserts
 * not just that the call succeeded but that the page actually changed — a click counted, a radio got
 * checked, a select changed value, a file got attached, the frame got entered. Where an effect is
 * observable it is asserted; where it is not, success alone is recorded.
 *
 * Usage (bundled node):
 *   node tests/act-coverage-e2e.mjs [entryPath]
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-act-'));
const uploadPath = join(dataDir, 'upload-probe.txt');
writeFileSync(uploadPath, 'act coverage probe', 'utf8');

/** The 13 documented action types; every one must be exercised below. */
const ACTION_TYPES = ['goto', 'click', 'dispatch', 'type', 'press', 'upload', 'select', 'check',
  'scroll', 'waitFor', 'frame', 'eval', 'extract'];
const exercised = new Set();

let failures = 0;
let engine;
let server;
let baseUrl = '';

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}${suffix}`);
}

function fakeContext() {
  const registered = [];
  return {
    registered,
    tools: { register: (d) => { registered.push(d); return () => {}; } },
    on: () => () => {},
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>act coverage</title></head><body>
  <h1>act coverage 页</h1>
  <button id="btn" type="button" onclick="window.__clicks=(window.__clicks||0)+1">点我</button>
  <input id="radio" type="radio" name="g" value="r1">
  <input id="radio2" type="radio" name="g" value="r2">
  <select id="sel"><option value="a">甲</option><option value="b">乙</option></select>
  <textarea id="ta"></textarea>
  <input id="file" type="file">
  <button id="late" type="button" onclick="document.getElementById('appeared').textContent='来了'">出现</button>
  <div id="appeared"></div>
  <iframe id="fr" src="/inner" width="300" height="60"></iframe>
  <div style="height:2400px"></div>
  <script>
    window.addEventListener('keydown', () => { window.__keys = (window.__keys || 0) + 1; });
  </script></body></html>`;

function startPlatform() {
  return new Promise((ok) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/inner') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><input id="inner" placeholder="iframe 内"></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      ok();
    });
  });
}

try {
  await startPlatform();
  engine = new EngineClient({ pythonPath: PYTHON, pluginRoot, dataDir, requestTimeoutMs: 180_000 });
  engine.on('log', (line) => console.log(`    engine| ${line}`));
  await engine.call('engine.status', {});
  // The session must belong to a registered account, or media_session open is a BAD_REQUEST.
  await engine.call('account.upsert', { code: 'ac-1', media: 'sohu', account: 'act coverage' });

  const mod = await import(pathToFileURL(entry).href);
  const harness = fakeContext();
  mod.applyWithEngine(harness, {
    engine,
    settings: { headless: false, requireExplicitPublish: true, requestTimeoutMs: 180_000 },
    dataDir,
    python: { path: PYTHON, source: 'real', exists: true, probe: 'real' },
    pluginRoot,
  });
  const act = harness.registered.find((tool) => tool.name === 'media_act');
  const sessionTool = harness.registered.find((tool) => tool.name === 'media_session');
  check(Boolean(act) && Boolean(sessionTool), 'media_act and media_session are registered');

  /** Run one action through the tool, validating its envelope every time. */
  async function doAct(sessionId, action, label = String(action.type)) {
    exercised.add(action.type);
    const args = { sessionId, action };
    let value;
    try {
      value = await act.execute(args);
    } catch (error) {
      check(false, `${label}: execute did not throw`, error?.message);
      return null;
    }
    const violations = validateArgs(act.output.schema, value);
    check(violations.length === 0, `${label}: value satisfies output.schema`, violations.slice(0, 2).join('; '));
    check(isLosslessJson(value), `${label}: value is lossless JSON`);
    check(value?.ok === true, `${label}: reported ok`, value?.error?.code ?? value?.summary);
    return value;
  }

  /**
   * The tool envelope nests the engine's own result under `data` (act.js does `data: result`), so the
   * engine payload — and therefore `url` / `values` / `result` / `ms` — lives one level deeper.
   * Tolerate both shapes rather than pinning one.
   */
  function payload(value) {
    const data = value?.data ?? {};
    return data.data && typeof data.data === 'object' ? data.data : data;
  }

  /** Read page state back through the `eval` action, unwrapping its envelope correctly. */
  async function readPage(sessionId, expression) {
    const value = await doAct(sessionId, { type: 'eval', expression, purpose: 'act coverage readback' },
      'eval (readback)');
    const inner = payload(value);
    return Object.prototype.hasOwnProperty.call(inner, 'result') ? inner.result : undefined;
  }

  const opened = await sessionTool.execute({ op: 'open', accountCode: 'ac-1', headless: true, proxyPolicy: 'direct' });
  check(opened?.ok === true, 'a session opened for the coverage run', opened?.error?.code);
  const sessionId = opened?.data?.sessionId;
  check(typeof sessionId === 'string', 'and it returned a session id', sessionId);

  // ---- goto ----
  const goto = await doAct(sessionId, { type: 'goto', url: `${baseUrl}/` });
  check(String(payload(goto).url ?? '').startsWith('http'), 'goto landed on the page', payload(goto).url);

  // ---- type (fill) ----
  await doAct(sessionId, { type: 'type', target: { selector: '#ta' }, text: '填进去的字' });
  check(await readPage(sessionId, "() => document.getElementById('ta').value") === '填进去的字',
    'type filled the textarea');

  // ---- press ----
  await doAct(sessionId, { type: 'press', target: { selector: '#ta' }, key: 'Enter' });
  const keys = Number(await readPage(sessionId, '() => window.__keys || 0'));
  check(keys >= 1, 'press delivered a real keydown to the page', keys);

  // ---- click ----
  await doAct(sessionId, { type: 'click', target: { selector: '#btn' } });
  check(Number(await readPage(sessionId, '() => window.__clicks || 0')) === 1,
    'click ran the element handler exactly once');

  // ---- dispatch: the native event stream 搜狐 needs ----
  await doAct(sessionId, { type: 'dispatch', target: { selector: '#radio2' }, event: 'click' });
  check(await readPage(sessionId, "() => document.getElementById('radio2').checked") === true,
    'dispatch click really toggled a radio — which is what the 搜狐 declaration step relies on');

  // ---- check ----
  await doAct(sessionId, { type: 'check', target: { selector: '#radio' }, checked: true });
  check(await readPage(sessionId, "() => document.getElementById('radio').checked") === true,
    'check set the checkbox/radio state');

  // ---- select ----
  await doAct(sessionId, { type: 'select', target: { selector: '#sel' }, value: 'b' });
  check(await readPage(sessionId, "() => document.getElementById('sel').value") === 'b',
    'select changed the value');

  // ---- upload ----
  await doAct(sessionId, { type: 'upload', target: { selector: '#file' }, paths: [uploadPath] });
  const fileCount = Number(await readPage(sessionId, "() => document.getElementById('file').files.length"));
  check(fileCount === 1, 'upload attached a real file to the input', fileCount);

  // ---- scroll ----
  await doAct(sessionId, { type: 'scroll', deltaY: 600 });
  const scrollY = Number(await readPage(sessionId, '() => window.scrollY'));
  check(scrollY > 0, 'scroll actually moved the page', scrollY);

  // ---- waitFor ----
  await doAct(sessionId, { type: 'click', target: { selector: '#late' } });
  const waited = await doAct(sessionId, { type: 'waitFor', for: { text: '来了' }, timeoutMs: 10_000 });
  check(Number(payload(waited).ms ?? 0) >= 0, 'waitFor returned once the text appeared');

  // ---- frame: the iframe handling CSDN's CKEditor4 needs ----
  await doAct(sessionId, { type: 'frame', frame: { selector: '#fr' } });
  await doAct(sessionId, { type: 'type', target: { selector: '#inner' }, text: '框内输入' });
  check(await readPage(sessionId, "() => document.getElementById('inner').value") === '框内输入',
    'frame switched the active frame, and the inner input received the text');
  await doAct(sessionId, { type: 'frame', frame: 'main' });
  check(await readPage(sessionId, '() => document.title') === 'act coverage',
    'frame "main" switched back to the top document');

  // ---- eval ----
  const evaluated = await doAct(sessionId, { type: 'eval', expression: '() => 40 + 2', purpose: 'coverage' });
  check(payload(evaluated).result === 42, 'eval returned the expression result', payload(evaluated).result);

  // ---- extract ----
  const extracted = await doAct(sessionId, {
    type: 'extract', spec: [{ name: 'heading', from: { selector: 'h1', text: true } }],
  });
  const inner = payload(extracted);
  const heading = inner.values?.heading ?? inner.heading;
  check(String(heading).includes('act coverage'), 'extract read the element text', heading);

  // ---- the enum must reject an unknown type, so a typo fails loudly ----
  // The tool validates its own arguments and THROWS, rather than returning a failure envelope.
  let bogusError = null;
  try {
    await act.execute({ sessionId, action: { type: 'definitely-not-an-action' } });
  } catch (error) {
    bogusError = error;
  }
  check(bogusError?.code === 'INVALID_ARGS',
    'an unknown action type is rejected by the tool schema', bogusError?.message?.slice(0, 90));

  // ---- coverage bookkeeping ----
  const missed = ACTION_TYPES.filter((type) => !exercised.has(type));
  check(missed.length === 0, 'every documented action type was exercised', missed);
  check(exercised.size === ACTION_TYPES.length,
    `all ${ACTION_TYPES.length} action types covered`, [...exercised].join(', '));

  await sessionTool.execute({ op: 'close', sessionId, saveState: false });
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error?.stack ?? error);
} finally {
  if (engine) await engine.close();
  if (server) await new Promise((ok) => server.close(ok));
  if (failures === 0) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`\nall checks passed; removed ${dataDir}`);
  } else {
    console.log(`\n${failures} check(s) failed; kept ${dataDir}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
