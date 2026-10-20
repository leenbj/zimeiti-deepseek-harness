/**
 * client-render-check.mjs — a real render test for the settings page.
 *
 * Why this exists: the account form used to be permanently rendered at the bottom of the panel, with no
 * “add account” button anywhere. Every static assertion still passed, because nothing was missing from the
 * source — the UI simply had no entry point, and only a human looking at the screen could tell. Static
 * checks cannot catch a layout that renders but is wrong.
 *
 * This file runs the shipped bundle through a tiny React that actually re-renders on setState, so it can
 * assert behaviour a person would check by clicking:
 *
 *   1. an explicit “新增账号” button exists in the accounts card;
 *   2. the form is NOT rendered before it is asked for;
 *   3. clicking that button opens the form;
 *   4. cancel closes it again;
 *   5. a row's “编辑” opens the form pre-filled with that account.
 *
 * Usage (bundled node):
 *   node tests/client-render-check.mjs
 */
import { readFileSync } from 'node:fs';
import { createContext, runInNewContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let failures = 0;
/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
}

// --------------------------------------------------------------------------- a tiny re-rendering React
function createReact() {
  const hooks = [];
  const effects = [];
  let cursor = 0;
  let dirty = false;
  let effectsRan = false;

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const slot = hooks[index];
      const set = (updater) => {
        slot.value = typeof updater === 'function' ? updater(slot.value) : updater;
        dirty = true;
      };
      return [slot.value, set];
    },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { value: { current: initial ?? null } };
      return hooks[index].value;
    },
    useEffect(effect) { effects.push(effect); },
  };

  return {
    React,
    reset() { effects.length = 0; cursor = 0; dirty = false; effectsRan = false; },
    async render(component, props) {
      let tree = null;
      for (let pass = 0; pass < 25; pass += 1) {
        cursor = 0;
        dirty = false;
        effects.length = 0;
        tree = component(props);
        if (!effectsRan) {
          effectsRan = true;
          for (const effect of effects) effect();
        }
        // Let the async loaders (fetch → setState) settle before deciding whether another pass is needed.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!dirty) break;
      }
      return tree;
    },
    /** Re-render after a click, without re-running mount effects. */
    async settle(component, props) {
      return this.render(component, props);
    },
  };
}

// --------------------------------------------------------------------------- tree helpers
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function textOf(node) {
  const parts = [];
  walk(node, (element) => {
    for (const child of element.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') parts.push(String(child));
    }
  });
  return parts.join(' ');
}

function findAll(node, predicate) {
  const found = [];
  walk(node, (element) => { if (predicate(element)) found.push(element); });
  return found;
}

function buttonByText(tree, label) {
  return findAll(tree, (element) => element.type === 'button' && textOf(element).includes(label))[0] ?? null;
}

function byProps(tree, predicate) {
  return findAll(tree, (element) => predicate(element.props ?? {}))[0] ?? null;
}

// --------------------------------------------------------------------------- load the shipped bundle
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
let captured = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { captured = definition; } } },
  document: {
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', remove() {}, setAttribute() {} }),
    querySelector: () => null,
  },
  navigator: { language: 'zh-CN' },
  location: { href: 'http://localhost/' },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
const context = createContext(sandbox);
runInNewContext(source, context);

if (!captured) {
  console.error('FATAL: the bundle did not register itself with the module loader');
  process.exit(1);
}

const harness = createReact();
const requireShim = (id) => {
  if (id === 'react') return harness.React;
  if (id === 'react/jsx-runtime') {
    return {
      jsx: harness.React.createElement,
      jsxs: harness.React.createElement,
      Fragment: harness.React.Fragment,
    };
  }
  throw new Error(`unexpected module ${id}`);
};

const exported = captured.factory(requireShim);
const component = exported.MediaPublishCard;
if (typeof component !== 'function') {
  console.error('FATAL: MediaPublishCard is not exported');
  process.exit(1);
}

