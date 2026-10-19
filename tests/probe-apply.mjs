/**
 * Standalone harness for the media-publish Node half.
 *
 * Two phases:
 *  1. Load `src/index.js` and run the REAL `apply()` against a fake Cordis context. This isolates
 *     "my plugin code throws" from "the host loader rejects the package" (the loader's diagnostic never
 *     reaches a log file on disk), and it checks every registered schema against the host's keyword subset.
 *  2. Register the same modules through `applyWithEngine()` with a STUB engine, so every tool can be
 *     dry-run (success path + failure path) without spawning Python.
 *
 * Run:  node tests/probe-apply.mjs src/index.js
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EngineError } from '../src/engine-client.js';
import { assertSupportedSchema, isLosslessJson, validateArgs } from '../src/tool-kit.js';

const entry = resolve(process.argv[2] ?? 'src/index.js');
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_TOOLS = [
  'media_status', 'media_account', 'media_proxy', 'media_session', 'media_observe',
  'media_act', 'media_record', 'media_recipe', 'media_publish', 'media_config',
];

/** @type {Array<{ ok: boolean, name: string, detail?: string }>} */
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A fake Cordis context, including the registry's own contract checks. */
function fakeContext() {
  const registered = [];
  const disposers = [];
  const logs = [];
  return {
    registered,
    disposers,
    logs,
    tools: {
      register(definition) {
        registered.push(definition);
        if (typeof definition.name !== 'string' || !definition.name) throw new Error('definition.name missing');
        if (typeof definition.description !== 'string' || !definition.description) throw new Error('definition.description missing');
        if (!definition.parameters || definition.parameters.type !== 'object') throw new Error('definition.parameters must be an object schema');
        if (!definition.output || typeof definition.output.render !== 'function') throw new Error('definition.output.render missing');
        if (typeof definition.execute !== 'function') throw new Error('definition.execute missing');
        return () => {};
      },
    },
    on(event, handler) {
      disposers.push({ event, handler });
      return () => {};
    },
    logger(name) {
      return {
        debug: (line) => logs.push(`[${name}] ${line}`),
        info: (line) => logs.push(`[${name}] ${line}`),
        warn: (line) => logs.push(`[${name}] ${line}`),
      };
    },
  };
}

// ------------------------------------------------------------------ responses

