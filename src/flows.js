/**
 * flows.js — declarative publish flows: validation, discovery, templating and execution.
 *
 * A flow is the replayable equivalent of the media-publish plugin's "recipe": an ordered list of page
 * steps with `{{param}}` placeholders. Built-in flows ship in `<package>/flows`; a user flow with the
 * same id under `<dataDir>/flows` wins, so a flow can be fixed on disk without republishing the plugin.
 *
 * @module ego-publish/flows
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { EgoError, sleep } from './cdp.js';
import { ensureDir, now, writeJson } from './store.js';

/** Step actions understood by the runner. */
export const ACTIONS = new Set([
  'goto', 'waitFor', 'click', 'fill', 'type', 'press', 'select', 'upload', 'eval',
  'sleep', 'screenshot', 'expect', 'extract', 'scroll',
]);

/** Fields copied through template rendering. */
const TEMPLATE_FIELDS = ['url', 'value', 'text', 'key', 'expression', 'name', 'selector', 'frame', 'files'];

/**
 * Replace `{{name}}` placeholders in every string of a step.
 * @param {unknown} value
 * @param {Record<string, any>} params
 * @returns {unknown}
 */
export function renderTemplates(value, params) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
      const found = params?.[key];
      return found === undefined || found === null ? match : String(found);
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplates(item, params));
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = renderTemplates(item, params);
    return out;
  }
  return value;
}

/**
 * Validate a flow document. Throws EgoError('INVALID_FLOW') with a readable first problem.
 * @param {Record<string, any>} flow
 * @returns {Record<string, any>} the same flow, normalized
 */
export function validateFlow(flow) {
  if (!flow || typeof flow !== 'object') throw new EgoError('INVALID_FLOW', 'a flow must be an object');
  const id = String(flow.id ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id)) {
    throw new EgoError('INVALID_FLOW', 'flow.id must be 1-64 characters of letters, digits, "_", "." or "-"');
  }
  const steps = flow.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new EgoError('INVALID_FLOW', 'flow.steps must be a non-empty array');
  if (steps.length > 200) throw new EgoError('INVALID_FLOW', 'flow.steps is limited to 200 steps');
  steps.forEach((step, index) => {
    const action = String(step?.action ?? '');
    if (!ACTIONS.has(action)) {
      throw new EgoError('INVALID_FLOW', `step ${index + 1}: unknown action "${action}" (known: ${[...ACTIONS].join(', ')})`);
    }
    if (action === 'goto' && !step.url) throw new EgoError('INVALID_FLOW', `step ${index + 1}: goto needs a url`);
    if (['click', 'fill', 'type', 'select', 'upload', 'scroll'].includes(action)
      && !step.selector && !step.text && !step.ref) {
      throw new EgoError('INVALID_FLOW', `step ${index + 1}: ${action} needs a selector, text or ref target`);
    }
    if (['fill', 'type'].includes(action) && step.value === undefined && step.text === undefined) {
      throw new EgoError('INVALID_FLOW', `step ${index + 1}: ${action} needs value or text`);
    }
    if (action === 'eval' && !step.expression) throw new EgoError('INVALID_FLOW', `step ${index + 1}: eval needs an expression`);
    if (action === 'waitFor' && !step.selector && !step.text && !step.urlContains && !step.expression) {
      throw new EgoError('INVALID_FLOW', `step ${index + 1}: waitFor needs selector, text, urlContains or expression`);
    }
    if (action === 'sleep' && !Number.isFinite(Number(step.ms))) {
      throw new EgoError('INVALID_FLOW', `step ${index + 1}: sleep needs a numeric ms`);
    }
    if (action === 'upload' && !step.files) throw new EgoError('INVALID_FLOW', `step ${index + 1}: upload needs files`);
  });
  const params = Array.isArray(flow.params) ? flow.params : [];
  for (const param of params) {
    if (!param || typeof param.name !== 'string' || !param.name) {
      throw new EgoError('INVALID_FLOW', 'every flow param needs a name');
    }
  }
  return { ...flow, id, params };
}

/**
 * Read one flow file.
 * @param {string} filePath
 * @param {'builtin'|'user'} source
 */
function readFlowFile(filePath, source) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return { ...parsed, source, path: filePath };
  } catch (error) {
    return { id: basename(filePath, '.json'), source, path: filePath, error: String(error?.message ?? error) };
  }
}

/**
 * Discover flows: built-ins first, user flows override by id.
 * @param {{ pluginRoot: string, dataDir: string }} input
 * @returns {Array<Record<string, any>>}
 */
export function loadFlows(input) {
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  for (const [dir, source] of [[join(input.pluginRoot, 'flows'), 'builtin'], [join(input.dataDir, 'flows'), 'user']]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const flow = readFlowFile(join(dir, entry), source);
      if (flow?.id) byId.set(flow.id, flow);
    }
  }
  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Public summary of one flow. */