const t = (key) => exported.dictionaries.zh[key] ?? key;

// --------------------------------------------------------------------------- the server-side stubs
const accountsPayload = {
  ok: true,
  media: ['sohu', 'toutiao', 'csdn'],
  accounts: [
    {
      code: 'a-1', media: 'sohu', account: '搜狐号主号', note: '', hasState: true,
      state: { path: 'x', exists: true, bytes: 2048 },
      proxy: { bound: false, server: null, username: null, hasPassword: false },
    },
  ],
};
const configPayload = { ok: true, revision: 1, fields: [], warnings: [], applied: false };

sandbox.fetch = async (path) => ({
  status: 200,
  ok: true,
  json: async () => (String(path).startsWith('/media-publish/accounts') ? accountsPayload : configPayload),
});

// --------------------------------------------------------------------------- the checks
try {
  harness.reset();
  const tree = await harness.render(component, { t });

  const addButton = buttonByText(tree, t('addAccount'));
  check(Boolean(addButton), 'the accounts card shows an explicit “add account” button', t('addAccount'));
  check(addButton?.props?.className?.includes('mp-btn-primary'),
    'and it is a primary button, so it reads as the main action', addButton?.props?.className);

  check(textOf(tree).includes('a-1'), 'the account list renders its rows');

  const codeInput = () => byProps(tree, (props) => props.id === 'mp-acc-code');
  check(!byProps(tree, (props) => props.id === 'mp-acc-code'),
    'the form is NOT rendered until it is asked for');
  check(!byProps(tree, (props) => props.role === 'dialog'),
    'and no dialog is on screen either');

  // ---- click “add account” ----
  addButton?.props?.onClick?.();
  const opened = await harness.settle(component, { t });
  check(Boolean(byProps(opened, (props) => props.id === 'mp-acc-code')),
    'clicking it opens the form (the account code input appears)');

  // It must be a MODAL, not an inline expander: the account form is a guided pop-up.
  const dialog = byProps(opened, (props) => props.role === 'dialog');
  check(Boolean(dialog), 'it opens as a modal dialog (role="dialog"), not inline');
  check(dialog?.props?.['aria-modal'] === 'true',
    'marked aria-modal so assistive tech treats it as modal', dialog?.props);
  check(dialog?.props?.['aria-labelledby'] === 'mp-acc-dialog-title',
    'and labelled by its title', dialog?.props?.['aria-labelledby']);
  check(Boolean(byProps(opened, (props) => String(props.className ?? '').includes('mp-overlay'))),
    'presented over a full-screen overlay');
  check(Boolean(byProps(opened, (props) => String(props.className ?? '').includes('mp-icon-btn'))),
    'with an explicit close button in the header');
  check(textOf(opened).includes(t('accountDialogHint')),
    'and a line of guidance about what to fill in');
  check(Boolean(byProps(opened, (props) => props.id === 'mp-acc-media')),
    'with the platform selector');
  check(textOf(opened).includes(t('addAccount')),
    'and the form is labelled as a new account');

  // ---- cancel closes it ----
  const cancel = buttonByText(opened, t('cancel'));
  check(Boolean(cancel), 'the open form offers a cancel button');
  cancel?.props?.onClick?.();
  const closed = await harness.settle(component, { t });
  check(!byProps(closed, (props) => props.id === 'mp-acc-code'),
    'cancel closes the form again');

  // ---- a row's “edit” opens the form pre-filled ----
  const edit = buttonByText(closed, t('edit'));
  check(Boolean(edit), 'each row offers an edit button');
  edit?.props?.onClick?.();
  const editing = await harness.settle(component, { t });
  const filled = byProps(editing, (props) => props.id === 'mp-acc-code');
  check(Boolean(filled), 'edit opens the form too');
  check(filled?.props?.value === 'a-1', 'pre-filled with that account’s code', filled?.props?.value);
  check(textOf(editing).includes('a-1'), 'and the heading names the account being edited');
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error?.stack ?? error);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
