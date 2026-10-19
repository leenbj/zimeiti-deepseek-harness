/**
 * common.js — shared plumbing for the `media_*` tool modules.
 *
 * Nothing here talks to the engine by itself: it shapes engine results and engine failures into the
 * uniform envelope every tool returns, keeps the per-session handoff log, and reads the recipe
 * catalogue off disk (SPEC §2.1 has no `recipe.list` RPC, so the Node half mirrors
 * `config_store.list_recipes()`: user recipes under `<dataDir>/recipes` win over builtins).
 *
 * Zero external imports: only `node:*` builtins, so the linked package still activates.
 *
 * @module media-publish/tools/common
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { renderValue } from '../tool-kit.js';

/** Per-call engine timeouts. The default (`settings.requestTimeoutMs`) is for cheap calls. */
export const TIMEOUT = {
  /** `account.login` waits for a human: give the engine 10 minutes and the client a little more. */
  LOGIN_MS: 600_000,
  LOGIN_CLIENT_MS: 660_000,
  /** A full replay with self-healing can be long: 15 minutes. */
  PUBLISH_MS: 900_000,
  /** `session.resume` polls until the page is usable; the engine's own ceiling is 5 minutes. */
  RESUME_MS: 360_000,
  OPEN_MS: 180_000,
  ACT_MS: 180_000,
  OBSERVE_MS: 120_000,
  CHECK_MS: 180_000,
  PROXY_MS: 60_000,
  VALIDATE_MS: 90_000,
  BACKFILL_MS: 300_000,
  STATUS_MS: 30_000,
};

/** Keys whose value is a credential and must never reach the model. */
const SECRET_KEYS = new Set(['password', 'passwd', 'pass', 'pwd', 'proxy_password', 'proxypassword']);

/**
 * Debug logger that never writes to stdout.
 * @param {any} ctx
 * @returns {(line: string) => void}
 */
export function log(ctx) {
  return (line) => {
    try {
      ctx?.logger?.('media-publish')?.debug?.(String(line));
    } catch {
      /* logging must never break a tool call */
    }
  };
}

/**
 * Keep the last `handoff` event per session, so failure text can quote the engine's real reason
 * instead of a generic "the session needs a human".
 * @param {number} [limit]
 */
export function createHandoffLog(limit = 50) {
  /** @type {Map<string, Record<string, any>>} */
  const bySession = new Map();
  return {
    record(data) {
      const sessionId = String(data?.sessionId ?? '').trim();
      if (!sessionId) return;
      bySession.set(sessionId, { ...data, sessionId, at: new Date().toISOString(), needsHuman: true });
      while (bySession.size > limit) bySession.delete(bySession.keys().next().value);
    },
    get(sessionId) {
      return bySession.get(String(sessionId ?? '')) ?? null;
    },
    clear(sessionId) {
      bySession.delete(String(sessionId ?? ''));
    },
    list() {
      return [...bySession.values()];
    },
  };
}

/**
 * Deep-copy a value with every credential removed; the object that carried one gains `hasPassword`.
 *
 * It also guarantees the result is **lossless JSON**, because the host validates a tool's return value
 * and rejects anything JSON would silently rewrite:
 *   - an `undefined` object value is dropped (JSON drops the key, so keeping it is a rewrite);
 *   - an `undefined` array element becomes `null` (JSON does exactly that, but the check compares
 *     against the value you returned, so it must already be `null`);
 *   - array holes are filled, since `Array.prototype.map` preserves them and JSON does not;
 *   - functions and symbols become `null`.
 * Without this, one stray `undefined` anywhere in an engine payload fails the whole call with
 * "value is not lossless JSON" — after the engine has already done the work.
 *
 * @param {unknown} value
 * @param {number} [depth]
 */
