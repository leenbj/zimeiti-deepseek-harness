/**
 * checks-check.mjs — schedule bookkeeping for post-publish checks (no browser is launched).
 *
 *   node tests/checks-check.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const dataDir = mkdtempSync(join(tmpdir(), 'ego-publish-checks-'));
const { CheckScheduler } = await import('../src/checks.js');

const configStore = { values: () => ({ linkCheckDelayMinutes: 60 }) };
const scheduler = new CheckScheduler({ dataDir, manager: {}, accounts: {}, configStore, log: () => {} });

const before = Date.now();
const check = scheduler.schedule({ accountCode: 'a-1', url: 'https://example.com/a/1', title: 't', flowId: 'f' });
const due = new Date(check.dueAt).getTime();
record('check scheduled ~60m out', due >= before + 59 * 60_000 && due <= before + 61 * 60_000, check.dueAt);
record('check is pending with an id', check.status === 'pending' && typeof check.id === 'string' && check.id.startsWith('c-'));
record('check persisted', JSON.parse(readFileSync(join(dataDir, 'checks.json'), 'utf8')).checks.length === 1);
record('pendingFor finds it', scheduler.pendingFor('a-1')?.id === check.id);
record('list projects public fields', Object.keys(scheduler.list()[0]).includes('dueAt') && !('flowId' in scheduler.list()[0]));

// An overdue record is re-armed for the near future instead of being lost.
const data = JSON.parse(readFileSync(join(dataDir, 'checks.json'), 'utf8'));
data.checks[0].dueAt = new Date(Date.now() - 3_600_000).toISOString();
data.checks[0].status = 'pending';
const { writeFileSync } = await import('node:fs');
writeFileSync(join(dataDir, 'checks.json'), JSON.stringify(data));
const second = new CheckScheduler({ dataDir, manager: {}, accounts: {}, configStore, log: () => {} });
second.rearmAll();
const rearmed = new Date(second.list()[0].dueAt).getTime();
record('overdue check re-armed soon', rearmed > Date.now() && rearmed < Date.now() + 60_000, second.list()[0].dueAt);
scheduler.dispose();
second.dispose();
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
