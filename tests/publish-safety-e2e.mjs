/**
 * publish-safety-e2e.mjs — verifies the plugin's single most important safety rail **through the tool
 * layer**, which is what the model actually calls.
 *
 * The rail is: `media_publish {op:"run"}` defaults to a DRY RUN, and only an explicit `dryRun:false`
 * may submit anything. If that default ever silently flipped, the first symptom would be a real article
 * published by a call the operator believed was a rehearsal — so it deserves a test that counts actual
 * submissions rather than inspecting flags.
 *
 * It drives `media_publish` through the real tool registration with a real engine against a local
 * stand-in platform that records every submission, and asserts:
 *   1. no `dryRun` field  -> nothing submitted, and the result says so in its headline, a warning and
 *      its next steps;
 *   2. `dryRun:true`      -> same, explicitly;
 *   3. `dryRun:false`     -> exactly one submission, carrying the parameters that were passed, and the
 *      result flags it as a REAL publish.
 *
 * Usage (bundled node):
 *   node tests/publish-safety-e2e.mjs
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EngineClient } from '../src/engine-client.js';
import { validateArgs } from '../src/tool-kit.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const entry = resolve(pluginRoot, process.argv[2] ?? 'src/index.js');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-safety-'));
/** @type {Array<{title: string, body: string}>} */
const submissions = [];
let failures = 0;
let engine;
let server;
let baseUrl = '';

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${suffix}`);
}

/** Minimal Cordis context: the tool modules only use `tools.register`, `on` and `logger`. */
function fakeContext() {
  const registered = [];
  return {
    registered,
    tools: { register: (d) => { registered.push(d); return () => {}; } },
    on: () => () => {},
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  };
}

function startPlatform() {
  return new Promise((ok) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/publish') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>发布页</title></head><body>
          <h1>发布中心</h1>
          <input id="title" placeholder="标题">
          <textarea id="body" placeholder="正文"></textarea>
          <button id="submit" type="button">发布</button>
          <script>
            document.getElementById('submit').addEventListener('click', async () => {
              await fetch('/_submit', {method:'POST', headers:{'content-type':'application/json'},
                body: JSON.stringify({
                  title: document.getElementById('title').value,
                  body: document.getElementById('body').value})});
              location.href = '/list';
            });
          </script></body></html>`);
        return;
      }
      if (url.pathname === '/_submit' && req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          try { submissions.push(JSON.parse(raw)); } catch { /* ignore */ }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        });
        return;
      }
      if (url.pathname === '/list') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><h1>内容管理</h1><ul>${submissions
          .map((s) => `<li>${s.title}</li>`).join('')}</ul></body></html>`);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      ok();
    });
  });
}

try {
  await startPlatform();
  mkdirSync(join(dataDir, 'recipes', 'sohu'), { recursive: true });
  // A user recipe (media `sohu` so the tool's schema accepts it) pointing at the local platform.
  writeFileSync(join(dataDir, 'recipes', 'sohu', 'safety-probe.yaml'), [
    'recipe_version: 1',
    'id: safety-probe',
    'media: sohu',
    'label: 发布安全闸门自检',
    'account_codes: [sa-1]',
    'capabilities: {editor: quill, cover: false, free_gallery: false}',
    'session_check:',
    `  url: ${baseUrl}/publish`,
    '  fail_if_url_contains: [/login]',
    '  fail_if_text_contains: [请登录]',
    'params:',
    '  - {name: title, type: string, required: true}',
    '  - {name: body, type: text, required: true}',
    'steps:',
    `  - {type: goto, url: "${baseUrl}/publish"}`,
    '  - {type: waitFor, for: {selector: "#title"}, timeoutMs: 20000}',
    '  - {type: type, target: {selector: "#title"}, text: "{{title}}"}',
    '  - {type: type, target: {selector: "#body"}, text: "{{body}}"}',
    '  - {type: click, target: {selector: "#submit"}, submit: true, timeoutMs: 20000}',
    '  - {type: waitFor, for: {urlContains: "/list"}, timeoutMs: 20000, optional: true}',
    'verify:',
    '  mode: immediate',
    `  list_url: ${baseUrl}/list`,
    '  title_match: exact_normalized',
    '  status_regex: "已发布|审核中"',
    '',
  ].join('\n'), 'utf8');

  engine = new EngineClient({ pythonPath: PYTHON, pluginRoot, dataDir, requestTimeoutMs: 300_000 });
  engine.on('log', (line) => console.log(`    engine| ${line}`));
  await engine.call('engine.status', {});
  await engine.call('account.upsert', { code: 'sa-1', media: 'sohu', account: 'safety probe' });

  const mod = await import(pathToFileURL(entry).href);
  const harness = fakeContext();
  mod.applyWithEngine(harness, {
    engine,
    settings: { headless: false, requireExplicitPublish: true, requestTimeoutMs: 300_000 },
    dataDir,
    python: { path: PYTHON, source: 'real', exists: true, probe: 'real' },
    pluginRoot,
  });
  const publish = harness.registered.find((tool) => tool.name === 'media_publish');
  check(Boolean(publish), 'media_publish is registered');

  /** Call the tool and return both the value and the text the model would read. */
  async function run(args) {
    const value = await publish.execute(args);
    const violations = validateArgs(publish.output.schema, value);
    check(violations.length === 0, `media_publish ${JSON.stringify(args.dryRun)} satisfies output.schema`,
      violations.slice(0, 2).join('; '));
    const text = publish.output.render(args, value).map((block) => block.text).join('\n');
    return { value, text };
  }

  const params = { title: '闸门自检标题', body: '闸门自检正文。' };

  // ---- 1. no dryRun field at all -> must not submit ----
  const before = submissions.length;
  const omitted = await run({ op: 'run', recipeId: 'safety-probe', accountCode: 'sa-1', params });
  check(submissions.length === before,
    'omitting dryRun submitted NOTHING — the default is a rehearsal',
    `${submissions.length - before} submission(s)`);
  check(omitted.value?.data?.dryRun === true, 'and the result states dryRun:true', omitted.value?.data?.dryRun);
  check(omitted.value?.ok === true, 'the rehearsal itself reported success', omitted.value?.failedStep);
  check(/DRY RUN/i.test(omitted.text), 'the text the model reads says DRY RUN',
    omitted.text.split('\n')[0]);
  check(/nothing was published|nothing was submitted/i.test(omitted.text),
    'and it says nothing was published');
  check((omitted.value?.warnings ?? []).some((w) => /DRY RUN/i.test(w)),
    'a warning carries the same fact, so it survives a partial read', omitted.value?.warnings);
  check((omitted.value?.nextSteps ?? []).some((s) => /dryRun:false/.test(s)),
    'and the next steps say how to publish for real, without doing it', omitted.value?.nextSteps);

  // ---- 2. explicit dryRun:true behaves identically ----
  const explicit = await run({ op: 'run', recipeId: 'safety-probe', accountCode: 'sa-1', params, dryRun: true });
  check(submissions.length === before, 'an explicit dryRun:true also submitted nothing',
    `${submissions.length - before} submission(s)`);
  check(/DRY RUN/i.test(explicit.text), 'and it is labelled a DRY RUN too');

  // ---- 3. only an explicit dryRun:false may submit ----
  const real = await run({ op: 'run', recipeId: 'safety-probe', accountCode: 'sa-1', params, dryRun: false });
  check(submissions.length === before + 1,
    'dryRun:false submitted exactly once', `${submissions.length - before} submission(s)`);
  const latest = submissions[submissions.length - 1];
  check(latest?.title === params.title,
    'the platform received the parameters that were passed', latest?.title);
  check(real.value?.data?.dryRun === false, 'the result reports dryRun:false');
  check(!/DRY RUN/i.test(real.text), 'a real publish is NOT labelled a dry run',
    real.text.split('\n')[0]);
  check((real.value?.warnings ?? []).some((w) => /REAL PUBLISH/i.test(w)),
    'a real publish carries an explicit REAL PUBLISH warning instead', real.value?.warnings);
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
    console.log(`submissions seen: ${JSON.stringify(submissions.map((s) => s.title))}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
