/**
 * record.js — `media_record`: turn a live session trace into a replayable recipe.
 *
 * Ops map onto `record.*` (SPEC §2.1). `save` compiles the trace into YAML, parameterizes the literals it
 * recognizes and marks the submit step; the engine also writes a `<recipeId>.compile-report.json` next to
 * the recipe explaining what it parameterized, which a human should read before trusting the recipe.
 *
 * @module media-publish/tools/record
 */
import { defineTool } from '../tool-kit.js';
import {
  TIMEOUT, argumentFailure, failure, renderEnvelope, success,
} from './common.js';

const OPS = ['start', 'status', 'note', 'undo', 'save'];

/**
 * @param {any} ctx
 * @param {{ engine: any, settings: Record<string, any>, dataDir: string, python: Record<string, any>,
 *           pluginRoot: string, handoffs?: any }} deps
 */
export function register(ctx, deps) {
  const { engine, handoffs } = deps;

  ctx.tools.register(defineTool({
    name: 'media_record',
    description:
      'Control recipe recording for a live session. Ops: '
      + '"start" {sessionId, recipeId, media} — begin recording (every media_act is appended to the trace); '
      + '"status" {sessionId} — recording flag, step count and a step outline; '
      + '"note" {sessionId, text} — annotate the trace (why a step exists); notes stay out of the recipe; '
      + '"undo" {sessionId, count?=1} — drop the last N steps from the trace; '
      + '"save" {sessionId, recipeId?, media?, label?, params?, overwrite?=false, sessionCheck?, verify?, accountCodes?} '
      + '— compile the trace into YAML, write it under <dataDir>/recipes/<media>/<recipeId>.yaml plus a '
      + '<recipeId>.compile-report.json that says which literals became {{params}} and which step it treats as '
      + 'submit. Read that report. NOTE: here `params` is the recipe\'s PARAMETER DECLARATION '
      + '([{name,type,required}]), not publish values — publish values belong to media_publish.',
    parameters: {
      op: { type: 'string', enum: OPS, required: true, description: 'Which recording operation to run.' },
      sessionId: { type: 'string', required: true, description: 'The session being recorded.' },
      recipeId: { type: 'string', description: 'Recipe id, e.g. "sohu__publish-article". Required for op:"start"; for op:"save" it defaults to the id given at start.' },
      media: { type: 'string', enum: ['sohu', 'toutiao', 'csdn'], description: 'Platform; required for op:"start".' },
      text: { type: 'string', description: 'op:"note" — the annotation to append to the trace.' },
      count: { type: 'integer', description: 'op:"undo" — how many trailing steps to drop (default 1).' },
      label: { type: 'string', description: 'op:"save" — human-readable recipe label, e.g. "搜狐号发布图文".' },
      params: {
        type: 'array',
        description: 'op:"save" — the recipe\'s parameter DECLARATIONS, e.g. [{name:"title",type:"string",required:true}]. Omit to let the engine infer them from the trace.',
        items: { type: 'object', additionalProperties: true },
      },
      overwrite: { type: 'boolean', description: 'op:"save" — replace an existing recipe file (default false).' },
      sessionCheck: {
        type: 'object',
        additionalProperties: true,
        description: 'op:"save" — login-state guard for replay, e.g. {url:"...", fail_if_url_contains:["passport","login"]}.',
      },
      verify: {
        type: 'object',
        additionalProperties: true,
        description: 'op:"save" — post-publish verification, e.g. {mode:"later_backfill", list_url:"...", status_regex:"已发布|审核中"}.',
      },
      accountCodes: {
        type: 'array',
        items: { type: 'string' },
        description: 'op:"save" — restrict the recipe to these account codes, e.g. ["a-1"].',
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
          ? `media_record ${value.op} — ok`
          : `media_record ${value.op ?? '?'} — failed (${value.error?.code ?? 'ERROR'})`,
        value,
        renderLines(value),
      ),
    },
    async execute(args) {
      const op = String(args.op);
      const sessionId = String(args.sessionId ?? '').trim();
      const base = { tool: 'media_record', op };
      const ctxFor = (method) => ({ ...base, method, sessionId: sessionId || null, accountCode: null, handoffs });

      if (!sessionId) {
        return argumentFailure({
          ...base,
          message: `op:"${op}" needs "sessionId"`,
          nextSteps: ['media_session {op:"list"} to find the session you are recording.'],
        });
      }

      switch (op) {
        case 'start': {
          const method = 'record.start';
          const recipeId = args.recipeId ? String(args.recipeId).trim() : '';
          if (!recipeId) {
            return argumentFailure({ ...base, method, message: 'op:"start" needs "recipeId"', nextSteps: ['Example: media_record {op:"start", sessionId, recipeId:"sohu__publish-article", media:"sohu"}'] });
          }
          if (!args.media) {
            return argumentFailure({ ...base, method, message: 'op:"start" needs "media" (sohu | toutiao | csdn)', nextSteps: ['The media decides the recipe directory and the built-in session check.'] });
          }
          try {
            const result = await engine.call(method, { sessionId, recipeId, media: String(args.media) }, { timeoutMs: TIMEOUT.VALIDATE_MS });
            return success({
              ...base,
              method,
              summary: `recording ${recipeId} (media ${args.media}) on ${sessionId}`,
              data: result,
              nextSteps: [
                `media_observe {sessionId:"${sessionId}"} then drive the flow with media_act; every action is recorded.`,
                'Publish once for real during recording: the recipe needs the real success signal and the publishedUrl extract step.',
              ],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'status': {
          const method = 'record.status';
          try {
            const result = await engine.call(method, { sessionId }, { timeoutMs: TIMEOUT.STATUS_MS });
            const steps = result?.steps ?? [];
            return success({
              ...base,
              method,
              summary: `recording=${result?.recording === true} steps=${result?.stepCount ?? steps.length}`,
              data: result,
              nextSteps: result?.recording === true
                ? ['media_record {op:"save"} when the flow is complete (and one real publish has been captured).']
                : ['recording is off: media_record {op:"start"} before acting.'],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'note': {
          const method = 'record.note';
          if (!args.text) {
            return argumentFailure({ ...base, method, message: 'op:"note" needs "text"', nextSteps: ['Notes explain non-obvious steps; they never enter the recipe.'] });
          }
          try {
            const result = await engine.call(method, { sessionId, text: String(args.text) }, { timeoutMs: TIMEOUT.STATUS_MS });
            return success({ ...base, method, summary: 'note appended to the trace', data: result });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'undo': {
          const method = 'record.undo';
          const count = Number.isInteger(args.count) && args.count > 0 ? args.count : 1;
          try {
            const result = await engine.call(method, { sessionId, count }, { timeoutMs: TIMEOUT.STATUS_MS });
            return success({
              ...base,
              method,
              summary: `dropped ${result?.removed ?? count} step(s) from the trace`,
              data: result,
              nextSteps: [`media_record {op:"status", sessionId:"${sessionId}"} to confirm the outline.`],
            });
          } catch (error) {
            return failure(error, ctxFor(method));
          }
        }

        case 'save': {
          const method = 'record.save';
          const params = {
            sessionId,
            overwrite: args.overwrite === true,
          };
          if (args.recipeId) params.recipeId = String(args.recipeId);
          if (args.media) params.media = String(args.media);
          if (args.label) params.label = String(args.label);
          if (args.params !== undefined) params.params = args.params;
          if (args.sessionCheck !== undefined) params.sessionCheck = args.sessionCheck;
          if (args.verify !== undefined) params.verify = args.verify;
          if (args.accountCodes !== undefined) params.accountCodes = args.accountCodes;
          try {
            const result = await engine.call(method, params, { timeoutMs: TIMEOUT.VALIDATE_MS });
            const recipePath = result?.recipePath ?? '';
            return success({
              ...base,
              method,
              summary: `recipe saved: ${recipePath || '(engine returned no path)'} (${result?.stepCount ?? '?'} steps)`,
              data: result,
              warnings: result?.warnings ?? [],
              nextSteps: [
                recipePath
                  ? `Read the compile report next to it (${recipePath.replace(/\.ya?ml$/i, '')}.compile-report.json) and check which literals became {{params}}.`
                  : 'Find the written recipe under <dataDir>/recipes/<media>/.',
                'media_recipe {op:"validate", recipeId:"..."} then media_publish {op:"run", dryRun:true} to rehearse.',
                result?.escape_hatches?.length
                  ? 'This recipe contains eval escape hatches; review them before unattended replay.'
                  : 'Then close the session: media_session {op:"close", sessionId, saveState:true}.',
              ],
            });
          } catch (error) {
            return failure(error, {
              ...ctxFor(method),
              nextSteps: args.overwrite === true
                ? []
                : ['If the recipe already exists, pass overwrite:true to replace it.'],
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
    presentCall: (args) => ({ card: 'generic', title: `media_record ${args?.op ?? ''}`.trim(), kind: 'other' }),
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
    case 'start':
      return [`  tracePath=${data.tracePath ?? '-'} recording=${data.recording === true}`];
    case 'status':
      return (data.steps ?? []).map((s) => `  ${String(s.index).padStart(3, ' ')}  ${s.type}  ${s.summary ?? ''}`);
    case 'undo':
      return [`  removed=${data.removed ?? '?'} remaining=${data.stepCount ?? '?'}`];
    case 'save':
      return [`  recipePath=${data.recipePath ?? '-'} stepCount=${data.stepCount ?? '?'}`,
        ...(data.compileReportPath ? [`  compileReport=${data.compileReportPath}`] : []),
        ...(data.params ?? []).map((p) => `  param ${p.name}${p.required ? ' (required)' : ''} type=${p.type ?? '?'}`)];
    default:
      return [];
  }
}
