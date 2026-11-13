/**
 * checks.js — post-publish checks: wait, verify the link, then sample points.
 *
 * Publishing does not update 积分 immediately: the article has to clear review, and only a valid link
 * means the post is really live. So a publish schedules one check at `linkCheckDelayMinutes` (default
 * 60). The check opens a background tab, verifies the URL is not a 404, and — only when the link is
 * valid — refreshes the account's 积分. An invalid link is retried a few times, one interval apart.
 *
 * Checks are persisted in `<dataDir>/checks.json` and re-armed when the plugin starts, so a Harness
 * restart does not lose them.
 *
 * @module ego-publish/checks
 */
import { join } from 'node:path';

import { sleep } from './cdp.js';
import { refreshAccountPoints } from './points.js';
import { readJson, writeJson } from './store.js';

const MAX_ATTEMPTS = 6;
const KEEP_RECORDS = 50;

/** Public projection for status/UI. */
function publicCheck(record) {
  return {
    id: record.id,
    accountCode: record.accountCode,
    title: record.title ?? '',
    url: record.url ?? null,
    dueAt: record.dueAt,
    attempts: record.attempts ?? 0,
    status: record.status ?? 'pending',
    link: record.link ?? null,
    points: record.points ? { value: record.points.value, at: record.points.at } : null,
    error: record.error ?? null,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt ?? null,
  };
}

export class CheckScheduler {
  /**
   * @param {{ dataDir: string, manager: any, accounts: any, configStore: any, log?: (line: string) => void }} input
   */
  constructor(input) {
    this.dataDir = input.dataDir;
    this.manager = input.manager;
    this.accounts = input.accounts;
    this.configStore = input.configStore;
    this.log = input.log ?? (() => {});
    this.filePath = join(input.dataDir, 'checks.json');
    this.data = readJson(this.filePath, { version: 1, checks: [] });
    if (!this.data || !Array.isArray(this.data.checks)) this.data = { version: 1, checks: [] };
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timers = new Map();
  }

  save() {
    const keep = this.data.checks.slice(-KEEP_RECORDS);
    this.data.checks = keep;
    writeJson(this.filePath, this.data);
  }

  /** Every known check, newest last. */
  list() {
    return this.data.checks.map(publicCheck);
  }

  /** The pending check for one account, if any. */
  pendingFor(code) {
    return this.list().filter((item) => item.accountCode === code && (item.status === 'pending' || item.status === 'running')).pop() ?? null;
  }

  get dueMinutes() {
    const value = Number(this.configStore.values().linkCheckDelayMinutes);
    return Number.isFinite(value) && value > 0 ? value : 60;
  }

  /**
   * Queue a check for a finished publish.
   * @param {{ accountCode: string, url?: string|null, title?: string, flowId?: string, delayMinutes?: number }} input
   */
  schedule(input) {
    const requested = Number(input.delayMinutes);
    const minutes = Number.isFinite(requested) && requested >= 0 ? requested : this.dueMinutes;
    const dueAt = new Date(Date.now() + minutes * 60_000).toISOString();
    const record = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      accountCode: String(input.accountCode),
      url: input.url ? String(input.url) : null,
      title: input.title ? String(input.title) : '',
      flowId: input.flowId ? String(input.flowId) : '',
      dueAt,
      attempts: 0,
      status: 'pending',
      link: null,
      points: null,
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.data.checks.push(record);
    this.save();
    this.arm(record);
    this.log(`check scheduled for ${record.accountCode} at ${dueAt}${record.url ? ` (${record.url})` : ''}`);
    return publicCheck(record);
  }

  /** Run one check immediately (manual trigger). */
  async runNow(id) {
    return this.run(id);
  }

  /** @param {Record<string, any>} record */
  arm(record) {
    const existing = this.timers.get(record.id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, new Date(record.dueAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(record.id);
      void this.run(record.id).catch((error) => this.log(`check ${record.id} failed: ${error?.message ?? error}`));
    }, delay);
    timer.unref?.();
    this.timers.set(record.id, timer);
  }

