/**
 * builtin-recipes-preflight.mjs — verifies the three shipped platform recipes against the real
 * platforms, at the one point that is reachable without credentials: the login guard.
 *
 * The worst failure mode for this plugin is typing a real article into a login page — or worse, into
 * the wrong page — and reporting a confusing error. `play.run` therefore runs the recipe's
 * `session_check` first and must fail fast and *actionably* when the account is not signed in. This
 * test proves that guard against sohu, toutiao and csdn for real, and that each shipped recipe loads,
 * validates and gets exactly that far.
 *
 * It is deliberately read-only against the platforms: one navigation to the recipe's own check URL per
 * platform, headless, `dryRun:true`, and a throwaway `MEDIA_DATA_DIR` with synthetic accounts, so no
 * real account, storage state or recipe is touched and nothing can be submitted.
 *
 * Requires outbound network access. Set MEDIA_SKIP_NETWORK=1 to skip it.
 *
 * Usage (bundled node):
 *   node tests/builtin-recipes-preflight.mjs
 */
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient, EngineError } from '../src/engine-client.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

/** recipe id → the account code that recipe declares, and enough params to pass validation. */
const PLATFORMS = [
  { media: 'sohu', recipe: 'sohu__publish-article', code: 'a-1', params: { title: '预检标题', body: '预检正文，不会发布。' } },
  { media: 'toutiao', recipe: 'toutiao__publish-article', code: 'b-1', params: { title: '预检标题', body: '预检正文，不会发布。' } },
  { media: 'csdn', recipe: 'csdn__publish-article', code: 'c-1', params: { title: '预检标题', body: '预检正文，不会发布。' } },
];

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-preflight-'));
let failures = 0;
let engine;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${suffix}`);
}

try {
  if (process.env.MEDIA_SKIP_NETWORK === '1') {
    console.log('skipped: MEDIA_SKIP_NETWORK=1');
    process.exit(0);
  }

  engine = new EngineClient({ pythonPath: PYTHON, pluginRoot: PLUGIN_ROOT, dataDir, requestTimeoutMs: 300_000 });
  engine.on('log', (line) => console.log(`    engine| ${line}`));
  await engine.call('engine.status', {});

  // The shipped recipes must be discoverable as built-ins before anything else can be true.
  const builtinDir = join(PLUGIN_ROOT, 'engine', 'recipes');
  const onDisk = existsSync(builtinDir) ? readdirSync(builtinDir).filter((n) => n.endsWith('.yaml')) : [];
  check(onDisk.length === 3, 'three built-in recipes ship with the plugin', onDisk);

  for (const platform of PLATFORMS) {
    console.log(`\n--- ${platform.media} (${platform.recipe}) ---`);
    await engine.call('account.upsert', { code: platform.code, media: platform.media, account: 'preflight' });

    // 1. the recipe itself must be valid
    const validated = await engine.call('play.validate', { recipeId: platform.recipe });
    const errors = (validated.issues ?? []).filter((i) => i.level === 'error');
    check(errors.length === 0, `[${platform.media}] the shipped recipe validates with no errors`, validated.issues);

    // 2. the login guard must fire before any content step
    let runResult = null;
    let runError = null;
    try {
      runResult = await engine.call('play.run', {
        recipeId: platform.recipe,
        accountCode: platform.code,
        params: platform.params,
        dryRun: true,
        headless: true,
      }, { timeoutMs: 300_000 });
    } catch (error) {
      runError = error;
    }

    const code = runError?.code ?? (runResult?.ok === false ? 'RUN_FAILED' : 'NONE');
    check(code === 'LOGIN_REQUIRED',
      `[${platform.media}] an unauthenticated run fails fast with LOGIN_REQUIRED, not a crash`,
      { code, message: runError?.message ?? runResult?.error, failedStep: runResult?.failedStep });

    // 3. the failure must be actionable, i.e. it names logging in as the fix
    const text = JSON.stringify({ message: runError?.message, details: runError?.details, result: runResult });
    check(/登录|login/i.test(text),
      `[${platform.media}] the failure tells the operator to sign in`, text.slice(0, 200));

    // 4. it must not have got as far as typing content: a content-step failure would mean the guard is
    //    in the wrong place and a real article could land on a login page.
    const steps = runResult?.steps ?? [];
    const reachedContent = steps.some((s) => s.status === 'ok' && (s.type === 'type' || s.type === 'dispatch'));
    check(!reachedContent,
      `[${platform.media}] no content step ran before the guard fired`,
      steps.map((s) => `${s.index}:${s.type}:${s.status}`));

    // 5. nothing may be reported as published
    check(!runResult?.publishedUrl,
      `[${platform.media}] no published URL is claimed for an unauthenticated run`, runResult?.publishedUrl);

    // 6. a crash-free failure still leaves evidence behind
    if (runResult?.runDir) {
      check(existsSync(join(runResult.runDir, 'run.json')),
        `[${platform.media}] the failed run left run.json behind`, runResult.runDir);
    }
  }
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error instanceof EngineError ? `${error.code}: ${error.message}` : error);
  if (error?.details) console.error('details:', JSON.stringify(error.details, null, 2).slice(0, 1200));
} finally {
  if (engine) await engine.close();
  if (failures === 0) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`\nall checks passed; removed ${dataDir}`);
  } else {
    console.log(`\n${failures} check(s) failed; kept ${dataDir} for inspection`);
  }
}

process.exit(failures === 0 ? 0 : 1);
