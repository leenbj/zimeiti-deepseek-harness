/**
 * proxy.js — `egolite_proxy`: a shared proxy pool plus per-account assignment.
 *
 * A proxy is added once to the pool and then assigned to any number of account browsers. Each account
 * launches with the assigned entry's server (and credentials), so two accounts can share one proxy, or
 * each use a different one, without retyping anything.
 *
 * @module ego-publish/tools/proxy
 */
import { EgoError } from '../cdp.js';
import { publicAccount } from '../accounts.js';
import { publicProxy, resolveAccountProxy } from '../proxies.js';
import { parseProxy, redactProxy, testProxy } from '../proxy.js';
import { extractProxies } from '../provider.js';
import { defineTool } from '../tool-kit.js';
import { TIMEOUT, renderEnvelope, requireAccount, sanitize } from './common.js';

/**
 * @param {any} ctx
 * @param {{ accounts: any, proxies: any, manager: any, settings: Record<string, any>, log: (line: string) => void }} deps
 */
export function register(ctx, deps) {
  const { accounts, proxies, manager, configStore, log } = deps;

  /** Accounts currently pointing at one pool entry. */
  function usageOf(id) {
    return accounts.list().filter((account) => account.proxyId === id).map((account) => account.code);
  }

  ctx.tools.register(defineTool({
    name: 'egolite_proxy',
    description:
      'Manage a shared proxy pool and assign entries to account browsers. Ops: list — the pool with assigned accounts; '
      + 'add — create an entry {label, server, username?, password?}; update — change an entry by id; remove — delete it '
      + '(assigned accounts fall back to direct); assign — point an account at an entry ({code, id}) or back to direct '
      + '(id:null); test — probe the exit IP of an entry ({id}) or of an account\'s current proxy ({code}); set/clear — '
      + 'legacy shortcuts that add-then-assign or unassign. Each account browser is launched with its own '
      + '--proxy-server, so assignments never leak across accounts.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['list', 'add', 'update', 'remove', 'assign', 'test', 'extract', 'set', 'clear'],
        description: 'Which proxy operation to run.',
      },
      id: { type: 'string', description: 'Pool entry id, e.g. "p-1" (add/update/remove/assign/test).' },
      label: { type: 'string', description: 'Human-friendly name for op:"add"/"update".' },
      code: { type: 'string', description: 'Account code, for assign/set/clear/test.' },
      server: { type: 'string', description: 'Proxy URL for add/update/test/set, e.g. http://host:port.' },
      username: { type: 'string', description: 'Optional proxy username.' },
      password: { type: 'string', description: 'Optional proxy password (never echoed back).' },
      timeoutMs: { type: 'integer', description: 'Probe timeout for op:"test" (default 20000).' },
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
    timeoutMs: TIMEOUT.PROXY_MS,
    async execute(args) {
      const pool = () => proxies.listPublic(accounts.proxyUsage());
      switch (args.op) {
        case 'list': {
          const rows = accounts.list().map((account) => {
            const resolved = resolveAccountProxy(account, proxies);
            return {
              code: account.code,
              media: account.media,
              proxyId: account.proxyId ?? null,
              proxy: resolved ? redactProxy(resolved) : null,
              proxySource: resolved?.source ?? null,
              sessionOpen: Boolean(manager.get(account.code)),
            };
          });
          return sanitize({
            ok: true,
            message: `${proxies.list().length} proxy(ies), ${rows.filter((row) => row.proxy).length} account(s) proxied`,
            data: { proxies: pool(), accounts: rows },
          });
        }
        case 'add': {
          if (!args.server) throw new EgoError('INVALID_PROXY', 'server is required for op:"add"');
          parseProxy({ server: args.server, username: args.username, password: args.password });
          const entry = proxies.add({ label: args.label, server: args.server, username: args.username, password: args.password });
          return sanitize({
            ok: true,
            message: `proxy ${entry.id} added`,
            data: { proxy: publicProxy(entry, []), proxies: pool() },
            nextSteps: [`Assign it: egolite_proxy {op:"assign", code:"<code>", id:"${entry.id}"}.`],
          });
        }
        case 'update': {
          const entry = proxies.update(String(args.id ?? ''), {
            ...(args.label !== undefined ? { label: args.label } : {}),
            ...(args.server !== undefined ? { server: args.server } : {}),
            ...(args.username !== undefined ? { username: args.username } : {}),
            ...(args.password !== undefined ? { password: args.password } : {}),
          });
          const affected = usageOf(entry.id);
          for (const code of affected) await manager.close(code).catch(() => {});
          return sanitize({
            ok: true,
            message: `proxy ${entry.id} updated${affected.length ? `; closed ${affected.join(', ')} so the change applies` : ''}`,
            data: { proxy: publicProxy(entry, affected), proxies: pool() },
          });
        }
        case 'remove': {
          const id = String(args.id ?? '');
          const entry = proxies.get(id);
          if (!entry) throw new EgoError('PROXY_NOT_FOUND', `no proxy with id "${id}"`);
          const affected = accounts.clearProxyId(id);
          for (const code of affected) await manager.close(code).catch(() => {});
          proxies.remove(id);
          return sanitize({
            ok: true,
            message: `proxy ${id} removed${affected.length ? `; now direct: ${affected.join(', ')}` : ''}`,
            data: { removed: true, affected, proxies: pool() },
          });
        }
        case 'assign': {
          const account = requireAccount(accounts, args.code);
          const id = args.id === undefined || args.id === null || args.id === '' ? null : String(args.id);
          if (id !== null && !proxies.get(id)) throw new EgoError('PROXY_NOT_FOUND', `no proxy with id "${id}"`);
          accounts.setProxyId(account.code, id);
          await manager.close(account.code).catch(() => {});
          return sanitize({
            ok: true,
            message: id === null ? `${account.code} now goes direct` : `${account.code} now uses proxy ${id}`,
            data: { account: publicAccount(accounts.get(account.code)), proxies: pool() },
          });
        }
        case 'test': {
          let entry = null;
          let proxy = null;
          let source = '';
          if (args.id) {
            entry = proxies.get(String(args.id));
            if (!entry) throw new EgoError('PROXY_NOT_FOUND', `no proxy with id "${args.id}"`);
            proxy = entry;
            source = `pool ${entry.id}`;
          } else if (args.server) {
            proxy = { server: args.server, username: args.username, password: args.password };
            source = 'argument';
          } else {
            const account = requireAccount(accounts, args.code);
            proxy = resolveAccountProxy(account, proxies);
            source = `account ${account.code}`;
            if (!proxy) throw new EgoError('NO_PROXY', `account "${account.code}" has no proxy`);
          }
          const result = await testProxy(proxy, { timeoutMs: args.timeoutMs ?? 20000 });
          if (entry) proxies.markTest(entry.id, { ip: result.ip, latencyMs: result.latencyMs });
          return sanitize({
            ok: true,
            message: `proxy works — exit IP ${result.ip} (${result.latencyMs}ms)`,
            data: { ...result, testedFrom: source, proxy: redactProxy(proxy), proxies: pool() },
          });
        }
        case 'extract': {
          const result = await extractProxies({ configStore, proxies, log, sources: deps.sources }, { count: 1 });
          return sanitize({
            ok: true,
            message: `extracted ${result.added.length} proxy(ies)${result.whitelist ? `; whitelisted ${result.whitelist.ip}` : ''}`,
            data: { ...result, proxies: pool() },
            nextSteps: result.added.length
              ? [`Assign one: egolite_proxy {op:"assign", code:"<code>", id:"${result.added[0].id}"}.`]
              : ['Provider returned IPs already in the pool; try again later or increase the count.'],
          });
        }
        case 'set': {
          const account = requireAccount(accounts, args.code);
          if (!args.server) throw new EgoError('INVALID_PROXY', 'server is required for op:"set"');
          const entry = proxies.add({ label: args.label || `账号 ${account.code}`, server: args.server, username: args.username, password: args.password });
          accounts.setProxyId(account.code, entry.id);
          await manager.close(account.code).catch(() => {});
          return sanitize({
            ok: true,
            message: `proxy ${entry.id} added and assigned to ${account.code}`,
            data: { proxy: publicProxy(entry, [account.code]), account: publicAccount(accounts.get(account.code)), proxies: pool() },
          });
        }
        case 'clear': {
          const account = requireAccount(accounts, args.code);
          accounts.setProxyId(account.code, null);
          await manager.close(account.code).catch(() => {});
          return sanitize({
            ok: true,
            message: `${account.code} now goes direct`,
            data: { account: publicAccount(accounts.get(account.code)), proxies: pool() },
          });
        }
        default:
          throw new EgoError('INVALID_OP', `unknown proxy op "${args.op}"`);
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `egolite proxy ${args.op}`, kind: 'other' }),
  }));
}
