/**
 * Live smoke test of the Node↔engine boundary: builds the real {@link EngineClient} with the bundled
 * DSH runtime interpreter and drives it over NDJSON exactly like the tools do.
 *
 * It answers one question the fake-context harness cannot: is `engine/sessiond.py` runnable from this
 * checkout right now? Run it after touching `src/`, and see `media_status {probe:true}` output for the
 * same information from inside the host.
 *
 * Run:  node tests/probe-engine-live.mjs
 */
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient } from '../src/engine-client.js';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const pythonPath = process.env.MEDIA_PYTHON
  || join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

console.log(`pluginRoot: ${pluginRoot}`);
console.log(`python:     ${pythonPath} (exists=${existsSync(pythonPath)})`);

const engine = new EngineClient({
  pythonPath,
  pluginRoot,
  dataDir: join(tmpdir(), 'media-publish-engine-probe'),
  requestTimeoutMs: 60_000,
});
const log = [];
engine.on('log', (line) => log.push(line));

/** @type {Array<[string, object]>} */
const probes = [
  ['engine.status', {}],
  ['account.list', {}],
  ['session.list', {}],
  ['play.backfill', { recipeId: 'sohu__publish-article', accountCode: 'a-1', title: 'probe' }],
];

let failures = 0;
for (const [method, params] of probes) {
  try {
    const result = await engine.call(method, params, { timeoutMs: 60_000 });
    const summary = JSON.stringify(result);
    console.log(`OK    ${method} → ${summary.length > 400 ? `${summary.slice(0, 400)}…` : summary}`);
  } catch (error) {
    // An engine-side gap is a valid finding, not a harness crash: report it verbatim.
    failures += error.code === 'UNKNOWN_METHOD' ? 0 : 1;
    console.log(`ERROR ${method} → ${error.code}: ${String(error.message).split('\n')[0]}`);
  }
}

await engine.close();
console.log(`engine stderr lines: ${log.length}`);
if (log.length) console.log(log.slice(-6).join('\n'));
console.log(failures ? `ENGINE PROBE FAILED (${failures})` : 'ENGINE PROBE OK');
process.exitCode = failures ? 1 : 0;