export function sanitize(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') return null;
    return value;
  }
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) {
    // Deliberately not .map(): it preserves holes, and JSON.stringify turns them into null, so the
    // returned value would differ from its own JSON round-trip.
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = sanitize(value[index], depth + 1);
      items.push(item === undefined ? null : item);
    }
    return items;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  let hadSecret = false;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      hadSecret = hadSecret || Boolean(item);
      continue;
    }
    const cleaned = sanitize(item, depth + 1);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  if (hadSecret && out.hasPassword === undefined) out.hasPassword = true;
  return out;
}

/**
 * Drop top-level keys whose value is `null`.
 *
 * The output schemas declare `data`, `handoff` and `error` as objects, but the builders below set them
 * to `null` on the paths where they do not apply — and the host validates strictly, so every call of
 * every tool was rejected *after* the engine had already done the work. Omitting a key is valid because
 * only `ok` is required, and `ok` is never null.
 *
 * @param {Record<string, any>} envelope
 * @returns {Record<string, any>}
 */
export function withoutNulls(envelope) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Redact `scheme://user:password@host` credentials that a caller may have embedded in a proxy server
 * string, and which an engine echo could otherwise hand straight back to the model.
 * @param {unknown} value
 * @param {number} [depth]
 */
export function scrubCredentials(value, depth = 0) {
  if (depth > 8 || value === null) return value;
  if (typeof value === 'string') return value.replace(/(:\/\/[^/\s:@]+):[^/\s@]+@/g, '$1:***@');
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubCredentials(item, depth + 1));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrubCredentials(item, depth + 1);
  return out;
}

/**
 * Render `error.details.candidates` (the engine's element list on TARGET_NOT_FOUND) as short lines
 * the model can match against the page model it just observed.
 * @param {unknown} candidates
 * @param {number} [limit]
 * @returns {string[]}
 */
export function compactCandidates(candidates, limit = 20) {
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, limit).map((item) => {
    if (item === null || typeof item !== 'object') return String(item);
    const parts = [
      item.ref,
      item.role || item.tag,
      item.text ? JSON.stringify(String(item.text).replace(/\s+/g, ' ').slice(0, 60)) : '',
      item.selector ? `selector=${item.selector}` : '',
      item.inFrame && item.inFrame !== 'main' ? `frame=${item.inFrame}` : '',
      item.visible === false ? 'hidden' : '',
    ];
    return parts.filter(Boolean).join('  ');
  });
}

/**
 * Error codes that mean "a human must finish something in the browser window".
 * @param {string} code
 */
function needsHuman(code) {
  return code === 'LOGIN_REQUIRED' || code === 'HANDOFF_REQUIRED';
}

/**
 * Code-specific, actionable next steps.
 * @param {string} code
 * @param {{ sessionId?: string|null, accountCode?: string|null, handoffs?: any, method?: string }} context
 * @returns {{ needsHuman: boolean, instruction: string|null, nextSteps: string[] }}
 */
