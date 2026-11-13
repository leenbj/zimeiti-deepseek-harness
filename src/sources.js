/**
 * sources.js — dynamic proxy API links ("动态代理"), separate from the IPs they produce.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { EgoError } from './cdp.js';
import { readJson, writeJson } from './store.js';

export class SourceStore {
  constructor(input) {
    this.filePath = join(input.dataDir, 'dynamic-sources.json');
    this.data = readJson(this.filePath, { version: 1, sources: [] });
    if (!this.data || !Array.isArray(this.data.sources)) this.data = { version: 1, sources: [] };
  }

  save() {
    writeJson(this.filePath, this.data);
  }

  list() {
    return this.data.sources;
  }

  get(id) {
    return this.data.sources.find((source) => source.id === id) ?? null;
  }

  first() {
    return this.data.sources[0] ?? null;
  }

  upsert(input) {
    const url = String(input.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw new EgoError('INVALID_SOURCE_URL', 'the API link must start with http:// or https://');
    const existing = input.id ? this.get(String(input.id)) : null;
    const record = existing ?? { id: `s-${randomUUID().slice(0, 6)}`, createdAt: new Date().toISOString() };
    record.label = String(input.label ?? record.label ?? '').trim() || record.id;
    record.url = url;
    record.updatedAt = new Date().toISOString();
    if (!existing) this.data.sources.push(record);
    this.save();
    return record;
  }

  remove(id) {
    const index = this.data.sources.findIndex((source) => source.id === id);
    if (index < 0) return false;
    this.data.sources.splice(index, 1);
    this.save();
    return true;
  }
}
