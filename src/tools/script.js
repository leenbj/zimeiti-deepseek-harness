/**
 * script.js — `egolite_script`: run a web-automation script in one account browser.
 *
 * The script is JavaScript executed in the host process with a small page API (`goto`, `click`, `fill`,
 * `type`, `press`, `waitFor`, `eval`, `text`, `url`, `title`, `screenshot`, `sleep`, `find`, `log`).
 * It is the escape hatch for anything a declarative flow cannot express, while the account, proxy and
 * persistent profile stay exactly the same as `egolite_publish`.
 *
 * @module ego-publish/tools/script
 */
import { join } from 'node:path';

import { EgoError, sleep } from '../cdp.js';
import { stamp } from '../store.js';
import { defineTool } from '../tool-kit.js';
import { TIMEOUT, openPage, renderEnvelope, requireAccount, sanitize } from './common.js';

/**
 * @param {any} ctx
 * @param {{ accounts: any, manager: any, settings: Record<string, any>, dataDir: string, log: (line: string) => void }} deps
 */
export function register(ctx, deps) {
  const { accounts, manager, settings, dataDir, log } = deps;

  ctx.tools.register(defineTool({
    name: 'egolite_script',
    description:
      'Run a JavaScript web-automation script inside one account browser (same isolated profile and proxy as '
      + 'egolite_publish). The script runs in an async function with these helpers available as locals: goto(url, opts), '
      + 'click(target, opts), fill(target, value), type(target, text), press(key), select(target, value), '
      + 'scroll(deltaY), waitFor({selector|text|urlContains|expression}, opts), eval(expression), text(limit), '
      + 'title(), url(), screenshot(path?, opts?), sleep(ms), find(target), log(...parts); `page` is the raw page '
      + 'object. A target is {selector} or {text, exact?, frame?}. Return a JSON-serializable value; it is reported back. '
      + 'This tool does not enforce a submit guard — use egolite_publish for a guarded publish.',
    parameters: {
      accountCode: { type: 'string', required: true, description: 'Account whose browser runs the script.' },
      code: { type: 'string', required: true, description: 'JavaScript body of an async function (no wrapper).' },
      timeoutMs: { type: 'integer', description: 'Script ceiling (default 120000, max 600000).' },
      screenshot: { type: 'boolean', description: 'Capture a final PNG (default true).' },
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
    timeoutMs: TIMEOUT.SCRIPT_MS,
    async execute(args) {
      const account = requireAccount(accounts, args.accountCode);
      const { page } = await openPage(manager, account.code);
      const logs = [];
      const normalize = (target) => {
        if (!target) return {};
        if (typeof target === 'string') return { selector: target };
        return {
          selector: target.selector,
          text: target.text,
          exact: target.exact === true,
          frame: target.frame,
        };
      };
      const screenshotPath = () => join(dataDir, 'screenshots', `${account.code}-script-${stamp()}.png`);

      const api = {
        page,
        goto: (url, options = {}) => page.goto(url, {
          timeoutMs: options.timeoutMs ?? settings.navigationTimeoutMs,
          waitUntil: options.waitUntil ?? 'domcontentloaded',
          settleMs: options.settleMs,
        }),
        click: (target, options = {}) => page.click(normalize(target), options),
        fill: (target, value) => page.fill(normalize(target), String(value)),
        type: async (target, text) => {
          if (target) await page.focus(normalize(target));
          return page.typeText(String(text));
        },
        press: async (key, times = 1) => {
          for (let index = 0; index < Math.max(1, Math.min(50, times)); index += 1) await page.press(key);
          return { pressed: key, times };
        },
        select: (target, value) => page.selectOption(normalize(target), value),
        scroll: (deltaY = 600) => page.scroll({ deltaY }),
        waitFor: (check, options = {}) => page.waitFor(check, options),
        eval: (expression) => page.evaluate(expression),
        text: (limit = 3000) => page.text(limit),
        title: () => page.title(),
        url: () => page.url(),
        find: (target) => page.find(normalize(target)),
        screenshot: (path, options = {}) => page.screenshot(path || screenshotPath(), options),
        sleep: (ms) => sleep(ms),
        log: (...parts) => {
          const line = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ');
          logs.push(line);
          log(`[script ${account.code}] ${line}`);
          return line;
        },
      };

      const timeoutMs = Math.max(1000, Math.min(600000, Number(args.timeoutMs ?? 120000)));
      let runner;
      try {
        // The body runs in a plain async function so `await` works; helpers are shadowed by locals.
        runner = new Function(
          'api',
          `const { page, goto, click, fill, type, press, select, scroll, waitFor, eval: evaluate, text, title, url, find, screenshot, sleep, log } = api;\n`
          + `return (async () => {\n${args.code}\n})();`,
        );
      } catch (error) {
        throw new EgoError('SCRIPT_SYNTAX', `cannot compile the script: ${error?.message ?? error}`);
      }

      const started = Date.now();
      let value;
      try {
        value = await Promise.race([
          runner(api),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new EgoError('SCRIPT_TIMEOUT', `script exceeded ${timeoutMs}ms`)), timeoutMs);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        throw error instanceof EgoError ? error : new EgoError('SCRIPT_FAILED', String(error?.message ?? error), { logs });
      }
      let result = value;
      if (result === undefined) result = null;
      try {
        JSON.stringify(result);
      } catch {
        result = String(result);
      }
      let shot = null;
      if (args.screenshot !== false) shot = await page.screenshot(screenshotPath()).catch(() => null);

      return sanitize({
        ok: true,
        message: `script finished in ${Date.now() - started}ms`,
        data: {
          result,
          logs: logs.slice(-50),
          screenshot: shot,
          url: await page.url().catch(() => null),
          title: await page.title().catch(() => null),
        },
      });
    },
    presentCall: () => ({ card: 'generic', title: 'egolite script', kind: 'other' }),
  }));
}
