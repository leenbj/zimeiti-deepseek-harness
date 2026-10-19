/**
 * publish.js — `media_publish`: replay a recipe (run) and fetch the final link after review (backfill).
 *
 * The safety rail from SPEC §7: `dryRun` defaults to TRUE, so a real publish needs an explicit
 * `dryRun:false`. A dry run opens the pages, fills the form and screenshots, but skips every step marked
 * `submit: true`. Both ops get an explicit, large engine timeout: a replay with self-healing is slow.
 *
 * @module media-publish/tools/publish
 */
import { defineTool } from '../tool-kit.js';
import {
  TIMEOUT, argumentFailure, failure, renderEnvelope, resolveRecipe, success,
} from './common.js';

const OPS = ['run', 'backfill'];
const PROXY_POLICIES = ['sticky', 'rotate', 'direct'];

/**
 * @param {any} ctx
 * @param {{ engine: any, settings: Record<string, any>, dataDir: string, python: Record<string, any>,
 *           pluginRoot: string, handoffs?: any }} deps
 */
export function register(ctx, deps) {
  const { engine, settings, dataDir, pluginRoot, handoffs } = deps;
  const paths = { dataDir, pluginRoot };

  ctx.tools.register(defineTool({
    name: 'media_publish',
    description:
      'Replay a recipe to publish (or to rehearse). Ops: '
      + '"run" {recipeId|media, accountCode, params, dryRun?, headless?, heal?, stopOnError?, proxyPolicy?} — '
      + 'opens the account\'s isolated context, executes the recipe step by step, self-heals broken locators and '
      + 'writes <dataDir>/runs/<timestamp>-<recipe>-<account>/ with run.json, per-step status and screenshots; '
      + '"backfill" {recipeId|media, accountCode, title, headless?} — after the platform has reviewed the post, go '
      + 'back and fetch the real published URL. IMPORTANT: dryRun DEFAULTS TO true — a dry run fills the form and '
      + 'screenshots but SKIPS the final submit, and the result says so. Real publishing requires an explicit '
      + 'dryRun:false (settings.requireExplicitPublish). `params` holds the publish values (title/body/...), which '
      + 'are NOT the same as the recipe\'s parameter declarations you read with media_recipe {op:"show"}. On '
      + 'failure the result carries failedStep, the engine error code, error.details.candidates (candidate '
      + 'elements for a broken locator) and the run directory to inspect.',
    parameters: {
      op: { type: 'string', enum: OPS, required: true, description: 'run = replay the recipe, backfill = fetch the reviewed post\'s final URL.' },
      recipeId: { type: 'string', description: 'Recipe id, e.g. "toutiao__publish-article". Required unless media identifies exactly one recipe.' },
      media: { type: 'string', description: 'Platform shortcut (sohu | toutiao | csdn) used when it has exactly one recipe.' },
      accountCode: { type: 'string', required: true, description: 'The account to publish as, e.g. "a-1" (its login state, fingerprint and proxy are used).' },
      params: {
        type: 'object',
        additionalProperties: true,
        description: 'op:"run" — the recipe parameter VALUES, e.g. {title:"...", body:"..."}. Get the required names from media_recipe {op:"show"}.',
      },
      dryRun: { type: 'boolean', description: 'Default TRUE. Set false ONLY when you really want to publish: dry runs stop before the submit step.' },
      headless: { type: 'boolean', description: 'Override the browser mode for this run; Toutiao needs false.' },
      heal: { type: 'boolean', description: 'Self-heal broken locators from a fresh snapshot (default true).' },
      stopOnError: { type: 'boolean', description: 'Stop at the first failing step (default true); false keeps going and reports every failure.' },
      proxyPolicy: { type: 'string', enum: PROXY_POLICIES, description: 'sticky (default) reuses the account\'s bound IP, rotate takes a new one, direct bypasses the proxy.' },
      title: { type: 'string', description: 'op:"backfill" — the article title to look up in the platform\'s post list.' },
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
          ? `media_publish ${value.op} — ${value.data?.dryRun === true ? 'DRY RUN (nothing was submitted)' : 'ok'}`
          : `media_publish ${value.op ?? '?'} — failed (${value.error?.code ?? 'ERROR'})`,
        value,
        renderLines(value),
      ),
    },
    async execute(args) {
      const op = String(args.op);
      const accountCode = args.accountCode ? String(args.accountCode).trim() : '';
      const base = { tool: 'media_publish', op };
      if (!accountCode) {
        return argumentFailure({
          ...base,
          message: `op:"${op}" needs "accountCode"`,
          nextSteps: ['media_account {op:"list"} to pick a code; its login state must be valid first (media_account {op:"check"}).'],
        });
      }
      const ctxFor = (method) => ({ ...base, method, sessionId: null, accountCode, handoffs });

      // `recipeId` is used verbatim (the engine also accepts paths); `media` is resolved here.
      let recipeId = args.recipeId ? String(args.recipeId).trim() : '';
      if (!recipeId) {
        const selected = resolveRecipe(paths, { recipeId: null, media: args.media });
        if (!selected.ok || !selected.recipe) {
          return argumentFailure({
            ...base,
            message: selected.message ?? 'pass recipeId, or media when that platform has exactly one recipe',
            nextSteps: [`Available recipes: ${selected.catalog.map((r) => r.id).join(', ') || 'none'} (media_recipe {op:"list"}).`],
          });
        }
        recipeId = selected.recipe.id;
      }

      switch (op) {
        case 'run': {
          const method = 'play.run';
          const dryRun = args.dryRun === undefined ? true : args.dryRun === true;
          const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {};
          const engineParams = {
            recipeId,
            accountCode,
            params,
            dryRun,
            stopOnError: args.stopOnError === undefined ? true : args.stopOnError === true,
            heal: args.heal === undefined ? true : args.heal === true,
            proxyPolicy: args.proxyPolicy ? String(args.proxyPolicy) : 'sticky',
          };
          if (args.headless !== undefined) engineParams.headless = args.headless === true;
          try {
            const result = await engine.call(method, engineParams, { timeoutMs: TIMEOUT.PUBLISH_MS });
            const warnings = [];
            if (dryRun) warnings.push('DRY RUN: the submit step was skipped, nothing was published.');
            if (!dryRun && settings.requireExplicitPublish) warnings.push('REAL PUBLISH (dryRun:false was passed explicitly).');
            const failedStep = result?.failedStep ?? null;
            return success({
              ...base,
              method,
              summary: result?.ok === true
                ? `${dryRun ? 'dry run of ' : ''}${recipeId} on ${accountCode}: ${result?.steps?.length ?? 0} steps ok`
                  + `${result?.publishedUrl ? `, publishedUrl=${result.publishedUrl}` : ''}`
                : `${recipeId} on ${accountCode} FAILED at step ${failedStep?.index ?? '?'}`
                  + `${failedStep?.error?.code ? ` (${failedStep.error.code})` : ''}${failedStep?.error?.message ? `: ${failedStep.error.message}` : ''}`,
              data: { ...result, dryRun, recipeId, accountCode },
              warnings: [...warnings, ...(result?.warnings ?? [])],
              nextSteps: result?.ok === true
                ? (dryRun
                  ? [
                    'This was a DRY RUN. To really publish, call again with dryRun:false — and only then.',
                    result?.runDir ? `Review the screenshots in ${result.runDir} first.` : 'Review the run directory screenshots first.',
                  ]
                  : [
                    result?.publishedUrl
                      ? `Published: ${result.publishedUrl}`
                      : 'The recipe returned no publishedUrl: use media_publish {op:"backfill", title:"..."} once the post clears review.',
                    ...(result?.runDir ? [`Evidence: ${result.runDir}`] : []),
                  ])
                : [
                  failedStep
                    ? `Inspect step ${failedStep.index} (${failedStep.type ?? '?'})${result?.runDir ? ` and ${result.runDir}` : ''}.`
                    : 'Inspect the run directory for run.json and screenshots.',
                  'Fix the failing step\'s target in the recipe (or re-record that stretch), then re-run with dryRun:true.',
                ],
            });
          } catch (error) {
            return failure(error, {
              ...ctxFor(method),
              nextSteps: [
                error?.code === 'LOGIN_REQUIRED' || error?.code === 'RECIPE_INVALID'
                  ? `media_account {op:"check", code:"${accountCode}"} if the failure is a stale login state.`
                  : '',
                error?.code === 'PARAM_MISSING'
                  ? `media_recipe {op:"show", recipeId:"${recipeId}"} lists the required params.`
                  : '',
                `Recipe used: ${recipeId}. A failed replay always leaves a run directory under <dataDir>/runs.`,
              ].filter(Boolean),
            });
          }
        }

        case 'backfill': {
          const method = 'play.backfill';
          const title = args.title ? String(args.title) : '';
          if (!title) {
            return argumentFailure({
              ...base,
              method,
              message: 'op:"backfill" needs "title" (the title used at publish time)',
              nextSteps: ['Use the exact title you passed to media_publish {op:"run"}.'],
            });
          }
          try {
            const result = await engine.call(method, {
              recipeId,
              accountCode,
              title,
              ...(args.headless !== undefined ? { headless: args.headless === true } : {}),
            }, { timeoutMs: TIMEOUT.BACKFILL_MS });
            return success({
              ...base,
              method,
              summary: result?.publishedUrl
                ? `backfill found ${result.publishedUrl}`
                : `backfill ran but found no final URL for "${title}"`,
              data: { ...result, recipeId, accountCode, title },
              nextSteps: result?.publishedUrl
                ? ['Store/report the final link; nothing else to do for this post.']
                : ['The post may still be under review: retry later, or check the platform\'s post list manually.'],
            });
          } catch (error) {
            return failure(error, {
              ...ctxFor(method),
              nextSteps: error?.code === 'UNKNOWN_METHOD' || error?.code === 'UNSUPPORTED'
                ? ['This engine build did not answer play.backfill: report it to the engine owner instead of retrying.',
                  'Meanwhile the recipe\'s `verify` section and the platform\'s post list are the fallback for the final link.']
                : ['The post may still be under review; retry backfill later, or check the platform\'s post list manually.'],
            });
          }
        }

        default:
          return argumentFailure({ ...base, message: `unknown op "${op}"`, nextSteps: [`Supported ops: ${OPS.join(', ')}.`] });
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `media_publish ${args?.op ?? ''}`.trim(), kind: 'other' }),
  }));
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function renderLines(value) {
  if (!value?.ok || !value.data) return [];
  const data = value.data;
  if (value.op === 'backfill') {
    return [`  publishedUrl=${data.publishedUrl ?? '-'}`, `  title=${data.title ?? '-'}`, ...(data.detail ? [`  detail=${data.detail}`] : [])];
  }
  const steps = data.steps ?? [];
  return [
    `  dryRun=${data.dryRun === true} runDir=${data.runDir ?? '-'} publishedUrl=${data.publishedUrl ?? '-'}`,
    ...(data.failedStep ? [`  failedStep=#${data.failedStep.index} ${data.failedStep.type ?? ''} ${data.failedStep.error?.code ?? ''} ${data.failedStep.error?.message ?? ''}`] : []),
    ...steps.map((s) => `  ${String(s.index).padStart(3, ' ')}  ${s.type ?? '?'}  ${s.status}${s.ms !== undefined ? ` ${s.ms}ms` : ''}${s.error ? `  ${s.error.code ?? ''} ${s.error.message ?? ''}` : ''}`),
  ];
}
