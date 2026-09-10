import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';
import { numSetting, setting } from './settings.js';

export function candidateSignalKey(candidate, signature = null) {
  const route = candidate.signals?.route || 'signal';
  const bucket = Math.floor(Number(candidate.createdAtMs || now()) / (5 * 60 * 1000));
  const sigFragment = signature ? `:${signature.slice(0, 16)}` : '';
  return `${route}:${candidate.token.mint}:${bucket}${sigFragment}`;
}

export function upsertCandidate(candidate, signature) {
  const signalKey = candidateSignalKey(candidate, signature);
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM candidates WHERE signal_key = ?').get(signalKey);
    if (existing) {
      db.prepare(`
        UPDATE candidates
        SET status = ?, updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
        WHERE id = ?
      `).run(
        candidate.filters.passed ? 'candidate' : 'filtered',
        now(),
        json(candidate),
        json(candidate.filters),
        existing.id,
      );
      return existing.id;
    }

    try {
      const result = db.prepare(`
        INSERT INTO candidates (mint, status, created_at_ms, updated_at_ms, signature, signal_key, candidate_json, filter_result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.token.mint,
        candidate.filters.passed ? 'candidate' : 'filtered',
        now(),
        now(),
        signature,
        signalKey,
        json(candidate),
        json(candidate.filters),
      );
      return Number(result.lastInsertRowid);
    } catch (err) {
      // signal_key embeds the route (see candidateSignalKey above), but the table's own
      // constraint is UNIQUE(signature, mint) — route-agnostic. Two different routes seeing the
      // SAME underlying transaction for the SAME mint (now genuinely likely with ALL routes
      // unblocked at once) produce two different signal_keys but the same (signature, mint)
      // pair, so the signal_key check above says "new" while the table itself rejects it.
      // Without this, the candidate was silently lost. If this is genuinely that specific
      // collision (not some other constraint failure), fall back to updating the row that
      // already holds this (signature, mint) instead of losing the candidate. Re-throws
      // anything that isn't this specific, known case.
      if (!(err.code === 'SQLITE_CONSTRAINT_UNIQUE' && signature)) throw err;
      const bySignature = db.prepare('SELECT id FROM candidates WHERE signature = ? AND mint = ?').get(signature, candidate.token.mint);
      if (!bySignature) throw err; // genuinely a different constraint violation — don't mask it
      db.prepare(`
        UPDATE candidates
        SET status = ?, updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
        WHERE id = ?
      `).run(
        candidate.filters.passed ? 'candidate' : 'filtered',
        now(),
        json(candidate),
        json(candidate.filters),
        bySignature.id,
      );
      return bySignature.id;
    }
  })();
}

export function updateCandidateStatus(candidateId, status) {
  db.prepare('UPDATE candidates SET status = ?, updated_at_ms = ? WHERE id = ?').run(status, now(), candidateId);
}

export function updateCandidateSnapshot(candidateId, candidate, status = null) {
  db.prepare(`
    UPDATE candidates
    SET status = COALESCE(?, status), updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
    WHERE id = ?
  `).run(status, now(), json(candidate), json(candidate.filters || {}), candidateId);
}

export function candidateById(id) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}

export function candidatesByIds(ids) {
  return ids.map(id => candidateById(Number(id))).filter(Boolean);
}

export function latestCandidateByMint(mint) {
  const row = db.prepare('SELECT * FROM candidates WHERE mint = ? ORDER BY id DESC LIMIT 1').get(mint);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}

// Hard floor — applies regardless of preferred_routes, so a route blocked here for
// structural/profitability reasons can't be re-enabled just by adding it to a preference list.
// pumpfun_pregrad: pre-grad tokens still on bonding curve, can't reliably trade yet — keep for
// data only. Exported so BOTH recentEligibleCandidates() (the LLM-batch path's SQL query) and
// isRouteEligible() (a single-candidate check, for the rule-based path below) share the exact
// same list — no risk of the two drifting apart the way they did before this fix.
// export const BLOCKED_ROUTES = ['dual_source', 'fee_graduated_trending', 'pumpfun_pregrad', 'graduated_trending'];
export const BLOCKED_ROUTES = [];

function parsePreferredRoutes() {
  return setting('preferred_routes', '')
    .split(',')
    .map(r => r.trim())
    .filter(Boolean)
    .filter(r => {
      const valid = /^[a-z0-9_]+$/.test(r);
      if (!valid) console.log(`[candidate] ignoring invalid route "${r}" in preferred_routes (must be lowercase letters/digits/underscore)`);
      return valid;
    });
}

// BUG FIX (2026-08-11, found via a real closed trade that shouldn't have existed): rule-based
// strategies (use_llm: false) never called recentEligibleCandidates() at all — they bought
// whatever candidate triggered the pass directly, via candidateById(), completely bypassing
// BLOCKED_ROUTES and preferred_routes. Confirmed on two real production trades: one on
// pumpfun_pregrad, one on dual_source — the single worst-performing route in every backtest run
// this project has done. This is the single-candidate equivalent of the SQL-level check above,
// for orchestrator.js's rule-based branch to call directly.
export function isRouteEligible(route) {
  if (!route) return true; // fail-open on missing route data, same posture as the rest of the filter pipeline
  if (BLOCKED_ROUTES.includes(route)) return false;
  const preferredRoutes = parsePreferredRoutes();
  if (preferredRoutes.length && !preferredRoutes.includes(route)) return false;
  return true;
}

export function recentEligibleCandidates(limit = 10) {
  const maxAgeMs = numSetting('llm_candidate_max_age_ms', 10 * 60 * 1000);
  const cutoff = now() - Math.max(30_000, maxAgeMs);
  // Lesson #3: block unprofitable routes at query level — prevents blocked routes from drowning out profitable ones
  const blockedClause = BLOCKED_ROUTES.map(r => `signal_key NOT LIKE '${r}:%'`).join(' AND ');

  // Optional allowlist on top of the block floor above — set via `npm run setting -- preferred_routes
  // <route1,route2,...>` to only trade specific routes (e.g. just pumpportal_graduated) without
  // touching code. Candidates from other routes still get built/logged/scored (useful for
  // backtesting later) — they just never reach the LLM or a buy. Empty/unset = no restriction,
  // same as before this existed. Route names are validated against [a-z0-9_]+ before use in SQL —
  // this setting is user-editable, unlike the hardcoded BLOCKED_ROUTES array above.
  const preferredRoutes = parsePreferredRoutes();
  const preferredClause = preferredRoutes.length
    ? `(${preferredRoutes.map(r => `signal_key LIKE '${r}:%'`).join(' OR ')})`
    : '1=1';

  const rows = db.prepare(`
    SELECT c.*
    FROM candidates c
    INNER JOIN (
      SELECT mint, MAX(id) as max_id
      FROM candidates
      WHERE status IN ('candidate', 'watch', 'buy', 'pass')
        AND created_at_ms >= ?
        AND id NOT IN (SELECT COALESCE(candidate_id, -1) FROM dry_run_positions WHERE status = 'open')
        AND ${blockedClause}
        AND ${preferredClause}
        AND (
          json_extract(candidate_json, '$.filters.passed') IS NULL
          OR json_extract(candidate_json, '$.filters.passed') = 1
        )
      GROUP BY mint
    ) latest ON c.id = latest.max_id
    ORDER BY c.id DESC
    LIMIT ?
  `).all(cutoff, limit);
  return rows.map(row => ({ ...row, candidate: safeJson(row.candidate_json, {}) })).reverse();
}
