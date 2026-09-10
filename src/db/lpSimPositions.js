import { db } from './connection.js';

/**
 * Creates a new simulated LP position with entry price tracking.
 */
export function createLpSimPosition({
  lpCandidateId,
  notionalUsd,
  binStep,
  poolAddress,
  entryPriceUsd = 0,
}) {
  const stmt = db.prepare(`
    INSERT INTO lp_sim_positions (
      lp_candidate_id,
      status,
      notional_usd,
      realized_fee_usd,
      bin_step,
      pool_address,
      entry_price_usd,
      current_price_usd,
      il_usd,
      net_pnl_usd,
      is_out_of_range,
      opened_at_ms
    ) VALUES (?, 'open', ?, 0, ?, ?, ?, ?, 0, 0, 0, ?)
  `);

  const info = stmt.run(
    lpCandidateId,
    notionalUsd,
    binStep,
    poolAddress,
    entryPriceUsd,
    entryPriceUsd, // current_price_usd initialized to entry_price_usd
    Date.now()
  );

  return info.lastInsertRowid;
}

/**
 * Updates position state during health checks with latest fees, prices, IL, and net PnL.
 */
export function updateLpSimPositionHealth({
  id,
  realizedFeeUsd,
  currentPriceUsd,
  ilUsd,
  netPnlUsd,
  isOutOfRange,
}) {
  const stmt = db.prepare(`
    UPDATE lp_sim_positions
    SET 
      realized_fee_usd = ?,
      current_price_usd = ?,
      il_usd = ?,
      net_pnl_usd = ?,
      is_out_of_range = ?
    WHERE id = ?
  `);

  stmt.run(
    realizedFeeUsd,
    currentPriceUsd,
    ilUsd,
    netPnlUsd,
    isOutOfRange ? 1 : 0,
    id
  );
}

/**
 * Closes simulated LP position with final realized figures.
 */
export function closeLpSimPosition({
  id,
  closeReason,
  realizedFeeUsd,
  currentPriceUsd,
  ilUsd,
  netPnlUsd,
  holdMs,
}) {
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE lp_sim_positions
    SET 
      status = 'closed',
      close_reason = ?,
      realized_fee_usd = ?,
      current_price_usd = ?,
      il_usd = ?,
      net_pnl_usd = ?,
      hold_ms = ?,
      closed_at_ms = ?
    WHERE id = ?
  `);

  stmt.run(
    closeReason,
    realizedFeeUsd,
    currentPriceUsd,
    ilUsd,
    netPnlUsd,
    holdMs,
    now,
    id
  );
}

/**
 * Retrieves recent simulated LP positions for CLI reporting.
 * @param {number} limit 
 */
export function recentSimPositions(limit = 20) {
  return db.prepare(`
    SELECT 
      s.*,
      s.pool_address,
      c.candidate_json
    FROM lp_sim_positions s
    LEFT JOIN lp_candidates lc ON lc.id = s.lp_candidate_id
    LEFT JOIN candidates c ON c.id = lc.candidate_id
    ORDER BY s.id DESC
    LIMIT ?
  `).all(limit);
}