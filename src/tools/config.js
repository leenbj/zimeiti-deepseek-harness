/**
 * config.js (tool) — `media_config`: the same five knobs the Settings → Plugins page edits, for the agent.
 *
 * One operation, two callers (`cordis-plugin-development/references/user-actions.md`): both the page's
 * HTTP route and this tool call the SAME store methods, so there is exactly one validation path and one
 * persistence path. The route exists because the page cannot reach a host service; this tool exists
 * because the agent should be able to read and change the same settings without a browser.
 *
 * @module media-publish/tools/config
 */
import { CONFIG_FIELDS } from '../config.js';
import { defineTool } from '../tool-kit.js';
import { argumentFailure, renderEnvelope, success } from './common.js';

const OPS = ['get', 'set', 'reset'];

/**
 * @param {any} ctx
 * @param {{ configStore: any, pluginVersion: string, pluginRoot: string, dataDir: any, python: any,
 *           engine: any, handoffs?: any }} deps
 */
export function register(ctx, deps) {
  const { configStore, pluginVersion } = deps;

  ctx.tools.register(defineTool({
    name: 'media_config',
    description:
      'Read or change media-publish\'s own settings — the four media-publish accounts\' behaviour knobs: '
      + 'pythonPath, dataDir, headless, requireExplicitPublish, requestTimeoutMs. Ops: "get" — every field '
      + 'with its effective value, its built-in default and where the value came from (default | env | patch '
      + '| config-file); "set" {values:{<field>:<value>}} — validate and persist the operator\'s explicit '
      + 'choice to <dataDir>/config.json, which wins over the bundle patch; "reset" {names:[...]} — drop that '
      + 'override so the layer beneath (the patch, then env, then the default) applies again. Values are '
      + 'validated strictly and a bad value is refused with a message naming the field. The same settings are '
      + 'editable in the GUI under Settings → Plugins; headless and requireExplicitPublish take effect on the '
      + 'next tool call, while pythonPath / dataDir / requestTimeoutMs restart the engine process.',
    parameters: {
      op: { type: 'string', enum: OPS, required: true, description: 'Which configuration operation to run.' },
      values: {
        type: 'object',
        additionalProperties: true,
        description: 'set only: the fields to write, e.g. {"headless": true, "requestTimeoutMs": 300000}.'
          + ' A path field set to null clears the override, exactly like reset.',
      },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'reset only: the field names whose explicit value should be dropped.',
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
          ? `media_config ${value.op} — ok (revision ${value.data?.revision ?? '?'})`
          : `media_config ${value.op ?? '?'} — failed (${value.error?.code ?? 'ERROR'})`,
        value,
        renderLines(value),
      ),
    },
    async execute(args) {
      const op = String(args.op);
      const base = { tool: 'media_config', op };
      const method = `local.config-${op}`;

      /** The shared payload: the five values, their provenance and the revision. */
      const snapshot = (changed = []) => ({
        revision: configStore.revision(),
        changed,
        values: { ...configStore.values() },
        fields: configStore.fields(),
        pluginVersion,
      });

      switch (op) {
        case 'get':
          return success({
            ...base,
            method,
            summary: `effective: ${formatValues(configStore.values())}`,
            data: snapshot([]),
            warnings: configStore.warnings(),
            nextSteps: [
              'Change one with media_config {op:"set", values:{...}}; drop an explicit choice with {op:"reset", names:[...]}.',
              'The same fields are editable in the GUI under Settings → Plugins.',
            ],
          });

        case 'set': {
          if (args.values === undefined) {
            return argumentFailure({
              ...base,
              method,
              message: 'set needs values, e.g. {"headless": true}',
              nextSteps: ['Read the accepted fields with media_config {op:"get"}.'],
            });
          }
          const result = configStore.set(args.values);
          if (!result.ok) {
            return argumentFailure({
              ...base,
              method,
              message: result.message,
              nextSteps: [
                `Read the field list and its types with media_config {op:"get"}.`,
                ...(result.field ? [`Fix "${result.field}" and retry; nothing was written.`] : []),
              ],
            });
          }
          const applied = describeApplication(result.changed);
          return success({
            ...base,
            method,
            summary: `updated ${result.changed.join(', ') || '(no value changed)'} — ${applied.summary}`,
            data: snapshot(result.changed),
            warnings: configStore.warnings(),
            nextSteps: [
              applied.live.length ? `Takes effect on the next call: ${applied.live.join(', ')}.` : '',
              applied.engine.length ? `Restarts the engine process: ${applied.engine.join(', ')}. The next engine call starts a new process; open sessions are gone.` : '',
              'media_status {probe:true} to confirm the effective configuration the engine actually uses.',
            ].filter(Boolean),
          });
        }

        case 'reset': {
          if (args.names === undefined) {
            return argumentFailure({
              ...base,
              method,
              message: 'reset needs names, e.g. ["headless"]',
              nextSteps: ['Read which fields are overridden with media_config {op:"get"} (overridden:true).'],
            });
          }
          const result = configStore.reset(args.names);
          if (!result.ok) {
            return argumentFailure({
              ...base,
              method,
              message: result.message,
              nextSteps: ['Read the field list with media_config {op:"get"}.'],
            });
          }
          const applied = describeApplication(result.changed);
          return success({
            ...base,
            method,
            summary: result.changed.length
              ? `dropped the explicit value of ${result.changed.join(', ')} — ${applied.summary}`
              : `nothing was overridden: ${args.names.join(', ')} already came from a lower layer`,
            data: snapshot(result.changed),
            warnings: configStore.warnings(),
            nextSteps: [
              `Effective now: ${formatValues(configStore.values())}.`,
              'The layer beneath (the bundle patch config, then env, then the built-in default) applies again.',
            ],
          });
        }

        default:
          return argumentFailure({
            ...base,
            message: `unknown op "${op}"`,
            nextSteps: [`Supported ops: ${OPS.join(', ')}.`],
          });
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `media_config ${args?.op ?? ''}`.trim(), kind: 'other' }),
  }));
}

/**
 * Split the changed field names by when they reach running work.
 * @param {string[]} changed
 */
function describeApplication(changed) {
  const specs = new Map(CONFIG_FIELDS.map((entry) => [entry.name, entry.applies]));
  const live = changed.filter((name) => specs.get(name) === 'live');
  const engine = changed.filter((name) => specs.get(name) === 'engine-restart');
  const summary = changed.length === 0
    ? 'nothing changed'
    : [live.length ? `${live.join(', ')} apply to the next call` : '', engine.length ? `${engine.join(', ')} restart the engine` : '']
      .filter(Boolean).join('; ');
  return { live, engine, summary };
}

/** One-line rendering of the effective values, for the summary line. */
function formatValues(values) {
  return CONFIG_FIELDS
    .map(({ name }) => `${name}=${values[name] === null || values[name] === undefined ? '(unset)' : JSON.stringify(values[name])}`)
    .join(' ');
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function renderLines(value) {
  if (!value?.ok || !value.data) return [];
  const fields = value.data.fields ?? [];
  const lines = fields.map((field) => {
    const shown = field.value === null || field.value === undefined ? '(unset)' : JSON.stringify(field.value);
    return `  ${field.name} = ${shown}  [${field.effectiveFrom}${field.overridden ? ', overridden' : ''}]`
      + `  default=${field.default === null ? '(unset)' : JSON.stringify(field.default)}  applies=${field.applies}`;
  });
  if (value.data.changed?.length) lines.push(`  changed: ${value.data.changed.join(', ')}`);
  for (const warning of value.warnings ?? []) lines.push(`  warning: ${warning}`);
  return lines;
}
