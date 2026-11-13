/**
 * provider.js — Shenlong HTTP proxy extraction.
 *
 * The operator stores the full extraction URL (it already carries `key` and `sign`) in
 * `config.proxyApiUrl`; extraction forces `pattern=json`, requests N IPs and adds each one to the
 * shared proxy pool. When `proxyApiWhitelist` is on, this machine's public IP is added to the
 * provider whitelist first (the relay connects from this host, so an unlisted IP gets HTTP 407).
 *
 * @module ego-publish/provider
 */
import { EgoError } from './cdp.js';

function apiUrl(config, rawUrl) {
  const raw = rawUrl || config.proxyApiUrl;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    throw new EgoError('PROXY_API_NOT_CONFIGURED', 'set config.proxyApiUrl to the Shenlong extraction URL (it contains key & sign)');
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EgoError('PROXY_API_NOT_CONFIGURED', 'config.proxyApiUrl is not a valid URL');
  }
  url.searchParams.set('pattern', 'json');
  return url;
}

async function callJson(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new EgoError('PROXY_API_UNREACHABLE', `proxy API request failed: ${error?.message ?? error}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new EgoError('PROXY_API_BAD_RESPONSE', `proxy API did not return JSON (HTTP ${response.status}): ${text.slice(0, 120)}`);
  }
}

/** Add this machine's public IP to the provider whitelist. */
export async function ensureWhitelist(config) {
  const url = apiUrl(config);
  const key = config.proxyWhitelistKey || null;
  const sign = config.proxyWhitelistSign || null;
  if (!key || !sign) {
    throw new EgoError('PROXY_WHITELIST_SKIPPED', 'whitelist key/sign not configured (proxyWhitelistKey/proxyWhitelistSign)');
  }
  let ip;
  try {
    // Must be a domestic endpoint. With a split-tunnel/VPN setup the public IP seen by a foreign host
    // is the VPN exit, not the address the provider actually receives — whitelisting that one would
    // register the wrong machine and every proxy call would still be rejected.
    const response = await fetch('https://myip.ipip.net', { signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    const match = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(text);
    if (!match) throw new Error(`no IP in the echo response: ${text.slice(0, 120)}`);
    ip = match[1];
  } catch (error) {
    throw new EgoError('PROXY_API_UNREACHABLE', `could not read the public IP: ${error?.message ?? error}`);
  }
  const white = new URL('/white/add', url.origin);
  white.searchParams.set('key', key);
  white.searchParams.set('sign', sign);
  white.searchParams.set('ip', ip);
  const body = await callJson(white);
  const code = Number(body?.code);
  if (code !== 200 && code !== 1007) {
    throw new EgoError('PROXY_WHITELIST_FAILED', `whitelist add failed (${code}): ${body?.msg ?? 'unknown'}`);
  }
  return { ip, alreadyListed: code === 1007 };
}

/**
 * Extract exactly one proxy for an account launch (dynamic mode), without adding it to the pool.
 * @param {{ configStore: any }} deps
 */
function sourceUrlOf(deps, sourceId) {
  const source = sourceId ? deps.sources?.get(sourceId) : deps.sources?.first();
  return source?.url || null;
}

export async function extractOne(deps) {
  const config = deps.configStore.values();
  const url = apiUrl(config, sourceUrlOf(deps, deps.sourceId));
  url.searchParams.set('count', '1');
  const body = await callJson(url);
  const code = Number(body?.code);
  if (code !== 200) throw new EgoError('PROXY_API_ERROR', `Shenlong extraction failed (${code}): ${body?.msg ?? 'unknown'}`);
  const row = Array.isArray(body?.data) ? body.data[0] : null;
  if (!row?.ip || !row?.port) throw new EgoError('PROXY_API_EMPTY', 'the provider returned no IP');
  return { server: `http://${row.ip}:${row.port}`, ip: row.ip, port: Number(row.port), at: new Date().toISOString() };
}

/**
 * Extract proxies and add them to the pool.
 * @param {{ configStore: any, proxies: any, log?: (line: string) => void }} deps
 * @param {{ count?: number }} [options]
 */
export async function extractProxies(deps, options = {}) {
  const config = deps.configStore.values();
  const url = apiUrl(config, sourceUrlOf(deps, options.sourceId));
  const count = Math.min(20, Math.max(1, Number(options.count) || 1));
  url.searchParams.set('count', String(count));

  let whitelist = null;
  if (config.proxyApiWhitelist !== false) {
    try {
      whitelist = await ensureWhitelist(config);
    } catch (error) {
      // A rejected whitelist IP must not hide the extraction result; report it alongside.
      whitelist = { ok: false, error: String(error?.message ?? error) };
      deps.log?.(`shenlong whitelist skipped: ${error?.message ?? error}`);
    }
  }

  const body = await callJson(url);
  const code = Number(body?.code);
  if (code !== 200) {
    throw new EgoError('PROXY_API_ERROR', `Shenlong extraction failed (${code}): ${body?.msg ?? 'unknown'}`);
  }
  const rows = Array.isArray(body?.data) ? body.data : [];
  if (!rows.length) throw new EgoError('PROXY_API_EMPTY', 'the provider returned no IPs (try another area or a larger count)');

  const existing = new Set(deps.proxies.list().map((entry) => entry.server));
  const added = [];
  for (const row of rows) {
    const server = `http://${row.ip}:${row.port}`;
    if (!row.ip || !row.port || existing.has(server)) continue;
    const label = ['神龙', row.city, row.isp].filter(Boolean).join(' ');
    const entry = deps.proxies.add({ label, server });
    existing.add(server);
    added.push({ id: entry.id, label: entry.label, server });
  }
  deps.log?.(`shenlong extracted ${added.length}/${rows.length} proxy(ies)`);
  return { added, whitelist, total: rows.length };
}
