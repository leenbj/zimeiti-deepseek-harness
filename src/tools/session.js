/**
 * session.js — `media_session`: isolated browser session lifecycle.
 *
 * One session is one account, one fingerprint, one proxy and one browser context (SPEC §4.1). The
 * `handoff` / `resume` pair is what makes human-in-the-loop recording work: the agent pulls the page to
 * the front and asks a human to solve a captcha or scan a QR code, then hands control back.
 *
 * @module media-publish/tools/session
 */
import { defineTool } from '../tool-kit.js';
import {
  TIMEOUT, argumentFailure, failure, renderEnvelope, success,
} from './common.js';

const OPS = ['open', 'close', 'list', 'state', 'handoff', 'resume'];
const PROXY_POLICIES = ['sticky', 'rotate', 'direct'];

/**
 * @param {any} ctx
 * @param {{ engine: any, settings: Record<string, any>, dataDir: string, python: Record<string, any>,
 *           pluginRoot: string, handoffs?: any }} deps
 */
export function register(ctx, deps) {
  const { engine, settings, handoffs } = deps;

  ctx.tools.register(defineTool({
    name: 'media_session',
    description:
      'Control isolated browser sessions (one account = one context = one fingerprint = one proxy). Ops: '
      + '"open" {accountCode, headless?, interactive?, proxyPolicy?} — launches a context and returns sessionId; '
      + '"close" {sessionId, saveState?=true} — saves storage_state.json then closes; '
      + '"list" — every live session; "state" {sessionId} — url/title/recording/stepCount/proxy; '
      + '"handoff" {sessionId, reason, hint?} — pull the window to the front and ask a HUMAN to solve a captcha / '
      + 'scan a QR code; "resume" {sessionId} — wait (up to 5 minutes) until the page is usable again and hand '
      + 'control back to the agent. Call "resume" after every handoff and after any LOGIN_REQUIRED failure. '
      + 'Warnings from "open" (e.g. an account with no bound proxy, so it shares an exit IP) must not be ignored '
      + 'in multi-account use.',
    parameters: {
      op: { type: 'string', enum: OPS, required: true, description: 'Which session operation to run.' },
      accountCode: { type: 'string', description: 'op:"open" — the account code to open a session for, e.g. "a-1".' },
      sessionId: { type: 'string', description: 'Required for every op except open/list.' },
      headless: { type: 'boolean', description: 'op:"open" — default false. Toutiao silently blocks headless publishes; keep it false when recording.' },
      interactive: { type: 'boolean', description: 'op:"open" — mark the session as human-supervised (kept front-most, no stealth shortcuts).' },
      proxyPolicy: { type: 'string', enum: PROXY_POLICIES, description: 'op:"open" — sticky (default) keeps the account\'s bound IP, rotate takes a new one, direct bypasses the proxy.' },
      saveState: { type: 'boolean', description: 'op:"close" — default true: persist cookies + localStorage for that account.' },
      reason: { type: 'string', description: 'op:"handoff" — why a human is needed, e.g. "captcha" | "qr-login" | "sms".' },
      hint: { type: 'string', description: 'op:"handoff" — instruction shown to the human.' },
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
          ? `media_session ${value.op} — ok`
          : `media_session ${value.op ?? '?'} — failed (${value.error?.code ?? 'ERROR'})`,
        value,
        renderLines(value),
      ),
    },
    async execute(args) {
      const op = String(args.op);
      const sessionId = args.sessionId ? String(args.sessionId).trim() : '';
      const base = { tool: 'media_session', op };
      const ctxFor = (method, accountCode = null) => ({
        ...base, method, sessionId: sessionId || null, accountCode, handoffs,
      });

      if (op !== 'open' && op !== 'list' && !sessionId) {
        return argumentFailure({
          ...base,
          message: `op:"${op}" needs "sessionId"`,
          nextSteps: ['media_session {op:"list"} to see live sessions, or {op:"open", accountCode:"<code>"} to create one.'],
        });
      }

      switch (op) {
        case 'open': {
          const method = 'session.open';
          const accountCode = args.accountCode ? String(args.accountCode).trim() : '';
          if (!accountCode) {
            return argumentFailure({
              ...base,
              method,
              message: 'op:"open" needs "accountCode"',
              nextSteps: ['media_account {op:"list"} to pick a registered code, or {op:"upsert"} to add one first.'],
            });
          }
          const headless = args.headless === undefined ? settings.headless === true : args.headless === true;
          try {
            const result = await engine.call(method, {
              accountCode,
              headless,
              interactive: args.interactive === true,
              proxyPolicy: args.proxyPolicy ? String(args.proxyPolicy) : 'sticky',
            }, { timeoutMs: TIMEOUT.OPEN_MS });
            const warnings = result?.warnings ?? [];
            return success({
              ...base,
              method,
              summary: `session ${result?.sessionId} open for ${accountCode}`
                + ` (proxy ${result?.proxy?.bound ? result.proxy.server : 'DIRECT — unbound'}, headless=${headless})`,
              data: result,
              warnings,
              nextSteps: [
                `media_observe {sessionId:"${result?.sessionId}"} to get the first ref list.`,
                ...(warnings.length ? ['Bind a proxy for this account (media_account {op:"bindProxy"}) or pass proxyPolicy:"direct" deliberately.'] : []),
              ],
            });
          } catch (error) {
            return failure(error, ctxFor(method, accountCode));
          }
        }

        case 'close': {
          const method = 'session.close';
          try {
            const result = await engine.call(method, {
              sessionId,
              saveState: args.saveState === undefined ? true : args.saveState === true,
            }, { timeoutMs: TIMEOUT.CHECK_MS });
            handoffs.clear(sessionId);
            return success({
              ...base,
              method,
              summary: `session ${sessionId} closed (state saved to ${result?.savedStatePath ?? 'not saved'})`,
              data: result,
              warnings: result?.warnings ?? [],
              nextSteps: ['media_session {op:"list"} to confirm no session is left behind.'],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'list': {
          const method = 'session.list';
          try {
            const result = await engine.call(method, {}, { timeoutMs: TIMEOUT.STATUS_MS });
            const sessions = result?.sessions ?? [];
            return success({
              ...base,
              method,
              summary: sessions.length ? `${sessions.length} live session(s)` : 'no live sessions',
              data: result,
              nextSteps: sessions.length
                ? ['media_observe {sessionId} to continue driving one of them.']
                : ['media_session {op:"open", accountCode:"<code>"} to start one.'],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'state': {
          const method = 'session.state';
          try {
            const result = await engine.call(method, { sessionId }, { timeoutMs: TIMEOUT.STATUS_MS });
            return success({
              ...base,
              method,
              summary: `${sessionId}: ${result?.url ?? '?'} "${result?.title ?? ''}" recording=${result?.recording === true} steps=${result?.stepCount ?? 0}`,
              data: result,
              nextSteps: result?.recording
                ? ['media_act to add steps, then media_record {op:"save"} to compile the recipe.']
                : ['media_record {op:"start"} to begin recording this session.'],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'handoff': {
          const method = 'session.handoff';
          const reason = args.reason ? String(args.reason) : 'manual';
          try {
            const result = await engine.call(method, {
              sessionId,
              reason,
              ...(args.hint ? { hint: String(args.hint) } : {}),
            }, { timeoutMs: TIMEOUT.STATUS_MS });
            const handoff = {
              sessionId,
              reason: result?.reason ?? reason,
              hint: result?.hint ?? args.hint ?? '',
              url: result?.url ?? null,
              headless: result?.headless === true,
              needsHuman: true,
              at: new Date().toISOString(),
            };
            handoffs.record(handoff);
            return success({
              ...base,
              method,
              summary: `handed session ${sessionId} to a human (reason "${handoff.reason}")`,
              data: result,
              handoff,
              nextSteps: [
                `Ask the human to finish "${handoff.reason}" in the browser window${handoff.url ? ` (currently at ${handoff.url})` : ''}.`,
                `Then call media_session {op:"resume", sessionId:"${sessionId}"}.`,
              ],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'resume': {
          const method = 'session.resume';
          try {
            const result = await engine.call(method, { sessionId }, { timeoutMs: TIMEOUT.RESUME_MS });
            handoffs.clear(sessionId);
            return success({
              ...base,
              method,
              summary: `session ${sessionId} usable again after ${result?.waitedMs ?? 0} ms — ${result?.url ?? '?'}`,
              data: result,
              nextSteps: [
                `media_observe {sessionId:"${sessionId}"} to re-read the page before acting: refs from before the handoff are gone.`,
              ],
            });
          } catch (error) {
            const recorded = handoffs.get(sessionId);
            return failure(error, {
              ...ctxFor(method),
              nextSteps: [
                `The page is still blocked (${recorded?.reason ?? 'captcha/login'}). Do NOT retry in a loop: ask the human to finish it in the browser window, then call resume again.`,
              ],
            });
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
    presentCall: (args) => ({ card: 'generic', title: `media_session ${args?.op ?? ''}`.trim(), kind: 'other' }),
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
    case 'open':
      return [`  sessionId=${data.sessionId} account=${data.accountCode} media=${data.media ?? '-'}`,
        `  proxy=${data.proxy?.bound ? `${data.proxy.server} (policy ${data.proxyPolicy})` : `DIRECT — ${data.proxyPolicy}`}`
        + ` storageState=${data.storageStateExists === true ? 'loaded' : 'none'} log=${data.logPath ?? '-'}`,
        ...(data.warnings ?? []).map((w) => `  WARNING: ${w}`)];
    case 'list':
      return (data.sessions ?? []).map((s) => `  ${s.sessionId}  ${s.accountCode}  ${s.url ?? '-'}  recording=${s.recording === true}`);
    case 'state':
      return [`  url=${data.url ?? '-'}`, `  title=${data.title ?? '-'}`, `  recording=${data.recording === true} steps=${data.stepCount ?? 0} proxy=${data.proxy?.server ?? 'direct'}`];
    case 'handoff':
    case 'resume':
      return [`  url=${data.url ?? '-'}`, `  hint=${data.hint ?? ''}`];
    case 'close':
      return [`  savedStatePath=${data.savedStatePath ?? '-'}`];
    default:
      return [];
  }
}
