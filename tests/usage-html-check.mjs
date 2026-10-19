/**
 * usage-html-check.mjs — keeps the usage web page honest and self-contained.
 *
 * The page is the operator-facing document, and it is hand-written, so it can rot in ways nothing else
 * would notice: an anchor that scrolls nowhere, a tag left unclosed so half the page renders inside a
 * table, a CDN link that breaks it offline, or a version number that no longer matches the plugin. Each
 * of those is asserted here.
 *
 * Usage (bundled node):
 *   node tests/usage-html-check.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const htmlPath = join(root, 'docs', 'USAGE.html');
const mdPath = join(root, 'docs', 'USAGE.md');

let failures = 0;
/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
}

try {
  check(existsSync(htmlPath), 'the usage page exists', htmlPath);
  const html = readFileSync(htmlPath, 'utf8');
  check(statSync(htmlPath).size > 4000, 'and it has real content', `${statSync(htmlPath).size} bytes`);
  check(existsSync(mdPath) && statSync(mdPath).size > 1000, 'the markdown twin still exists too');

  // ---- structure: every element that wraps content must be closed, or the page renders inside itself ----
  for (const tag of ['html', 'head', 'body', 'style', 'script', 'div', 'nav', 'main', 'header', 'footer',
    'section', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'ol', 'ul', 'li', 'pre', 'p', 'code']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    check(open === close, `<${tag}> opens and closes the same number of times`, { open, close });
  }

  // ---- navigation: every link lands somewhere, and every section is reachable ----
  const ids = [...html.matchAll(/id="(s\d+)"/g)].map((match) => match[1]);
  const hrefs = [...html.matchAll(/href="#(s\d+)"/g)].map((match) => match[1]);
  check(ids.length >= 8, 'the page has the expected sections', ids.length);
  const dangling = hrefs.filter((href) => !ids.includes(href));
  check(dangling.length === 0, 'no navigation link points at a missing section', dangling);
  const unreachable = ids.filter((id) => !hrefs.includes(id));
  check(unreachable.length === 0, 'no section is missing from the navigation', unreachable);

  // ---- self-contained: it must open from disk with no network ----
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((match) => match[1]);
  check(external.length === 0, 'nothing is loaded from the network — the file opens offline', external);
  check(!/<link[^>]+stylesheet/i.test(html), 'no external stylesheet is linked');
  check(/<style>/.test(html) && /<script>/.test(html), 'styles and the small script are inlined');
  check(/prefers-color-scheme:\s*dark/.test(html), 'the page carries a dark-mode variant');

  // ---- it must agree with the plugin it documents ----
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  check(html.includes(pkg.version), `the page states the installed version ${pkg.version}`);
  const indexSource = readFileSync(join(root, 'src', 'index.js'), 'utf8');
  const pluginVersion = /PLUGIN_VERSION = '([^']+)'/.exec(indexSource)?.[1];
  check(pluginVersion === pkg.version, 'the plugin version marker matches package.json',
    { pluginVersion, packageVersion: pkg.version });

  // ---- the facts an operator acts on must actually be on the page ----
  for (const [label, needle] of [
    ['the dry-run safety rail', 'dryRun'],
    ['where a login is stored', 'storage_state.json'],
    ['account isolation', '隔离'],
    ['the login-required diagnosis', 'LOGIN_REQUIRED'],
    ['the proxy-vs-login distinction', 'PROXY_UNAVAILABLE'],
    ['the restart requirement', '重启'],
    ['the honest limit about the shipped recipes', '未对真机确证'],
  ]) {
    check(html.includes(needle), `the page mentions ${label}`, needle);
  }

  // ---- honesty about the colours: the page must not claim DSH's real values ----
  check(/只导出名字与用途、不导出具体色值/.test(html)
    || /不导出具体色值/.test(html),
    'the page states that the colours are not DSH’s real values');
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error?.stack ?? error);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