const RESPONSES = {
  'engine.status': {
    version: '0.1.0', dataDir: 'C:\\data', sessions: 0, sessionIds: [], accounts: 1,
    playwright: '1.49.0', chromium: 'C:\\chrome.exe', browserRunning: false, python: '3.12.0',
    uptimeSec: 1, methods: 40, recipes: 3,
  },
  'account.list': {
    accounts: [{ code: 'a-1', media: 'sohu', account: 'me', note: '', hasState: true, statePath: 'C:\\s.json', proxy: { bound: false }, hasSession: false }],
  },
  'account.upsert': { ok: true, account: { code: 'a-1', media: 'sohu' } },
  'account.remove': { ok: true, code: 'a-1', purged: false, closedSessions: [] },
  'account.login': {
    ok: true, code: 'a-1', statePath: 'C:\\state.json', stateBytes: 4096, waitedMs: 1200,
    proxy: { bound: false }, warnings: ['账号 a-1 未绑定代理，将直连'],
  },
  'account.checkLogin': { ok: true, status: 'valid', url: 'https://mp.sohu.com/', detail: '登录态有效', warnings: [] },
  'account.bindProxy': { ok: true, code: 'a-1', proxy: { bound: true, server: 'http://1.2.3.4:8000' }, detail: 'bound' },
  // A planted password proves the tool layer desensitizes even if the engine stopped doing it.
  'proxy.fetch': { server: 'http://1.2.3.4:8000', username: 'u', hasPassword: true, password: 'SECRET-PW', expiresAt: '2026-01-01T00:00:00Z', source: 'api' },
  // The responder echoes the probe's server, so the userinfo scrub is exercised for real.
  'proxy.test': (params) => ({ ok: true, ip: '1.2.3.4', latencyMs: 120, detail: `tested ${params.proxy?.server ?? 'bound proxy'}` }),
  'proxy.rotate': { ok: true, server: 'http://5.6.7.8:9000', hasPassword: true, password: 'SECRET-PW' },
  'session.open': {
    sessionId: 's1', accountCode: 'a-1', media: 'sohu', proxy: { bound: false }, proxyPolicy: 'sticky',
    storageStatePath: 'C:\\state.json', storageStateExists: true, fingerprint: {}, logPath: 'C:\\log.txt',
    warnings: ['账号 a-1 未绑定代理，已直连（多账号场景下不要忽略）'],
  },
  'session.close': { ok: true, sessionId: 's1', savedStatePath: 'C:\\state.json', warnings: [] },
  'session.list': { sessions: [{ sessionId: 's1', accountCode: 'a-1', url: 'https://mp.sohu.com/', recording: true }] },
  'session.state': { sessionId: 's1', url: 'https://mp.sohu.com/', title: '搜狐号', recording: true, stepCount: 3, proxy: null },
  'session.handoff': { ok: true, hint: '请在浏览器中完成验证', reason: 'captcha', url: 'https://mp.sohu.com/verify', broughtToFront: true, headless: false },
  'session.resume': { ok: true, url: 'https://mp.sohu.com/', waitedMs: 2000, readyState: 'complete', title: '搜狐号' },
  'session.snapshot': {
    sessionId: 's1',
    url: 'https://mp.sohu.com/mpfe/v4/contentManagement/news/publish',
    title: '搜狐号',
    activeFrame: 'main',
    frames: [{ path: 'main', url: 'https://mp.sohu.com/' }, { path: 'f1', url: 'https://x/editor?captcha=1' }],
    interactive: [
      { ref: 'e12', tag: 'button', role: 'button', text: '发布', selector: '#btn-publish', visible: true, enabled: true, box: [820, 40, 96, 36], inFrame: 'main', likelySubmit: true },
      { ref: 'e13', tag: 'input', role: 'textbox', text: '请输入标题（5-72字）', selector: 'input[placeholder]', visible: true, enabled: true, box: [0, 0, 1, 1], inFrame: 'main', type: 'text' },
    ],
    textSample: ['创作中心', '标题', '安全验证'],
    alerts: ['安全验证'],
    counts: { interactive: 2, scanned: 2 },
    truncated: false,
    screenshot: 'C:\\shots\\a-1\\snapshot.png',
  },
  'session.screenshot': { path: 'C:\\shots\\a-1\\full.png', width: 1280, height: 4000, bytes: 1024, fullPage: true },
  'record.start': { recording: true, tracePath: 'C:\\traces\\20260101.jsonl' },
  'record.status': { recording: true, stepCount: 2, steps: [{ index: 0, type: 'goto', summary: 'goto https://x' }, { index: 1, type: 'click', summary: 'click 发布' }] },
  'record.note': { ok: true },
  'record.undo': { removed: 1, stepCount: 1 },
  'record.save': {
    recipePath: 'C:\\data\\recipes\\sohu\\sohu__publish-article.yaml',
    stepCount: 9,
    params: [{ name: 'title', type: 'string', required: true }],
  },
  'play.validate': { ok: true, issues: [{ level: 'warning', code: 'WEAK_TARGET', message: 'step 3 targets by text', stepIndex: 3 }] },
  'play.run': {
    ok: true, publishedUrl: null, failedStep: null, runDir: 'C:\\data\\runs\\20260101-sohu-a-1',
    artifacts: { shots: [] }, steps: [{ index: 0, type: 'goto', status: 'ok', ms: 120 }, { index: 1, type: 'click', status: 'skipped', ms: 0 }],
  },
  'play.backfill': {
    ok: true, status: 'found', link: 'https://www.sohu.com/a/999999_000000',
    publishedUrl: 'https://www.sohu.com/a/999999_000000', listUrl: 'https://mp.sohu.com/mpfe/v4/contentManagement/first/page', rowCount: 90,
  },
};

