// Postgres-backed store for express-rate-limit.
//
// The app runs on Vercel serverless, where each invocation may be a fresh
// instance — so the library's default in-memory store cannot enforce a real
// limit (every cold start resets the counter). This store keeps the counters
// in the shared Postgres database instead, so a limit like "4 per 15 min per
// IP" is enforced across every serverless instance.
//
// A single atomic upsert both counts the hit and rolls the window when it has
// expired, so concurrent requests can't race past the limit.

const pool = require('../db/pool');

// Create the counter table once per process. Memoized; on failure the promise
// is cleared so the next call retries rather than caching a rejection forever.
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool
      .query(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          key        TEXT PRIMARY KEY,
          hits       INTEGER NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL
        )
      `)
      .catch((err) => {
        tableReady = null;
        throw err;
      });
  }
  return tableReady;
}

class PgRateLimitStore {
  // `prefix` namespaces one limiter's keys from another's in the shared table.
  constructor({ prefix = 'rl', windowMs } = {}) {
    this.prefix = prefix;
    this.windowMs = windowMs;
  }

  // Called by express-rate-limit with the resolved options; gives us windowMs
  // when it wasn't supplied to the constructor.
  init(options) {
    if (this.windowMs == null) this.windowMs = options.windowMs;
  }

  key(k) {
    return `${this.prefix}:${k}`;
  }

  async increment(key) {
    await ensureTable();
    const { rows } = await pool.query(
      `INSERT INTO rate_limits (key, hits, expires_at)
       VALUES ($1, 1, now() + ($2::double precision * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.expires_at <= now()
                     THEN 1 ELSE rate_limits.hits + 1 END,
         expires_at = CASE WHEN rate_limits.expires_at <= now()
                           THEN now() + ($2::double precision * interval '1 millisecond')
                           ELSE rate_limits.expires_at END
       RETURNING hits, expires_at`,
      [this.key(key), this.windowMs]
    );

    // Occasionally sweep expired rows so the table doesn't grow unbounded with
    // one-off IPs. Best-effort; failures are ignored.
    if (Math.random() < 0.02) {
      pool.query('DELETE FROM rate_limits WHERE expires_at <= now()').catch(() => {});
    }

    return { totalHits: rows[0].hits, resetTime: new Date(rows[0].expires_at) };
  }

  async decrement(key) {
    await ensureTable();
    await pool.query(
      'UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1 AND expires_at > now()',
      [this.key(key)]
    );
  }

  async resetKey(key) {
    await ensureTable();
    await pool.query('DELETE FROM rate_limits WHERE key = $1', [this.key(key)]);
  }
}

module.exports = PgRateLimitStore;
