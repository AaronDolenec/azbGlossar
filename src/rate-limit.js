'use strict';

// Sliding-window limiter: at most `max` hits per `windowMs` for each key.
class RateLimiter {
  constructor({ max, windowMs, now = Date.now }) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  // Records a hit. Returns 0 if allowed, otherwise the seconds until the
  // oldest counted hit leaves the window (always at least 1).
  hit(key) {
    const t = this.now();
    const recent = (this.hits.get(key) || []).filter((ts) => ts > t - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + this.windowMs - t) / 1000));
    }
    recent.push(t);
    this.hits.set(key, recent);
    return 0;
  }

  // Drops keys with no hits left in the window, so memory stays bounded.
  sweep() {
    const cutoff = this.now() - this.windowMs;
    for (const [key, list] of this.hits) {
      if (!list.some((ts) => ts > cutoff)) this.hits.delete(key);
    }
  }
}

module.exports = { RateLimiter };
