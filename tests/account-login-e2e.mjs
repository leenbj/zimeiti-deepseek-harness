/**
 * account-login-e2e.mjs — verifies the operator's very first step after install: signing an account in.
 *
 * `account.login` is the one path that cannot be fully tested without real credentials, but its
 * *machinery* can, and that machinery is what decides whether a failed login leaves the profile in a
 * clean state. The expensive failure mode is a half-finished login that writes a bogus
 * `storage_state.json`: every later run would then believe the account is signed in and would try to
 * publish with it.
 *
 * What this proves, using a throwaway `MEDIA_DATA_DIR` and synthetic accounts:
 *   1. argument/validation failures are classified (missing account, unsupported media) rather than crashing;
 *   2. `account.checkLogin` with no saved state answers `status:"unknown"` with an actionable detail
 *      *without* launching a browser;
 *   3. a login that times out against the real login page fails with a clear TIMEOUT that names the
 *      login URL and tells the operator what to do — and, critically, writes **no** state file and
 *      leaks no session;
 *   4. it reports the proxy warning instead of silently going direct.
 *
 * It never completes a login and never submits a credential, so it is safe to run unattended. It does
 * navigate to the real platform login page, so it needs outbound network; set MEDIA_SKIP_NETWORK=1 to skip.
 *
 * Usage (bundled node):
 *   node tests/account-login-e2e.mjs
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient, EngineError } from '../src/engine-client.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

const dataDir = mkdtempSync(join(tmpdir(), 'media-publish-login-'));
let failures = 0;
let engine;

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${suffix}`);
}

/** @param {string} code */
function statePathFor(code) {
  return join(dataDir, 'accounts', code, 'storage_state.json');
}

/** Assert a promise rejects, and hand back the error. */
async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

try {
  if (process.env.MEDIA_SKIP_NETWORK === '1') {
    console.log('skipped: MEDIA_SKIP_NETWORK=1');
    process.exit(0);
  }

  engine = new EngineClient({ pythonPath: PYTHON, pluginRoot: PLUGIN_ROOT, dataDir, requestTimeoutMs: 180_000 });
  engine.on('log', (line) => console.log(`    engine| ${line}`));
  await engine.call('engine.status', {});

  // ---- 1. validation failures are classified, not crashes ----
  const noAccount = await rejection(engine.call('account.login', { code: 'nope-1' }));
  check(noAccount instanceof EngineError && noAccount.code === 'BAD_REQUEST',
    'logging in an unregistered account is a BAD_REQUEST', noAccount?.code);

  await engine.call('account.upsert', { code: 'lg-unknown', media: 'weibo', account: 'x' });
  const badMedia = await rejection(engine.call('account.login', { code: 'lg-unknown' }));
  check(badMedia instanceof EngineError && badMedia.code === 'UNSUPPORTED',
    'a media with no login configuration is UNSUPPORTED, not a crash', badMedia?.code);
  check(Array.isArray(badMedia?.details?.known) && badMedia.details.known.length >= 3,
    'the UNSUPPORTED error lists the platforms that DO have a login flow', badMedia?.details?.known);

  // ---- 2. checkLogin with no saved state must not launch a browser ----
  await engine.call('account.upsert', { code: 'lg-sohu', media: 'sohu', account: 'sohu test' });
  const noState = await engine.call('account.checkLogin', { code: 'lg-sohu' });
  check(noState.ok === false && noState.status === 'unknown',
    'checkLogin with no saved state reports unknown', { ok: noState.ok, status: noState.status });
  check(/account\.login/.test(String(noState.detail ?? '')),
    'the unknown status tells the operator to run account.login first', noState.detail);
  check((await engine.call('session.list', {})).sessions?.length === 0,
    'checkLogin with no state left no session behind');

  // ---- 3. a login that times out must stay clean ----
  const timedOut = await rejection(engine.call(
    'account.login',
    { code: 'lg-sohu', headless: true, timeoutMs: 6_000, proxyPolicy: 'direct' },
    { timeoutMs: 180_000 },
  ));
  check(timedOut instanceof EngineError, 'a login that is never completed fails rather than hanging');
  check(timedOut?.code === 'TIMEOUT', 'the incomplete login reports TIMEOUT', timedOut?.code);
  const detailText = JSON.stringify(timedOut?.details ?? {});
  check(/mp\.sohu\.com/.test(detailText),
    'the timeout names the login URL the operator must open', detailText.slice(0, 160));
  check(/登录|login|扫码/i.test(String(timedOut?.message ?? '') + detailText),
    'the timeout explains that a human sign-in is required', String(timedOut?.message ?? '').slice(0, 160));
  check(!existsSync(statePathFor('lg-sohu')),
    'a timed-out login writes NO storage_state — so no later run can believe it is signed in',
    statePathFor('lg-sohu'));
  check((await engine.call('session.list', {})).sessions?.length === 0,
    'a timed-out login leaks no browser session');

  // ---- 4. the account is still usable afterwards, and the proxy warning is surfaced ----
  const listed = await engine.call('account.list', {});
  const item = (listed.accounts ?? []).find((a) => a.code === 'lg-sohu');
  check(Boolean(item), 'the account still exists after a failed login', item);
  check(item?.hasState === false, 'and it is still marked as having no login state', item?.hasState);

  const direct = await engine.call('session.open',
    { accountCode: 'lg-sohu', headless: true, proxyPolicy: 'direct' }, { timeoutMs: 120_000 });
  check((direct.warnings ?? []).length > 0,
    'opening a session with no saved login surfaces a warning rather than failing silently',
    direct.warnings);
  check((direct.warnings ?? []).some((warning) => /login|登录|storage_state/i.test(warning)),
    'the warning names the missing login state so the operator knows what to fix', direct.warnings);
  await engine.call('session.close', { sessionId: direct.sessionId });

  const sticky = await engine.call('session.open',
    { accountCode: 'lg-sohu', headless: true, proxyPolicy: 'sticky' }, { timeoutMs: 120_000 });
  check((sticky.warnings ?? []).some((warning) => /代理|proxy/i.test(warning)),
    'an unbound account under sticky policy says so instead of silently going direct', sticky.warnings);
  check(sticky.proxy === null, 'and it really is direct', sticky.proxy);
  await engine.call('session.close', { sessionId: sticky.sessionId });

  // ---- 5. a state file that exists but is empty must not be trusted ----
  const bogus = statePathFor('lg-sohu');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(dataDir, 'accounts', 'lg-sohu'), { recursive: true });
  writeFileSync(bogus, '{}', 'utf8');
  check(statSync(bogus).size < 10, 'a deliberately empty state file was written for the probe');
  const checkWithEmptyState = await engine.call('account.checkLogin',
    { code: 'lg-sohu', proxyPolicy: 'direct' }, { timeoutMs: 180_000 });
  check(checkWithEmptyState.ok === false,
    'checkLogin does not accept an empty state file as a valid login',
    { ok: checkWithEmptyState.ok, status: checkWithEmptyState.status, detail: checkWithEmptyState.detail });
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
