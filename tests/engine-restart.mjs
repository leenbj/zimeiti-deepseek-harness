/**
 * engine-restart.mjs — transport-resilience tests for `EngineClient`.
 *
 * The plugin's promise in docs/SPEC.md §7 is that a misbehaving engine must never take the plugin
 * down: a crashed engine has to be restarted transparently on the next call, stray stdout must be
 * logged rather than parsed, events must reach the host, and a hung call must still surface the
 * engine's own stderr so the failure is diagnosable.
 *
 * It drives the deliberately badly-behaved stand-in in `tests/flaky_engine.py` instead of the real
 * engine, so the failure modes are reproducible on demand and this test does not depend on the
 * browser engine being importable.
 *
 * Usage (bundled node):
 *   node tests/engine-restart.mjs
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient, EngineError } from '../src/engine-client.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.MEDIA_PYTHON
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

let failures = 0;
/** @type {string[]} */
const logs = [];
/** @type {object[]} */
const events = [];

/** @param {boolean} ok @param {string} label @param {unknown} [detail] */
function check(ok, label, detail) {
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${suffix}`);
}

/** Wait until `predicate` holds, or give up. @param {() => boolean} predicate */
async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return predicate();
}

const client = new EngineClient({
  pythonPath: PYTHON,
  pluginRoot: PLUGIN_ROOT,
  engineModule: 'tests.flaky_engine',
  requestTimeoutMs: 8_000,
  stderrTailLines: 50,
});
client.on('log', (line) => logs.push(line));
client.on('event', (frame) => events.push(frame));

try {
  // ---- 1. it starts lazily and talks the protocol ----
  const first = await client.call('ping', {});
  check(first.pong === 1, 'first ping answered after a lazy start', first);
  const pidA = first.pid;
  check(Number.isInteger(pidA), 'the engine reports its pid', pidA);

  // ---- 2. stray non-protocol stdout is logged, not fatal ----
  const noisy = await client.call('noise', {});
  check(noisy.survivedNoise === true, 'a non-protocol stdout line does not break the client', noisy);
  check(await waitFor(() => logs.some((l) => l.includes('not JSON at all'))),
    'the stray stdout line was captured as a log line, not parsed as a frame');

  // ---- 3. unsolicited events reach the host (this is how handoff/progress are delivered) ----
  await client.call('event', {});
  check(await waitFor(() => events.some((e) => e.event === 'progress')),
    'a progress event is emitted to the host', events.map((e) => e.event));
  await client.call('handoff', {});
  const handoff = events.find((e) => e.event === 'handoff');
  check(Boolean(handoff), 'a handoff event is emitted to the host');
  check(handoff?.data?.hint?.includes('验证码'), 'the handoff event carries the hint for the operator',
    handoff?.data?.hint);

  // ---- 4. an engine that dies mid-request rejects that call, and the next call restarts it ----
  let died = null;
  try {
    await client.call('die', {});
  } catch (error) {
    died = error;
  }
  check(died instanceof EngineError, 'a dying engine rejects the in-flight call with an EngineError');
  check(died?.code === 'ENGINE_EXITED', 'the rejection code is ENGINE_EXITED', died?.code);
  check(Boolean(died?.message && died.message.includes('引擎进程退出')),
    'the rejection explains that the engine exited', died?.message?.split('\n')[0]);
  check(Boolean(died?.message && died.message.includes('exiting with status 3 as requested')),
    'the rejection carries the engine stderr tail, so it is diagnosable',
    died?.message?.includes('exiting with status 3') ? 'stderr tail present' : 'STDERR TAIL MISSING');
  check(client.running === false, 'the client knows the engine is no longer running');

  const afterDeath = await client.call('ping', {});
  check(Number.isInteger(afterDeath.pong), 'the next call transparently restarts the engine', afterDeath);
  check(afterDeath.pid !== pidA, 'the restarted engine is a new process', { before: pidA, after: afterDeath.pid });

  // ---- 5. a hung call still fails, and killing the engine externally is reported, not swallowed ----
  const hung = client.call('slow', {}, { timeoutMs: 1_500 });
  const timedOut = await hung.then(() => null, (error) => error);
  check(timedOut instanceof EngineError, 'a call that never answers times out');
  check(timedOut?.code === 'ENGINE_TIMEOUT', 'the timeout code is ENGINE_TIMEOUT', timedOut?.code);
  check(client.running === true, 'a timed-out call does not kill the engine');
  const stillAlive = await client.call('ping', {});
  check(Number.isInteger(stillAlive.pong), 'the engine is still usable after a per-call timeout', stillAlive);

  const second = client.call('slow', {}, { timeoutMs: 20_000 });
  await waitFor(() => client.running);
  client.child.kill();
  const killed = await second.then(() => null, (error) => error);
  check(killed instanceof EngineError && killed.code === 'ENGINE_EXITED',
    'an externally killed engine rejects the pending call', killed?.code);
  const recovered = await client.call('ping', {});
  check(recovered.pong === 1, 'the engine is restarted again after being killed externally', recovered);

  // ---- 6. an unknown method surfaces the engine's own error code, not a transport failure ----
  const unknown = await client.call('nope', {}).then(() => null, (error) => error);
  check(unknown instanceof EngineError && unknown.code === 'UNKNOWN_METHOD',
    'an engine-side error code is preserved', unknown?.code);

  // ---- 7. close() is safe and idempotent ----
  await client.close();
  await client.close();
  check(client.running === false, 'close() shuts the engine down and is idempotent');
} catch (error) {
  failures += 1;
  console.error('\nFATAL:', error instanceof EngineError ? `${error.code}: ${error.message}` : error);
} finally {
  await client.close().catch(() => {});
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