export function guidanceForCode(code, context = {}) {
  const sessionId = context.sessionId ?? null;
  const accountCode = context.accountCode ?? null;
  const handoff = sessionId ? context.handoffs?.get?.(sessionId) ?? null : null;
  const resumeStep = sessionId
    ? `media_session {op:"resume", sessionId:"${sessionId}"}`
    : 'media_session {op:"resume", sessionId:"<the session you were driving>"}';
  const humanInstruction = needsHuman(code)
    ? (handoff
      ? `A human must finish this in the browser window — engine handoff reason="${handoff.reason ?? 'unknown'}"`
        + `${handoff.hint ? `, hint="${handoff.hint}"` : ''}`
        + `${handoff.url ? ` (page: ${handoff.url})` : ''}. `
        + `Then call ${resumeStep} to hand control back to the agent.`
      : 'A human must finish the captcha / QR scan / login in the browser window, then call '
        + `${resumeStep} to hand control back to the agent.`)
    : null;

  /** @type {string[]} */
  const steps = [];
  switch (code) {
    case 'LOGIN_REQUIRED':
      steps.push('Ask the human to finish the login in the open browser window (scan the QR code or solve the captcha).');
      steps.push(`Then call ${resumeStep}.`);
      if (accountCode) {
        steps.push(`If the window is gone or the login state is stale, call media_account {op:"login", code:"${accountCode}"} and then media_account {op:"check", code:"${accountCode}"}.`);
      }
      break;
    case 'TARGET_NOT_FOUND':
      steps.push('Re-read the page with media_observe; refs are only valid until the next snapshot.');
      steps.push('Retarget with {selector:"..."} or {text:"...", role:"..."} from the candidates above — never guess a ref.');
      steps.push('If the page changed shape, re-record that stretch and annotate it with media_record {op:"note"}, or edit the recipe step directly.');
      break;
    case 'TIMEOUT':
      steps.push('The page may still be loading: call media_observe or media_session {op:"state"} to see the current URL/title.');
      steps.push('For a human-in-the-loop wait, call session resume again after the human finishes.');
      steps.push('For a replay step, raise that step\'s timeoutMs in the recipe.');
      break;
    case 'PROXY_UNAVAILABLE':
      steps.push('Call media_proxy {op:"test", code:"<code>"} to probe the bound proxy; check the extractor URL in <dataDir>/proxies.yaml.');
      steps.push('Call media_proxy {op:"rotate", code:"<code>"} to take a new IP, or media_account {op:"bindProxy", code:"<code>", proxy:null} to go direct.');
      break;
    case 'SESSION_NOT_FOUND':
      steps.push('Call media_session {op:"list"} to see live sessions; open one with media_session {op:"open", accountCode:"<code>"}.');
      steps.push('A session dies when the engine restarts: reopening is cheap, the account keeps its login state.');
      break;
    case 'RECIPE_INVALID':
      steps.push('Call media_recipe {op:"list"} / {op:"validate", recipeId:"..."} and fix the reported issue.');
      break;
    case 'PARAM_MISSING':
      steps.push('The recipe declares required params: read them with media_recipe {op:"show", recipeId:"..."} and pass all of them in params.');
      break;
    case 'UNSUPPORTED':
    case 'UNKNOWN_METHOD':
      steps.push('This engine build does not implement that method yet (engine-side gap); report it rather than retrying.');
      steps.push('Workaround: drive the same flow by hand with media_session + media_observe + media_act and record it.');
      break;
    case 'ENGINE_SPAWN_FAILED':
    case 'ENGINE_EXITED':
    case 'ENGINE_TIMEOUT':
      steps.push('Call media_status {probe:true} to see the interpreter, the engine log tail and whether it restarts.');
      steps.push('The engine is restarted lazily on the next call; live sessions from the crashed process are gone.');
      break;
    case 'BAD_REQUEST':
      steps.push('Fix the argument the engine named, then retry the same call.');
      break;
    default:
      steps.push('Call media_status {probe:true} for engine/diagnostic context before retrying.');
      break;
  }
  return { needsHuman: needsHuman(code), instruction: humanInstruction, nextSteps: steps };
}

/**
 * Build the success envelope every tool returns.
 * @param {{ tool: string, op?: string|null, method: string, summary: string, data: any,
 *           warnings?: string[], nextSteps?: string[], handoff?: any }} input
 */
export function success(input) {
  return withoutNulls({
    ok: true,
    tool: input.tool,
    op: input.op ?? null,
    method: input.method,
    summary: input.summary,
    data: sanitize(input.data),
    warnings: input.warnings ?? [],
    handoff: input.handoff ?? null,
    error: null,
    nextSteps: input.nextSteps ?? [],
  });
}

/**
 * Build the failure envelope. Never throws: every tool funnels engine errors through here.
 * @param {any} error
 * @param {{ tool: string, op?: string|null, method: string, sessionId?: string|null,
 *           accountCode?: string|null, handoffs?: any, data?: any, nextSteps?: string[],
 *           summary?: string }} context
 */