export function flowSummary(flow) {
  return {
    id: flow.id,
    media: flow.media ?? null,
    label: flow.label ?? flow.id,
    source: flow.source ?? null,
    params: (flow.params ?? []).map((param) => ({
      name: param.name,
      required: param.required === true,
      default: param.default ?? null,
      description: param.description ?? null,
    })),
    stepCount: Array.isArray(flow.steps) ? flow.steps.length : 0,
    path: flow.path ?? null,
    ...(flow.error ? { error: flow.error } : {}),
  };
}

/**
 * Persist a user flow.
 * @param {{ dataDir: string, flow: Record<string, any>, overwrite?: boolean }} input
 */
export function saveUserFlow(input) {
  const flow = validateFlow(input.flow);
  const dir = ensureDir(join(input.dataDir, 'flows'));
  const filePath = join(dir, `${flow.id}.json`);
  if (existsSync(filePath) && !input.overwrite) {
    throw new EgoError('FLOW_EXISTS', `a user flow with id "${flow.id}" already exists; pass overwrite:true to replace it`, { path: filePath });
  }
  const stored = { ...flow, updatedAt: now() };
  delete stored.source;
  delete stored.path;
  writeJson(filePath, stored);
  return { id: flow.id, path: filePath };
}

/**
 * Delete a user flow (built-ins cannot be deleted).
 * @param {{ dataDir: string, id: string }} input
 */
export function removeUserFlow(input) {
  const filePath = join(input.dataDir, 'flows', `${input.id}.json`);
  if (!existsSync(filePath)) return { removed: false, path: filePath };
  rmSync(filePath, { force: true });
  return { removed: true, path: filePath };
}

/**
 * Validate that the supplied params satisfy the flow's declarations.
 * @param {Record<string, any>} flow
 * @param {Record<string, any>} params
 */
