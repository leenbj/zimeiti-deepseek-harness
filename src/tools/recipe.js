/**
 * recipe.js — `media_recipe`: inspect and validate recorded/built-in recipes.
 *
 * SPEC §2.1 has no `recipe.list` RPC, so `list`/`show` read the same two roots the engine does
 * (`<dataDir>/recipes` first, then `engine/recipes`) and parse the handful of fields the model needs;
 * `validate` is a real engine call (`play.validate`), which is the authority on recipe correctness.
 *
 * @module media-publish/tools/recipe
 */
import { defineTool } from '../tool-kit.js';
import {
  TIMEOUT, argumentFailure, failure, readRecipeCatalog, readRecipeFile, renderEnvelope, resolveRecipe, success,
} from './common.js';

const OPS = ['list', 'show', 'validate'];

/**
 * @param {any} ctx
 * @param {{ engine: any, settings: Record<string, any>, dataDir: string, python: Record<string, any>,
 *           pluginRoot: string, handoffs?: any }} deps
 */
export function register(ctx, deps) {
  const { engine, dataDir, pluginRoot, handoffs } = deps;
  const paths = { dataDir, pluginRoot };

  ctx.tools.register(defineTool({
    name: 'media_recipe',
    description:
      'Inspect publish recipes (YAML scripts that replay a recorded flow). Ops: '
      + '"list" — the catalogue, user recipes under <dataDir>/recipes taking precedence over the built-in ones '
      + 'in engine/recipes; "show" {recipeId|media} — the recipe\'s declared params (title/body/...), its step '
      + 'outline, its login-state guard and the raw YAML; "validate" {recipeId|media} — run the engine\'s real '
      + 'validator (play.validate) and report every issue with its level and step index. Read params with "show" '
      + 'before calling media_publish, and validate after recording or hand-editing a recipe.',
    parameters: {
      op: { type: 'string', enum: OPS, required: true, description: 'Which recipe operation to run.' },
      recipeId: { type: 'string', description: 'Recipe id, e.g. "sohu__publish-article". Required for show/validate unless media identifies exactly one recipe.' },
      media: { type: 'string', description: 'Platform shortcut (sohu | toutiao | csdn) used when it has exactly one recipe.' },
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
          ? `media_recipe ${value.op} — ok`
          : `media_recipe ${value.op ?? '?'} — failed (${value.error?.code ?? 'ERROR'})`,
        value,
        renderLines(value),
      ),
    },
    async execute(args) {
      const op = String(args.op);
      const base = { tool: 'media_recipe', op };
      const ctxFor = (method) => ({ ...base, method, sessionId: null, accountCode: null, handoffs });

      switch (op) {
        case 'list': {
          const method = 'local.recipe-catalog';
          const recipes = readRecipeCatalog(paths);
          return success({
            ...base,
            method,
            summary: recipes.length
              ? `${recipes.length} recipe(s): ${recipes.map((r) => `${r.id} (${r.stepCount} steps, ${r.source})`).join(', ')}`
              : 'no recipes found (neither <dataDir>/recipes nor engine/recipes)',
            data: { dataDir, roots: [`${dataDir}/recipes`, `${pluginRoot}/engine/recipes`], recipes },
            nextSteps: recipes.length
              ? ['media_recipe {op:"show", recipeId:"..."} to read the params, then media_publish {op:"run", dryRun:true}.',
                'media_recipe {op:"validate", recipeId:"..."} before the first real run.']
              : ['Record one: media_session {op:"open"} → media_record {op:"start"} → media_act... → media_record {op:"save"}.'],
          });
        }

        case 'show': {
          const method = 'local.recipe-read';
          const selected = resolveRecipe(paths, { recipeId: args.recipeId, media: args.media });
          if (!selected.ok || !selected.recipe) {
            return argumentFailure({
              ...base,
              method,
              message: selected.message ?? `no recipe matches ${JSON.stringify({ recipeId: args.recipeId, media: args.media })}`,
              nextSteps: [`Available: ${selected.catalog.map((r) => r.id).join(', ') || 'none'}.`],
            });
          }
          const full = readRecipeFile(selected.recipe.path, selected.recipe.source);
          if (!full) {
            return argumentFailure({
              ...base,
              method,
              message: `recipe file is unreadable: ${selected.recipe.path}`,
              nextSteps: ['Check the file encoding/permissions, or re-record it.'],
            });
          }
          const required = full.parsed.params.filter((p) => p.required === true).map((p) => p.name);
          return success({
            ...base,
            method,
            summary: `${full.id} (${full.media}, ${full.source}) — ${full.stepCount} steps`
              + `${required.length ? `, required params: ${required.join(', ')}` : ''}`,
            data: {
              id: full.id,
              media: full.media,
              label: full.label,
              source: full.source,
              path: full.path,
              stepCount: full.stepCount,
              accountCodes: full.accountCodes,
              params: full.parsed.params,
              sessionCheck: full.parsed.sessionCheck,
              capabilities: full.parsed.capabilities,
              verify: full.parsed.verify,
              steps: full.parsed.steps,
              yaml: full.raw,
            },
            nextSteps: [
              required.length
                ? `Pass every required param to media_publish: ${required.map((name) => `${name}:"..."`).join(', ')}.`
                : 'This recipe declares no required params.',
              `media_recipe {op:"validate", recipeId:"${full.id}"} then media_publish {op:"run", recipeId:"${full.id}", accountCode:"<code>", params:{...}, dryRun:true}.`,
            ],
          });
        }

        case 'validate': {
          const method = 'play.validate';
          const selected = resolveRecipe(paths, { recipeId: args.recipeId, media: args.media });
          if (!selected.ok || !selected.recipe) {
            return argumentFailure({
              ...base,
              method,
              message: selected.message ?? 'pass recipeId (or media when it resolves to exactly one recipe)',
              nextSteps: [`Available: ${selected.catalog.map((r) => r.id).join(', ') || 'none'}.`],
            });
          }
          try {
            const result = await engine.call(method, { recipeId: selected.recipe.id }, { timeoutMs: TIMEOUT.VALIDATE_MS });
            const issues = result?.issues ?? [];
            const errors = issues.filter((i) => i.level === 'error');
            return success({
              ...base,
              method,
              summary: result?.ok === true
                ? `${selected.recipe.id}: valid (${issues.length} advisory issue(s))`
                : `${selected.recipe.id}: INVALID — ${errors.length} error(s), ${issues.length - errors.length} warning(s)`,
              data: { ...result, recipeId: selected.recipe.id, recipePath: result?.recipePath ?? selected.recipe.path },
              warnings: issues.filter((i) => i.level !== 'error').map((i) => `${i.code ?? i.level}: ${i.message}`),
              nextSteps: result?.ok === true
                ? [`media_publish {op:"run", recipeId:"${selected.recipe.id}", accountCode:"<code>", params:{...}, dryRun:true} to rehearse.`]
                : ['Fix the reported steps (or re-record that stretch), then validate again.'],
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
    presentCall: (args) => ({ card: 'generic', title: `media_recipe ${args?.op ?? ''}`.trim(), kind: 'other' }),
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
    case 'list':
      return (data.recipes ?? []).map((r) => `  ${r.id}  media=${r.media}  steps=${r.stepCount}  source=${r.source}  ${r.path}`);
    case 'show':
      return [
        `  path=${data.path} accountCodes=${(data.accountCodes ?? []).join(',') || '-'}`,
        ...(data.params ?? []).map((p) => `  param ${p.name}${p.required ? ' (required)' : ''} type=${p.type ?? '?'}${p.max_len ? ` max_len=${p.max_len}` : ''}${p.default !== undefined ? ` default=${JSON.stringify(p.default)}` : ''}`),
        ...(data.steps ?? []).map((s, index) => `  ${String(s.index ?? index).padStart(3, ' ')}  ${s.summary ?? s.type}${s.submit ? '  <-- submit' : ''}${s.optional ? '  (optional)' : ''}`),
      ];
    case 'validate':
      return [
        `  recipeId=${data.recipeId ?? '-'} ok=${data.ok === true} issues=${(data.issues ?? []).length}`,
        ...(data.issues ?? []).map((i) => `  [${i.level}] ${i.code ?? ''} ${i.stepIndex !== undefined && i.stepIndex !== null ? `step#${i.stepIndex} ` : ''}${i.message}`),
      ];
    default:
      return [];
  }
}
