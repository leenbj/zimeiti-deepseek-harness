/**
 * handoff-resume-e2e.mjs — acceptance test for the human-in-the-loop path.
 *
 * The chosen recording mode is half-automatic: the agent drives the browser, and when it hits a QR
 * login or a captcha it hands control to the operator, who solves it in the window, and then tells the
 * agent to continue. That contract has three parts and all three must hold:
 *
 *   1. a blocking page is *detected* — an alert is reported, so the agent knows to stop rather than
 *      type an article into a captcha;
 *   2. `session.handoff` reaches the host as an event and returns operator-facing guidance;
 *   3. `session.resume` must NOT claim success while the page is still blocked, and MUST return once the
 *      page becomes usable on its own — which is what happens after a captcha is solved in an SPA.
 *
 * The stand-in page is a single-page app that polls the server, so the DOM becomes clean *without* a
 * navigation, exactly as a real post-captcha re-render does. That distinction matters: a resume loop
 * that only noticed a URL change would pass a naive test and fail in the field.
 *
 * Usage (bundled node):
 *   node tests/handoff-resume-e2e.mjs
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient, EngineError } from '../src/engine-client.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-handoff-'));
let failures = 0;
let engine;
let server;
let baseUrl = '';
/** Server-side switch standing in for the operator solving the challenge. */
let blocked = true;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${suffix}`);
}

function startPlatform() {
  return new Promise((ok) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/_state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ blocked }));
        return;
      }
      if (url.pathname === '/guard') {
        // The challenge text is present only while `blocked`; the page polls and clears itself, so no
        // navigation happens when the operator succeeds.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>后台</title></head><body>
          <h1 id="msg">安全验证</h1>
          <p>请完成验证后继续</p>
          <div id="editor" contenteditable="true" style="border:1px solid #ccc;min-height:40px"></div>
          <script>
            async function poll() {
              try {
                const r = await fetch('/_state');
                const s = await r.json();
                if (!s.blocked) {
                  document.getElementById('msg').textContent = '内容管理';
                  document.title = '内容管理';
                  document.body.setAttribute('data-ready', '1');
                }
              } catch (e) {}
            }
            poll(); setInterval(poll, 400);
          </script></body></html>`);
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

/** @param {string} path */
async function httpGet(path) {
  const response = await fetch(baseUrl + path);
  return response.text();
}

const events = [];

try {
  await startPlatform();
  engine = new EngineClient({ pythonPath: PYTHON, pluginRoot: PLUGIN_ROOT, dataDir, requestTimeoutMs: 120_000 });
  engine.on('log', (line) => console.log(`    engine| ${line}`));
  engine.on('event', (frame) => events.push(frame));
  await engine.call('engine.status', {});
  await engine.call('account.upsert', { code: 'ho-1', media: 'sohu', account: 'handoff test' });

  const session = await engine.call('session.open',
    { accountCode: 'ho-1', headless: true, proxyPolicy: 'direct' }, { timeoutMs: 120_000 });
  const sessionId = session.sessionId;
  await engine.call('act.goto', { sessionId, url: `${baseUrl}/guard` });

  // ---- 1. the blocking page must be detected, so the agent knows to stop ----
  const blockedSnap = await engine.call('session.snapshot', { sessionId });
  check(Array.isArray(blockedSnap.alerts) && blockedSnap.alerts.length > 0,
    'a blocking page reports alerts in the page model', blockedSnap.alerts);
  check((blockedSnap.alerts ?? []).some((a) => a.includes('安全验证')),
    'the alert names the challenge so the agent can react', blockedSnap.alerts);

  // ---- 2. handoff reaches the host and carries guidance for the operator ----
  const handedOff = await engine.call('session.handoff', {
    sessionId, reason: 'captcha', hint: '请在浏览器窗口中完成验证码，然后调用 session.resume',
  });
  check(handedOff.ok === true, 'session.handoff succeeds', handedOff);
  check(typeof handedOff.hint === 'string' && handedOff.hint.includes('resume'),
    'handoff returns operator guidance that names the next step', handedOff.hint);
  const handoffEvent = events.find((e) => e.event === 'handoff');
  check(Boolean(handoffEvent), 'the handoff is delivered to the host as an event',
    events.map((e) => e.event));
  check(handoffEvent?.data?.sessionId === sessionId,
    'the handoff event identifies the session', handoffEvent?.data?.sessionId);

  // ---- 3a. resume must NOT report success while the page is still blocked ----
  let premature = null;
  try {
    await engine.call('session.resume', { sessionId, timeoutMs: 4_000 }, { timeoutMs: 30_000 });
  } catch (error) {
    premature = error;
  }
  check(premature instanceof EngineError, 'resume does not return while the page is still blocked');
  check(premature?.code === 'TIMEOUT', 'the blocked resume reports TIMEOUT, not success', premature?.code);
  check(/验证码|登录|不可用|验证/.test(String(premature?.message ?? '')),
    'the timeout message explains what is still blocking', String(premature?.message ?? '').slice(0, 120));
  check(Array.isArray(premature?.details?.blocking) || Array.isArray(premature?.details?.alerts),
    'the timeout carries the blocking signals for the agent to reason about',
    Object.keys(premature?.details ?? {}));

  // ---- 3b. once the operator succeeds, resume must notice WITHOUT a navigation ----
  blocked = false;
  const urlBeforeResume = (await engine.call('session.state', { sessionId })).url;
  const resumed = await engine.call('session.resume', { sessionId, timeoutMs: 30_000 }, { timeoutMs: 45_000 });
  check(resumed.ok === true, 'resume succeeds once the page becomes usable', resumed);
  const urlAfterResume = (await engine.call('session.state', { sessionId })).url;
  check(urlAfterResume === urlBeforeResume,
    'resume noticed a DOM change, not a navigation — so it works for a post-captcha re-render',
    { before: urlBeforeResume, after: urlAfterResume });
  check(Number.isFinite(resumed.waitedMs),
    'resume reports how long it waited, which is useful evidence', resumed.waitedMs);

  const clearedSnap = await engine.call('session.snapshot', { sessionId });
  check((clearedSnap.alerts ?? []).length === 0,
    'the page model no longer reports alerts after the operator succeeds', clearedSnap.alerts);

  // ---- 4. the session is genuinely usable again: the whole point of resuming ----
  await engine.call('act.type', {
    sessionId, target: { selector: '#editor' }, text: '验证通过后可以正常录入', mode: 'type',
  });
  const typed = await engine.call('act.extract', {
    sessionId, spec: [{ name: 'body', from: { selector: '#editor', text: true } }],
  });
  const value = (typed.data?.values ?? typed.data)?.body ?? '';
  check(String(value).includes('验证通过后可以正常录入'),
    'the session accepts input after resume — resume returns a genuinely usable page', value);

  await engine.call('session.close', { sessionId, saveState: true });
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error instanceof EngineError ? `${error.code}: ${error.message}` : error);
  if (error?.details) console.error('details:', JSON.stringify(error.details, null, 2).slice(0, 1500));
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