export function failure(error, context) {
  const code = String(error?.code ?? 'INTERNAL');
  const message = String(error?.message ?? error ?? 'unknown error');
  const details = error?.details ?? null;
  const candidates = compactCandidates(details?.candidates);
  const guidance = guidanceForCode(code, {
    sessionId: context.sessionId ?? details?.sessionId ?? null,
    accountCode: context.accountCode ?? null,
    handoffs: context.handoffs,
    method: context.method,
  });
  const handoff = context.sessionId ? context.handoffs?.get?.(context.sessionId) ?? null : null;
  const extra = Array.isArray(details?.known) && details.known.length
    ? [`known values: ${details.known.join(', ')}`]
    : [];

  return withoutNulls({
    ok: false,
    tool: context.tool,
    op: context.op ?? null,
    method: context.method,
    summary: context.summary ?? `${context.method} failed: ${code} — ${message}`,
    data: context.data !== undefined ? sanitize(context.data) : null,
    warnings: [],
    handoff,
    error: {
      code,
      message,
      details: details ? sanitize(details) : null,
      candidates,
      needsHuman: guidance.needsHuman,
      instruction: guidance.instruction,
    },
    nextSteps: [...(context.nextSteps ?? []), ...guidance.nextSteps, ...extra],
  });
}

/**
 * Failure envelope for an argument problem detected on the Node side (no engine round trip).
 * @param {{ tool: string, op?: string|null, method?: string, message: string, nextSteps?: string[] }} input
 */
export function argumentFailure(input) {
  return withoutNulls({
    ok: false,
    tool: input.tool,
    op: input.op ?? null,
    method: input.method ?? 'local.validation',
    summary: `${input.tool}: ${input.message}`,
    data: null,
    warnings: [],
    handoff: null,
    error: { code: 'INVALID_ARGS', message: input.message, details: null, candidates: [], needsHuman: false, instruction: null },
    nextSteps: input.nextSteps ?? [],
  });
}

/**
 * Render an envelope for the model: a readable block first, then the structured JSON.
 * @param {string} headline
 * @param {any} value
 * @param {string[]} [extraLines]
 */
export function renderEnvelope(headline, value, extraLines = []) {
  /** @type {string[]} */
  const lines = [headline];
  if (value?.summary && value.summary !== headline) lines.push(value.summary);
  for (const line of extraLines) if (line) lines.push(line);
  if (value?.handoff) {
    lines.push(`HUMAN ACTION REQUIRED — handoff reason="${value.handoff.reason ?? 'unknown'}"`
      + `${value.handoff.hint ? ` hint="${value.handoff.hint}"` : ''}`);
  }
  if (value?.warnings?.length) lines.push(`WARNINGS: ${value.warnings.join(' | ')}`);
  if (value && value.ok === false && value.error) {
    lines.push(`error ${value.error.code}: ${value.error.message}`);
    if (value.error.instruction) lines.push(value.error.instruction);
    for (const candidate of value.error.candidates ?? []) lines.push(`  candidate: ${candidate}`);
  }
  if (value?.nextSteps?.length) lines.push(`next: ${value.nextSteps.join(' ')}`);
  return renderValue(lines.join('\n'), value);
}

/**
 * Normalize an engine `engine.status` report into the status tool's compact view.
 * @param {any} report
 */
export function engineSummary(report) {
  if (!report || typeof report !== 'object') return null;
  return {
    version: report.version ?? null,
    python: report.python ?? null,
    playwright: report.playwright ?? null,
    chromium: report.chromium ?? null,
    browserRunning: report.browserRunning ?? null,
    dataDir: report.dataDir ?? null,
    accounts: report.accounts ?? null,
    recipes: report.recipes ?? null,
    sessions: report.sessions ?? null,
    sessionIds: report.sessionIds ?? [],
    uptimeSec: report.uptimeSec ?? null,
    methods: report.methods ?? null,
  };
}

// ------------------------------------------------------------------ yaml-lite

