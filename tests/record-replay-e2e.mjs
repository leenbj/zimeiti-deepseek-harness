/**
 * record-replay-e2e.mjs — the acceptance test for the core promise of this plugin:
 * an agent drives a browser through a publishing flow, the flow is compiled into a recipe,
 * and a later run replays that recipe with *different* content and no model involvement.
 *
 * It runs the real engine against a throwaway `MEDIA_DATA_DIR` and a local HTTP "publishing platform"
 * served in-process, so it needs no external network and no real account. The local platform mimics the
 * shape that matters: a form page, a submit button, a post-submit redirect to a list page, and a
 * server-side record of what was actually submitted.
 *
 * What it proves, in order:
 *   1. recording captures the actions and `record.save` compiles a loadable recipe;
 *   2. the compile step turned the literals that were typed into `{{title}}` / `{{body}}` parameters,
 *      and wrote a compile report explaining its decisions;
 *   3. `dryRun:true` fills the form but does NOT submit;
 *   4. `dryRun:false` submits, and the platform received the *replay* content, not the recorded content —
 *      which is the whole point of turning a session into a script;
 *   5. the replay is reproducible: a second replay of the same recipe also succeeds.
 *
 * Usage (bundled node):
 *   node tests/record-replay-e2e.mjs
 */
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient, EngineError } from '../src/engine-client.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

const RECORDED = { title: '录制的标题：这是第一次', body: '这是录制时输入的正文内容，用来测试参数化推断是否把它替换成占位符。'.repeat(4) };
const REPLAYED = { title: '回放的标题：这是第二次', body: '这是回放时传入的正文，如果平台收到的是这一份，就证明模板替换生效了。'.repeat(4) };

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-rr-'));
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

/** The local stand-in platform: a form, a submit that redirects, and a submission log. */
function startPlatform() {
  return new Promise((ok) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/_submissions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(submissions));
        return;
      }
      if (url.pathname === '/publish') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>发布页</title></head><body>
          <h1>发布中心</h1>
          <input id="title" placeholder="标题" />
          <div id="body" contenteditable="true" style="border:1px solid #ccc;min-height:60px"></div>
          <button id="submit" type="button">发布</button>
          <script>
            document.getElementById('submit').addEventListener('click', async () => {
              const title = document.getElementById('title').value;
              const body = document.getElementById('body').innerText;
              const r = await fetch('/_submit', {method:'POST',headers:{'content-type':'application/json'},
                body: JSON.stringify({title, body})});
              if (r.ok) location.href = '/list';
            });
          </script></body></html>`);
        return;
      }
      if (url.pathname === '/_submit' && req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          try { submissions.push(JSON.parse(raw)); } catch { /* ignore malformed */ }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        });
        return;
      }
      if (url.pathname === '/list') {
        const rows = submissions.map((s) => `<li>${s.title}</li>`).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>内容管理</title></head>
          <body><h1>内容管理</h1><ul id="rows">${rows}</ul></body></html>`);
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

const recipePath = () => join(dataDir, 'recipes', 'demo', 'demo__publish-article.yaml');

