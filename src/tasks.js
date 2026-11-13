/**
 * tasks.js — saved browser tasks (the "任务" tab).
 *
 * A task is a small, editable recipe: an account, an optional start URL, and a JavaScript body that
 * runs inside that account's ego page. Running it uses the account's static proxy, or extracts a fresh
 * dynamic IP first when the account is in dynamic mode.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { EgoError, sleep } from './cdp.js';
import { readJson, writeJson } from './store.js';

export class TaskStore {
  /** @param {{ dataDir: string }} input */
  constructor(input) {
    this.filePath = join(input.dataDir, 'tasks.json');
    this.data = readJson(this.filePath, { version: 1, tasks: [] });
    if (!this.data || !Array.isArray(this.data.tasks)) this.data = { version: 1, tasks: [] };
  }

  save() {
    writeJson(this.filePath, this.data);
  }

  list() {
    return this.data.tasks;
  }

  get(id) {
    return this.data.tasks.find((task) => task.id === id) ?? null;
  }

  /**
   * @param {Record<string, any>} input
   */
  upsert(input) {
    const id = String(input.id || `t-${randomUUID().slice(0, 8)}`);
    const existing = this.get(id);
    const record = existing ?? { id, createdAt: new Date().toISOString(), lastRun: null };
    record.title = String(input.title ?? record.title ?? '未命名任务');
    record.description = String(input.description ?? record.description ?? '');
    record.accountCode = String(input.accountCode ?? record.accountCode ?? '');
    record.url = String(input.url ?? record.url ?? '');
    record.script = String(input.script ?? record.script ?? '');
    record.proxyMode = ['account', 'dynamic', 'static'].includes(input.proxyMode) ? input.proxyMode : (record.proxyMode ?? 'account');
    record.proxyId = String(input.proxyId ?? record.proxyId ?? '');
    record.updatedAt = new Date().toISOString();
    if (!existing) this.data.tasks.push(record);
    this.save();
    return record;
  }

  remove(id) {
    const index = this.data.tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    this.data.tasks.splice(index, 1);
    this.save();
    return true;
  }

  markRun(id, result) {
    const task = this.get(id);
    if (!task) return null;
    task.lastRun = { at: new Date().toISOString(), ...result };
    this.save();
    return task;
  }
}

function taskOptions(task, deps) {
  if (task.proxyMode === 'dynamic') return { forceDynamic: true };
  if (task.proxyMode === 'static' && task.proxyId) {
    const entry = deps.proxies?.get(task.proxyId);
    if (!entry) throw new EgoError('PROXY_NOT_FOUND', `static proxy "${task.proxyId}" no longer exists`);
    return { proxyOverride: { server: entry.server, username: entry.username, password: entry.password } };
  }
  return {};
}

/**
 * Run one task in its account browser.
 * @param {{ manager: any, accounts: any, tasks: TaskStore, settings: any, log?: (line: string) => void }} deps
 * @param {string} id
 */
export async function runTask(deps, id) {
  const task = deps.tasks.get(id);
  if (!task) throw new EgoError('TASK_NOT_FOUND', `no task with id "${id}"`);
  if (!task.accountCode) throw new EgoError('TASK_NO_ACCOUNT', 'the task has no account');
  if (!deps.accounts.get(task.accountCode)) throw new EgoError('ACCOUNT_NOT_FOUND', `no account "${task.accountCode}"`);
  const { page } = await deps.manager.open(task.accountCode, taskOptions(task, deps));
  if (task.url) {
    await page.goto(task.url, { waitUntil: 'domcontentloaded', timeoutMs: deps.settings.navigationTimeoutMs });
    await sleep(800);
  }
  let result = null;
  if (task.script.trim()) {
    result = await page.evaluate(`(async () => {\n${task.script}\n})()`, undefined, { timeoutMs: 180_000 });
  }
  const summary = { ok: true, url: await page.url().catch(() => null), title: await page.title().catch(() => null), result };
  deps.tasks.markRun(id, { ok: true, message: 'ok', url: summary.url });
  return { task, ...summary };
}
