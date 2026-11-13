/**
 * account.js 鈥?`egolite_account`: the account registry plus the sign-in hand-off.
 *
 * Logging in is deliberately a browser hand-off: the plugin opens that account's own ego window on the
 * platform's login page, waits while the human scans the QR code / enters the password, and then records
 * the sign-in on disk (ego keeps the cookies in that account's profile directory). Nothing about the
 * credentials passes through the model.
 *
 * @module ego-publish/tools/account
 */
import { MEDIA_DEFAULTS, publicAccount } from '../accounts.js';
import { detectLogin } from '../actions.js';
import { EgoError, sleep } from '../cdp.js';
import { readProfileVersion } from '../ego.js';
import { resolveAccountProxy } from '../proxies.js';
import { refreshAccountPoints } from '../points.js';
import { defineTool } from '../tool-kit.js';
import { TIMEOUT, openPage, renderEnvelope, requireAccount, sanitize } from './common.js';

/**
 * @param {any} ctx
 * @param {{ accounts: any, proxies: any, manager: any, settings: Record<string, any>, log: (line: string) => void }} deps
 */
export function register(ctx, deps) {
  const { accounts, proxies, manager, settings } = deps;

  /** Public account plus the pool-resolved proxy (inline proxies still show through). */
  function view(code) {
    const record = accounts.get(code);
    const base = publicAccount(record);
    if (!base) return null;
    const resolved = resolveAccountProxy(record, proxies);
    return {
      ...base,
      proxy: resolved
        ? { server: resolved.server, hasAuth: Boolean(resolved.username || resolved.password), username: resolved.username ?? null }
        : null,
      proxyId: record.proxyId ?? null,
      proxySource: resolved?.source ?? null,
    };
  }

  /** Evaluate whether the page currently looks signed in (shared, polling implementation). */
  async function detect(page, account) {
    return detectLogin(page, account);
  }

  ctx.tools.register(defineTool({
    name: 'egolite_account',
    description:
      'Manage publishing accounts, each of which owns one isolated ego lite browser profile (its own cookies and '
      + 'sign-in state) and an optional network proxy. Ops: list 鈥?every account with profile/proxy status; upsert 鈥?'
      + 'create or update an account (code, media sohu|toutiao|csdn|custom, login name, optional proxy); remove 鈥?'
      + 'delete the account (removeProfile:true also deletes its cookies); login 鈥?open that account\'s own ego window '
      + 'on the platform login page and wait for the human to finish signing in (up to timeoutSec), then record it; '
      + 'check — reopen the platform home page and report whether the saved sign-in still works; '
      + 'points — read the Sohu 积分/credit page for this account and record a new history sample.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['list', 'upsert', 'remove', 'login', 'check', 'points'],
        description: 'Which account operation to run.',
      },
      code: {
        type: 'string',
        description: 'Account code, e.g. "a-1" (lowercase letters, digits, "_", ".", "-"). Required except for list.',
      },
      media: {
        type: 'string',
        enum: ['sohu', 'toutiao', 'csdn', 'custom'],
        description: 'Platform for op:"upsert" (defaults to custom).',
      },
      account: {
        type: 'string',
        description: 'The platform-side login name or phone number, for op:"upsert".',
      },
      loginUrl: {
        type: 'string',
        description: 'Override the platform login URL for op:"upsert"/"login".',
      },
      homeUrl: {
        type: 'string',
        description: 'Override the platform home URL used by op:"check".',
      },
      note: {
        type: 'string',
        description: 'Free-form note for op:"upsert".',
      },
      proxy: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional inline proxy at upsert time: {server:"http://host:port", username?, password?}. Prefer proxyId; pass null to unbind.',
      },
      proxyId: {
        type: 'string',
        description: 'Assign a proxy from the shared pool by id (see egolite_proxy {op:"add"}). Empty string or null assigns direct.',
      },
      proxyMode: {
        type: 'string',
        enum: ['static', 'dynamic'],
        description: 'dynamic: extract a fresh provider IP each time the account browser opens (3-minute TTL).',
      },
      removeProfile: {
        type: 'boolean',
        description: 'For op:"remove": also delete the isolated browser profile (cookies and sign-in state).',
      },
      timeoutSec: {
        type: 'integer',
        description: 'For op:"login": how long to wait for the human, in seconds (default from config, capped at 600).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          data: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => renderEnvelope(value.message, value),
    },
    timeoutMs: TIMEOUT.LOGIN_MS,
    async execute(args) {
      switch (args.op) {
        case 'list': {
          const list = accounts.list().map((account) => ({
            ...view(account.code),
            profileVersion: readProfileVersion(account.profileDir),
          }));
          const proxyPool = proxies.listPublic(accounts.proxyUsage());
          return sanitize({
            ok: true,
            message: `${list.length} account(s)`,
            data: { accounts: list, proxies: proxyPool },
            nextSteps: list.length
              ? ['Use egolite_account {op:"login", code:"<code>"} to sign an account in.']
              : ['No accounts yet: egolite_account {op:"upsert", code:"a-1", media:"sohu", account:"<login name>"}.'],
          });
        }
        case 'upsert': {
          // Editing an existing account must not silently re-platform it: an omitted `media` used to
          // fall back to 'custom', which replaces the platform login markers and breaks its flows.
          const existing = accounts.get(args.code);
          const record = accounts.upsert({
            code: args.code,
            media: args.media ?? existing?.media ?? 'custom',
            account: args.account,
            note: args.note,
            loginUrl: args.loginUrl,
            homeUrl: args.homeUrl,
            proxy: args.proxy === undefined ? undefined : args.proxy,
            proxyId: args.proxyId === undefined ? undefined : args.proxyId,
            proxyMode: args.proxyMode === undefined ? undefined : args.proxyMode,
          });
          return sanitize({
            ok: true,
            message: `account ${record.code} (${record.media}) saved`,
            data: { account: view(record.code) },
            nextSteps: [
              `Sign in: egolite_account {op:"login", code:"${record.code}"} 鈥?this opens the account's own ego window.`,
            ],
          });
        }
        case 'remove': {
          const record = requireAccount(accounts, args.code);
          await manager.close(record.code).catch(() => {});
          const outcome = accounts.remove(record.code, { removeProfile: args.removeProfile === true });
          return sanitize({
            ok: true,
            message: `account ${record.code} removed${outcome.profileDeleted ? ' (profile deleted)' : ''}`,
            data: outcome,
          });
        }
        case 'login': {
          const account = requireAccount(accounts, args.code);
          const defaults = MEDIA_DEFAULTS[account.media] ?? MEDIA_DEFAULTS.custom;
          const loginUrl = args.loginUrl || account.loginUrl || defaults.loginUrl || account.homeUrl;
          if (!loginUrl) {
            throw new EgoError('NO_LOGIN_URL', `account "${account.code}" has no login URL; pass loginUrl or set media`, {
              hint: 'egolite_account {op:"upsert", code:"...", media:"sohu"} or pass loginUrl to this call.',
            });
          }
          // A sign-in hand-off must be visible even if a headless session was already open.
          await manager.close(account.code).catch(() => {});
          const { page } = await openPage(manager, account.code, { headless: false });
          await page.goto(loginUrl, { timeoutMs: settings.navigationTimeoutMs, waitUntil: 'domcontentloaded' });
          await sleep(1500);
          let state = await detect(page, account);
          if (state.loggedIn) {
            accounts.touch(account.code, { lastLoginAt: new Date().toISOString(), lastCheck: { ok: true, at: new Date().toISOString(), detail: 'already signed in' } });
            return sanitize({
              ok: true,
              message: `account ${account.code} is already signed in`,
              data: { account: view(account.code), state },
            });
          }
          const timeoutSec = Math.max(20, Math.min(600, Number(args.timeoutSec ?? settings.loginTimeoutSec ?? 300)));
          const deadline = Date.now() + timeoutSec * 1000;
          while (Date.now() < deadline) {
            await sleep(2000);
            state = await detect(page, account);
            if (state.loggedIn) {
              const timestamp = new Date().toISOString();
              accounts.touch(account.code, {
                lastLoginAt: timestamp,
                lastCheck: { ok: true, at: timestamp, detail: `signed in at ${state.url}` },
              });
              return sanitize({
                ok: true,
                message: `account ${account.code} signed in`,
                data: { account: view(account.code), state, sessionOpen: true },
                nextSteps: [
                  `Verify later with egolite_account {op:"check", code:"${account.code}"}.`,
                  `Publish with egolite_publish {accountCode:"${account.code}", media:"${account.media}", params:{...}} (dry run by default).`,
                ],
              });
            }
          }
          return sanitize({
            ok: false,
            message: `login hand-off timed out after ${timeoutSec}s; the ego window for ${account.code} stays open`,
            data: {
              account: view(account.code),
              state,
              sessionOpen: true,
              needsHuman: true,
              instructions: `Finish signing in to ${account.media} in the ego lite window that is open for account ${account.code}, then call egolite_account {op:"check", code:"${account.code}"}.`,
            },
            nextSteps: [
              'The browser window is open on the login page; scan the QR code / enter the password there.',
              'Re-run op:"login" to wait again, or op:"check" once the page shows the signed-in console.',
            ],
          });
        }
        case 'check': {
          const account = requireAccount(accounts, args.code);
          const defaults = MEDIA_DEFAULTS[account.media] ?? MEDIA_DEFAULTS.custom;
          const homeUrl = args.homeUrl || account.homeUrl || defaults.homeUrl;
          if (!homeUrl) throw new EgoError('NO_HOME_URL', `account "${account.code}" has no home URL; pass homeUrl`);
          const { page } = await openPage(manager, account.code);
          await page.goto(homeUrl, { timeoutMs: settings.navigationTimeoutMs, waitUntil: 'domcontentloaded', settleMs: 2500 });
          const state = await detect(page, account);
          const timestamp = new Date().toISOString();
          accounts.touch(account.code, {
            lastCheck: { ok: state.loggedIn, at: timestamp, detail: state.loggedIn ? `signed in at ${state.url}` : `signed out (${state.url})` },
          });
          return sanitize({
            ok: true,
            message: state.loggedIn ? `account ${account.code} is signed in` : `account ${account.code} is NOT signed in`,
            data: { account: view(account.code), state },
            nextSteps: state.loggedIn ? [] : [`Run egolite_account {op:"login", code:"${account.code}"} and sign in again.`],
          });
        }
        case 'points': {
          const account = requireAccount(accounts, args.code);
          const points = await refreshAccountPoints({ manager, accounts, log: deps.log }, account.code);
          const projected = view(account.code);
          const trend = projected?.points?.trend ?? 'unknown';
          const nextSteps = [];
          if (trend === 'down') {
            nextSteps.push('积分正在下降：暂停广告/营销类内容，先查明违规或质量扣分来源，等积分回升再发稿。');
          } else if (trend === 'unknown') {
            nextSteps.push('再取几次样本才能判断趋势；页面会按 pointsRefreshMinutes 自动刷新。');
          }
          return sanitize({
            ok: true,
            message: `${account.code} 积分 ${points.value}（趋势 ${trend}，近30日 ${points.recent30 ?? '—'}）`,
            data: { points: { ...points, trend }, account: projected },
            nextSteps,
          });
        }
        default:
          throw new EgoError('INVALID_OP', `unknown account op "${args.op}"`);
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `egolite account ${args.op}`, kind: 'other' }),
  }));
}
