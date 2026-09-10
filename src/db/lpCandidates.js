import { db } from './connection.js';
import { now, json, safeJson } from '../utils.js';

/**
 * Insert or update the pool-screening result for a token candidate that already
 * passed charon's token-level filter. One row per candidate_id (a candidate that
 * gets re-screened later — e.g. after a pool discovery retry — updates in place).
 */
export function upsertLpCandidate({
  candidateId,
  mint,
  symbol,
  poolsFound,
  bestPool,
  degenScore,
  poolScreenPassed,
  poolRejectReasons,
  pools,
  bestPoolDetail,
}) {
  const status = poolScreenPassed ? 'lp_candidate' : (poolsFound > 0 ? 'pool_rejected' : 'no_pool_found');
  const existing = db.prepare('SELECT id FROM lp_candidates WHERE candidate_id = ?').get(candidateId);

  const fields = {
    mint,
    symbol: symbol || null,
    status,
    updated_at_ms: now(),
    pools_found: poolsFound || 0,
    best_pool_address: bestPool?.address || bestPool?.pool_address || null,
    best_bin_step: bestPool?.bin_step ?? bestPool?.pool_config?.bin_step ?? null,
    best_fee_active_tvl_ratio: bestPoolDetail?.fee_active_tvl_ratio ?? null,
    best_active_tvl: bestPoolDetail?.active_tvl ?? null,
    best_volume_window: bestPoolDetail?.volume_window ?? bestPoolDetail?.volume ?? null,
    degen_score: degenScore ?? null,
    pool_screen_passed: poolScreenPassed ? 1 : 0,
    pool_reject_reasons_json: json(poolRejectReasons || []),
    pools_json: json(pools || []),
    best_pool_detail_json: json(bestPoolDetail || null),
  };

  if (existing) {
    db.prepare(`
      UPDATE lp_candidates SET
        mint = @mint, symbol = @symbol, status = @status, updated_at_ms = @updated_at_ms,
        pools_found = @pools_found, best_pool_address = @best_pool_address,
        best_bin_step = @best_bin_step, best_fee_active_tvl_ratio = @best_fee_active_tvl_ratio,
        best_active_tvl = @best_active_tvl, best_volume_window = @best_volume_window,
        degen_score = @degen_score, pool_screen_passed = @pool_screen_passed,
        pool_reject_reasons_json = @pool_reject_reasons_json, pools_json = @pools_json,
        best_pool_detail_json = @best_pool_detail_json
      WHERE id = @id
    `).run({ ...fields, id: existing.id });
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO lp_candidates (
      candidate_id, mint, symbol, status, created_at_ms, updated_at_ms,
      pools_found, best_pool_address, best_bin_step, best_fee_active_tvl_ratio,
      best_active_tvl, best_volume_window, degen_score, pool_screen_passed,
      pool_reject_reasons_json, pools_json, best_pool_detail_json
    ) VALUES (
      @candidate_id, @mint, @symbol, @status, @created_at_ms, @updated_at_ms,
      @pools_found, @best_pool_address, @best_bin_step, @best_fee_active_tvl_ratio,
      @best_active_tvl, @best_volume_window, @degen_score, @pool_screen_passed,
      @pool_reject_reasons_json, @pools_json, @best_pool_detail_json
    )
  `).run({ ...fields, candidate_id: candidateId, created_at_ms: now() });
  return Number(result.lastInsertRowid);
}

export function lpCandidateByCandidateId(candidateId) {
  const row = db.prepare('SELECT * FROM lp_candidates WHERE candidate_id = ?').get(candidateId);
  return row ? hydrate(row) : null;
}

export function recentLpCandidates(limit = 20, onlyPassed = false) {
  const rows = onlyPassed
    ? db.prepare('SELECT * FROM lp_candidates WHERE pool_screen_passed = 1 ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM lp_candidates ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(hydrate);
}

function hydrate(row) {
  return {
    ...row,
    pools: safeJson(row.pools_json, []),
    bestPoolDetail: safeJson(row.best_pool_detail_json, null),
    poolRejectReasons: safeJson(row.pool_reject_reasons_json, []),
  };
}
