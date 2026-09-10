import { db } from './connection.js';
import { now } from '../utils.js';
import { pruneExpiredCache } from './decisions.js';

// ── DB retention ─────────────────────────────────────────────────────────
// charon.sqlite is designed as an insert-only audit log — every signal seen
// (even ones filtered out), every LLM call, every decision branch taken,
// every Telegram send attempt gets its own row with a full JSON blob
// (token metrics, top-20 holders, chart context, raw LLM responses, etc).
// Nothing was ever deleted, so the file only grows. This module prunes the
// tables that are pure telemetry/audit trail on a rolling window. It never
// touches trading history — dry_run_positions / dry_run_trades are kept
// forever since that's the actual PnL record.

const DAY_MS = 24 * 60 * 60 * 1000;

// table -> [timestamp column, max age]
const RETENTION = {
  candidates: ['created_at_ms', 2 * DAY_MS],      // raw signal snapshots incl. filtered/rejected — no lasting value
  decision_logs: ['at_ms', 3 * DAY_MS],           // decision audit trail — kept longer, useful for debugging
  signal_events: ['at_ms', 1 * DAY_MS],            // high-volume trending/poll telemetry
  alerts: ['sent_at_ms', 4 * DAY_MS],             // telegram send log
  llm_decisions: ['created_at_ms', 3 * DAY_MS],
  llm_batches: ['created_at_ms', 3 * DAY_MS],
};

// Prune each telemetry table down to its retention window. Returns
// { table: rowsDeleted } so callers (CLI, scheduled job) can log/report it.
export function pruneOldRows() {
  const results = { decision_cache: pruneExpiredCache() };
  for (const [table, [col, maxAgeMs]] of Object.entries(RETENTION)) {
    const cutoff = now() - maxAgeMs;
    let result;
    if (table === 'candidates') {
      // Never delete a candidate row still referenced by ANY position, open or closed —
      // or, in Charonsol, by any lp_candidates row (which the backtest/filter-report tools
      // both depend on for candidate_json). dry_run_positions is charon's own table for
      // this same protection, kept here for anyone who reintroduces real position tracking
      // later — but it's PERMANENTLY EMPTY in Charonsol (nothing writes to it; positions.js
      // is dead code here), so on its own that clause excluded nothing at all: every
      // candidates row older than 2 days was being deleted unconditionally, silently
      // breaking backtest.js's LEFT JOIN and filter-report's token-level analysis for
      // anything older than the window. Fixed 2026-08-28 by adding the lp_candidates check.
      result = db.prepare(`
        DELETE FROM candidates
        WHERE created_at_ms < ?
          AND id NOT IN (SELECT candidate_id FROM dry_run_positions WHERE candidate_id IS NOT NULL)
          AND id NOT IN (SELECT candidate_id FROM lp_candidates WHERE candidate_id IS NOT NULL)
      `).run(cutoff);
    } else {
      result = db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(cutoff);
    }
    results[table] = result.changes;
  }
  return results;
}

// Reclaims disk space DELETEs leave behind (SQLite doesn't shrink the file
// on its own). This rewrites the whole DB file and briefly locks it — don't
// call it from inside the live trading loop. Meant for `npm run vacuum` or
// a weekly cron entry run against the file directly.
export function vacuumDb() {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
}

// Row counts + on-disk file size, for `npm run dbsize` / quick diagnosis.
export function dbStats() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  const counts = {};
  for (const t of tables) {
    counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  }
  const pageCount = db.pragma('page_count', { simple: true });
  const pageSize = db.pragma('page_size', { simple: true });
  const freelist = db.pragma('freelist_count', { simple: true });
  return {
    counts,
    fileBytes: pageCount * pageSize,
    reclaimableBytes: freelist * pageSize,
  };
}
