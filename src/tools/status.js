/**
 * status.js — `media_status`: the agent's first stop.
 *
 * Self-check of both halves: the Python/Playwright interpreter, the runtime data root, the installed
 * account registry, the recipe catalogue and (with `probe:true`) a live `engine.status` round trip.
 *
 * @module media-publish/tools/status
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { defineTool } from '../tool-kit.js';
import {
  TIMEOUT, createHandoffLog, engineSummary, readRecipeCatalog, renderEnvelope,
} from './common.js';

/**
 * @param {any} ctx - registrant context carrying the tool registry.
 * @param {{ engine: any, settings: Record<string, any>, dataDir: string, python: Record<string, any>,
 *           pluginRoot: string, pluginVersion: string, handoffs?: any }} deps
 */
export function register(ctx, deps) {
  const { engine, settings, dataDir, python, pluginRoot, pluginVersion } = deps;
  const handoffs = deps.handoffs ?? createHandoffLog();
  const pluginRootDir = pluginRoot;

  ctx.tools.register(defineTool({
    name: 'media_status',
    description:
      'Report media-publish status and self-check both halves: the Python/Playwright interpreter in use, the '
      + 'runtime data root, the plugin/engine versions, the registered publishing accounts (and whether each has a '
      + 'saved login state), the recipe catalogue, any session waiting on a human, and the engine log tail when it '
      + 'fails to start. Call this first before any other media_* tool, and with probe:true whenever an engine call '
      + 'failed with ENGINE_SPAWN_FAILED / ENGINE_EXITED / ENGINE_TIMEOUT.',
    parameters: {
      probe: {
        type: 'boolean',
        description: 'Also start the Python browser engine and ask it to self-report (slower, about a second).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          pluginVersion: { type: 'string', required: true },
          pluginRoot: { type: 'string', required: true },
          dataDir: { type: 'string', required: true },
          config: { type: 'object', additionalProperties: true, required: true },
          python: {
            type: 'object',
            additionalProperties: true,
            required: true,
            properties: {
              path: { type: 'string', required: true },
              source: { type: 'string', required: true },
              exists: { type: 'boolean', required: true },
              probe: { type: 'string', required: true },
            },
          },
          engine: {
            type: 'object',
            additionalProperties: true,
            required: true,
            properties: {
              module: { type: 'string', required: true },
              entryPresent: { type: 'boolean', required: true },
              report: { type: 'object', additionalProperties: true },
              error: { type: 'string' },
            },
          },
          recipes: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          accounts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          sessions: { type: 'array', items: { type: 'string' } },
          handoffs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          nextSteps: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderEnvelope(
        value.engine.error
          ? `media-publish: engine not ready — ${value.engine.error}`
          : `media-publish ${value.pluginVersion} — data root ${value.dataDir} — python ${value.python.source}`,
        value,
        [
          `python: ${value.python.path} (exists=${value.python.exists}) — ${String(value.python.probe).slice(0, 200)}`,
          `engine/sessiond.py: ${value.engine.entryPresent ? 'present' : 'MISSING'}`
            + (value.engine.report ? ` — engine ${value.engine.report.version ?? '?'} ready` : ''),
          `recipes: ${value.recipes.length} — ${value.recipes.map((r) => `${r.id}(${r.stepCount} steps)`).join(', ') || 'none'}`,
        ],
      ),
    },
    async execute(args) {
      /** @type {Record<string, any>} */
      const result = {
        pluginVersion,
        pluginRoot: pluginRootDir,
        dataDir,
        config: settings,
        python: { path: python.path, source: python.source, exists: python.exists, probe: python.probe },
        engine: {
          module: 'engine.sessiond',
          entryPresent: existsSync(join(pluginRootDir, 'engine', 'sessiond.py')),
        },
        recipes: readRecipeCatalog({ dataDir, pluginRoot: pluginRootDir }),
        accounts: [],
        sessions: [],
        handoffs: handoffs.list(),
        nextSteps: [],
      };

      if (!result.python.exists) {
        result.nextSteps.push(
          'No usable Python+Playwright interpreter: set config.pythonPath (or MEDIA_PYTHON) to one that can '
          + '`import playwright`.',
        );
      }
      if (!result.engine.entryPresent) {
        result.engine.error = 'engine/sessiond.py is missing from the package';
        result.nextSteps.push('Reinstall the plugin: the engine half of the package was not found.');
      } else if (args?.probe) {
        try {
          const report = await engine.call('engine.status', {}, { timeoutMs: TIMEOUT.STATUS_MS });
          result.engine.report = engineSummary(report);
          result.sessions = report?.sessionIds ?? [];
          const accounts = await engine.call('account.list', {}, { timeoutMs: TIMEOUT.STATUS_MS });
          result.accounts = accounts?.accounts ?? [];
          const signedIn = result.accounts.filter((a) => a.hasState).map((a) => a.code);
          const unbound = result.accounts.filter((a) => !a.proxy?.bound).map((a) => a.code);
          if (!result.accounts.length) {
            result.nextSteps.push('No accounts yet: media_account {op:"upsert", code:"a-1", media:"sohu", account:"<login name>"}.');
          } else if (!signedIn.length) {
            result.nextSteps.push('No account has a saved login state: media_account {op:"login", code:"<code>"} (a browser window opens for the human; it waits up to 10 minutes).');
          } else {
            result.nextSteps.push(`Signed in: ${signedIn.join(', ')}. Continue with media_session {op:"open", accountCode:"<code>"}.`);
          }
          if (unbound.length) {
            result.nextSteps.push(`Accounts with no bound proxy (they will go direct — do not ignore this in multi-account use): ${unbound.join(', ')}.`);
          }
          if (report?.recipes !== undefined && report.recipes !== result.recipes.length) {
            result.nextSteps.push(`Engine sees ${report.recipes} recipes, this half lists ${result.recipes.length}: a recipe file may be unreadable.`);
          }
        } catch (error) {
          result.engine.error = `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`;
          result.nextSteps.push('Fix the reported engine error, then call media_status again with probe:true.');
        }
      } else {
        result.nextSteps.push('Call media_status with probe:true to start the engine and verify Playwright end to end.');
      }
      if (result.handoffs.length) {
        for (const handoff of result.handoffs) {
          result.nextSteps.push(`Session ${handoff.sessionId} is waiting on a human (reason "${handoff.reason ?? 'unknown'}"): complete it in the browser window, then media_session {op:"resume", sessionId:"${handoff.sessionId}"}.`);
        }
      }
      return result;
    },
    presentCall: () => ({ card: 'generic', title: 'media-publish status', kind: 'other' }),
  }));
}