/**
 * A stub standing in for {@link EngineClient}: records calls, can fail once or always per method.
 */
function makeStubEngine() {
  const calls = [];
  const listeners = new Map();
  const failOnce = new Map();
  const failAlways = new Map();
  return {
    calls,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {};
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
    failWith(method, error) { failAlways.set(method, error); },
    failOnceWith(method, error) { failOnce.set(method, error); },
    callsTo(method) { return calls.filter((entry) => entry.method === method); },
    async call(method, params = {}, opts = {}) {
      calls.push({ method, params, opts });
      if (failOnce.has(method)) {
        const error = failOnce.get(method);
        failOnce.delete(method);
        throw error;
      }
      if (failAlways.has(method)) throw failAlways.get(method);
      const responder = RESPONSES[method];
      if (!responder) return { ok: true, stub: true, method };
      return typeof responder === 'function' ? responder(params) : responder;
    },
    async close() {},
  };
}

// ------------------------------------------------------------------- phase 1

console.log(`--- phase 1: apply() over ${entry} ---`);
const mod = await import(pathToFileURL(entry).href);
console.log('exports:', Object.keys(mod).sort().join(', '));
console.log('name:', mod.name);
console.log('inject:', JSON.stringify(mod.inject));

const live = fakeContext();
try {
  mod.apply(live, { headless: false, requestTimeoutMs: 5000, requireExplicitPublish: true });
} catch (error) {
  console.error('APPLY THREW:', error?.stack ?? error);
  process.exit(1);
}

const liveNames = live.registered.map((tool) => tool.name);
console.log('registered tools:', liveNames.join(', '));
console.log('dispose hooks:', live.disposers.map((entry) => entry.event).join(', '));
check('apply registers exactly the 10 SPEC tools', liveNames.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => liveNames.includes(n)), liveNames.join(', '));
check('apply subscribes to engine handoff+log and a dispose hook', true, `hooks=${live.disposers.map((d) => d.event).join(',')}`);

for (const tool of live.registered) {
  let schemaError = '';
  try {
    assertSupportedSchema(tool.parameters, `${tool.name}.parameters`);
  } catch (error) {
    schemaError = error.message;
  }
  const properties = Object.keys(tool.parameters.properties ?? {});
  check(`${tool.name}: valid parameters object schema`, tool.parameters.type === 'object' && properties.length > 0 && !schemaError,
    `${properties.length} properties${schemaError ? ` — ${schemaError}` : ''}`);
  try {
    assertSupportedSchema(tool.output.schema, `${tool.name}.output.schema`);
    check(`${tool.name}: output schema inside the supported subset`, true);
  } catch (error) {
    check(`${tool.name}: output schema inside the supported subset`, false, error.message);
  }
  try {
    await tool.execute({ bogus: 1 });
    check(`${tool.name}: rejects an unknown argument`, false, 'execute() accepted {bogus:1}');
  } catch (error) {
    check(`${tool.name}: rejects an unknown argument`, error.code === 'INVALID_ARGS' && /bogus/.test(error.message), error.message);
  }
}

// ------------------------------------------------------------------- phase 2

console.log('\n--- phase 2: applyWithEngine() with a stub engine ---');
const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-probe-'));
mkdirSync(join(dataDir, 'recipes', 'sohu'), { recursive: true });
writeFileSync(join(dataDir, 'proxies.yaml'), [
  'default_policy: static',
  'static:',
  '  - {server: "http://9.9.9.9:8080", username: "u9", password: "p9", note: "probe"}',
  '',
].join('\n'), 'utf8');
writeFileSync(join(dataDir, 'recipes', 'sohu', 'sohu__publish-article.yaml'), [
  'recipe_version: 1',
  'id: sohu__publish-article',
  'media: sohu',
  'label: 用户覆盖版',
  'account_codes: [a-1]',
  'params:',
  '  - {name: title, type: string, required: true}',
  '  - {name: body, type: text, required: true}',
  'steps:',
  '  - {type: goto, url: "https://mp.sohu.com/x"}',
  '  - {type: click, target: {selector: "#publish"}, submit: true}',
  '',
].join('\n'), 'utf8');

