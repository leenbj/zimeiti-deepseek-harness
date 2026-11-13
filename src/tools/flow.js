/**
 * flow.js — `egolite_flow`: inspect and edit the publish flows.
 *
 * A flow is the replayable description of a publishing run (goto, fill, click, wait, submit). Built-ins
 * ship with the plugin; a saved user flow overrides a built-in with the same id, so a broken selector can
 * be fixed on disk without republishing the plugin.
 *
 * @module ego-publish/tools/flow
 */
import { EgoError } from '../cdp.js';
import { flowSummary, loadFlows, removeUserFlow, saveUserFlow, validateFlow } from '../flows.js';
import { defineTool } from '../tool-kit.js';
import { renderEnvelope, sanitize } from './common.js';

/**
 * @param {any} ctx
 * @param {{ dataDir: string, pluginRoot: string }} deps
 */
export function register(ctx, deps) {
  const { dataDir, pluginRoot } = deps;

  const pick = (args) => {
    const flows = loadFlows({ pluginRoot, dataDir });
    if (args.id) {
      const found = flows.find((flow) => flow.id === args.id);
      if (!found) throw new EgoError('FLOW_NOT_FOUND', `no flow with id "${args.id}"`, { known: flows.map((flow) => flow.id) });
      return found;
    }
    if (args.media) {
      const matches = flows.filter((flow) => flow.media === args.media);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new EgoError('AMBIGUOUS_FLOW', `several flows match media "${args.media}"; pass id`, { ids: matches.map((flow) => flow.id) });
      throw new EgoError('FLOW_NOT_FOUND', `no flow for media "${args.media}"`, { known: flows.map((flow) => flow.id) });
    }
    throw new EgoError('NO_FLOW_ID', 'pass id (or media)');
  };

  ctx.tools.register(defineTool({
    name: 'egolite_flow',
    description:
      'Inspect and edit publish flows. Ops: list — every flow (built-in and user) with its params and step count; show — '
      + 'the full step list of one flow by id or media; save — write a user flow from a spec object (a saved flow with '
      + 'the same id overrides the built-in); remove — delete a user flow. A flow step is {action, selector|text|ref, '
      + 'frame?, value?, url?, key?, expression?, timeoutMs?, optional?, submit?}; actions: goto, waitFor, click, fill, '
      + 'type, press, select, upload, eval, sleep, screenshot, expect, extract, scroll. Mark the submit step with '
      + 'submit:true so a dry run stops before it.',
    parameters: {
      op: { type: 'string', required: true, enum: ['list', 'show', 'save', 'remove'], description: 'Which flow operation to run.' },
      id: { type: 'string', description: 'Flow id, e.g. "sohu__publish-article".' },
      media: { type: 'string', enum: ['sohu', 'toutiao', 'csdn', 'custom'], description: 'Select a flow by platform instead of id.' },
      spec: { type: 'object', additionalProperties: true, description: 'For op:"save": the complete flow document.' },
      overwrite: { type: 'boolean', description: 'For op:"save": replace an existing user flow.' },
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
        case 'list': {
          const flows = loadFlows({ pluginRoot, dataDir }).map(flowSummary);
          return sanitize({ ok: true, message: `${flows.length} flow(s)`, data: { flows } });
        }
        case 'show': {
          const flow = pick(args);
          return sanitize({ ok: true, message: `${flow.id} (${flow.steps?.length ?? 0} steps)`, data: { summary: flowSummary(flow), flow } });
        }
        case 'save': {
          if (!args.spec) throw new EgoError('NO_SPEC', 'op:"save" needs spec');
          validateFlow(args.spec);
          const outcome = saveUserFlow({ dataDir, flow: args.spec, overwrite: args.overwrite === true });
          return sanitize({ ok: true, message: `saved flow ${outcome.id}`, data: outcome });
        }
        case 'remove': {
          if (!args.id) throw new EgoError('NO_FLOW_ID', 'op:"remove" needs id');
          const outcome = removeUserFlow({ dataDir, id: args.id });
          return sanitize({
            ok: true,
            message: outcome.removed ? `removed user flow ${args.id}` : `no user flow ${args.id} (a built-in cannot be removed; save an override instead)`,
            data: outcome,
          });
        }
        default:
          throw new EgoError('INVALID_OP', `unknown flow op "${args.op}"`);
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `egolite flow ${args.op}`, kind: 'other' }),
  }));
}
