"use strict";

// Retry timing. Clocks and random sources are injectable for tests.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Backoff: delays base, 2*base, 4*base ... capped at max, each multiplied by
 * a jitter factor in [1-jitter, 1+jitter] and re-capped. A rate-limited
 * failure never waits less than rateLimitFloor.
 */
class Backoff {
  constructor({ base = MINUTE, max = 30 * MINUTE, jitter = 0.2, rateLimitFloor = 15 * MINUTE, random = Math.random } = {}) {
    Object.assign(this, { base, max, jitter, rateLimitFloor, random });
    this.failures = 0;
  }

  next({ rateLimited = false } = {}) {
    this.failures += 1;
    const exp = Math.min(this.max, this.base * 2 ** Math.min(this.failures - 1, 30));
    const factor = 1 + (this.random() * 2 - 1) * this.jitter;
    let delay = Math.min(this.max, Math.round(exp * factor));
    if (rateLimited) delay = Math.max(delay, this.rateLimitFloor);
    return delay;
  }

  reset() {
    this.failures = 0;
  }
}

/** jittered returns interval ±fraction (default ±10%). */
function jittered(intervalMs, fraction = 0.1, random = Math.random) {
  return Math.round(intervalMs * (1 + (random() * 2 - 1) * fraction));
}

/**
 * LoginLimiter allows at most `limit` logins in any rolling `windowMs`.
 * Attempts are kept in the store, so a restart does not reset the limit.
 */
class LoginLimiter {
  constructor({ limit = 3, windowMs = HOUR, now = () => Date.now(), store } = {}) {
    Object.assign(this, { limit, windowMs, now, store });
    const saved = store?.get("loginAttempts");
    this.attempts = Array.isArray(saved) ? saved.filter(Number.isFinite) : [];
  }

  prune(t) {
    this.attempts = this.attempts.filter((a) => t - a < this.windowMs && a <= t);
  }

  tryAcquire() {
    const t = this.now();
    this.prune(t);
    if (this.attempts.length >= this.limit) {
      return { ok: false, retryAfterMs: this.attempts[0] + this.windowMs - t };
    }
    this.attempts.push(t);
    this.store?.update({ loginAttempts: this.attempts });
    return { ok: true };
  }
}

module.exports = { Backoff, HOUR, LoginLimiter, MINUTE, SECOND, jittered };