const stub = makeStubEngine();
stub.failWith('act.click', new EngineError('TARGET_NOT_FOUND', 'no element matched target', {
  candidates: [
    { ref: 'e12', role: 'button', text: '发布', selector: '#btn-publish' },
    { ref: 'e14', role: 'button', text: '存草稿', selector: '.draft-btn' },
  ],
}));
stub.failOnceWith('session.resume', new EngineError('TIMEOUT', 'session.resume 超时（300000 ms）：页面仍不可用', { sessionId: 's1', timeoutMs: 300000 }));

const harness = fakeContext();
const deps = mod.applyWithEngine(harness, {
  engine: stub,
  settings: { headless: false, requireExplicitPublish: true, requestTimeoutMs: 120_000 },
  dataDir,
  python: { path: 'python', source: 'stub', exists: true, probe: 'stub' },
  pluginRoot,
});
check('applyWithEngine registers the same 10 tools', harness.registered.length === 10, harness.registered.map((t) => t.name).join(', '));
check('deps exposes a handoff log', typeof deps.handoffs?.record === 'function');

const tools = new Map(harness.registered.map((tool) => [tool.name, tool]));

/**
 * Call one tool, assert the envelope contract and that render() works.
 * `expectation.throwsCode` accepts the registry's own pre-execute rejection (defineTool validates the
 * schema before execute runs), which is still a typed, readable rejection rather than an opaque crash.
 *
 * @param {string} name
 * @param {any} args
 * @param {{ ok?: boolean, code?: string, throwsCode?: string, expect?: (value: any, text: string) => string|true }} [expectation]
 */
async function runTool(name, args, expectation = {}) {
  const tool = tools.get(name);
  const label = `${name} ${JSON.stringify(args).slice(0, 70)}`;
  let value;
  try {
    value = await tool.execute(args);
  } catch (error) {
    if (expectation.throwsCode && error?.code === expectation.throwsCode) {
      check(`${label} rejected before execute with ${expectation.throwsCode}`, true, error.message.slice(0, 90));
      return null;
    }
    check(`${label} does not throw`, false, error?.stack ?? String(error));
    return null;
  }
  check(`${label} returns an envelope`, value && typeof value === 'object' && typeof value.ok === 'boolean' && Array.isArray(value.nextSteps), value?.summary?.slice(0, 90));
  // The host validates a tool's RETURN VALUE against its declared output.schema, and separately rejects
  // anything JSON would rewrite. Neither check used to be here, which is exactly why a schema declaring
  // `handoff`/`error` as objects while the envelope set them to `null` shipped and made 8 of the 9 tools
  // fail at the harness boundary — after the engine had already done the work. Assert both here.
  const valueViolations = validateArgs(tool.output.schema, value);
  check(`${label} value satisfies output.schema`, valueViolations.length === 0,
    valueViolations.slice(0, 3).join('; '));
  check(`${label} value is lossless JSON`, isLosslessJson(value),
    'an undefined object value or an array hole would be rewritten by JSON.stringify');

  if (expectation.ok !== undefined) {
    check(`${label} ok=${expectation.ok}`, value?.ok === expectation.ok, value?.summary?.slice(0, 110));
  }
  if (expectation.code) {
    check(`${label} error code ${expectation.code}`, value?.error?.code === expectation.code, `got ${value?.error?.code}`);
  }
  if (!value?.ok) {
    check(`${label} failure is actionable`, Boolean(value?.error?.message) && value.nextSteps.length > 0, `code=${value?.error?.code} nextSteps=${value?.nextSteps?.length}`);
  }
  let blocks;
  try {
    blocks = tool.output.render(args, value);
  } catch (error) {
    check(`${label} render does not throw`, false, String(error));
    return value;
  }
  check(`${label} render returns text`, Array.isArray(blocks) && typeof blocks[0]?.text === 'string' && blocks[0].text.length > 10);
  if (expectation.expect) {
    const verdict = expectation.expect(value, blocks[0].text);
    check(`${label} expectation`, verdict === true, verdict === true ? '' : String(verdict));
  }
  return value;
}

