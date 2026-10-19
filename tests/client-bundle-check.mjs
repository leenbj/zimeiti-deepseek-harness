/**
 * client-bundle-check.mjs — static verification of the plugin's browser half.
 *
 * The settings page cannot appear until DSH restarts (the browser loads plugin bundles at boot), so
 * everything that can be proven *before* a restart is proven here, against both the workspace source and
 * an installed copy if one is given:
 *
 *   1. the file parses and registers itself through `window.__ModuleLoader__.load` in the shipped shape;
 *   2. its `id` is the package name, and its factory exports `apply` + `inject`;
 *   3. every bare `require(...)` specifier is either in the shell's frozen `PLATFORM_MODULES` baseline
 *      (`react`, `react/jsx-runtime`) or declared under `dsh.client.external` — an undeclared specifier
 *      makes the bundle fail to load in the browser;
 *   4. `package.json` declares `dsh.client.platform === 'web'`, an `inject` list, and an `exports['./client']`
 *      that resolves to the file that was just checked;
 *   5. the component renders without throwing for both views the Plugins page asks for (`summary`, `page`),
 *      driven by stubbed React/fetch so it runs headless;
 *   6. the two slot keys the page registers match the owner's own convention,
 *      `rowConfigKey(bundle, rowId) === `${bundle}#${rowId}``
 *      (`@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`), plus the bundle key.
 *
 * Usage (bundled node):
 *   node tests/client-bundle-check.mjs [packageDir] [installedPackageDir]
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..', process.argv[2] ?? '.');
const installedDir = process.argv[3] ? resolve(process.argv[3]) : null;

/** Specifiers the shell seeds in its frozen module table; anything else must be declared. */
const BASELINE_MODULES = new Set(['react', 'react/jsx-runtime']);

let failures = 0;
/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
}

/** A React stub good enough to call a component function outside a renderer. */
function stubReact() {
  const noop = () => {};
  return {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useCallback: (fn) => fn,
    useEffect: noop,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  };
}

/** A minimal `document`, so the page's stylesheet injection can be exercised headlessly. */
function fakeDocument() {
  /** @type {any[]} */
  const children = [];
  const head = {
    children,
    appendChild(node) { children.push(node); return node; },
  };
  return {
    head,
    children,
    getElementById: (id) => children.find((child) => child.id === id) ?? null,
    createElement: (tagName) => ({
      tagName: String(tagName).toUpperCase(),
      id: '',
      textContent: '',
      remove() {
        const at = children.indexOf(this);
        if (at >= 0) children.splice(at, 1);
      },
    }),
  };
}

/** The `document` the most recent bundle load saw, so a test can inspect what the page injected. */
let lastDocument = null;

/**
 * Load the bundle the way the browser does, and hand back its exports.
 * @param {string} file
 */
function loadBundle(file) {
  const source = readFileSync(file, 'utf8');
  /** @type {any} */
  let captured = null;
  const document = fakeDocument();
  lastDocument = document;
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition; } } },
    console,
    navigator: { language: 'zh-CN' },
    document,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, revision: 0, fields: [] }) }),
    setTimeout,
  };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: file }).runInContext(sandbox);
  return captured;
}

// A UTF-8 BOM in a manifest breaks `JSON.parse`, and PowerShell's `Set-Content -Encoding utf8` adds one.
// That mistake shipped once, so it is asserted by name before anything tries to parse the file.
const pkgBytes = readFileSync(join(packageDir, 'package.json'));
const hasBom = pkgBytes[0] === 0xef && pkgBytes[1] === 0xbb && pkgBytes[2] === 0xbf;
check(!hasBom, 'package.json carries no UTF-8 BOM (a BOM makes JSON.parse fail)');
const pkg = JSON.parse(pkgBytes.toString('utf8').replace(/^\uFEFF/, ''));
const indexPath = join(packageDir, 'src', 'index.js');
if (existsSync(indexPath)) {
  const indexBytes = readFileSync(indexPath);
  check(!(indexBytes[0] === 0xef && indexBytes[1] === 0xbb && indexBytes[2] === 0xbf),
    'src/index.js carries no UTF-8 BOM either');
}
check(Boolean(pkg.version), 'the manifest parses and declares a version', pkg.version);
const clientExport = pkg.exports?.['./client'];
const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default;
check(Boolean(clientPath), 'package.json declares exports["./client"]', clientExport);
const clientFile = resolve(packageDir, clientPath ?? 'lib/client.js');
check(existsSync(clientFile), 'the declared client entry exists on disk', clientFile);

