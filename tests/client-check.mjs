/**
 * client-check.mjs — static + registration check for the hand-written client bundle.
 *
 * It evaluates lib/client.js with a fake `window.__ModuleLoader__` and a minimal `react`, then applies
 * the module to a fake browser plugin context and asserts the four Settings seats, the locale
 * dictionaries, and the theme-token-only stylesheet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const clientPath = join(import.meta.dirname, '..', 'lib', 'client.js');
const source = readFileSync(clientPath, 'utf8');
record('client file exists', source.length > 5000, `${source.length} bytes`);

// A fake module table: the only import the bundle is allowed to make.
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};
const capture = { id: null, module: null };
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      capture.id = spec.id;
      capture.module = spec.factory((name) => {
        if (name === 'react') return fakeReact;
        throw new Error(`unexpected module request: ${name}`);
      });
    },
  },
};

await import(pathToFileURL(clientPath).href);
record('loader id', capture.id === '@dsh-plugin/ego-publish', String(capture.id));
const mod = capture.module;
record('exports', Boolean(mod && typeof mod.apply === 'function' && Array.isArray(mod.inject)),
  mod ? `inject=${JSON.stringify(mod.inject)}` : 'no module');
record('dictionaries', Boolean(mod?.dictionaries?.zh?.title && mod?.dictionaries?.en?.title),
  `${Object.keys(mod?.dictionaries?.zh ?? {}).length} zh keys`);
record('stylesheet uses theme tokens', /--dsw-alias-/.test(mod?.STYLES ?? '') && !/#[0-9a-fA-F]{3,8}\b/.test(mod?.STYLES ?? ''),
  `${(mod?.STYLES ?? '').length} chars`);

const registered = [];
const ctx = {
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
  effect: (fn) => {
    const dispose = fn();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
  slots: {
    inject: (name, callback) => {
      callback();
      return () => {};
    },
    register: (options) => {
      registered.push(options);
      return () => {};
    },
  },
};
mod.apply(ctx);
const seats = registered.map((item) => item.name);
record('settings seats', seats.includes('settings.section')
  && seats.includes('settings.plugins.tab')
  && seats.includes('plugins.row.config')
  && seats.includes('plugins.bundle.config'), seats.join(', '));
record('sidebar panel entry', seats.includes('sidebar.panellist'), seats.join(', '));
record('main panel', seats.includes('main'), seats.join(', '));
const panelEntry = registered.find((item) => item.name === 'sidebar.panellist');
record('panel id + label', panelEntry?.id === 'ego-publish' && typeof panelEntry.label === 'function', JSON.stringify(panelEntry?.id));
const mainEntry = registered.find((item) => item.name === 'main');
record('main panel key', mainEntry?.key === 'ego-publish', String(mainEntry?.key));
const rowKey = registered.find((item) => item.name === 'plugins.row.config')?.key;
record('row config key', rowKey === '@dsh-plugin/ego-publish#ego-publish', String(rowKey));
const section = registered.find((item) => item.name === 'settings.section');
record('settings section label', section?.id === 'ego-publish' && typeof section.label === 'function', JSON.stringify(section?.id));

// Render the page component with a prepared "ready" state, so a crash or a missing label is caught
// without a browser. React is replaced by a hook shim; the element tree is only walked for text.
const prepared = {
  phase: 'ready',
  data: {
    plugin: { version: '0.5.0', egoExists: true, egoPath: 'C:/ego.exe', dataDir: 'C:/data', installedVersion: '156' },
    config: { values: { idleCloseMinutes: 30, requireExplicitPublish: true, egoPath: null }, sources: { idleCloseMinutes: 'file' }, defaults: {} },
    accounts: [{
      code: 'a-1', media: 'sohu', label: '搜狐号', account: 'alice', note: '', hasProfile: true,
      proxy: { server: 'http://127.0.0.1:7890', hasAuth: true, username: 'u' },
      proxyId: 'p-1',
      lastCheck: { ok: true, at: 'x', detail: '' },
      points: { value: 45, recent30: 0, components: { '违规行为': -444 }, at: '2026-10-30T06:00:00.000Z', error: null, trend: 'down', delta: -3, history: [{ at: 'x', value: 48 }, { at: 'y', value: 45 }] },
    }],
    sessions: [{ accountCode: 'a-1', pid: 42, url: 'https://example.com/', proxy: null }],
    proxies: [{ id: 'p-1', label: 'HK-01', server: 'http://127.0.0.1:7890', hasAuth: true, username: 'u', lastTest: { ok: true, ip: '203.0.113.7', latencyMs: 120, at: 'x' }, assigned: ['a-1'] }],
    flows: [{ id: 'sohu__publish-article', label: '搜狐号发布图文', media: 'sohu', stepCount: 14 }],
    media: [{ key: 'sohu', label: '搜狐号' }, { key: 'custom', label: '自定义站点' }],
  },
  error: null, notice: null, busy: null, modalOpen: false, editing: null, tab: 'accounts',
  form: { code: '', media: 'sohu', account: '', note: '', proxyId: '' },
  proxyFormOpen: false, proxyEditing: null, proxyForm: { label: '', server: '', username: '', password: '' },
  draft: { idleCloseMinutes: 30, requireExplicitPublish: true, egoPath: null },
  draftDirty: false,
};
let firstState = true;
const renderReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => {
    if (firstState) {
      firstState = false;
      return [prepared, () => {}];
    }
    return [initial, () => {}];
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
};
// Re-evaluate the bundle with the render hook shim.
let renderModule = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      renderModule = spec.factory((name) => (name === 'react' ? renderReact : (() => { throw new Error(name); })()));
    },
  },
};
const sourceUrl = pathToFileURL(clientPath).href;
await import(`${sourceUrl}?render=1`);
const texts = [];
// Resolve function components (the exported card is a thin wrapper around the body component).
function resolve(node) {
  if (node === null || node === undefined) return node;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(resolve);
  if (typeof node.type === 'function') return resolve(node.type({ ...(node.props || {}), children: node.children }));
  return { ...node, children: (node.children || []).map(resolve) };
}
function collect(node, into) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') { into.push(node); return; }
  if (Array.isArray(node)) { node.forEach((item) => collect(item, into)); return; }
  if (node.children) node.children.forEach((item) => collect(item, into));
}
collect(resolve(renderModule.EgoPublishCard({ view: 'page', t: (key) => key })), texts);
const rendered = texts.join(' | ');
record('page renders without crashing', texts.join('').length > 0, `${texts.length} text nodes`);
record('page shows account + status', rendered.includes('a-1') && rendered.includes('accountsTitle') && rendered.includes('signedIn'), rendered.slice(0, 160));
record('page shows tabs + stats', rendered.includes('tabAccounts') && rendered.includes('tabProxies') && rendered.includes('statsProxied'), rendered.slice(0, 200));
record('page shows the proxy pool tab', rendered.includes('tabProxies') && rendered.includes('p-1'), rendered.slice(0, 240));
record('page shows points and the falling warning', rendered.includes('points 45 ↓')
  && rendered.includes('pointsWarning')
  && rendered.includes('a-1 (45)'), rendered.slice(0, 260));
record('account row shows the proxy id', rendered.includes('p-1') && !rendered.includes('noProxy'), rendered.slice(0, 240));

// The account dialog must render its guided header/sections/footer when opened.
prepared.modalOpen = true;
prepared.editing = 'a-1';
firstState = true;
const modalTexts = [];
collect(resolve(renderModule.EgoPublishCard({ view: 'page', t: (key) => key })), modalTexts);
const modalRendered = modalTexts.join(' | ');
record('account dialog renders', modalRendered.includes('editAccountTitle')
  && modalRendered.includes('sectionIdentity')
  && modalRendered.includes('sectionNetwork')
  && modalRendered.includes('afterSaveHint')
  && modalRendered.includes('saveAccount'), modalRendered.slice(-220));
record('account dialog shows points detail', modalRendered.includes('pointsDetail')
  && modalRendered.includes('refreshPointsNow')
  && modalRendered.includes('45'), modalRendered.slice(-260));

// The Open browsers tab shows a direct/proxy tag plus a connectivity badge.
prepared.modalOpen = false;
prepared.tab = 'sessions';
firstState = true;
const sessionTexts = [];
collect(resolve(renderModule.EgoPublishCard({ view: 'page', t: (key) => key })), sessionTexts);
const sessionRendered = sessionTexts.join(' | ');
record('sessions tab shows connectivity', sessionRendered.includes('sessionsTitle')
  && sessionRendered.includes('direct')
  && sessionRendered.includes('notProbed'), sessionRendered.slice(-200));

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;