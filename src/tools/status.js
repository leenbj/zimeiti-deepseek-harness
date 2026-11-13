/**
 * status.js — `egolite_status`: the agent's first stop.
 *
 * Reports the ego lite executable in use, the data root, the configuration, the account registry
 * (including which accounts have a browser profile and a proxy), the open browser sessions, the flows
 * and the actionable next step — without starting a browser.
 *
 * @module ego-publish/tools/status
 */
import { existsSync } from 'node:fs';

import { defineTool } from '../tool-kit.js';
import { publicAccount } from '../accounts.js';
import { readProfileVersion } from '../ego.js';
import { resolveAccountProxy } from '../proxies.js';
import { flowSummary, loadFlows } from '../flows.js';
import { renderEnvelope, sanitize } from './common.js';

/**
 * @param {any} ctx
 * @param {{ ego: any, accounts: any, manager: any, settings: Record<string, any>, dataDir: string,
 *           configStore: any, pluginRoot: string, pluginVersion: string, pluginName: string }} deps
 */
export function register(ctx, deps) {
  const { ego, accounts, proxies, manager, settings, dataDir, configStore, pluginRoot, pluginVersion, pluginName } = deps;

  /** Public account row with the pool-resolved proxy attached. */
  function accountView(account) {
    const base = publicAccount(account);
    if (!base) return null;
    const resolved = resolveAccountProxy(account, proxies);
    return {
      ...base,
      proxy: resolved
        ? { server: resolved.server, hasAuth: Boolean(resolved.username || resolved.password), username: resolved.username ?? null }
        : null,
      proxyId: account.proxyId ?? null,
      proxySource: resolved?.source ?? null,
    };
  }

  ctx.tools.register(defineTool({
    name: 'egolite_status',
    description:
      'Report ego-publish status before any other egolite_* call: which ego lite executable will be launched, the '
      + 'runtime data root, the effective configuration and its sources, every registered publishing account (with '
      + 'whether it has an isolated browser profile and a proxy), the live account browser sessions, and the publish '
      + 'flows available. This tool never launches a browser.',
    parameters: {
      probe: {
        type: 'boolean',
        description: 'Also report the engine-free health details of each account profile directory (slower only on many accounts).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          plugin: { type: 'object', additionalProperties: true, required: true },
          config: { type: 'object', additionalProperties: true, required: true },
          dataDir: { type: 'string', required: true },
          accounts: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          sessions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          flows: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          nextSteps: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderEnvelope(
        `ego-publish ${value.plugin.version} — ${value.plugin.ego.exists ? 'ego lite found' : 'ego lite NOT found'} — data ${value.dataDir}`,
        value,
      ),
    },
    async execute(args) {
      const flows = loadFlows({ pluginRoot, dataDir }).map(flowSummary);
      const accountList = accounts.list().map(accountView);
      const proxyList = proxies.listPublic(accounts.proxyUsage());
      const sessions = manager.list();
      const nextSteps = [];

      if (!ego.exists) {
        nextSteps.push(`No ego lite executable found (looked via ${ego.source}: ${ego.path}). Set config.egoPath to ego.exe or install ego lite.`);
      }
      if (!accountList.length) {
        nextSteps.push('No accounts yet: egolite_account {op:"upsert", code:"a-1", media:"sohu", account:"<login name>"}.');
      } else {
        const withoutProfile = accountList.filter((account) => !account.hasProfile).map((account) => account.code);
        const withoutProxy = accountList.filter((account) => !account.proxy).map((account) => account.code);
        if (withoutProfile.length) {
          nextSteps.push(`Accounts without a browser profile yet (created on first login): ${withoutProfile.join(', ')}.`);
        }
        if (withoutProxy.length) {
          nextSteps.push(`Accounts with no proxy (they exit from this machine's IP): ${withoutProxy.join(', ')}. Add a proxy with egolite_proxy {op:"add", server:"http://host:port"} then assign it with {op:"assign", code:"<code>", id:"p-1"}.`);
        }
        nextSteps.push('Sign an account in with egolite_account {op:"login", code:"<code>"} (opens its own ego window; the human scans the QR code).');
      }
      if (flows.every((flow) => flow.error)) nextSteps.push('No readable publish flow: check <dataDir>/flows/*.json.');

      return sanitize({
        ok: true,
        plugin: {
          name: pluginName,
          version: pluginVersion,
          root: pluginRoot,
          ego,
          configFile: configStore.filePath,
          configFileExists: existsSync(configStore.filePath),
        },
        config: { values: settings, sources: configStore.sources() },
        dataDir,
        accounts: accountList.map((account) => ({
          ...account,
          ...(args?.probe ? { profileVersion: readProfileVersion(account.profileDir) } : {}),
        })),
        proxies: proxyList,
        sessions,
        flows,
        nextSteps,
      });
    },
    presentCall: () => ({ card: 'generic', title: 'ego-publish status', kind: 'other' }),
  }));
}
