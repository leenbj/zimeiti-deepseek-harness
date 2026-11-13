/**
 * actions.js — operations shared by the model-facing tools' settings page and the HTTP surface.
 *
 * These are the same building blocks the `egolite_account` / `egolite_session` tools use, but returning
 * plain data instead of model envelopes, and never waiting for a human: a page request must answer fast,
 * so a sign-in hand-off only *starts* the visible browser and reports `needsHuman`.
 *
 * @module ego-publish/actions
 */
import { EgoError, sleep } from './cdp.js';
import { MEDIA_DEFAULTS, publicAccount } from './accounts.js';

/**
 * Decide whether the current page looks signed in for the account's platform.
 * @param {import('./cdp.js').TargetSession} page
 * @param {Record<string, any>} account
 * @param {{ settleMs?: number }} [options]
 */
export async function detectLogin(page, account, options = {}) {
  const defaults = MEDIA_DEFAULTS[account.media] ?? MEDIA_DEFAULTS.custom;
  // These consoles are single-page apps: right after `domcontentloaded` the body is still empty, so a
  // single read reports "signed out" on a perfectly valid session. Poll until a decisive signal shows
  // up (a marker or a logged-out URL) or the settle budget runs out.
  const deadline = Date.now() + Math.max(0, Number(options.settleMs ?? 8000));
  let url = '';
  let text = '';
  let state = { loggedIn: false, url, urlHit: false, marker: null, loggedOut: false };
  for (;;) {
    url = String(await page.url().catch(() => ''));
    try {
      text = await page.text(3000);
    } catch {
      text = '';
    }
    const loggedOut = (defaults.loggedOutUrlContains ?? []).some((fragment) => url.includes(fragment));
    const urlHit = defaults.loggedInUrlContains ? url.includes(defaults.loggedInUrlContains) : false;
    const marker = (defaults.loginMarkers ?? []).find((item) => text.includes(item)) ?? null;
    state = { loggedIn: !loggedOut && (urlHit || Boolean(marker)), url, urlHit, marker, loggedOut };
    if (state.loggedIn || state.loggedOut || Date.now() >= deadline) return state;
    await sleep(400);
  }
}

/**
 * Open the account's own visible browser on the platform login page.
 *
 * It stops there: the human scans the code in that window, then the page calls `checkLogin`.
 *
 * @param {{ manager: any, accounts: any, settings: Record<string, any> }} deps
 * @param {{ code: string, loginUrl?: string }} input
 */
export async function startLogin(deps, input) {
  const account = deps.accounts.get(input.code);
  if (!account) throw new EgoError('ACCOUNT_NOT_FOUND', `no account with code "${input.code}"`);
  const defaults = MEDIA_DEFAULTS[account.media] ?? MEDIA_DEFAULTS.custom;
  const url = input.loginUrl || account.loginUrl || defaults.loginUrl || account.homeUrl;
  if (!url) throw new EgoError('NO_LOGIN_URL', `account "${account.code}" has no login URL`);
  // A sign-in must be visible even if a headless session was open.
  await deps.manager.close(account.code).catch(() => {});
  const session = await deps.manager.open(account.code, { headless: false });
  await session.page.goto(url, { timeoutMs: deps.settings.navigationTimeoutMs, waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const state = await detectLogin(session.page, account);
  if (state.loggedIn) {
    const at = new Date().toISOString();
    deps.accounts.touch(account.code, { lastLoginAt: at, lastCheck: { ok: true, at, detail: `already signed in at ${state.url}` } });
  }
  return {
    account: publicAccount(deps.accounts.get(account.code)),
    url,
    state,
    needsHuman: !state.loggedIn,
    message: state.loggedIn
      ? '该账号已登录'
      : '登录窗口已打开：请在 ego lite 窗口里扫码/输入密码，完成后点「检查登录」',
  };
}

/**
 * Re-open the platform home page and report whether the saved sign-in still works.
 * @param {{ manager: any, accounts: any, settings: Record<string, any> }} deps
 * @param {{ code: string, homeUrl?: string }} input
 */
export async function checkLogin(deps, input) {
  const account = deps.accounts.get(input.code);
  if (!account) throw new EgoError('ACCOUNT_NOT_FOUND', `no account with code "${input.code}"`);
  const defaults = MEDIA_DEFAULTS[account.media] ?? MEDIA_DEFAULTS.custom;
  const url = input.homeUrl || account.homeUrl || defaults.homeUrl;
  if (!url) throw new EgoError('NO_HOME_URL', `account "${account.code}" has no home URL`);
  const session = await deps.manager.open(account.code);
  await session.page.goto(url, {
    timeoutMs: deps.settings.navigationTimeoutMs,
    waitUntil: 'domcontentloaded',
    settleMs: 2000,
  });
  const state = await detectLogin(session.page, account);
  const at = new Date().toISOString();
  deps.accounts.touch(account.code, {
    ...(state.loggedIn ? { lastLoginAt: at } : {}),
    lastCheck: { ok: state.loggedIn, at, detail: state.loggedIn ? `signed in at ${state.url}` : `signed out (${state.url})` },
  });
  return {
    account: publicAccount(deps.accounts.get(account.code)),
    state,
    needsHuman: !state.loggedIn,
    message: state.loggedIn ? '已登录' : '未登录，请重新登录',
  };
}
