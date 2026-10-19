/**
 * proxy.js — `media_proxy`: the proxy pool (fetch / test / rotate).
 *
 * SECURITY: proxy passwords live in `secrets.yaml` and must never reach the model. The engine already
 * answers with `hasPassword` instead of the secret, and this module additionally runs every result
 * through `sanitize()`, so a future engine change cannot leak one either.
 *
 * @module media-publish/tools/proxy
 */
import { defineTool } from '../tool-kit.js';
import {
  TIMEOUT, argumentFailure, failure, renderEnvelope, resolveProxyArg, scrubCredentials, success,
} from './common.js';

const OPS = ['fetch', 'test', 'rotate'];

/**
 * @param {any} ctx
 * @param {{ engine: any, settings: Record<string, any>, dataDir: string, python: Record<string, any>,
 *           pluginRoot: string, handoffs?: any }} deps
 */
export function register(ctx, deps) {
  const { engine, dataDir, handoffs } = deps;

  ctx.tools.register(defineTool({
    name: 'media_proxy',
    description:
      'Inspect and rotate the proxy pool so each account can leave from a different IP. Ops: '
      + '"fetch" {code?, force?} (take an IP: sticky accounts keep their bound proxy until it expires or '
      + 'force:true), "test" {code?} or {proxy} (probe the exit IP and latency; {proxy} accepts an object, a '
      + 'bare server, or "static:<index>" from <dataDir>/proxies.yaml), "rotate" {code} (drop the sticky '
      + 'binding and take a new IP). Results are ALWAYS desensitized: a proxy password is never returned — '
      + 'look at hasPassword instead. A dead extractor or unreachable proxy surfaces as PROXY_UNAVAILABLE, '
      + 'never as a login error.',
    parameters: {
      op: { type: 'string', enum: OPS, required: true, description: 'Which proxy operation to run.' },
      code: { type: 'string', description: 'Account code whose bound proxy is used, e.g. "a-1".' },
      force: { type: 'boolean', description: 'op:"fetch" — ignore the sticky cache and take a fresh IP now.' },
      proxy: {
        oneOf: [
          { type: 'string', description: 'Server, "server|user|pass", or "static:<index>" from <dataDir>/proxies.yaml.' },
          { type: 'object', additionalProperties: true, description: 'A proxy object {server, username?, password?}.' },
        ],
        description: 'op:"test" — probe this proxy instead of the one bound to code.',
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
          ? `media_proxy ${value.op} — ok`
          : `media_proxy ${value.op ?? '?'} — failed (${value.error?.code ?? 'ERROR'})`,
        value,
        renderLines(value),
      ),
    },
    async execute(args) {
      const op = String(args.op);
      const code = args.code ? String(args.code).trim() : '';
      const base = { tool: 'media_proxy', op };
      const ctxFor = (method) => ({ ...base, method, sessionId: null, accountCode: code || null, handoffs });

      switch (op) {
        case 'fetch': {
          const method = 'proxy.fetch';
          try {
            const result = await engine.call(method, {
              ...(code ? { code } : {}),
              force: args.force === true,
            }, { timeoutMs: TIMEOUT.PROXY_MS });
            return success({
              ...base,
              method,
              summary: `proxy ${result?.server ?? '?'} (source=${result?.source ?? '?'}, hasPassword=${result?.hasPassword === true})${result?.expiresAt ? ` expires ${result.expiresAt}` : ''}`,
              data: scrubCredentials(result),
              nextSteps: [
                code
                  ? `media_proxy {op:"test", code:"${code}"} to confirm the exit IP before publishing.`
                  : 'Pass code to bind the result to one account: media_proxy {op:"fetch", code:"a-1"}.',
              ],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'test': {
          const method = 'proxy.test';
          const hasProxyArg = args.proxy !== undefined && args.proxy !== null;
          if (!hasProxyArg && !code) {
            return argumentFailure({
              ...base,
              method,
              message: 'op:"test" needs "code" (the account whose bound proxy to probe) or "proxy"',
              nextSteps: ['media_proxy {op:"test", code:"a-1"}', 'media_proxy {op:"test", proxy:{server:"http://1.2.3.4:8000"}}'],
            });
          }
          let params = code ? { code } : {};
          if (hasProxyArg) {
            const resolved = resolveProxyArg(args.proxy, { dataDir });
            if (!resolved.ok || !resolved.proxy) {
              return argumentFailure({
                ...base,
                method,
                message: resolved.ok ? 'proxy:null cannot be probed — pass a server or omit proxy and use code' : resolved.message,
                nextSteps: resolved.ok ? ['media_proxy {op:"test", code:"a-1"} to probe the account\'s bound proxy.'] : resolved.nextSteps,
              });
            }
            params = { proxy: resolved.proxy };
          }
          try {
            const result = await engine.call(method, params, { timeoutMs: TIMEOUT.PROXY_MS });
            return success({
              ...base,
              method,
              summary: result?.ok === true
                ? `proxy ok — exit IP ${result?.ip ?? '?'} in ${result?.latencyMs ?? '?'} ms`
                : `proxy test failed — ${result?.detail ?? 'no detail'}`,
              data: scrubCredentials(result),
              nextSteps: result?.ok === true
                ? ['media_session {op:"open", accountCode, proxyPolicy:"sticky"} uses this exit IP for the whole session.']
                : ['Check the extractor URL/credentials in <dataDir>/proxies.yaml, then media_proxy {op:"rotate", code:"<code>"}.'],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'rotate': {
          const method = 'proxy.rotate';
          if (!code) {
            return argumentFailure({
              ...base,
              method,
              message: 'op:"rotate" needs "code" — rotation is per account (the sticky binding lives in that account)',
              nextSteps: ['media_account {op:"list"} to pick the code, then media_proxy {op:"rotate", code:"a-1"}.'],
            });
          }
          try {
            const result = await engine.call(method, { code }, { timeoutMs: TIMEOUT.PROXY_MS });
            return success({
              ...base,
              method,
              summary: `rotated ${code} → ${result?.server ?? '?'} (hasPassword=${result?.hasPassword === true})`,
              data: scrubCredentials(result),
              nextSteps: [
                'Close and reopen the session to pick up the new IP: media_session {op:"close", sessionId} then {op:"open", accountCode}.',
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
    presentCall: (args) => ({ card: 'generic', title: `media_proxy ${args?.op ?? ''}`.trim(), kind: 'other' }),
  }));
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function renderLines(value) {
  if (!value?.ok || !value.data) return [];
  const data = value.data;
  switch (value.op) {
    case 'fetch':
    case 'rotate':
      return [`  server=${data.server ?? '-'} username=${data.username ?? '-'} hasPassword=${data.hasPassword === true}`
        + ` source=${data.source ?? '-'} expiresAt=${data.expiresAt ?? '-'}`];
    case 'test':
      return [`  ok=${data.ok === true} ip=${data.ip ?? '-'} latencyMs=${data.latencyMs ?? '-'} bound=${data.bound ?? '-'}`,
        `  detail=${data.detail ?? ''}`];
    default:
      return [];
  }
}
