type RateLimitBucket = {
  resetAt: number;
  count: number;
};

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retrySeconds: number };

export class RateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly windowSeconds: number,
    private readonly maxUpdates: number,
  ) {}

  check(key: string): RateLimitResult {
    const now = Date.now();
    const windowMs = this.windowSeconds * 1000;
    const bucket = this.buckets.get(key) || { resetAt: now + windowMs, count: 0 };

    if (now >= bucket.resetAt) {
      bucket.resetAt = now + windowMs;
      bucket.count = 0;
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);

    if (bucket.count <= this.maxUpdates) return { ok: true };

    return {
      ok: false,
      retrySeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
}
