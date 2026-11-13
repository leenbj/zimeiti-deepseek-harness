/**
 * config.js — `egolite_config`: read and change the plugin's own settings.
 *
 * Settings are layering-safe: a write goes to `<dataDir>/config.json` and wins over the bundle patch.
 * `dataDir` is the exception — it decides where that file lives, so it is a composition change and is
 * rejected here with an explanation.
 *
 * @module ego-publish/tools/config
 */
import { EgoError } from '../cdp.js';
import { defineTool } from '../tool-kit.js';
import { renderEnvelope, sanitize } from './common.js';

/**
 * @param {any} ctx
 * @param {{ configStore: any, settings: Record<string, any>, ego: any }} deps
 */
export function register(ctx, deps) {
  const { configStore, settings } = deps;

  ctx.tools.register(defineTool({
    name: 'egolite_config',
    description:
      'Read or change ego-publish settings. Ops: get — every effective value with where it came from; set — persist one '
      + 'or more overrides to <dataDir>/config.json (wins over the bundle patch); reset — drop overrides so the built-in '
      + 'defaults apply. Keys: egoPath, requireExplicitPublish, idleCloseMinutes, loginTimeoutSec, actionTimeoutMs, '
      + 'navigationTimeoutMs, headless. dataDir is fixed by the bundle patch and cannot be changed here.',
    parameters: {
      op: { type: 'string', required: true, enum: ['get', 'set', 'reset'], description: 'Which configuration operation to run.' },
      values: {
        type: 'object',
        additionalProperties: true,
        description: 'For op:"set": the keys to persist, e.g. {"idleCloseMinutes": 15, "egoPath": "C:/.../ego.exe"}.',
      },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'For op:"reset": the keys to reset (default all).',
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
    async execute(args) {
      switch (args.op) {
        case 'get':
          return sanitize({
            ok: true,
            message: 'effective configuration',
            data: { values: settings, sources: configStore.sources(), file: configStore.filePath },
          });
        case 'set': {
          const values = args.values ?? {};
          if (!Object.keys(values).length) throw new EgoError('NO_VALUES', 'op:"set" needs at least one value');
          if ('dataDir' in values) {
            throw new EgoError('DATADIR_FIXED', 'dataDir decides where config.json itself lives, so change it in the bundle patch (or EGO_PUBLISH_DATA_DIR) and restart', {
              hint: 'cordis.patch.yml: config.dataDir',
            });
          }
          const outcome = configStore.set(values);
          if (!outcome.ok) throw new EgoError('INVALID_CONFIG', outcome.message ?? 'invalid configuration value');
          return sanitize({
            ok: true,
            message: outcome.changed.length ? `updated ${outcome.changed.join(', ')}` : 'no values changed',
            data: { changed: outcome.changed, values: outcome.values },
          });
        }
        case 'reset': {
          const values = configStore.reset(args.names);
          return sanitize({ ok: true, message: 'reset to defaults', data: { values } });
        }
        default:
          throw new EgoError('INVALID_OP', `unknown config op "${args.op}"`);
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `egolite config ${args.op}`, kind: 'other' }),
  }));
}
