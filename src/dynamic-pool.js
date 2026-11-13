/**
 * dynamic-pool.js — in-memory registry of freshly extracted dynamic IPs.
 *
 * Each entry is valid for the provider's TTL (default 3 minutes); expired entries disappear, so the
 * page can show how many dynamic IPs are still usable right now. Nothing is persisted: an IP that old
 * is worthless after a restart.
 */
export class DynamicPool {
  /** @param {{ ttlMinutes?: () => number }} [input] */
  constructor(input = {}) {
    this.ttlMinutes = input.ttlMinutes ?? (() => 3);
    this.items = new Map();
  }

  add(accountCode, proxy) {
    const ttl = Math.max(1, Number(this.ttlMinutes()) || 3) * 60_000;
    const key = `${proxy.ip}:${proxy.port}`;
    this.items.set(key, {
      ip: proxy.ip,
      port: proxy.port,
      server: proxy.server,
      accountCode,
      at: Date.now(),
      expiresAt: Date.now() + ttl,
    });
    this.prune();
    return key;
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.items) {
      if (entry.expiresAt <= now) this.items.delete(key);
    }
  }

  snapshot() {
    this.prune();
    const now = Date.now();
    const ips = [...this.items.values()]
      .map((entry) => ({
        ip: entry.ip,
        port: entry.port,
        server: entry.server,
        accountCode: entry.accountCode,
        expiresAt: new Date(entry.expiresAt).toISOString(),
        remainingSeconds: Math.max(0, Math.round((entry.expiresAt - now) / 1000)),
      }))
      .sort((a, b) => a.remainingSeconds - b.remainingSeconds);
    return { remaining: ips.length, ttlMinutes: Math.max(1, Number(this.ttlMinutes()) || 3), ips };
  }
}