/** Strip a trailing `# comment` that is not inside quotes/brackets. */
function stripComment(line) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === '#' && depth === 0 && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** Split on `sep` at bracket/quote depth 0. */
function splitTopLevel(text, sep = ',') {
  /** @type {string[]} */
  const out = [];
  let quote = null;
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === sep && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out.map((item) => item.trim()).filter(Boolean);
}

/** Parse a YAML scalar: quoted string, flow array, bool, null, number, else raw string. */
function parseScalar(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitTopLevel(text.slice(1, -1)).map((item) => parseScalar(item));
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

/** Parse a flow map `{a: 1, b: [x, y]}`. */
function parseFlowMap(raw) {
  const text = String(raw ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const pair of splitTopLevel(text.slice(start + 1, end))) {
    const at = pair.indexOf(':');
    if (at < 0) continue;
    out[pair.slice(0, at).trim()] = parseScalar(pair.slice(at + 1));
  }
  return out;
}

/**
 * Split a YAML block's lines into list items at the block's own list indentation.
 * @param {string[]} lines
 * @returns {string[][]} one array of dedented lines per item
 */
function splitListItems(lines) {
  /** @type {number|null} */
  let itemIndent = null;
  /** @type {string[][]} */
  const items = [];
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const isItem = /^-\s|^-$/.test(line.trimStart());
    if (isItem) {
      if (itemIndent === null || indent <= itemIndent) itemIndent = indent;
      if (indent === itemIndent) { items.push([line.trimStart().replace(/^-\s?/, '')]); continue; }
    }
    if (itemIndent === null) continue;
    if (indent < itemIndent) break;
    if (items.length) items[items.length - 1].push(line.trimStart());
  }
  return items;
}

/**
 * Parse a block map (key: value, nested maps/lists by indentation) from dedented lines.
 * @param {string[]} lines
 * @returns {Record<string, any>}
 */
function parseBlockMap(lines) {
  /** @type {Record<string, any>} */
  const out = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    if (rest.trim()) { out[key] = parseScalar(rest); continue; }
    /** @type {string[]} */
    const nested = [];
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim()) { index += 1; continue; }
      if (/^([A-Za-z_][\w-]*):/.test(next) || /^-\s/.test(next)) break;
      nested.push(next);
      index += 1;
    }
    out[key] = nested.length ? parseBlockMap(nested) : null;
  }
  return out;
}

/**
 * Split a YAML document into top-level blocks (`key:` at column 0) plus its scalar map.
 * @param {string} text
 */
function topLevelBlocks(text) {
  /** @type {Map<string, string>} */
  const scalars = new Map();
  /** @type {Map<string, string[]>} */
  const blocks = new Map();
  let current = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) { if (current) blocks.get(current)?.push(''); continue; }
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      const [, key, rest] = top;
      if (rest.trim()) { scalars.set(key, rest.trim()); current = null; continue; }
      current = key;
      if (!blocks.has(key)) blocks.set(key, []);
      continue;
    }
    if (current && /^\s/.test(line)) blocks.get(current)?.push(line);
  }
  return { scalars, blocks };
}

/**
 * Parse the subset of a recipe this half needs: identity, declared params and the step outline.
 * Full fidelity parsing is the engine's job (`play.validate`); this is for listing and display.
 * @param {string} text
 */
