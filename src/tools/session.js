/**
 * session.js — `egolite_session`: the account browser windows.
 *
 * A session is one ego lite process launched for one account. Opening is idempotent (the same window is
 * reused), closing frees the proxy relay, and the plugin closes every session on unload.
 *
 * @module ego-publish/tools/session
 */
import { defineTool } from '../tool-kit.js';
import { readProfileVersion } from '../ego.js';
import { TIMEOUT, openPage, renderEnvelope, requireAccount, sanitize } from './common.js';

/**
 * @param {any} ctx
 * @param {{ accounts: any, manager: any, settings: Record<string, any>, dataDir: string }} deps
 */
export function register(ctx, deps) {
  const { accounts, manager, dataDir } = deps;

  ctx.tools.register(defineTool({
    name: 'egolite_session',
    description:
      'Open, inspect or close the isolated ego lite browser window that belongs to one account. Opening is idempotent '
      + 'and reuses the window (cookies and sign-in state persist in that account\'s profile directory between runs). '
      + 'Ops: open — launch/reuse the account browser and report the page; close — shut that window down; list — every '
      + 'live account browser; status — one account browser with its URL, title, proxy and profile version.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['open', 'close', 'list', 'status'],
        description: 'Which session operation to run.',
      },
      accountCode: {
        type: 'string',
        description: 'Account code (required for open/close/status).',
      },
      headless: {
        type: 'boolean',
        description: 'For op:"open": run this account browser without a visible window (not recommended for sign-in).',
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
    timeoutMs: TIMEOUT.OPEN_MS,
    async execute(args) {
      switch (args.op) {
        case 'open': {
          const account = requireAccount(accounts, args.accountCode);
          const { session, page } = await openPage(manager, account.code, { headless: args.headless });
          const url = await page.url().catch(() => null);
          const title = await page.title().catch(() => null);
          return sanitize({
            ok: true,
            message: `account ${account.code} browser is open (pid ${session.pid}, port ${session.port})`,
            data: {
              accountCode: account.code,
              pid: session.pid,
              port: session.port,
              url,
              title,
              proxy: session.proxyUrl,
              profileDir: session.profileDir,
              profileVersion: readProfileVersion(session.profileDir),
              browser: session.browser,
            },
            nextSteps: [`Drive it with egolite_observe / egolite_act, or publish with egolite_publish.`],
          });
        }
        case 'close': {
          const outcome = await manager.close(args.accountCode);
          return sanitize({
            ok: true,
            message: outcome.closed ? `closed the browser for ${args.accountCode}` : `no open browser for ${args.accountCode}`,
            data: outcome,
          });
        }
        case 'list': {
          const sessions = manager.list();
          return sanitize({
            ok: true,
            message: `${sessions.length} live account browser(s)`,
            data: { sessions, dataDir },
          });
        }
        case 'status': {
          const session = manager.get(args.accountCode);
          if (!session) {
            return sanitize({
              ok: true,
              message: `account ${args.accountCode} has no open browser`,
              data: { open: false },
              nextSteps: [`Open it with egolite_session {op:"open", accountCode:"${args.accountCode}"}.`],
            });
          }
          return sanitize({
            ok: true,
            message: `account ${args.accountCode} browser is open`,
            data: {
              open: true,
              url: await session.page.url().catch(() => null),
              title: await session.page.title().catch(() => null),
              proxy: session.proxyUrl,
              pid: session.pid,
              port: session.port,
              startedAt: new Date(session.startedAt).toISOString(),
              idleSeconds: Math.round((Date.now() - session.lastUsedAt) / 1000),
            },
          });
        }
        default:
          throw new Error(`unknown session op "${args.op}"`);
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `egolite session ${args.op}`, kind: 'other' }),
  }));
}