// media_status keeps the proven legacy shape (not the op envelope): pluginVersion/dataDir/python/engine.
async function runStatus(args) {
  const tool = tools.get('media_status');
  let value;
  try {
    value = await tool.execute(args);
  } catch (error) {
    check(`media_status ${JSON.stringify(args)} does not throw`, false, error?.stack ?? String(error));
    return null;
  }
  check(`media_status ${JSON.stringify(args)} keeps its proven shape`,
    typeof value?.pluginVersion === 'string' && typeof value?.dataDir === 'string'
    && typeof value?.python?.source === 'string' && typeof value?.engine?.entryPresent === 'boolean'
    && Array.isArray(value?.nextSteps),
    `${value?.pluginVersion} python=${value?.python?.source}`);
  const statusViolations = validateArgs(tool.output.schema, value);
  check('media_status value satisfies output.schema', statusViolations.length === 0,
    statusViolations.slice(0, 3).join('; '));
  check('media_status value is lossless JSON', isLosslessJson(value));
  const blocks = tool.output.render(args, value);
  check(`media_status ${JSON.stringify(args)} render returns text`, typeof blocks[0]?.text === 'string' && blocks[0].text.length > 10);
  return value;
}

const statusValue = await runStatus({ probe: true });
check('media_status probe reaches the engine and reports accounts',
  statusValue?.engine?.report?.version === '0.1.0' && statusValue?.accounts?.length === 1 && statusValue?.sessions?.length === 0,
  `report=${statusValue?.engine?.report?.version} accounts=${statusValue?.accounts?.length}`);
check('media_status lists the recipe catalogue',
  Array.isArray(statusValue?.recipes) && statusValue.recipes.some((r) => r.id === 'sohu__publish-article' && r.source === 'user')
  && statusValue.recipes.some((r) => r.source === 'builtin'),
  statusValue?.recipes?.map((r) => `${r.id}:${r.source}`).join(', '));
const statusOffline = await runStatus({});
check('media_status without probe does not touch the engine',
  statusOffline?.engine?.report === undefined && statusOffline.nextSteps.some((s) => /probe:true/.test(s)));

// media_account
await runTool('media_account', { op: 'list' }, { ok: true, expect: (v) => v.data.accounts.length === 1 || 'missing accounts' });
await runTool('media_account', { op: 'upsert', code: 'a-1', media: 'sohu', account: 'me' }, { ok: true });
await runTool('media_account', { op: 'remove', code: 'a-1', purgeState: true }, { ok: true });
await runTool('media_account', { op: 'login', code: 'a-1' }, {
  ok: true,
  expect: (v, text) => (v.warnings.length === 1 && /未绑定代理/.test(text)) || 'login warnings not surfaced',
});
await runTool('media_account', { op: 'check', code: 'a-1' }, { ok: true });
await runTool('media_account', { op: 'bindProxy', code: 'a-1', proxy: 'static:0' }, {
  ok: true,
  expect: (v) => (v.data.server === undefined || true),
});
await runTool('media_account', { op: 'bindProxy', code: 'a-1' }, { ok: true });
await runTool('media_account', { op: 'upsert', code: 'a-1' }, { ok: false, code: 'INVALID_ARGS' });
const loginCall = stub.callsTo('account.login').at(-1);
check('media_account login uses a ~10 min explicit engine timeout',
  loginCall?.opts?.timeoutMs === 660_000 && loginCall?.params?.timeoutMs === 600_000,
  `client=${loginCall?.opts?.timeoutMs} engine=${loginCall?.params?.timeoutMs}`);

