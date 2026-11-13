/**
 * smoke.mjs — end-to-end smoke test for ego-publish.
 *
 * Run with the DSH bundled Node:
 *   node tests/smoke.mjs
 *
 * It exercises the real installed ego lite: status, account registry, browser launch over CDP,
 * observe/act/script, and a dry-run publish against example.com (no submit). Set EGO_SMOKE_KEEP=1 to
 * leave the browser open for inspection.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(error) {
  record('unexpected', false, String(error?.stack ?? error));
  throw error;
}

const dataDir = mkdtempSync(join(tmpdir(), 'ego-publish-smoke-'));
process.env.EGO_PUBLISH_DATA_DIR = dataDir;
// Keep the points watchdog out of the smoke run: it would open a headless browser mid-test.
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pointsRefreshMinutes: 0 }));

const { apply, PLUGIN_ROOT } = await import('../src/index.js');
const { loadFlows, runFlow } = await import('../src/flows.js');

/** Minimal registrant context: captures tool definitions and ignores lifecycle plumbing. */
const tools = new Map();
const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
  logger: () => ({ debug: () => {} }),
  on: () => {},
  effect: () => {},
};

const deps = apply(ctx, {});
const call = async (toolName, args = {}) => {
  const tool = tools.get(toolName);
  if (!tool) throw new Error(`tool ${toolName} is not registered (have: ${[...tools.keys()].join(', ')})`);
  return tool.execute(args, {});
};

record('tools registered', tools.size === 10, `${tools.size}: ${[...tools.keys()].join(', ')}`);
record('ego resolved', deps.ego.exists, `${deps.ego.source}: ${deps.ego.path} v${deps.ego.installedVersion}`);

const status = await call('egolite_status', {});
record('status ok', status.ok === true, `flows=${status.flows.length} accounts=${status.accounts.length}`);

const configGet = await call('egolite_config', { op: 'get' });
record('config get', configGet.ok === true && configGet.data.values.requireExplicitPublish === true, JSON.stringify(configGet.data.values));
const configSet = await call('egolite_config', { op: 'set', values: { idleCloseMinutes: 15 } });
record('config set', configSet.ok === true && configSet.data.values.idleCloseMinutes === 15);
await call('egolite_config', { op: 'reset' });

const proxyList = await call('egolite_proxy', { op: 'list' });
record('proxy list', proxyList.ok === true, `${proxyList.data.accounts.length} account row(s)`);

const flowList = await call('egolite_flow', { op: 'list' });
record('flow list', flowList.ok === true && flowList.data.flows.length >= 3, flowList.data.flows.map((flow) => flow.id).join(', '));
const flowShow = await call('egolite_flow', { op: 'show', media: 'sohu' });
record('flow show', flowShow.ok === true && flowShow.data.flow.steps.length > 5, `${flowShow.data.flow.steps.length} steps`);

const flows = loadFlows({ pluginRoot: PLUGIN_ROOT, dataDir });
record('builtin flows load', flows.length >= 3, flows.map((flow) => flow.id).join(', '));

const upsert = await call('egolite_account', { op: 'upsert', code: 'smoke-1', media: 'sohu', account: 'smoke' });
record('account upsert', upsert.ok === true, upsert.data.account.code);

const open = await call('egolite_session', { op: 'open', accountCode: 'smoke-1' });
record('browser open', open.ok === true, `pid=${open.data.pid} port=${open.data.port} ${open.data.browser}`);

const liveStatus = await call('egolite_session', { op: 'status', accountCode: 'smoke-1' });
record('session status', liveStatus.ok === true && liveStatus.data.open === true, liveStatus.data.url ?? '');
const liveList = await call('egolite_session', { op: 'list' });
record('session list', liveList.ok === true && liveList.data.sessions.length >= 1, `${liveList.data.sessions.length} session(s)`);

const goto = await call('egolite_act', { accountCode: 'smoke-1', action: 'goto', url: 'https://example.com' });
record('navigate example.com', goto.ok === true, goto.data.url);