export function parseRecipe(text) {
  const { scalars, blocks } = topLevelBlocks(text);
  const rawParams = blocks.get('params') ?? [];
  const rawSteps = blocks.get('steps') ?? [];
  const params = splitListItems(rawParams).map((itemLines) => {
    const joined = itemLines.join(' ').trim();
    const map = joined.startsWith('{') ? parseFlowMap(joined) : parseBlockMap(itemLines);
    return map;
  });
  const steps = splitListItems(rawSteps).map((itemLines, index) => {
    const first = itemLines[0] ?? '';
    const inline = /^\{/.test(first) ? parseFlowMap(first) : null;
    const map = inline ?? parseBlockMap(itemLines);
    const detail = map.url ? `url=${map.url}` : '';
    return {
      index,
      type: map.type ?? null,
      submit: map.submit === true,
      optional: map.optional === true,
      summary: [map.type ?? inline ?? first, detail].filter(Boolean).join(' '),
      note: typeof map.note === 'string' ? map.note.slice(0, 160) : undefined,
    };
  });
  return {
    id: scalars.get('id') ? String(parseScalar(scalars.get('id'))) : null,
    media: scalars.get('media') ? String(parseScalar(scalars.get('media'))) : null,
    label: scalars.get('label') ? String(parseScalar(scalars.get('label'))) : null,
    recipeVersion: scalars.has('recipe_version') ? parseScalar(scalars.get('recipe_version')) : null,
    accountCodes: parseScalar(scalars.get('account_codes') ?? '') || [],
    params,
    steps,
    sessionCheck: parseBlockMap(blocks.get('session_check') ?? []),
    capabilities: parseBlockMap(blocks.get('capabilities') ?? []),
    verify: parseBlockMap(blocks.get('verify') ?? []),
  };
}

/**
 * Read one recipe file; returns null when it cannot be read as a mapping.
 * @param {string} file
 * @param {'user'|'builtin'} source
 */
export function readRecipeFile(file, source) {
  let text = '';
  try {
    if (statSync(file).size > 2_000_000) return null;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseRecipe(text);
  const stem = basename(file, extname(file));
  const id = parsed.id || stem;
  const media = parsed.media || (/__/.test(stem) ? stem.slice(0, stem.indexOf('__')) : 'misc');
  return {
    id,
    media,
    label: parsed.label || id,
    source,
    path: file,
    stepCount: parsed.steps.length,
    accountCodes: parsed.accountCodes,
    raw: text,
    parsed,
  };
}

/** List `*.yaml`/`*.yml` under a directory (bounded depth). */
function listYamlFiles(root, depth = 3) {
  /** @type {string[]} */
  const out = [];
  if (depth < 0 || !existsSync(root)) return out;
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listYamlFiles(full, depth - 1));
    else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/**
 * The recipe catalogue, mirroring `config_store.list_recipes()`: `<dataDir>/recipes` first,
 * `engine/recipes` as the builtin fallback.
 * @param {{ dataDir?: string|null, pluginRoot: string }} paths
 */
export function readRecipeCatalog({ dataDir, pluginRoot }) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  /** @type {Array<[string, 'user'|'builtin']>} */
  const roots = [];
  if (dataDir) roots.push([join(dataDir, 'recipes'), 'user']);
  roots.push([join(pluginRoot, 'engine', 'recipes'), 'builtin']);
  for (const [root, source] of roots) {
    for (const file of listYamlFiles(root)) {
      const meta = readRecipeFile(file, source);
      if (!meta) continue;
      const previous = byId.get(meta.id);
      if (!previous || source === 'user') byId.set(meta.id, meta);
    }
  }
  return [...byId.values()]
    .map(({ raw, parsed, ...rest }) => rest)
    .sort((a, b) => `${a.media}/${a.id}`.localeCompare(`${b.media}/${b.id}`));
}

/**
 * Resolve `{recipeId}` or `{media}` down to one concrete recipe.
 * @param {{ dataDir?: string|null, pluginRoot: string }} paths
 * @param {{ recipeId?: string|null, media?: string|null }} args
 */
export function resolveRecipe(paths, { recipeId, media }) {
  const catalog = readRecipeCatalog(paths);
  const wanted = String(recipeId ?? '').trim();
  if (wanted) {
    const hit = catalog.find((item) => item.id === wanted);
    return { ok: true, recipe: hit ?? null, catalog };
  }
  const mediaKey = String(media ?? '').trim();
  if (!mediaKey) {
    return {
      ok: false,
      message: 'pass recipeId, or media to auto-select when that platform has exactly one recipe',
      catalog,
    };
  }
  const candidates = catalog.filter((item) => item.media === mediaKey || item.id.startsWith(`${mediaKey}__`));
  if (candidates.length === 1) return { ok: true, recipe: candidates[0], catalog };
  return {
    ok: false,
    message: candidates.length
      ? `media "${mediaKey}" has ${candidates.length} recipes: ${candidates.map((c) => c.id).join(', ')} — pass recipeId`
      : `no recipe for media "${mediaKey}"`,
    catalog,
  };
}

/**
 * The `static:` list from `<dataDir>/proxies.yaml` (may contain passwords: never render it).
 * @param {string|null|undefined} dataDir
 * @returns {Array<Record<string, any>>}
 */
export function readStaticProxies(dataDir) {
  if (!dataDir) return [];
  const file = join(dataDir, 'proxies.yaml');
  if (!existsSync(file)) return [];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const { blocks } = topLevelBlocks(text);
  return splitListItems(blocks.get('static') ?? []).map((lines) => {
    const joined = lines.join(' ').trim();
    return joined.startsWith('{') ? parseFlowMap(joined) : parseBlockMap(lines);
  });
}

/**
 * Turn the tool's `proxy` argument into the engine's `{server, username?, password?}|null`.
 * Accepts null/'direct'/'' (unbind), an object, `static:<index>`, a bare server, or `server|user|pass`.
 * @param {unknown} raw
 * @param {{ dataDir?: string|null }} paths
 * @returns {{ ok: true, proxy: any, detail: string }|{ ok: false, message: string, nextSteps: string[] }}
 */
export function resolveProxyArg(raw, paths) {
  const unbind = { ok: true, proxy: null, detail: 'proxy=null → unbind (direct connection)' };
  if (raw === undefined || raw === null) return unbind;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const server = String(raw.server ?? '').trim();
    if (!server) {
      return { ok: false, message: 'proxy object needs a "server" (e.g. http://1.2.3.4:8000)', nextSteps: ['Pass proxy:{server:"http://host:port", username?:"u", password?:"p"} or proxy:null to unbind.'] };
    }
    return { ok: true, proxy: { server, username: raw.username ?? null, password: raw.password ?? null }, detail: `explicit proxy ${server}` };
  }
  const text = String(raw).trim();
  if (!text || text === 'null' || text === 'none' || text === 'direct') return unbind;
  const staticRef = /^static:(\d+)$/i.exec(text);
  if (staticRef) {
    const list = readStaticProxies(paths.dataDir);
    const index = Number.parseInt(staticRef[1], 10);
    const item = list[index];
    if (!item) {
      return {
        ok: false,
        message: `static:${index} is out of range — <dataDir>/proxies.yaml static has ${list.length} entr${list.length === 1 ? 'y' : 'ies'}`,
        nextSteps: ['Add entries to the `static:` list in <dataDir>/proxies.yaml, or pass an explicit proxy object.'],
      };
    }
    return {
      ok: true,
      proxy: { server: item.server, username: item.username ?? null, password: item.password ?? null },
      detail: `static:${index} → ${item.server}${item.note ? ` (${item.note})` : ''}`,
    };
  }
  if (text.includes('://')) return { ok: true, proxy: { server: text, username: null, password: null }, detail: `server ${text}` };
  if (text.includes('|')) {
    const [server, username, password] = text.split('|');
    if (!server) return { ok: false, message: 'proxy must start with server', nextSteps: ['Use "server|username|password".'] };
    return { ok: true, proxy: { server: server.trim(), username: (username ?? '').trim() || null, password: (password ?? '').trim() || null }, detail: `server ${server.trim()}` };
  }
  return { ok: false, message: `cannot interpret proxy "${text}"`, nextSteps: ['Use an object {server,username?,password?}, "static:<index>", "server|user|pass", or null to unbind.'] };
}
