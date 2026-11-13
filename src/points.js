/**
 * points.js — read a Sohu account's 积分 (points) from its user centre and persist the history.
 *
 * The points page renders every digit as an icon-font glyph (`mp-iconnumber_4`), so the value is read
 * from class names rather than text. History is append-only and the page derives a trend from it:
 * a falling total is the signal that the account is being penalised, which is what gates advertising.
 *
 * @module ego-publish/points
 */
import { EgoError, sleep } from './cdp.js';

/** The Sohu user-centre page that shows 积分. */
export const POINTS_URL = 'https://mp.sohu.com/mpfe/v4/personalCenter/integral';

/** How many samples to keep per account. */
export const HISTORY_LIMIT = 50;

/**
 * Read the points card from a page already on the integral route.
 * @param {{ evaluate: Function }} page
 */
export async function readPoints(page) {
  return page.evaluate(`(() => {
    const digits = (root) => {
      if (!root) return null;
      const chars = [...root.querySelectorAll('[class*="mp-iconnumber_"]')].map((el) => {
        const cls = [...el.classList].find((name) => name.startsWith('mp-iconnumber_'));
        return cls ? cls.slice('mp-iconnumber_'.length) : '';
      });
      const text = chars.join('');
      return /^-?\\d+$/.test(text) ? Number(text) : null;
    };
    const blocks = [...document.querySelectorAll('.integral-body_total_num')];
    const components = {};
    for (const dim of document.querySelectorAll('.dimension_con')) {
      const label = (dim.querySelector('.dimension_con_text')?.textContent || '').trim();
      if (label) components[label] = digits(dim.querySelector('.dimension_con_num'));
    }
    return {
      url: document.location.href,
      title: document.title,
      total: digits(blocks[0]),
      recent30: digits(blocks[1]),
      components,
      body: (document.body.innerText || '').slice(0, 240),
    };
  })()`, undefined, { timeoutMs: 20000 });
}

function isLoginUrl(url) {
  return /passport|login|signin/i.test(String(url));
}

/**
 * Fetch points for one account using a background tab, so an open visible window is not disturbed.
 *
 * @param {{ manager: any, accounts: any, log?: (line: string) => void }} deps
 * @param {string} code
 * @param {{ openIfNeeded?: boolean }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function refreshAccountPoints(deps, code, options = {}) {
  const { manager, accounts, log } = deps;
  const account = accounts.get(code);
  if (!account) throw new EgoError('ACCOUNT_NOT_FOUND', `no account with code "${code}"`);
  if (account.media !== 'sohu') {
    throw new EgoError('UNSUPPORTED_MEDIA', 'points are only available for Sohu accounts');
  }

  let opened = false;
  let session = manager.get(code);
  if (!session) {
    if (options.openIfNeeded === false) throw new EgoError('SESSION_NOT_FOUND', `no open browser for "${code}"`);
    session = await manager.open(code, { headless: true });
    opened = true;
  }

  /** @type {{ page: any, close: Function } | null} */
  let background = null;
  try {
    background = await manager.createBackgroundPage(code);
    const { page } = background;
    await page.goto(POINTS_URL, { waitUntil: 'domcontentloaded', timeoutMs: 45000 });
    await page.waitFor({ selector: '.integral-body_total_num' }, { timeoutMs: 20000 });
    await sleep(1200);
    const raw = await readPoints(page);

    if (isLoginUrl(raw?.url)) {
      throw new EgoError('LOGIN_REQUIRED', `${code} is not signed in (redirected to ${raw.url})`);
    }
    if (raw?.total === null || raw?.total === undefined) {
      throw new EgoError('POINTS_PARSE_FAILED', `could not read 积分 from ${raw?.url ?? 'the points page'}: ${String(raw?.body ?? '').slice(0, 120)}`);
    }

    const at = new Date().toISOString();
    const history = Array.isArray(account.points?.history) ? account.points.history.slice(-(HISTORY_LIMIT - 1)) : [];
    history.push({ at, value: raw.total });
    while (history.length > HISTORY_LIMIT) history.shift();

    const points = {
      value: raw.total,
      recent30: raw.recent30,
      components: raw.components ?? {},
      at,
      error: null,
      history,
    };
    accounts.mergePoints(code, points);
    log?.(`points ${code}: ${raw.total} (recent30 ${raw.recent30})`);
    return points;
  } catch (error) {
    const at = new Date().toISOString();
    const current = account.points ?? {};
    accounts.mergePoints(code, {
      ...current,
      at,
      error: String(error?.message ?? error),
      history: Array.isArray(current.history) ? current.history : [],
    });
    if (error instanceof EgoError) throw error;
    throw new EgoError('POINTS_FETCH_FAILED', `could not read points for ${code}: ${String(error?.message ?? error)}`);
  } finally {
    if (background) await background.close().catch(() => {});
    if (opened) await manager.close(code).catch(() => {});
  }
}

/**
 * Refresh every Sohu account, sequentially and without letting one failure stop the rest.
 * @param {{ manager: any, accounts: any, log?: (line: string) => void }} deps
 */
export async function refreshAllPoints(deps) {
  const targets = deps.accounts.list().filter((account) => account.media === 'sohu');
  const results = [];
  for (const account of targets) {
    try {
      results.push({ code: account.code, points: await refreshAccountPoints(deps, account.code) });
    } catch (error) {
      results.push({ code: account.code, error: String(error?.message ?? error) });
    }
  }
  return results;
}