const definition = loadBundle(clientFile);
check(Boolean(definition), 'the bundle registers itself through window.__ModuleLoader__.load');
check(definition?.id === pkg.name, 'the bundle id is the package name', definition?.id);

const sourceText = readFileSync(clientFile, 'utf8');
const requested = [...sourceText.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
const declared = new Set(pkg.dsh?.client?.external ?? []);
const undeclared = [...new Set(requested)].filter((name) => !BASELINE_MODULES.has(name) && !declared.has(name));
check(undeclared.length === 0,
  'every require() specifier is baseline or declared in dsh.client.external',
  { requested: [...new Set(requested)], undeclared });

const externals = pkg.dsh?.client?.external;
check(externals === undefined || (Array.isArray(externals) && externals.length === 0),
  'dsh.client.external is empty because both requests are baseline', externals);
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform is "web"', pkg.dsh?.client?.platform);
const clientInject = pkg.dsh?.client?.inject ?? [];
check(Array.isArray(clientInject) && clientInject.includes('@deepseek-ai/dsh-client-locale'),
  'dsh.client.inject names the locale package', clientInject);
check(clientInject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'),
  'dsh.client.inject names the page that declares our target slots', clientInject);

check(typeof definition?.factory === 'function', 'the definition carries a factory');
const exported = definition.factory((name) => {
  if (name === 'react') return stubReact();
  if (name === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}), Fragment: null };
  throw new Error(`the bundle requested an undeclared module: ${name}`);
});
check(typeof exported?.apply === 'function', 'the client half exports apply()');
check(Array.isArray(exported?.inject), 'the client half exports inject as an array', exported?.inject);
check((exported?.inject ?? []).includes('slots') && (exported?.inject ?? []).includes('locale'),
  'inject names the services the page uses', exported?.inject);

// The keys must match the owner's own convention, or the page registers into a cell nobody dispatches.
const BUNDLE = '@dsh-plugin/media-publish';
const ROW_ID = 'media-publish';
check(exported?.ROW_CONFIG_KEY === `${BUNDLE}#${ROW_ID}`,
  'the row.config key is `<package name>#<row id>` as rowConfigKey() builds it', exported?.ROW_CONFIG_KEY);
check(sourceText.includes('plugins.row.config') && sourceText.includes('plugins.bundle.config'),
  'the page registers into the row and bundle configuration slots of the sidebar Plugins page');
check(sourceText.includes('settings.section') && sourceText.includes('settings.plugins.tab'),
  'the page also registers into the Settings panel seats (top-level page + Plugins section tab)');
check(!sourceText.includes('plugins.item'),
  'the page does NOT register into plugins.item, which the catalogue reserves for official plugins');

// Both views must render without throwing when the Plugins page asks for them.
const t = (key) => ({ summary: 'SUMMARY-COPY', loading: 'LOADING-COPY' }[key] ?? key);
try {
  const summary = exported.MediaPublishCard
    ? exported.MediaPublishCard({ view: 'summary', t })
    : null;
  check(summary === 'SUMMARY-COPY' || summary !== undefined,
    'the summary view answers with text and no side effects', summary);
} catch (error) {
  check(false, 'the summary view renders', error?.message);
}
try {
  const page = exported.MediaPublishCard({ view: 'page', t });
  check(Boolean(page), 'the page view returns an element tree');
  // The first paint is the loading line, since the route read is asynchronous.
  const seen = JSON.stringify(page);
  check(seen.includes('LOADING-COPY'), 'the first paint shows the loading copy', seen.slice(0, 120));
} catch (error) {
  check(false, 'the page view renders', error?.message);
}
try {
  // The Settings seats (`settings.section`, `settings.plugins.tab`) pass no `view` at all. If the card
  // only treated an explicit 'page' as the page, those seats would never read the route and would sit on
  // the loading line forever.
  const settingsSeat = exported.MediaPublishCard({ t });
  check(settingsSeat !== 'SUMMARY-COPY', 'a Settings seat with no `view` prop is NOT rendered as a summary');
  check(JSON.stringify(settingsSeat).includes('LOADING-COPY'),
    'a Settings seat renders the page (it starts by loading)', JSON.stringify(settingsSeat).slice(0, 120));
} catch (error) {
  check(false, 'a Settings seat renders', error?.message);
}

// Every dictionary value must be a plain string. A function value is a real hazard: a locale service that
// stores strings only would throw while the plugin activates, and the operator would see nothing but the
// host's generic "the plugin could not handle this request" with no hint that a translation was at fault.
for (const [locale, table] of Object.entries(exported.dictionaries ?? {})) {
  const notStrings = Object.entries(table).filter(([, value]) => typeof value !== 'string');
  check(notStrings.length === 0, `the ${locale} dictionary holds only strings`,
    notStrings.map(([key]) => key));
}

