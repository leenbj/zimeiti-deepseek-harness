/**
 * publish.js — `egolite_publish`: guarded, replayable publishing in one account browser.
 *
 * The default is a dry run: every step runs up to the one marked `submit:true`, which is skipped and
 * captured as a screenshot. A real publish requires `dryRun:false`. The run directory keeps the report
 * and screenshots as evidence.
 *
 * @module ego-publish/tools/publish
 */
import { join } from 'node:path';

import { EgoError } from '../cdp.js';
import { flowSummary, loadFlows, runFlow } from '../flows.js';
import { ensureDir, stamp, writeJson } from '../store.js';
import { defineTool } from '../tool-kit.js';
import { TIMEOUT, openPage, renderEnvelope, requireAccount, sanitize } from './common.js';

/**
 * @param {any} ctx
 * @param {{ accounts: any, manager: any, settings: Record<string, any>, dataDir: string, pluginRoot: string,
 *           log: (line: string) => void }} deps
 */
export function register(ctx, deps) {
  const { accounts, manager, checks, settings, dataDir, pluginRoot, log } = deps;

  ctx.tools.register(defineTool({
    name: 'egolite_publish',
    description:
      'Publish an article with one account through a replayable flow. The account\'s isolated ego browser is opened '
      + '(its own cookies and proxy), the saved sign-in is checked, then the flow runs with {{title}}/{{body}}/... '
      + 'substituted. DRY RUN BY DEFAULT: stops before the step marked submit:true and screenshots the filled form. '
      + 'Pass dryRun:false only when the user really wants to publish. Every step, screenshot and extracted URL is '
      + 'written under <dataDir>/runs/<timestamp>-<flow>-<account>/.',
    parameters: {
      accountCode: { type: 'string', required: true, description: 'Account that publishes (its browser, proxy and login).' },
      flow: { type: 'string', description: 'Flow id, e.g. "sohu__publish-article".' },
      media: { type: 'string', enum: ['sohu', 'toutiao', 'csdn', 'custom'], description: 'Pick the flow by platform when there is exactly one.' },
      params: {
        type: 'object',
        additionalProperties: true,
        description: 'Publish values, e.g. {title:"...", body:"..."}; also fills any extra {{name}} placeholder.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Default true: fill the form and stop before submit. Pass false to really publish.',
      },
      screenshots: {
        type: 'boolean',
        description: 'Screenshot every step as well as the submit/error points (default false).',
      },
      skipLoginCheck: {
        type: 'boolean',
        description: 'Skip the pre-flight signed-in check (only when the flow has no loginCheck).',
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
    timeoutMs: TIMEOUT.PUBLISH_MS,
    async execute(args) {
      const account = requireAccount(accounts, args.accountCode);
      const flows = loadFlows({ pluginRoot, dataDir });
      let flow;
      if (args.flow) {
        flow = flows.find((item) => item.id === args.flow);
        if (!flow) throw new EgoError('FLOW_NOT_FOUND', `no flow with id "${args.flow}"`, { known: flows.map((item) => item.id) });
      } else if (args.media) {
        const matches = flows.filter((item) => item.media === args.media);
        if (matches.length !== 1) throw new EgoError('AMBIGUOUS_FLOW', `pass flow explicitly; media "${args.media}" matched ${matches.length} flows`, { ids: matches.map((item) => item.id) });
        flow = matches[0];
      } else {
        const matches = flows.filter((item) => item.media === account.media);
        if (matches.length !== 1) throw new EgoError('NO_FLOW', `no single flow for account media "${account.media}"; pass flow explicitly`, { ids: flows.map((item) => item.id) });
        flow = matches[0];
      }
      if (!flow.steps?.length) throw new EgoError('INVALID_FLOW', `flow "${flow.id}" has no steps`);

      const explicit = args.dryRun === true || args.dryRun === false;
      const dryRun = explicit ? args.dryRun : Boolean(settings.requireExplicitPublish);

      // Human cadence guard: one account does not publish twice within minutes. The window is derived
      // from (account, previous publish) so re-running the same call answers the same way instead of
      // flipping between allowed and refused on every attempt.
      if (!dryRun) {
        const lastAt = Date.parse(account.lastPublishAt ?? '') || 0;
        const minMin = Math.max(0, Number(settings.publishIntervalMinMinutes ?? 45));
        const maxMin = Math.max(minMin, Number(settings.publishIntervalMaxMinutes ?? 150));
        if (lastAt) {
          const nextAt = lastAt + (minMin + stableJitter(`${account.code}:${lastAt}`, maxMin - minMin)) * 60000;
          if (Date.now() < nextAt) {
            const elapsedMin = Math.round((Date.now() - lastAt) / 60000);
            throw new EgoError('PUBLISH_TOO_SOON', `account ${account.code} published ${elapsedMin} min ago; the next slot opens at ${new Date(nextAt).toISOString()}`, {
              accountCode: account.code,
              lastPublishAt: account.lastPublishAt,
              nextPublishAt: new Date(nextAt).toISOString(),
            });
          }
        }
      }

      const { page } = await openPage(manager, account.code);
      const runDir = ensureDir(join(dataDir, 'runs', `${stamp()}-${flow.id}-${account.code}`));
      const report = {
        startedAt: new Date().toISOString(),
        accountCode: account.code,
        media: account.media,
        flow: flowSummary(flow),
        dryRun,
        proxy: manager.get(account.code)?.proxyUrl ?? null,
      };

      // Pre-flight: confirm the saved sign-in still works on the platform home page.
      const check = flow.loginCheck;
      if (!args.skipLoginCheck && check && (check.urlContains || check.text || check.selector)) {
        const homeUrl = check.url || account.homeUrl;
        if (homeUrl) {
          try {
            await page.goto(homeUrl, { timeoutMs: settings.navigationTimeoutMs, waitUntil: 'domcontentloaded', settleMs: 1000 });
            // These consoles render their shell asynchronously: a single read right after navigation
            // reports "signed out" on a valid session. Poll for a decisive answer instead.
            const deadline = Date.now() + 12000;
            let url = '';
            let urlOk = false;
            let textOk = false;
            for (;;) {
              url = String(await page.url());
              const text = check.text ? await page.text(3000) : '';
              urlOk = !check.urlContains || url.includes(check.urlContains);
              textOk = !check.text || text.includes(check.text);
              if ((urlOk && textOk) || Date.now() >= deadline) break;
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (!urlOk || !textOk) {
              const failure = new EgoError('LOGIN_REQUIRED', `account ${account.code} is not signed in to ${account.media} (landed on ${url})`, {
                accountCode: account.code,
                url,
                needsHuman: true,
                instructions: `Run egolite_account {op:"login", code:"${account.code}"} and complete the sign-in in the ego window, then publish again.`,
              });
              report.error = failure.message;
              writeJson(join(runDir, 'run.json'), { ...report, finishedAt: new Date().toISOString() });
              throw failure;
            }
          } catch (error) {
            if (error instanceof EgoError && error.code === 'LOGIN_REQUIRED') throw error;
            log(`login pre-flight failed to navigate (${error?.message ?? error}); continuing to the flow`);
          }
        }
      }

      let outcome;
      try {
        outcome = await runFlow({
          page,
          flow,
          params: args.params ?? {},
          dryRun,
          runDir,
          screenshotEveryStep: args.screenshots === true,
          settings,
          log,
        });
      } catch (error) {
        writeJson(join(runDir, 'run.json'), {
          ...report,
          failed: { code: error?.code ?? 'ERROR', message: String(error?.message ?? error), details: error?.details ?? null },
          finishedAt: new Date().toISOString(),
        });
        if (error instanceof EgoError) {
          error.details = { ...(error.details ?? {}), runDir };
          throw error;
        }
        throw new EgoError('PUBLISH_FAILED', String(error?.message ?? error), { runDir });
      }

      writeJson(join(runDir, 'run.json'), { ...report, outcome, finishedAt: new Date().toISOString() });
      // Only a real submit starts this account's interval clock; dry runs publish nothing.
      if (!dryRun && outcome?.submitSkipped !== true) {
        accounts.touch(account.code, { lastPublishAt: new Date().toISOString() });
      }

      // A real publish schedules one delayed check: verify the link is live, then sample 积分.
      let scheduledCheck = null;
      if (!dryRun && checks) {
        const outputs = outcome.outputs ?? {};
        const publishedUrl = outputs.publishedUrl || outputs.publicUrl || null;
        scheduledCheck = checks.schedule({
          accountCode: account.code,
          url: publishedUrl,
          title: String(args.params?.title ?? ''),
          flowId: flow.id,
        });
      }

      return sanitize({
        ok: true,
        message: dryRun
          ? `dry run of ${flow.id} on ${account.code}: form filled, submit skipped`
          : `${flow.id} submitted on ${account.code}`,
        data: {
          accountCode: account.code,
          flowId: flow.id,
          dryRun,
          submitSkipped: outcome.submitSkipped,
          steps: outcome.steps,
          outputs: outcome.outputs,
          finalUrl: outcome.finalUrl,
          runDir,
          scheduledCheck,
        },
        nextSteps: dryRun
          ? [`Review ${runDir} screenshots, then repeat with dryRun:false to publish.`]
          : [
            `A link check and 积分 refresh is scheduled at ${scheduledCheck?.dueAt ?? 'the configured delay'}; nothing else to do now.`,
            'The platform may review the post before it gets a public URL; the check retries if the link is not live yet.',
          ],
      });
    },
    presentCall: (args) => ({ card: 'generic', title: `egolite publish ${args.flow ?? args.media ?? ''}`.trim(), kind: 'other' }),
  }));
}

/**
 * Deterministic 0..span offset. Two calls with the same inputs must land on the same slot, otherwise
 * a retry could pass a guard that just refused it.
 * @param {string} key
 * @param {number} span
 * @returns {number}
 */
function stableJitter(key, span) {
  if (!(span > 0)) return 0;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % (Math.floor(span) + 1);
}