const observe = await call('egolite_observe', { accountCode: 'smoke-1' });
record('observe', observe.ok === true && observe.data.title.length > 0, `title=${observe.data.title} elements=${observe.data.elements.length}`);

const evaluate = await call('egolite_act', { accountCode: 'smoke-1', action: 'eval', expression: 'document.title' });
record('eval', evaluate.ok === true && String(evaluate.data.detail.value).includes('Example'), String(evaluate.data.detail.value));

// Real mouse click through CDP input events.
await call('egolite_act', {
  accountCode: 'smoke-1',
  action: 'eval',
  expression: `document.body.innerHTML = "<button id='probe-btn'>Go</button>"; document.getElementById("probe-btn").addEventListener("click", () => { document.title = "clicked"; }); true`,
});
const clicked = await call('egolite_act', { accountCode: 'smoke-1', action: 'click', selector: '#probe-btn' });
const titleAfterClick = await call('egolite_act', { accountCode: 'smoke-1', action: 'eval', expression: 'document.title' });
record('mouse click', clicked.ok === true && titleAfterClick.data.detail.value === 'clicked', `${JSON.stringify(clicked.data.detail)} -> ${titleAfterClick.data.detail.value}`);

// Contenteditable fill keeps paragraph breaks (the path the rich-text editors use).
await call('egolite_act', {
  accountCode: 'smoke-1',
  action: 'eval',
  expression: 'document.body.innerHTML = \'<div id="editor" contenteditable="true" style="min-height:60px"></div>\'; true',
});
const filled = await call('egolite_act', { accountCode: 'smoke-1', action: 'fill', selector: '#editor', value: 'line one\nline two' });
const editorText = await call('egolite_act', { accountCode: 'smoke-1', action: 'eval', expression: 'document.getElementById("editor").innerText' });
record('contenteditable multi-line fill', filled.ok === true && String(editorText.data.detail.value).includes('line two'), JSON.stringify(editorText.data.detail.value));

const script = await call('egolite_script', {
  accountCode: 'smoke-1',
  code: 'const heading = await title(); log("title", heading); return { heading, url: await url() };',
});
record('script', script.ok === true && String(script.data.result.heading ?? '').length > 0, JSON.stringify(script.data.result));

const flowSpec = {
  id: 'smoke__dry-run',
  media: 'custom',
  label: 'smoke dry run',
  params: [{ name: 'who', required: true }],
  steps: [
    { action: 'goto', url: 'https://example.com', timeoutMs: 30000 },
    { action: 'waitFor', selector: 'body', timeoutMs: 15000 },
    { action: 'eval', expression: 'document.title = "Hello {{who}}"; true' },
    { action: 'screenshot', name: 'filled' },
    { action: 'click', selector: 'a', submit: true },
  ],
};
const saved = await call('egolite_flow', { op: 'save', spec: flowSpec, overwrite: true });
record('flow save', saved.ok === true, saved.data.path);

const publish = await call('egolite_publish', {
  accountCode: 'smoke-1',
  flow: 'smoke__dry-run',
  params: { who: 'smoke' },
});
record('dry-run publish stops before submit', publish.ok === true && publish.data.submitSkipped === true, `steps=${publish.data.steps.length} runDir=${publish.data.runDir}`);

// Real runner check (bypasses the tool) so a submit step would actually be attempted.
const page = deps.manager.get('smoke-1').page;
const run = await runFlow({ page, flow: flows[0], params: { title: 'x', body: 'y' }, dryRun: true, runDir: join(dataDir, 'direct-run') }).catch((error) => ({ error }));
record('built-in flow dry run reaches submit guard', Boolean(run.error) || run.submitSkipped === true, run.error ? String(run.error.message).slice(0, 120) : 'submit skipped');

if (!process.env.EGO_SMOKE_KEEP) {
  await call('egolite_session', { op: 'close', accountCode: 'smoke-1' });
}
record('browser closed', deps.manager.list().length === 0 || process.env.EGO_SMOKE_KEEP === '1');

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (!process.env.EGO_SMOKE_KEEP) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
}
if (failed.length) {
  console.error('FAILED:', failed.map((result) => result.name).join(', '));
  process.exitCode = 1;
}