// `apply` must register all four seats on a working host.
{
  /** @type {any[]} */
  const registrations = [];
  const working = {
    locale: { bind: () => (key) => `t:${key}`, register: () => () => {} },
    slots: {
      inject: (_name, callback) => { callback(); return () => {}; },
      register: (options, component) => { registrations.push({ options, component }); return () => {}; },
    },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  };
  let threw = null;
  try {
    exported.apply(working);
  } catch (error) {
    threw = error;
  }
  check(threw === null, 'apply() registers without throwing on a working host', threw?.message);
  check(registrations.length === 4, 'apply() registers exactly four seats',
    registrations.map((entry) => entry.options.name));
  const bySlot = new Map(registrations.map((entry) => [entry.options.name, entry.options]));
  check(bySlot.get('settings.section')?.id === 'media-publish',
    'the Settings page seat uses an id of our own', bySlot.get('settings.section'));
  check(bySlot.get('settings.plugins.tab')?.id === 'media-publish',
    'the Settings Plugins tab seat uses an id of our own', bySlot.get('settings.plugins.tab'));
  check(bySlot.get('plugins.row.config')?.key === '@dsh-plugin/media-publish#media-publish',
    'the row seat uses the exact key the owner dispatches', bySlot.get('plugins.row.config'));
  check(bySlot.get('plugins.bundle.config')?.key === '@dsh-plugin/media-publish',
    'the bundle seat is keyed by the package name', bySlot.get('plugins.bundle.config'));
  check(registrations.every((entry) => entry.options.locale === 'media-publish'),
    'every seat binds our locale namespace, so the card receives `t`');
  check(registrations.every((entry) => typeof entry.component === 'function'),
    'every seat registers the same card component');
}

// A host whose every service call fails must not turn into an activation failure, and a card rendered
// without a locale reader must still render — either would otherwise reach the operator as the host's
// generic plugin error.
{
  const broken = {
    locale: {
      bind: () => { throw new Error('no locale.bind'); },
      register: () => { throw new Error('no locale.register'); },
    },
    slots: { inject: () => { throw new Error('no slots.inject'); } },
    effect: () => { throw new Error('no effect'); },
  };
  let threw = null;
  try {
    exported.apply(broken);
  } catch (error) {
    threw = error;
  }
  check(threw === null, 'apply() does not throw even when every service call fails', threw?.message);

  let renderError = null;
  try {
    const summary = exported.MediaPublishCard({ view: 'summary' });
    check(typeof summary === 'string', 'the summary view renders with no `t` reader at all', summary);
    const page = exported.MediaPublishCard({});
    check(Boolean(page), 'the page view renders with no `t` reader at all');
  } catch (error) {
    renderError = error;
  }
  check(renderError === null, 'a card with no locale reader does not throw', renderError?.message);
}

