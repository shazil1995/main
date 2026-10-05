import { HttpError } from './errors.js';

interface Bucket { tokens: number; updated: number }
/** Bounded in-memory token buckets. Per-process; see SECURITY.md for the multi-instance caveat. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private maxKeys = 50_000) {}

  /** Returns header values; throws 429 with Retry-After when empty. */
  take(key: string, perMinute: number): Record<string, string> {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      b = { tokens: perMinute, updated: now };
      this.buckets.set(key, b);
    }
    const rate = perMinute / 60_000;
    b.tokens = Math.min(perMinute, b.tokens + (now - b.updated) * rate);
    b.updated = now;
    const reset = Math.ceil((perMinute - b.tokens) / rate / 1000);
    if (b.tokens < 1) {
      const retry = Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
      throw new HttpError(429, 'rate_limited', 'Rate limit exceeded', { retry_after_seconds: retry }, {
        'retry-after': String(retry), 'ratelimit-limit': String(perMinute), 'ratelimit-remaining': '0', 'ratelimit-reset': String(retry),
      });
    }
    b.tokens -= 1;
    return { 'ratelimit-limit': String(perMinute), 'ratelimit-remaining': String(Math.floor(b.tokens)), 'ratelimit-reset': String(reset) };
  }

  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (now - b.updated > 120_000) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) this.buckets.clear(); // pathological flood: fail open on memory, not on auth
  }
  get size() { return this.buckets.size; }
}
