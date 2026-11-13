/**
 * observe.js — `egolite_observe`: read the account page before acting.
 *
 * Returns the URL, the title, a trimmed body text, the visible interactive elements with stable refs and
 * selectors, and a screenshot path. Refs are the recommended way to point `egolite_act` at an element:
 * they are re-derived on every observation, so an action always refers to what the model just saw.
 *
 * @module ego-publish/tools/observe
 */
import { join } from 'node:path';

import { defineTool } from '../tool-kit.js';
import { TIMEOUT, openPage, renderEnvelope, requireAccount, sanitize } from './common.js';
import { stamp } from '../store.js';

/**
 * @param {any} ctx
 * @param {{ accounts: any, manager: any, settings: Record<string, any>, dataDir: string }} deps
 */
export function register(ctx, deps) {
  const { accounts, manager, dataDir } = deps;

  ctx.tools.register(defineTool({
    name: 'egolite_observe',
    description:
      'Observe the current page of one account browser: URL, title, visible body text (trimmed), a list of visible '
      + 'interactive elements (buttons, links, inputs, editable regions) with refs and CSS selectors, and a PNG '
      + 'screenshot path. Call this before egolite_act so the action targets what is actually on screen.',
    parameters: {
      accountCode: { type: 'string', required: true, description: 'Account whose browser to observe.' },
      includeText: { type: 'boolean', description: 'Include the trimmed body text (default true).' },
      textLimit: { type: 'integer', description: 'Maximum body-text characters (default 3000).' },
      screenshot: { type: 'boolean', description: 'Capture a PNG (default true).' },
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the viewport.' },
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
    timeoutMs: TIMEOUT.OBSERVE_MS,
    async execute(args) {
      const account = requireAccount(accounts, args.accountCode);
      const { page } = await openPage(manager, account.code);
      const url = await page.url().catch(() => null);
      const title = await page.title().catch(() => null);
      const elements = await page.describeInteractive().catch(() => []);
      const text = args.includeText === false ? '' : await page.text(args.textLimit ?? 3000).catch(() => '');
      let screenshotPath = null;
      if (args.screenshot !== false) {
        screenshotPath = join(dataDir, 'screenshots', `${account.code}-${stamp()}.png`);
        await page.screenshot(screenshotPath, { fullPage: args.fullPage === true }).catch(() => {
          screenshotPath = null;
        });
      }
      return sanitize({
        ok: true,
        message: `${account.code}: ${title || url || 'page'}`,
        data: {
          accountCode: account.code,
          url,
          title,
          text: String(text).slice(0, args.textLimit ?? 3000),
          elements,
          screenshot: screenshotPath,
          proxy: manager.get(account.code)?.proxyUrl ?? null,
        },
        nextSteps: elements.length
          ? ['Pick an element ref and call egolite_act {accountCode:"' + account.code + '", action:"click", ref:"e3"}.']
          : ['No interactive elements found; navigate with egolite_act {action:"goto", url:"..."} first.'],
      });
    },
    presentCall: () => ({ card: 'generic', title: 'egolite observe', kind: 'other' }),
  }));
}
