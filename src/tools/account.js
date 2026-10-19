/**
 * account.js — `media_account`: the account registry and login state.
 *
 * Ops map 1:1 onto `account.*` engine methods (SPEC §2.1). `login` is the long one: it opens a headed
 * browser, blocks up to ~10 minutes while a human scans the QR code, saves `storage_state.json`, and
 * verifies the result — so it gets an explicit, larger per-call engine timeout.
 *
 * @module media-publish/tools/account
 */
import { defineTool } from '../tool-kit.js';
import {
  TIMEOUT, argumentFailure, failure, renderEnvelope, resolveProxyArg, success,
} from './common.js';

const OPS = ['list', 'upsert', 'remove', 'login', 'check', 'bindProxy'];

/**
 * @param {any} ctx
 * @param {{ engine: any, settings: Record<string, any>, dataDir: string, python: Record<string, any>,
 *           pluginRoot: string, handoffs?: any }} deps
 */
export function register(ctx, deps) {
  const { engine, dataDir, handoffs } = deps;

  ctx.tools.register(defineTool({
    name: 'media_account',
    description:
      'Manage publishing accounts and their login state. Ops: '
      + '"list" (registry + whether each account has a saved login state + its bound proxy), '
      + '"upsert" {code, media, account?, note?} (register or update: media is one of sohu|toutiao|csdn), '
      + '"remove" {code, purgeState?} (purgeState also deletes the stored login state and profile), '
      + '"login" {code, headless?=false} — opens a HEADED browser, waits up to 10 minutes for a human to scan '
      + 'the QR code / type the password, then saves storage_state.json and verifies it (blocking call), '
      + '"check" {code} (headless re-verification of a saved login state), '
      + '"bindProxy" {code, proxy} (pin a fixed proxy to one account: an object {server,username?,password?}, '
      + '"static:<index>" from <dataDir>/proxies.yaml, "server|user|pass", or null to unbind and go direct). '
      + 'Proxy passwords are written to secrets.yaml and are never echoed back.',
    parameters: {
      op: { type: 'string', enum: OPS, required: true, description: 'Which account operation to run.' },
      code: { type: 'string', description: 'Account code, e.g. "a-1" (required for every op except list).' },
      media: { type: 'string', enum: ['sohu', 'toutiao', 'csdn'], description: 'Platform, for op:"upsert".' },
      account: { type: 'string', description: 'The platform-side login name/id, for op:"upsert".' },
      note: { type: 'string', description: 'Free-form note, for op:"upsert".' },
      purgeState: { type: 'boolean', description: 'op:"remove" — also delete storage_state/profile for that account.' },
      headless: { type: 'boolean', description: 'op:"login" — keep false (default): a human must see the window.' },
      proxy: {
        oneOf: [
          { type: 'string', description: 'An explicit server, "server|user|pass", "static:<index>", or "direct"/null to unbind.' },
          { type: 'object', additionalProperties: true, description: 'A proxy object {server, username?, password?}.' },
        ],
        description: 'op:"bindProxy" — the proxy to pin, or omit/null to unbind.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          op: { type: 'string' },
          method: { type: 'string' },
          summary: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' } },
          handoff: { type: 'object', additionalProperties: true },
          error: { type: 'object', additionalProperties: true },
          nextSteps: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderEnvelope(
        value.ok
          ? `media_account ${value.op} — ok`
          : `media_account ${value.op ?? '?'} — failed (${value.error?.code ?? 'ERROR'})`,
        value,
        renderLines(value),
      ),
    },
    async execute(args) {
      const op = String(args.op);
      const code = args.code ? String(args.code).trim() : '';
      const base = { tool: 'media_account', op };
      const needCode = op !== 'list';
      if (needCode && !code) {
        return argumentFailure({
          ...base,
          message: `op:"${op}" needs "code" (the account code, e.g. "a-1")`,
          nextSteps: ['Call media_account {op:"list"} to see the registered codes, or {op:"upsert"} to add one.'],
        });
      }
      const ctxFor = (method) => ({ ...base, method, sessionId: null, accountCode: code || null, handoffs });

      switch (op) {
        case 'list': {
          const method = 'account.list';
          try {
            const result = await engine.call(method, {}, { timeoutMs: TIMEOUT.CHECK_MS });
            const accounts = result?.accounts ?? [];
            return success({
              ...base,
              method,
              summary: accounts.length
                ? `${accounts.length} account(s): ${accounts.map((a) => `${a.code}${a.hasState ? '' : ' [no login state]'}${a.proxy?.bound ? '' : ' [direct]'}`).join(', ')}`
                : 'no accounts registered yet',
              data: result,
              nextSteps: accounts.length
                ? ['media_account {op:"check", code:"<code>"} to verify a login state, or {op:"login"} to refresh it.']
                : [`media_account {op:"upsert", code:"a-1", media:"sohu", account:"<login name>"}`],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'upsert': {
          const method = 'account.upsert';
          if (!args.media) {
            return argumentFailure({
              ...base,
              message: 'op:"upsert" needs "media" (sohu | toutiao | csdn)',
              nextSteps: ['media_account {op:"upsert", code:"a-1", media:"sohu", account:"<login name>"}'],
            });
          }
          try {
            const result = await engine.call(method, {
              code,
              media: String(args.media),
              account: args.account ? String(args.account) : '',
              note: args.note ? String(args.note) : '',
            }, { timeoutMs: TIMEOUT.PROXY_MS });
            return success({
              ...base,
              method,
              summary: `account ${code} (${args.media}) saved`,
              data: result,
              nextSteps: [`media_account {op:"login", code:"${code}"} to sign it in with a visible browser window.`],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'remove': {
          const method = 'account.remove';
          try {
            const result = await engine.call(method, { code, purgeState: args.purgeState === true }, { timeoutMs: TIMEOUT.PROXY_MS });
            return success({
              ...base,
              method,
              summary: `account ${code} removed${args.purgeState === true ? ' (state purged)' : ''}`,
              data: result,
              nextSteps: ['media_account {op:"list"} to confirm.'],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'login': {
          const method = 'account.login';
          const headless = args.headless === true;
          try {
            const result = await engine.call(method, {
              code,
              headless,
              timeoutMs: TIMEOUT.LOGIN_MS,
            }, { timeoutMs: TIMEOUT.LOGIN_CLIENT_MS });
            const warnings = result?.warnings ?? [];
            return success({
              ...base,
              method,
              summary: `account ${code} logged in — login state saved to ${result?.statePath ?? '?'}`,
              data: result,
              warnings,
              nextSteps: [
                `media_account {op:"check", code:"${code}"} to re-verify, then media_session {op:"open", accountCode:"${code}"}.`,
                ...(warnings.length ? ['Bind a proxy before publishing: media_account {op:"bindProxy", code, proxy} — an account with no proxy shares its exit IP with every other account.'] : []),
              ],
            });
          } catch (error) {
            return failure(error, {
              ...ctxFor(method),
              nextSteps: headless
                ? ['Retry with headless:false: the human must be able to see the login page and solve the captcha.']
                : ['The window closes when this call ends: finish the QR scan/captcha first, then call it again.'],
            });
          }
        }

        case 'check': {
          const method = 'account.checkLogin';
          try {
            const result = await engine.call(method, { code }, { timeoutMs: TIMEOUT.CHECK_MS });
            const valid = result?.ok === true;
            return success({
              ...base,
              method,
              summary: `${code}: ${result?.status ?? (valid ? 'valid' : 'invalid')} — ${result?.detail ?? ''}`,
              data: result,
              warnings: result?.warnings ?? [],
              nextSteps: valid
                ? [`media_session {op:"open", accountCode:"${code}"} when you are ready to record or publish.`]
                : [`Login state is not usable: media_account {op:"login", code:"${code}"} then re-check.`],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'bindProxy': {
          const method = 'account.bindProxy';
          const resolved = resolveProxyArg(args.proxy, { dataDir });
          if (!resolved.ok) {
            return argumentFailure({
              ...base,
              method,
              message: resolved.message,
              nextSteps: resolved.nextSteps,
            });
          }
          try {
            const result = await engine.call(method, { code, proxy: resolved.proxy }, { timeoutMs: TIMEOUT.PROXY_MS });
            return success({
              ...base,
              method,
              summary: `account ${code}: ${resolved.detail}`,
              data: { ...result, argument: resolved.detail },
              nextSteps: [
                'media_proxy {op:"test", code:"<code>"} to confirm the exit IP.',
                'Open a new session to use it: an already-open session keeps the proxy it started with.',
              ],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        default:
          return argumentFailure({
            ...base,
            message: `unknown op "${op}"`,
            nextSteps: [`Supported ops: ${OPS.join(', ')}.`],
          });
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `media_account ${args?.op ?? ''}`.trim(), kind: 'other' }),
  }));
}

/**
 * Readable, tool-specific lines for the renderer.
 * @param {any} value
 * @returns {string[]}
 */
function renderLines(value) {
  if (!value?.ok || !value.data) return [];
  const data = value.data;
  switch (value.op) {
    case 'list': {
      const accounts = data.accounts ?? [];
      return accounts.map((a) => `  ${a.code}  media=${a.media}  account=${a.account || '-'}  loginState=${a.hasState ? 'yes' : 'NO'}`
        + `  proxy=${a.proxy?.bound ? `${a.proxy.server}${a.proxy.healthy === false ? ' (unhealthy)' : ''}` : 'direct(unbound)'}`
        + `${a.lastRunAt ? `  lastRun=${a.lastRunAt}` : ''}`);
    }
    case 'check':
      return [`  status=${data.status} url=${data.url ?? '-'}`, `  detail=${data.detail ?? ''}`, ...(data.reasons ?? []).map((r) => `  reason: ${r}`)];
    case 'login':
      return [`  statePath=${data.statePath ?? '-'} bytes=${data.stateBytes ?? 0} waitedMs=${data.waitedMs ?? 0}`,
        `  proxy=${data.proxy?.bound ? data.proxy.server : 'direct(unbound)'} hint=${data.detail ?? ''}`];
    case 'bindProxy':
      return [`  bound=${data.proxy?.bound === true} server=${data.proxy?.server ?? '-'} expiresAt=${data.proxy?.expiresAt ?? '-'}`,
        `  ${data.detail ?? ''}`];
    default:
      return [];
  }
}