try {
  await startPlatform();
  engine = new EngineClient({ pythonPath: PYTHON, pluginRoot: PLUGIN_ROOT, dataDir, requestTimeoutMs: 180_000 });
  engine.on('log', (line) => console.log(`    engine| ${line}`));
  await engine.call('engine.status', {});
  await engine.call('account.upsert', { code: 'demo-1', media: 'demo', account: 'demo account', note: 'record/replay e2e' });

  // ---- phase 1: an agent drives the flow, the engine records it ----
  const session = await engine.call('session.open',
    { accountCode: 'demo-1', headless: true, proxyPolicy: 'direct' }, { timeoutMs: 120_000 });
  const sessionId = session.sessionId;
  const rec = await engine.call('record.start', { sessionId, recipeId: 'demo__publish-article', media: 'demo' });
  check(rec.recording === true, 'record.start begins recording', rec.tracePath ?? rec);

  await engine.call('act.goto', { sessionId, url: `${baseUrl}/publish` });
  await engine.call('act.waitFor', { sessionId, for: { selector: '#title' }, timeoutMs: 15_000 });
  await engine.call('act.type', { sessionId, target: { selector: '#title' }, text: RECORDED.title });
  await engine.call('act.type', { sessionId, target: { selector: '#body' }, text: RECORDED.body, mode: 'type' });
  // The page deliberately contains an <h1>发布中心</h1> as well as a <button>发布</button>, so the
  // recorded target must be precise: a bare `{text:'发布'}` is ambiguous on this page, exactly as it is
  // on the real platforms. Recording with the role included is what a careful agent should do.
  await engine.call('act.click', { sessionId, target: { text: '发布', role: 'button' }, timeoutMs: 15_000 });
  await engine.call('act.waitFor', { sessionId, for: { urlContains: '/list' }, timeoutMs: 15_000 });
  await engine.call('act.extract', { sessionId, spec: [{ name: 'publishedUrl', from: { url: true } }] });

  check(submissions.length === 1, 'the recorded run actually submitted once', submissions.length);
  check(submissions[0]?.title === RECORDED.title, 'the platform received the recorded title');

  const status = await engine.call('record.status', { sessionId });
  check(status.recording === true && status.stepCount >= 6,
    'the trace captured the steps', { stepCount: status.stepCount, steps: status.steps?.length });

  const saved = await engine.call('record.save', {
    sessionId,
    recipeId: 'demo__publish-article',
    media: 'demo',
    label: '回放自检用本地平台',
    overwrite: true,
    accountCodes: ['demo-1'],
    sessionCheck: { url: `${baseUrl}/publish`, fail_if_url_contains: ['/login'] },
  });
  check(existsSync(recipePath()), 'record.save wrote the recipe', saved.recipePath ?? recipePath());

  // ---- phase 2: the compiled recipe is a real, loadable, parameterized script ----
  const yamlText = readFileSync(recipePath(), 'utf8');
  check(/\{\{\s*title\s*\}\}/.test(yamlText), 'the recorded title literal became {{title}}');
  check(/\{\{\s*body\s*\}\}/.test(yamlText), 'the recorded body literal became {{body}}');
  check(!yamlText.includes(RECORDED.title), 'the recorded title literal is gone from the recipe');
  check(!yamlText.includes(RECORDED.body.slice(0, 40)), 'the recorded body literal is gone from the recipe');
  check(/submit:\s*true/.test(yamlText), 'the submit step is marked as the submit step');
  check(/role:\s*['"]?button/.test(yamlText),
    'the recorded click step kept its role, so an ambiguous button text still replayable');
  const reportPath = recipePath().replace(/\.yaml$/, '.compile-report.json');
  check(existsSync(reportPath), 'record.save wrote a compile report', reportPath);
  if (existsSync(reportPath)) {
    const report = readFileSync(reportPath, 'utf8');
    check(report.includes('title') && report.includes('body'),
      'the compile report explains the parameterization');
  }

  const validated = await engine.call('play.validate', { recipeId: 'demo__publish-article' });
  const errors = (validated.issues ?? []).filter((i) => i.level === 'error');
  check(errors.length === 0, 'the compiled recipe validates with no errors', validated.issues);

  const listed = await engine.call('engine.status', {});
  check(listed.recipes >= 1, 'the recipe is discoverable', listed.recipes);

  // ---- phase 3: a later, independent replay with different content ----
  const beforeReplay = submissions.length;
  const dry = await engine.call('play.run', {
    recipeId: 'demo__publish-article',
    accountCode: 'demo-1',
    params: { ...REPLAYED },
    dryRun: true,
    headless: true,
  }, { timeoutMs: 240_000 });
  // A rehearsal must report SUCCESS, not failure. Steps that logically depend on the submission
  // (here: waiting for the redirect to /list) cannot pass once the submit is skipped, so they have to
  // be reported as skipped rather than failed — otherwise the operator reads a green rehearsal as a
  // broken recipe and stops trusting the dry run.
  const drySteps = dry.steps ?? [];
  const shape = drySteps.map((s) => `${s.index}:${s.type}:${s.status}`);
  check(dry.ok === true, 'the dry run reports success, not a failure',
    { ok: dry.ok, failedStep: dry.failedStep, error: dry.error, steps: shape });
  check(drySteps.some((s) => s.status === 'skipped'),
    'the dry run reports skipped steps rather than silently omitting them', shape);
  check(!drySteps.some((s) => s.status === 'failed'),
    'no step is reported as failed in a dry run',
    drySteps.filter((s) => s.status === 'failed').map((s) => `${s.index}:${s.type}`));
  check(submissions.length === beforeReplay,
    'dryRun:true did NOT submit anything (the safety guarantee)', `${submissions.length - beforeReplay} submission(s)`);

  const real = await engine.call('play.run', {
    recipeId: 'demo__publish-article',
    accountCode: 'demo-1',
    params: { ...REPLAYED },
    dryRun: false,
    headless: true,
  }, { timeoutMs: 240_000 });
  check(real.ok === true, 'the real replay reported success', real.failedStep ?? real.error);
  check(submissions.length === beforeReplay + 1,
    'the real replay submitted exactly once', `${submissions.length - beforeReplay} submission(s)`);
  const latest = submissions[submissions.length - 1];
  check(latest?.title === REPLAYED.title,
    'the platform received the REPLAY title, not the recorded one — template substitution works', latest?.title);
  check(latest?.body?.includes('回放时传入的正文'),
    'the platform received the REPLAY body — {{body}} substituted too');
  check(typeof real.publishedUrl === 'string' && real.publishedUrl.includes('/list'),
    'the replay captured the published URL', real.publishedUrl);
  check(typeof real.runDir === 'string' && existsSync(real.runDir),
    'the replay left an inspectable run directory', real.runDir);
  if (real.runDir && existsSync(real.runDir)) {
    const artifacts = readdirSync(real.runDir);
    check(artifacts.includes('run.json'), 'the run directory holds run.json', artifacts.slice(0, 8));
  }

  // ---- phase 4: the recipe is reproducible, not a one-off ----
  const again = await engine.call('play.run', {
    recipeId: 'demo__publish-article',
    accountCode: 'demo-1',
    params: { title: '第三次回放', body: '第三次的正文内容。'.repeat(6) },
    dryRun: false,
    headless: true,
  }, { timeoutMs: 240_000 });
  check(again.ok === true, 'a second replay of the same recipe also succeeds', again.failedStep ?? again.error);
  check(submissions[submissions.length - 1]?.title === '第三次回放',
    'the third submission carried its own content');

  await engine.call('session.close', { sessionId, saveState: true });
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error instanceof EngineError ? `${error.code}: ${error.message}` : error);
  if (error?.details) console.error('details:', JSON.stringify(error.details, null, 2).slice(0, 1800));
} finally {
  if (engine) await engine.close();
  if (server) await new Promise((ok) => server.close(ok));
  if (failures === 0) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`\nall checks passed; removed ${dataDir}`);
  } else {
    console.log(`\n${failures} check(s) failed; kept ${dataDir} for inspection`);
    console.log(`platform submissions seen: ${JSON.stringify(submissions.map((s) => s.title))}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
