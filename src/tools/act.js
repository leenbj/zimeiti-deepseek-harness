/**
 * act.js — `media_act`: one browser action per call, appended to the session trace.
 *
 * `action` is a discriminated object whose `type` selects the engine method (`act.<type>`), exactly like a
 * recipe step (SPEC §3: "step 的 type 与 RPC 方法名一一对应"). Everything an action needs is in the action
 * itself, so the model can copy a successful call straight into a recipe.
 *
 * @module media-publish/tools/act
 */
import { defineTool } from '../tool-kit.js';
import {
  TIMEOUT, argumentFailure, failure, renderEnvelope, success,
} from './common.js';

/** The SPEC §7 action surface, each one an `act.*` engine method. */
const ACTION_TYPES = [
  'goto', 'click', 'dispatch', 'type', 'press', 'upload', 'select', 'check',
  'scroll', 'waitFor', 'frame', 'eval', 'extract',
];

const DESCRIPTION =
  'Perform ONE browser action inside a live session and append it to that session\'s trace, so '
  + 'media_record {op:"save"} can compile the whole run into a recipe. `action.type` selects the engine call '
  + '(act.<type>) and is one of:\n'
  + '  goto     {url, waitUntil?="domcontentloaded", timeoutMs?}\n'
  + '  click    {target, timeoutMs?, force?, button?}\n'
  + '  dispatch {target, event="click"|"input"|"change", detail?} — fires the native event stream; required for '
  + 'Sohu\'s declaration radios and many el-*/mt-* widgets where a plain click is ignored\n'
  + '  type     {target, text, mode?="fill"|"type"|"insertText", clear?=true, delayMs?} — mode:"type" types '
  + 'character by character and is REQUIRED for CSDN\'s CKEditor4, which discards fill()\n'
  + '  press    {target?, key, times?=1}\n'
  + '  upload   {target, paths:[...]} — absolute file paths\n'
  + '  select   {target, value?|label?|index?}\n'
  + '  check    {target, checked?=true}\n'
  + '  scroll   {deltaY?, target?}\n'
  + '  waitFor  {for:{selector?|text?|urlContains?|loadState?|timeoutMs?}, timeoutMs?=30000, optional?}\n'
  + '  frame    {frame:"main"|{urlContains?|name?|selector?|index?}} — switch the active frame for every later '
  + 'action until switched back (most editors live in an iframe)\n'
  + '  eval     {expression, arg?, purpose?} — escape hatch; marks the recipe as containing escape_hatches\n'
  + '  extract  {spec:[{name, from:{selector?|attr?|text?|value?|url?|eval?}, all?}]} — capture values such as '
  + 'publishedUrl into the recording\n'
  + '`action.target` has three equivalent forms, resolved in the order ref > selector > text/role:\n'
  + '  {ref:"e12"} — a ref from the MOST RECENT media_observe snapshot; that is the intended way to drive by eye\n'
  + '  {selector:"#btn-publish"} — a CSS selector (the form that survives in a recipe)\n'
  + '  {text:"发布", role:"button", nth:0, exact:false, within:{ref:"e5"}} — visible text plus ARIA role\n'
  + 'A ref is only guaranteed valid until the next snapshot: re-run media_observe after any navigation, dialog or '
  + 're-render, and prefer selector / text+role for steps that must keep working on replay.';

/**
 * @param {any} ctx
 * @param {{ engine: any, settings: Record<string, any>, dataDir: string, python: Record<string, any>,
 *           pluginRoot: string, handoffs?: any }} deps
 */