  /** Re-arm pending checks after a restart; overdue ones run almost immediately. */
  rearmAll() {
    for (const record of this.data.checks) {
      if (record.status === 'pending' || record.status === 'running') {
        record.status = 'pending';
        if (!record.dueAt || new Date(record.dueAt).getTime() < Date.now()) {
          record.dueAt = new Date(Date.now() + 10_000).toISOString();
        }
        this.arm(record);
      }
    }
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** @param {string} id */
  async run(id) {
    const record = this.data.checks.find((item) => item.id === id);
    if (!record || record.status === 'done' || record.status === 'link-timeout') return publicCheck(record ?? {});
    record.attempts = (record.attempts ?? 0) + 1;
    record.status = 'running';
    this.save();

    const link = await this.verifyLink(record).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
    record.link = link;

    // Console/preview URLs are not public yet; treat them as "cannot verify" and still sample points.
    const unverifiable = link?.ok === null;
    if (link?.ok === false && !unverifiable) {
      if (record.attempts < MAX_ATTEMPTS) {
        record.status = 'pending';
        record.dueAt = new Date(Date.now() + this.dueMinutes * 60_000).toISOString();
        record.error = `link not live yet (attempt ${record.attempts}/${MAX_ATTEMPTS}); will retry`;
        this.save();
        this.arm(record);
        return publicCheck(record);
      }
      record.status = 'link-timeout';
      record.error = `link never became valid after ${MAX_ATTEMPTS} attempts`;
      record.finishedAt = new Date().toISOString();
      this.save();
      return publicCheck(record);
    }

    try {
      const points = await refreshAccountPoints({ manager: this.manager, accounts: this.accounts, log: this.log }, record.accountCode);
      record.points = { value: points.value, at: points.at };
      record.status = 'done';
      record.error = null;
    } catch (error) {
      record.status = 'error';
      record.error = String(error?.message ?? error);
    }
    record.finishedAt = new Date().toISOString();
    this.save();
    this.log(`check ${record.id} for ${record.accountCode}: ${record.status}${record.points ? ` points=${record.points.value}` : ''}`);
    return publicCheck(record);
  }

  /**
   * Resolve a public article URL by searching the account console for the title.
   * Sohu's public URL is `https://www.sohu.com/a/<articleId>_<accountId>`; the console preview link
   * exposes both ids, but the list is virtualised — so search first instead of trusting row order.
   * @param {any} page
   * @param {string} title
   */
  async resolveTitleUrl(page, title) {
    const wanted = String(title).trim();
    if (!wanted) return null;
    await page.goto('https://mp.sohu.com/mpfe/v4/contentManagement/first/page', { waitUntil: 'domcontentloaded', timeoutMs: 45000 });
    await sleep(2000);
    const search = await page.evaluate(`(() => {
      const el = [...document.querySelectorAll('input')].find((input) => (input.placeholder || '').includes('关键词'));
      if (!el) return null;
      el.focus();
      return true;
    })()`, undefined, { timeoutMs: 10000 });
    if (search) {
      await page.typeText(wanted.slice(0, 30));
      await page.press('Enter');
      await sleep(2500);
    }
    const found = await page.evaluate(`(() => {
      const wanted = ${JSON.stringify(wanted.slice(0, 24))};
      const links = [...document.querySelectorAll('a[href*="articlepreview"]')];
      const link = links.find((a) => (a.innerText || '').trim().includes(wanted));
      if (!link) return null;
      const id = (link.href.match(/[?&]id=(\\d+)/) || [])[1];
      const account = (link.href.match(/[?&]accountId=(\\d+)/) || [])[1];
      return id && account ? 'https://www.sohu.com/a/' + id + '_' + account : null;
    })()`, undefined, { timeoutMs: 15000 });
    return found || null;
  }

  /**
   * Open the public link in a background tab of the account browser, resolving it by title when the
   * flow could not provide one.
   * @param {Record<string, any>} record
   */
  async verifyLink(record) {
    const isConsole = record.url && /mp\.sohu\.com|contentManagement|articlepreview/i.test(record.url);
    if (!record.url && !record.title) return { ok: null, reason: 'no url or title to resolve' };
    if (isConsole && !record.title) return { ok: null, reason: 'console url without a title to resolve' };

    let opened = false;
    let session = this.manager.get(record.accountCode);
    if (!session) {
      session = await this.manager.open(record.accountCode, { headless: true });
      opened = true;
    }
    let background = null;
    try {
      background = await this.manager.createBackgroundPage(record.accountCode);
      const { page } = background;
      let target = isConsole ? null : record.url;
      let resolved = false;
      if (!target && record.title) {
        target = await this.resolveTitleUrl(page, record.title);
        resolved = Boolean(target);
      }
      if (!target) return { ok: null, reason: 'public url not found yet', resolved };
      await page.goto(target, { waitUntil: 'domcontentloaded', timeoutMs: 45000 });
      await sleep(1200);
      const info = await page.evaluate(`({
        url: document.location.href,
        title: document.title,
        text: (document.body.innerText || '').slice(0, 600)
      })`, undefined, { timeoutMs: 15000 });
      const blob = `${info?.title ?? ''} ${info?.text ?? ''}`;
      const missing = /404|页面不存在|内容不存在|已删除|无法访问|not found/i.test(blob);
      return { ok: !missing, url: info?.url ?? target, target, resolved, title: info?.title ?? '', reason: missing ? 'page looks missing' : 'reachable' };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      if (background) await background.close().catch(() => {});
      if (opened) await this.manager.close(record.accountCode).catch(() => {});
    }
  }
}
