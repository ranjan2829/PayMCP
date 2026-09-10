/**
 * Tiny in-memory fixed-window rate limiter for paid routes.
 * Not distributed — suitable for single-process demo / small deploys.
 */
export class SimpleRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Returns true if the key is allowed; false if rate-limited. */
  allow(key: string): boolean {
    if (this.max <= 0) return true;
    const now = Date.now();
    const cur = this.hits.get(key);
    if (cur === undefined || now >= cur.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (cur.count >= this.max) {
      return false;
    }
    cur.count += 1;
    return true;
  }

  reset(): void {
    this.hits.clear();
  }
}