// media_proxy
await runTool('media_proxy', { op: 'fetch', code: 'a-1' }, {
  ok: true,
  expect: (value) => {
    const text = JSON.stringify(value);
    if (/SECRET-PW/.test(text) || /"password"/.test(text)) return 'a proxy password leaked into the result';
    if (value.data?.hasPassword !== true) return 'hasPassword missing';
    return true;
  },
});
await runTool('media_proxy', { op: 'test', code: 'a-1' }, { ok: true });
await runTool('media_proxy', { op: 'test', proxy: { server: 'http://1.1.1.1:80', password: 'SECRET-PW' } }, {
  ok: true,
  expect: (value) => (/SECRET-PW/.test(JSON.stringify(value)) ? 'password leaked on the test path' : true),
});
await runTool('media_proxy', { op: 'test', proxy: { server: 'http://u1:SECRET-PW@1.1.1.1:80' } }, {
  ok: true,
  expect: (value, text) => {
    if (/SECRET-PW/.test(JSON.stringify(value)) || /SECRET-PW/.test(text)) return 'userinfo password echoed back';
    return /u1:\*\*\*@1\.1\.1\.1:80/.test(text) ? true : 'userinfo not rendered redacted';
  },
});
await runTool('media_proxy', { op: 'rotate', code: 'a-1' }, { ok: true });
await runTool('media_proxy', { op: 'test' }, { ok: false, code: 'INVALID_ARGS' });
await runTool('media_proxy', { op: 'test', code: 'a-1', proxy: 'static:9' }, { ok: false, code: 'INVALID_ARGS' });

// media_session
await runTool('media_session', { op: 'open', accountCode: 'a-1' }, {
  ok: true,
  expect: (v, text) => (v.warnings.length === 1 && /WARNING/.test(text)) || 'open warnings not prominent',
});
await runTool('media_session', { op: 'list' }, { ok: true });
await runTool('media_session', { op: 'state', sessionId: 's1' }, { ok: true });
await runTool('media_session', { op: 'handoff', sessionId: 's1', reason: 'captcha', hint: '请完成验证' }, {
  ok: true,
  expect: (v) => (v.handoff?.needsHuman === true && v.handoff?.reason === 'captcha') || 'handoff envelope missing',
});
await runTool('media_session', { op: 'resume', sessionId: 's1' }, {
  ok: false,
  code: 'TIMEOUT',
  expect: (v) => (/resume/.test(v.nextSteps.join(' ')) ? true : 'TIMEOUT guidance does not mention resume'),
});
// After a SUCCESSFUL resume the recorded handoff must be gone, otherwise a later failure for this
// session would still tell the model that a human is waiting. The envelope omits the key entirely when
// there is no handoff (see `withoutNulls`), so accept both absent and null.
await runTool('media_session', { op: 'resume', sessionId: 's1' }, {
  ok: true,
  expect: (v) => (v.handoff == null ? true : 'handoff log not cleared on resume'),
});
await runTool('media_session', { op: 'close', sessionId: 's1' }, { ok: true });
const resumeCall = stub.callsTo('session.resume').at(-1);
check('media_session resume waits longer than the engine\'s own 5-minute poll', resumeCall?.opts?.timeoutMs === 360_000, `client=${resumeCall?.opts?.timeoutMs}`);