export function register(ctx, deps) {
  const { engine, handoffs } = deps;

  ctx.tools.register(defineTool({
    name: 'media_act',
    description: DESCRIPTION,
    parameters: {
      sessionId: { type: 'string', required: true, description: 'A live session from media_session {op:"open"}.' },
      action: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: 'The action to run: {type, ...fields}, see the tool description for every type and target form.',
        properties: {
          type: { type: 'string', enum: ACTION_TYPES, required: true, description: 'Which action to run.' },
          target: {
            type: 'object',
            additionalProperties: false,
            description: 'Element target: {ref} from the last snapshot, {selector}, or {text, role, nth, exact, within}.',
            properties: {
              ref: { type: 'string', description: 'Ref from the most recent media_observe snapshot, e.g. "e12".' },
              selector: { type: 'string', description: 'CSS selector.' },
              text: { type: 'string', description: 'Visible text to match.' },
              role: { type: 'string', description: 'ARIA role to match together with text, e.g. "button", "link", "textbox".' },
              nth: { type: 'integer', description: 'Pick the nth match when several are equal (default 0).' },
              exact: { type: 'boolean', description: 'Require an exact text match instead of a substring match.' },
              within: {
                type: 'object',
                additionalProperties: false,
                description: 'Narrow the search to the subtree of another element.',
                properties: {
                  ref: { type: 'string', description: 'Container ref from the last snapshot.' },
                  selector: { type: 'string', description: 'Container CSS selector.' },
                },
              },
            },
          },
          selector: { type: 'string', description: 'waitFor/frame helpers — a CSS selector used directly by the action (element actions use action.target.selector instead).' },
          url: { type: 'string', description: 'goto — absolute URL to open.' },
          waitUntil: { type: 'string', enum: ['commit', 'domcontentloaded', 'load', 'networkidle'], description: 'goto — navigation milestone (default domcontentloaded).' },
          text: { type: 'string', description: 'type — the text to enter (literal; templating is a recipe feature).' },
          mode: { type: 'string', enum: ['fill', 'type', 'insertText'], description: 'type — fill (default), type (per keystroke, CKEditor4), insertText.' },
          clear: { type: 'boolean', description: 'type — clear the field first (default true).' },
          delayMs: { type: 'integer', description: 'type — delay between keystrokes for mode:"type".' },
          key: { type: 'string', description: 'press — key name, e.g. "Enter", "Control+A".' },
          times: { type: 'integer', description: 'press — how many times to press.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'upload — absolute file paths.' },
          value: { type: 'string', description: 'select — option value.' },
          label: { type: 'string', description: 'select — option label.' },
          index: { type: 'integer', description: 'select — option index; frame — nth frame when using {index}.' },
          checked: { type: 'boolean', description: 'check — desired state (default true).' },
          deltaY: { type: 'integer', description: 'scroll — pixels to scroll down (negative scrolls up).' },
          event: { type: 'string', enum: ['click', 'input', 'change'], description: 'dispatch — which native event stream to fire.' },
          detail: { type: 'object', additionalProperties: true, description: 'dispatch — extra event detail.' },
          for: {
            type: 'object',
            additionalProperties: false,
            description: 'waitFor — the condition to wait for.',
            properties: {
              selector: { type: 'string', description: 'Wait until this selector matches.' },
              text: { type: 'string', description: 'Wait until this text appears.' },
              urlContains: { type: 'string', description: 'Wait until the URL contains this substring.' },
              loadState: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Wait for this document readyState.' },
              timeoutMs: { type: 'integer', description: 'Ceiling for this condition.' },
            },
          },
          frame: {
            oneOf: [
              { type: 'string', description: '"main" (or a frame name) to return to the top document.' },
              { type: 'object', additionalProperties: true, description: '{urlContains|name|selector|index} to pick a frame.' },
            ],
            description: 'frame — which frame later actions run in.',
          },
          timeoutMs: { type: 'integer', description: 'Per-action timeout for click/type/waitFor/goto.' },
          optional: { type: 'boolean', description: 'waitFor — do not fail the recording when the condition is not met.' },
          force: { type: 'boolean', description: 'click — skip actionability checks.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click — mouse button.' },
          expression: { type: 'string', description: 'eval — JavaScript expression to evaluate in the page.' },
          arg: { type: 'object', additionalProperties: true, description: 'eval — argument passed to the expression.' },
          purpose: { type: 'string', description: 'eval — why the escape hatch is needed (recorded in the recipe).' },
          spec: {
            type: 'array',
            description: 'extract — what to capture.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string', required: true, description: 'Result key, e.g. "publishedUrl".' },
                from: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  description: 'Where the value comes from.',
                  properties: {
                    selector: { type: 'string', description: 'Element to read (optional when using url/eval).' },
                    attr: { type: 'string', description: 'Attribute to read from that element.' },
                    text: { type: 'boolean', description: 'Read the element text.' },
                    value: { type: 'boolean', description: 'Read the input value.' },
                    url: { type: 'boolean', description: 'Read the current page URL.' },
                    eval: { type: 'string', description: 'Evaluate this expression instead.' },
                  },
                },
                all: { type: 'boolean', description: 'Collect every match instead of the first.' },
              },
            },
          },
          submit: { type: 'boolean', description: 'Mark this step as the final submit; dry runs skip it.' },
          note: { type: 'string', description: 'Comment stored with the step in the trace.' },
        },
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
          ? `media_act ${value.op} — ok in ${value.data?.ms ?? '?'} ms`
          : `media_act ${value.op ?? '?'} — failed (${value.error?.code ?? 'ERROR'})`,
        value,
        renderLines(value),
      ),
    },
    async execute(args) {
      const sessionId = String(args.sessionId ?? '').trim();
      const action = args.action && typeof args.action === 'object' ? args.action : {};
      const type = String(action.type ?? '').trim();
      const method = `act.${type}`;
      const base = { tool: 'media_act', op: type || null, method, sessionId, accountCode: null, handoffs };

      if (!sessionId) {
        return argumentFailure({ ...base, message: 'media_act needs "sessionId"', nextSteps: ['media_session {op:"list"}.'] });
      }
      if (!action.type || !ACTION_TYPES.includes(type)) {
        return argumentFailure({
          ...base,
          message: `action.type must be one of ${ACTION_TYPES.join(', ')}`,
          nextSteps: [`Call media_observe first, then media_act {sessionId:"${sessionId}", action:{type:"click", target:{ref:"eN"}}}.`],
        });
      }
      // A couple of shapes the engine would reject with a less helpful message.
      if (type === 'goto' && !action.url) {
        return argumentFailure({ ...base, message: 'action.type:"goto" needs action.url', nextSteps: ['Example: action:{type:"goto", url:"https://mp.sohu.com/..."}'] });
      }
      if (['click', 'dispatch', 'type', 'upload', 'select', 'check'].includes(type) && !action.target) {
        return argumentFailure({
          ...base,
          message: `action.type:"${type}" needs action.target`,
          nextSteps: [`Re-run media_observe and target by ref: action:{type:"${type}", target:{ref:"eN"}}.`],
        });
      }
      if (type === 'type' && typeof action.text !== 'string') {
        return argumentFailure({ ...base, message: 'action.type:"type" needs action.text (a string)', nextSteps: ['Example: action:{type:"type", target:{ref:"e12"}, text:"标题"}'] });
      }

      try {
        const result = await engine.call(method, { ...action, sessionId }, { timeoutMs: TIMEOUT.ACT_MS });
        const step = result?.step ?? null;
        const extracted = type === 'extract' && result?.data ? ` extracted=${JSON.stringify(result.data)}` : '';
        return success({
          ...base,
          summary: `${type} ok in ${result?.ms ?? '?'} ms`
            + `${step?.target ? ` → ${JSON.stringify(step.target)}` : ''}`
            + extracted,
          data: result,
          nextSteps: type === 'extract'
            ? ['Captured values are part of the recording: media_record {op:"save"} keeps them as step output names.',
              `media_observe {sessionId:"${sessionId}"} to see where the page stands.`]
            : [
              'If the page changed (navigation, dialog, new panel), call media_observe again before reusing a ref.',
              result?.step?.submit === true
                ? 'This step is the publish submit: media_publish {op:"run"} skips it while dryRun is true.'
                : 'Keep going, then media_record {op:"save"} to compile the recipe.',
            ],
        });
      } catch (error) {
        return failure(error, {
          ...base,
          nextSteps: error?.code === 'TARGET_NOT_FOUND'
            ? [
              `Nothing matched ${JSON.stringify(action.target ?? action.selector ?? {})}. Use a candidate from the list above, or re-run media_observe.`,
              'Never re-use a ref from an older snapshot: the engine falls back to the recorded selector/text, which may no longer be unique.',
            ]
            : [],
        });
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `media_act ${args?.action?.type ?? ''}`.trim(), kind: 'other' }),
  }));
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function renderLines(value) {
  if (!value?.ok || !value.data) return [];
  const data = value.data;
  /** @type {string[]} */
  const lines = [];
  if (data.step) lines.push(`recorded step: ${JSON.stringify(data.step)}`);
  if (data.data && typeof data.data === 'object' && Object.keys(data.data).length) {
    lines.push(`data: ${JSON.stringify(data.data)}`);
  }
  if (data.ms !== undefined) lines.push(`ms: ${data.ms}`);
  return lines;
}