export function resolveParams(flow, params) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const declared of flow.params ?? []) {
    const value = params?.[declared.name];
    if (value === undefined || value === null || value === '') {
      if (declared.required) {
        throw new EgoError('MISSING_PARAM', `flow "${flow.id}" requires the parameter "${declared.name}"`);
      }
      if (declared.default !== undefined) out[declared.name] = declared.default;
      continue;
    }
    out[declared.name] = value;
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/**
 * Turn a step into a target descriptor for the page facade.
 * @param {Record<string, any>} step
 */
export function stepTarget(step) {
  return {
    selector: step.selector,
    text: step.text,
    exact: step.exact === true,
    frame: step.frame,
    ref: step.ref,
  };
}

/**
 * Execute a flow against one live page.
 *
 * `dryRun` skips the step marked `submit:true` (and everything after it), captures a screenshot at
 * that point and reports `submitSkipped:true` — the same contract as the media-publish plugin.
 *
 * @param {{
 *   page: import('./cdp.js').TargetSession,
 *   flow: Record<string, any>,
 *   params: Record<string, any>,
 *   dryRun: boolean,
 *   runDir: string,
 *   screenshotEveryStep?: boolean,
 *   log?: (line: string) => void,
 * }} input
 */
export async function runFlow(input) {
  const { page, flow, dryRun } = input;
  const params = resolveParams(flow, input.params ?? {});
  const runDir = ensureDir(input.runDir);
  const log = input.log ?? (() => {});
  /** @type {Array<Record<string, any>>} */
  const steps = [];
  /** @type {Record<string, any>} */
  const outputs = {};
  let submitSkipped = false;
  let screenshotCount = 0;

  /** @param {string} name */
  const shot = async (name) => {
    const filePath = join(runDir, `${String(++screenshotCount).padStart(2, '0')}-${name.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.png`);
    await page.screenshot(filePath).catch(() => null);
    return filePath;
  };

  for (let index = 0; index < flow.steps.length; index += 1) {
    const raw = flow.steps[index];
    const step = renderTemplates(raw, params);
    const started = Date.now();
    const label = `${index + 1}/${flow.steps.length} ${step.action}`;
    if (step.submit === true && dryRun) {
      const evidence = await shot('dry-run-before-submit');
      steps.push({ index: index + 1, action: step.action, ok: true, skipped: true, ms: 0, screenshot: evidence });
      submitSkipped = true;
      log(`${label}: skipped (dry run)`);
      break;
    }
    if (step.submit === true && !dryRun) {
      // A person reads what they pasted before pressing publish. Pausing for a jittered stretch turns
      // an instant fill-then-submit burst into something with a plausible human cadence.
      const min = Math.max(0, Number(input.settings?.preSubmitDwellMinSec ?? 20));
      const max = Math.max(min, Number(input.settings?.preSubmitDwellMaxSec ?? 60));
      const waitMs = Math.round((min + Math.random() * (max - min)) * 1000);
      if (waitMs > 0) {
        log(`human dwell ${Math.round(waitMs / 1000)}s before submit`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    try {
      const detail = await executeStep(page, step, { runDir, outputs, shot });
      const elapsed = Date.now() - started;
      const record = { index: index + 1, action: step.action, ok: true, ms: elapsed, ...(detail ? { detail } : {}) };
      if (input.screenshotEveryStep || step.screenshot === true || step.submit === true) {
        record.screenshot = await shot(`step-${index + 1}-${step.action}`);
      }
      steps.push(record);
      log(`${label}: ok (${elapsed}ms)`);
    } catch (error) {
      const elapsed = Date.now() - started;
      const screenshot = await shot(`error-step-${index + 1}`).catch(() => null);
      const message = String(error?.message ?? error);
      steps.push({
        index: index + 1,
        action: step.action,
        ok: false,
        ms: elapsed,
        error: message,
        ...(error?.code ? { code: error.code } : {}),
        ...(screenshot ? { screenshot } : {}),
      });
      const failure = new EgoError('STEP_FAILED', `step ${index + 1} (${step.action}) failed: ${message}`, {
        stepIndex: index + 1,
        action: step.action,
        runDir,
        screenshot,
        steps,
      });
      failure.cause = error;
      throw failure;
    }
  }

  return {
    ok: true,
    flowId: flow.id,
    params,
    dryRun,
    submitSkipped,
    steps,
    outputs,
    finalUrl: await page.url().catch(() => null),
    runDir,
  };
}

/**
 * Execute one already-rendered step.
 * @param {import('./cdp.js').TargetSession} page
 * @param {Record<string, any>} step
 * @param {{ runDir: string, outputs: Record<string, any>, shot: (name: string) => Promise<string|null> }} context
 */
async function executeStep(page, step, context) {
  const timeoutMs = Number(step.timeoutMs ?? page.actionTimeoutMs);
  const optional = step.optional === true;
  const target = stepTarget(step);
  if (target.ref) {
    const ref = page.ref(target.ref);
    if (!ref) throw new EgoError('UNKNOWN_REF', `no observed element with ref "${target.ref}"; call egolite_observe again`);
    target.selector = ref.selector;
  }
  const guard = async (run) => {
    try {
      return await run();
    } catch (error) {
      if (optional) return { optionalFailure: String(error?.message ?? error) };
      throw error;
    }
  };

  switch (step.action) {
    case 'goto':
      return guard(async () => page.goto(step.url, {
        timeoutMs: timeoutMs || page.navigationTimeoutMs,
        waitUntil: step.waitUntil ?? 'load',
        settleMs: step.settleMs,
      }));
    case 'waitFor':
      return guard(async () => page.waitFor({
        selector: step.selector,
        text: step.text,
        urlContains: step.urlContains,
        expression: step.expression,
      }, { timeoutMs }));
    case 'click':
      return guard(async () => page.click(target, { timeoutMs, button: step.button, clickCount: step.clickCount }));
    case 'fill':
      return guard(async () => page.fill(target, String(step.value ?? step.text ?? ''), {
        timeoutMs,
        mode: step.humanize ?? step.mode,
        minDelayMs: step.minDelayMs,
        maxDelayMs: step.maxDelayMs,
      }));
    case 'type':
      return guard(async () => {
        if (step.selector || step.text) await page.focus(target);
        return page.typeText(String(step.text ?? step.value ?? ''), { delayMs: step.delayMs });
      });
    case 'press':
      return guard(async () => {
        const times = Math.max(1, Math.min(50, Number(step.times ?? 1)));
        for (let index = 0; index < times; index += 1) await page.press(String(step.key ?? 'Enter'));
        return { pressed: step.key ?? 'Enter', times };
      });
    case 'select':
      return guard(async () => page.selectOption(target, step.value ?? step.label ?? ''));
    case 'upload':
      return guard(async () => {
        const files = Array.isArray(step.files) ? step.files : [step.files];
        return page.upload(target, files);
      });
    case 'scroll':
      return guard(async () => page.scroll({ deltaY: Number(step.deltaY ?? 600), deltaX: Number(step.deltaX ?? 0) }));
    case 'eval':
      return guard(async () => {
        const value = await page.evaluate(String(step.expression), step.argument);
        if (value && typeof value === 'object' && value.__egoError) throw new EgoError('EVAL_FAILED', String(value.__egoError));
        return { value: value ?? null };
      });
    case 'sleep':
      await sleep(Math.max(0, Math.min(120000, Number(step.ms ?? 1000))));
      return { sleptMs: Number(step.ms ?? 1000) };
    case 'screenshot': {
      const filePath = await context.shot(String(step.name ?? 'step'));
      return { screenshot: filePath };
    }
    case 'expect':
      return guard(async () => page.waitFor({
        text: step.text,
        expression: step.expression,
        selector: step.selector,
      }, { timeoutMs }));
    case 'extract': {
      const name = String(step.name ?? `value${Object.keys(context.outputs).length + 1}`);
      let value;
      if (step.url) value = await page.url();
      else if (step.expression) value = await page.evaluate(String(step.expression));
      else if (step.selector) value = await page.evaluate(`(() => { const el = __ego.query(${JSON.stringify(step.selector)}); return el ? (el.innerText || el.textContent || '') : null; })()`);
      else value = await page.text(2000);
      context.outputs[name] = value ?? null;
      return { extracted: name, value: value ?? null };
    }
    default:
      throw new EgoError('UNKNOWN_ACTION', `unknown action "${step.action}"`);
  }
}