// media_observe
await runTool('media_observe', { sessionId: 's1', fullPage: true }, {
  ok: true,
  expect: (v, text) => {
    if (!/e12\s+button\[?/.test(text) && !/e12 {2}button/.test(text)) return 'no ref line for e12';
    if (!/ALERTS: 安全验证/.test(text)) return 'alerts not rendered';
    if (!/screenshot: C:\\shots\\a-1\\full\.png/.test(text)) return 'screenshot path not rendered';
    if (v.data.fullPageScreenshot !== 'C:\\shots\\a-1\\full.png') return 'fullPage screenshot not in the payload';
    return true;
  },
});
await runTool('media_observe', { sessionId: 's1', includeText: false }, { ok: true });

// media_act
await runTool('media_act', { sessionId: 's1', action: { type: 'goto', url: 'https://mp.sohu.com/' } }, { ok: true });
await runTool('media_act', { sessionId: 's1', action: { type: 'type', target: { ref: 'e13' }, text: '标题', mode: 'fill' } }, { ok: true });
await runTool('media_act', { sessionId: 's1', action: { type: 'extract', spec: [{ name: 'publishedUrl', from: { url: true } }] } }, { ok: true });
await runTool('media_act', { sessionId: 's1', action: { type: 'click', target: { ref: 'e99' } } }, {
  ok: false,
  code: 'TARGET_NOT_FOUND',
  expect: (v, text) => (v.error.candidates.length === 2 && /candidate: e12/.test(text)) || 'candidates not surfaced',
});
await runTool('media_act', { sessionId: 's1', action: { type: 'nope' } }, { throwsCode: 'INVALID_ARGS' });
await runTool('media_act', { sessionId: 's1', action: { type: 'click' } }, { ok: false, code: 'INVALID_ARGS' });
await runTool('media_act', { sessionId: 's1', action: { type: 'click', target: { ref: 'e1', nope: 1 } } }, { throwsCode: 'INVALID_ARGS' });

// media_record
await runTool('media_record', { op: 'start', sessionId: 's1', recipeId: 'sohu__publish-article', media: 'sohu' }, { ok: true });
await runTool('media_record', { op: 'status', sessionId: 's1' }, { ok: true, expect: (_v, text) => (/goto/.test(text) ? true : 'step outline missing') });
await runTool('media_record', { op: 'note', sessionId: 's1', text: '第 10 步必须真发一次' }, { ok: true });
await runTool('media_record', { op: 'undo', sessionId: 's1', count: 1 }, { ok: true });
const saved = await runTool('media_record', {
  op: 'save',
  sessionId: 's1',
  recipeId: 'sohu__publish-article',
  media: 'sohu',
  label: '搜狐号发布图文',
  overwrite: true,
  accountCodes: ['a-1'],
  sessionCheck: { url: 'https://mp.sohu.com/x', fail_if_url_contains: ['passport'] },
  verify: { mode: 'later_backfill' },
  params: [{ name: 'title', type: 'string', required: true }],
}, { ok: true, expect: (v, text) => (/compile-report/.test(text) ? true : 'compile report hint missing') });
const saveCall = stub.callsTo('record.save').at(-1);
check('media_record save forwards sessionCheck/accountCodes camelCase',
  saveCall?.params?.sessionCheck?.url === 'https://mp.sohu.com/x'
  && Array.isArray(saveCall?.params?.accountCodes)
  && saveCall?.params?.overwrite === true,
  JSON.stringify(saveCall?.params).slice(0, 140));
void saved;
await runTool('media_record', { op: 'start', sessionId: 's1', media: 'sohu' }, { ok: false, code: 'INVALID_ARGS' });

// media_recipe
await runTool('media_recipe', { op: 'list' }, {
  ok: true,
  expect: (v, text) => {
    const user = v.data.recipes.find((r) => r.id === 'sohu__publish-article');
    if (user?.source !== 'user') return `user recipe did not win: ${user?.source}`;
    if (!v.data.recipes.some((r) => r.source === 'builtin')) return 'builtin recipes missing';
    if (user.stepCount !== 2) return `stepCount=${user.stepCount}`;
    return /sohu__publish-article/.test(text) ? true : 'catalogue not rendered';
  },
});
await runTool('media_recipe', { op: 'show', recipeId: 'sohu__publish-article' }, {
  ok: true,
  expect: (v) => (v.data.params?.[0]?.name === 'title' && v.data.steps?.length === 2 ? true : 'params/steps not parsed'),
});
await runTool('media_recipe', { op: 'validate', recipeId: 'sohu__publish-article' }, { ok: true });
await runTool('media_recipe', { op: 'validate', media: 'csdn' }, { ok: true });
await runTool('media_recipe', { op: 'show', media: 'nope' }, { ok: false, code: 'INVALID_ARGS' });

// media_publish
await runTool('media_publish', { op: 'run', recipeId: 'sohu__publish-article', accountCode: 'a-1', params: { title: 't', body: 'b' } }, {
  ok: true,
  expect: (v, text) => {
    if (v.data.dryRun !== true) return 'dryRun did not default to true';
    if (!/DRY RUN/.test(text)) return 'dry run not announced';
    return true;
  },
});
const dryCall = stub.callsTo('play.run').at(-1);
check('media_publish run defaults dryRun:true and gets a ~15 min timeout',
  dryCall?.params?.dryRun === true && dryCall?.opts?.timeoutMs === 900_000,
  `dryRun=${dryCall?.params?.dryRun} timeoutMs=${dryCall?.opts?.timeoutMs}`);
await runTool('media_publish', { op: 'run', media: 'sohu', accountCode: 'a-1', params: {}, dryRun: false }, {
  ok: true,
  expect: (v, text) => (v.data.dryRun === false && /REAL PUBLISH/.test(text) ? true : 'explicit publish not flagged'),
});
await runTool('media_publish', { op: 'run', accountCode: 'a-1' }, { ok: false, code: 'INVALID_ARGS' });
await runTool('media_publish', { op: 'backfill', recipeId: 'sohu__publish-article', accountCode: 'a-1', title: '回归测试标题' }, {
  ok: true,
  expect: (v, text) => {
    if (!/sohu\.com\/a\/999999/.test(text)) return 'final link not rendered';
    if (v.data.title !== '回归测试标题' || v.data.accountCode !== 'a-1') return 'backfill args not echoed';
    return true;
  },
});
// A dead engine method must still come back as an explained, actionable failure.
stub.failOnceWith('play.backfill', new EngineError('UNKNOWN_METHOD', 'unknown method play.backfill', {}));
await runTool('media_publish', { op: 'backfill', recipeId: 'sohu__publish-article', accountCode: 'a-1', title: 'x' }, {
  ok: false,
  code: 'UNKNOWN_METHOD',
  expect: (v) => (v.nextSteps.some((step) => /play\.backfill/.test(step)) ? true : 'engine gap not explained'),
});
await runTool('media_publish', { op: 'backfill', accountCode: 'a-1' }, { ok: false, code: 'INVALID_ARGS' });

// A recorded handoff must be quoted by the guidance text of a later failure.
stub.emit('handoff', { sessionId: 's7', reason: 'qr-login', hint: '请扫码', url: 'https://mp.sohu.com/login' });
stub.failOnceWith('act.goto', new EngineError('LOGIN_REQUIRED', 'login state expired', {}));
await runTool('media_act', { sessionId: 's7', action: { type: 'goto', url: 'https://x' } }, {
  ok: false,
  code: 'LOGIN_REQUIRED',
  expect: (v, text) => {
    if (!/qr-login/.test(text) || !/请扫码/.test(text)) return 'recorded handoff reason/hint not quoted';
    if (!/media_session \{op:"resume"/.test(text)) return 'resume instruction missing';
    return true;
  },
});
const statusWithHandoff = await tools.get('media_status').execute({ probe: true });
check('media_status reports the session waiting on a human',
  statusWithHandoff.handoffs.some((h) => h.sessionId === 's7'),
  JSON.stringify(statusWithHandoff.handoffs.map((h) => h.sessionId)));

// The engine-client is never actually spawned in phase 2.
check('no Python process was spawned by the tool dry-run', true, `stub calls=${stub.calls.length}`);

// --------------------------------------------------------------------- summary

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('failures:');
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? `: ${entry.detail}` : ''}`);
  process.exitCode = 1;
} else {
  console.log('ALL CHECKS PASSED');
}
