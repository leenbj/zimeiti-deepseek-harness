/**
 * act.js — `egolite_act`: one page action per call.
 *
 * The target can be a ref from the latest `egolite_observe`, a CSS selector, or visible text. One action
 * per call keeps the trace readable and lets the model re-observe between steps.
 *
 * @module ego-publish/tools/act
 */
import { EgoError, sleep } from '../cdp.js';
import { defineTool } from '../tool-kit.js';
import { TIMEOUT, openPage, renderEnvelope, requireAccount, sanitize } from './common.js';

const ACTIONS = [
  'goto', 'back', 'reload', 'click', 'fill', 'type', 'press', 'select', 'upload',
  'scroll', 'waitFor', 'eval', 'screenshot',
];

/**
 * @param {any} ctx
 * @param {{ accounts: any, manager: any, settings: Record<string, any>, dataDir: string }} deps
 */
export function register(ctx, deps) {
  const { accounts, manager, settings, dataDir } = deps;

  /** Resolve args into a page target descriptor. */
  function targetOf(page, args) {
    if (args.ref) {
      const found = page.ref(String(args.ref));
      if (!found) throw new EgoError('UNKNOWN_REF', `no observed element with ref "${args.ref}"; call egolite_observe again`);
      return { selector: found.selector, exact: true, frame: args.frame };
    }
    if (!args.selector && !args.text) {
      throw new EgoError('NO_TARGET', 'this action needs ref, selector or text');
    }
    return { selector: args.selector, text: args.text, exact: args.exact === true, frame: args.frame };
  }

  ctx.tools.register(defineTool({
    name: 'egolite_act',
    description:
      'Run exactly one page action in one account browser. Actions: goto, back, reload, click, fill, type, press, '
      + 'select, upload, scroll, waitFor, eval (escape hatch, returns the evaluated value), screenshot. Point at an '
      + 'element with ref (from egolite_observe), selector, or visible text; for text inside an iframe pass frame as '
      + 'the iframe selector. This tool never publishes by itself — use egolite_publish for that.',
    parameters: {
      accountCode: { type: 'string', required: true, description: 'Account whose browser to drive.' },
      action: { type: 'string', required: true, enum: ACTIONS, description: 'The single action to run.' },
      ref: { type: 'string', description: 'Element ref from the latest egolite_observe (e.g. "e3").' },
      selector: { type: 'string', description: 'CSS selector for the target element.' },
      text: { type: 'string', description: 'Visible text to match instead of a selector.' },
      exact: { type: 'boolean', description: 'Require exact text (with text targets).' },
      frame: { type: 'string', description: 'Selector of an iframe whose document contains the target.' },
      value: { type: 'string', description: 'Value for fill/select.' },
      url: { type: 'string', description: 'URL for goto.' },
      key: { type: 'string', description: 'Key or chord for press, e.g. Enter or Control+A.' },
      times: { type: 'integer', description: 'How many times to press (default 1).' },
      deltaY: { type: 'integer', description: 'Scroll delta in CSS pixels (default 600).' },
      expression: { type: 'string', description: 'JavaScript expression for eval / waitFor.' },
      urlContains: { type: 'string', description: 'For waitFor: wait until the URL contains this.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths for upload.' },
      timeoutMs: { type: 'integer', description: 'Action ceiling (default from config).' },
      fullPage: { type: 'boolean', description: 'For screenshot: capture the whole page.' },
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
    timeoutMs: TIMEOUT.ACT_MS,
    async execute(args) {
      const account = requireAccount(accounts, args.accountCode);
      const { page } = await openPage(manager, account.code);
      const timeoutMs = Number(args.timeoutMs ?? settings.actionTimeoutMs ?? 15000);
      let detail;

      switch (args.action) {
        case 'goto': {
          if (!args.url) throw new EgoError('NO_URL', 'goto needs url');
          detail = await page.goto(args.url, { timeoutMs: Math.max(timeoutMs, settings.navigationTimeoutMs ?? 60000), waitUntil: 'domcontentloaded', settleMs: 500 });
          break;
        }
        case 'back': {
          await page.evaluate('history.back()');
          await page.waitForLoadState('domcontentloaded', { timeoutMs }).catch(() => {});
          await sleep(500);
          detail = { back: true };
          break;
        }
        case 'reload': {
          await page.send('Page.reload', {});
          await page.waitForLoadState('domcontentloaded', { timeoutMs }).catch(() => {});
          detail = { reloaded: true };
          break;
        }
        case 'click':
          detail = await page.click(targetOf(page, args), { timeoutMs });
          break;
        case 'fill':
          detail = await page.fill(targetOf(page, args), String(args.value ?? ''), { timeoutMs });
          break;
        case 'type': {
          const target = targetOf(page, args);
          await page.focus(target);
          detail = await page.typeText(String(args.value ?? args.text ?? ''), {});
          break;
        }
        case 'press': {
          const times = Math.max(1, Math.min(50, Number(args.times ?? 1)));
          for (let index = 0; index < times; index += 1) await page.press(String(args.key ?? 'Enter'));
          detail = { pressed: args.key ?? 'Enter', times };
          break;
        }
        case 'select':
          detail = await page.selectOption(targetOf(page, args), args.value ?? '');
          break;
        case 'upload':
          if (!Array.isArray(args.files) || !args.files.length) throw new EgoError('NO_FILES', 'upload needs files');
          detail = await page.upload(targetOf(page, args), args.files);
          break;
        case 'scroll':
          detail = await page.scroll({ deltaY: Number(args.deltaY ?? 600) });
          break;
        case 'waitFor':
          detail = await page.waitFor({
            selector: args.selector,
            text: args.text,
            urlContains: args.urlContains,
            expression: args.expression,
          }, { timeoutMs });
          break;
        case 'eval':
          if (!args.expression) throw new EgoError('NO_EXPRESSION', 'eval needs expression');
          detail = { value: await page.evaluate(args.expression) };
          break;
        case 'screenshot': {
          const { join } = await import('node:path');
          const { stamp } = await import('../store.js');
          const filePath = join(dataDir, 'screenshots', `${account.code}-${stamp()}.png`);
          await page.screenshot(filePath, { fullPage: args.fullPage === true });
          detail = { screenshot: filePath };
          break;
        }
        default:
          throw new EgoError('INVALID_ACTION', `unknown action "${args.action}"`);
      }

      return sanitize({
        ok: true,
        message: `${args.action} ok`,
        data: {
          action: args.action,
          detail,
          url: await page.url().catch(() => null),
          title: await page.title().catch(() => null),
        },
      });
    },
    presentCall: (args) => ({ card: 'generic', title: `egolite ${args.action}`, kind: 'other' }),
  }));
}
