import { Injectable } from "@nestjs/common";

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

/**
 * In-memory fixed-window limiter for login attempts, keyed by normalized
 * email + IP. This is a single-process stand-in only: it does not share
 * state across API instances. Production hardening (Phase 5) should move
 * this to a Redis-backed limiter shared by every instance.
 */
@Injectable()
export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  isBlocked(key: string): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return false;
    if (Date.now() - bucket.windowStartedAt > WINDOW_MS) {
      this.buckets.delete(key);
      return false;
    }
    return bucket.count >= MAX_ATTEMPTS;
  }

  recordAttempt(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket || Date.now() - bucket.windowStartedAt > WINDOW_MS) {
      this.buckets.set(key, { count: 1, windowStartedAt: Date.now() });
      return;
    }
    bucket.count += 1;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}
