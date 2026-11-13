/**
 * task.js — `egolite_task`: saved browser tasks.
 */
import { EgoError } from '../cdp.js';
import { runTask } from '../tasks.js';
import { defineTool } from '../tool-kit.js';
import { TIMEOUT, renderEnvelope, sanitize } from './common.js';

/**
 * @param {any} ctx
 * @param {{ tasks: any, manager: any, accounts: any, settings: any, log: (line: string) => void }} deps
 */
export function register(ctx, deps) {
  const { tasks } = deps;

  ctx.tools.register(defineTool({
    name: 'egolite_task',
    description:
      'Saved browser tasks shown in the "任务" tab. Ops: list — all tasks; save — create/update a task '
      + '(id?, title, description?, accountCode, url?, script); remove — delete one; run — open the task\'s '
      + 'account browser (static proxy, or a fresh dynamic IP) and execute its script in the page.',
    parameters: {
      op: { type: 'string', required: true, enum: ['list', 'save', 'remove', 'run'] },
      id: { type: 'string', description: 'Task id, for save/remove/run.' },
      title: { type: 'string', description: 'Task name.' },
      description: { type: 'string', description: 'What the task does.' },
      accountCode: { type: 'string', description: 'Account whose browser runs the task.' },
      proxyMode: { type: 'string', enum: ['account', 'dynamic', 'static'], description: 'Proxy for this task: follow the account, force a dynamic IP, or use a static proxyId.' },
      proxyId: { type: 'string', description: 'Static proxy id when proxyMode:"static".' },
      url: { type: 'string', description: 'Optional start URL.' },
      script: { type: 'string', description: 'JavaScript body evaluated in the page (async, can return a value).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean', required: true }, message: { type: 'string', required: true } },
      },
      render: (_args, value) => renderEnvelope(value.message, value),
    },
    timeoutMs: TIMEOUT.PUBLISH_MS,
    async execute(args) {
      switch (args.op) {
        case 'list':
          return sanitize({ ok: true, message: `${tasks.list().length} task(s)`, data: { tasks: tasks.list() } });
        case 'save': {
          const task = tasks.upsert({
            id: args.id, title: args.title, description: args.description,
            accountCode: args.accountCode, url: args.url, script: args.script,
            proxyMode: args.proxyMode, proxyId: args.proxyId,
          });
          return sanitize({ ok: true, message: `task ${task.id} saved`, data: { task } });
        }
        case 'remove': {
          const removed = tasks.remove(String(args.id ?? ''));
          if (!removed) throw new EgoError('TASK_NOT_FOUND', `no task with id "${args.id}"`);
          return sanitize({ ok: true, message: 'task removed', data: { removed: true } });
        }
        case 'run': {
          const outcome = await runTask(deps, String(args.id ?? ''));
          return sanitize({
            ok: true,
            message: `task ${outcome.task.id} ran${outcome.result !== null ? ' and returned a value' : ''}`,
            data: outcome,
          });
        }
        default:
          throw new EgoError('INVALID_OP', `unknown task op "${args.op}"`);
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `egolite task ${args.op}`, kind: 'other' }),
  }));
}