// ---- the look must follow the shipped primitives, not invent its own ----
// Every value asserted here was copied from `@deepseek-ai/dsh-client-ui-primitives`' Button / Checkbox /
// Input CSS modules. Pinning them keeps the page from drifting away from the DSH type scale, control
// heights and radii the next time it is edited.
{
  const css = String(exported.STYLES ?? '');
  check(css.length > 400, 'the page ships a stylesheet', css.length);

  const defined = new Set([...css.matchAll(/\.(mp-[a-z0-9-]+)/g)].map((match) => match[1]));
  check(defined.size >= 12, 'the sheet defines the page class names', defined.size);

  // A class used in markup but never defined renders unstyled — the exact failure this pass is fixing.
  const used = [...sourceText.matchAll(/className:\s*"([^"]+)"/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter(Boolean);
  const undefinedClasses = [...new Set(used)].filter((name) => !defined.has(name));
  check(undefinedClasses.length === 0, 'every className the page uses is defined in the sheet', undefinedClasses);

  // The account row must stay self-sizing. It was once a fixed-column grid with four action columns while
  // the row carried six buttons, so two buttons wrapped onto a second line and the whole section looked
  // broken. A settings panel is far narrower than a table wide enough for six buttons, so wrapping is the
  // only shape that holds at every width.
  check(/\.mp-acct\{[^}]*flex-wrap/.test(css), 'the account row wraps instead of relying on fixed columns');
  check(!/\.mp-acct\{[^}]*grid-template-columns/.test(css), 'and it does not pin column widths');
  // Six permanent buttons per row is what made the layout look broken, so the destructive pair stays
  // behind a toggle. If someone ever puts them back inline, this goes red.
  check(/moreFor/.test(sourceText), 'destructive account actions stay behind a “More” toggle');
  check(/dangerZone/.test(sourceText), 'and that toggle says what it does');

  // Colour must come from the theme, or the page breaks in dark mode and looks foreign in light mode.
  check(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no hard-coded hex colour anywhere');
  // `rgba(` used to slip past this: the pattern looked for `rgb(`, and the `a` broke the match. The
  // optional `a` closes that hole, so a semi-transparent hard-coded colour cannot hide here either.
  check(!/\b(rgba?|hsla?|oklch)\(/.test(css), 'no hard-coded rgb/rgba/hsl/hsla/oklch colour');
  const tokens = [...new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))];
  check(tokens.length >= 10, 'the sheet is built from DSH theme tokens', tokens.length);
  check(tokens.every((name) => name.startsWith('--dsw-')), 'and only DSH tokens', tokens);

  // The control geometry that makes it read as a DSH surface.
  check(/height:\s*36px/.test(css), 'buttons use the shipped 36px control height');
  check(/height:\s*28px/.test(css), 'the compact button uses the shipped 28px height');
  check(/height:\s*32px/.test(css), 'inputs use the shipped 32px field height');
  check(/border-radius:var\(--dsw-radius-md\)/.test(css) && /border-radius:var\(--dsw-radius-sm\)/.test(css),
    'radii come from the shared control-radius scale');
  check(/border:0\.5px solid var\(--dsw-alias-border-l4\)/.test(css),
    'inputs use the shipped 0.5px field border');
  check(/accent-color:var\(--dsw-alias-brand-primary\)/.test(css),
    'checkboxes use the brand accent like the shipped Checkbox');
  check(/font-size:14px/.test(css) && /line-height:22px/.test(css), 'the 14px/22px type scale is used');
  check(/\.mp-label\{[^}]*font-weight:500/.test(css), 'field labels use the medium weight');
  check(/\.mp-desc\{[^}]*font-size:12px/.test(css), 'hints drop to the 12px tertiary tier');
  check(/var\(--dsw-alias-label-tertiary\)/.test(css), 'hints use the tertiary label token');
}

// The stylesheet must actually reach the document head, or none of the above is visible. Load a fresh
// copy so the exports and the fake document provably belong to the same bundle instance.
{
  const freshDefinition = loadBundle(clientFile);
  const document = lastDocument;
  const freshExports = freshDefinition.factory((name) => {
    if (name === 'react') return stubReact();
    if (name === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}), Fragment: null };
    throw new Error(`the bundle requested an undeclared module: ${name}`);
  });
  const before = document.children.length;
  let threw = null;
  try {
    freshExports.apply({
      locale: { bind: () => (key) => key, register: () => () => {} },
      slots: { inject: (_name, callback) => { callback(); return () => {}; }, register: () => () => {} },
      effect: (fn) => { const result = fn(); return typeof result === 'function' ? result : () => {}; },
    });
  } catch (error) {
    threw = error;
  }
  check(threw === null, 'apply() does not throw while injecting the stylesheet', threw?.message);
  const injected = document.getElementById('media-publish-settings-style');
  check(document.children.length === before + 1, 'apply() injects exactly one stylesheet',
    { before, after: document.children.length, ids: document.children.map((child) => child.id) });
  check(Boolean(injected), 'the injected element carries the stylesheet id');
  check(String(injected?.textContent ?? '').includes('.mp-root'),
    'and it carries the page stylesheet text', String(injected?.textContent ?? '').slice(0, 40));
}

if (installedDir) {
  const installedPkgPath = join(installedDir, 'package.json');
  check(existsSync(installedPkgPath), 'the installed copy exists', installedDir);
  if (existsSync(installedPkgPath)) {
    const installedPkg = JSON.parse(readFileSync(installedPkgPath, 'utf8'));
    check(installedPkg.version === pkg.version,
      'the installed copy carries the same version', `${pkg.version} vs ${installedPkg.version}`);
    const installedClient = join(installedDir, 'lib/client.js');
    check(existsSync(installedClient), 'the installed copy ships lib/client.js');
    if (existsSync(installedClient)) {
      const same = readFileSync(installedClient, 'utf8') === sourceText;
      check(same, 'the installed client bundle is byte-identical to the workspace source');
      const installedDefinition = loadBundle(installedClient);
      check(installedDefinition?.id === pkg.name && typeof installedDefinition?.factory === 'function',
        'the installed bundle loads in the same shape');
    }
    check(installedPkg.dsh?.client?.platform === 'web', 'the installed manifest declares dsh.client');
  }
}

if (!exported.MediaPublishCard) {
  console.log('note: the card component was not exported, so only the module shape was checked');
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
