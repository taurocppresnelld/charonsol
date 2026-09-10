import { db } from './connection.js';
import { now, json, safeJson } from '../utils.js';

// Bounds snapshots_json per position — at a ~15min default poll interval this covers
// several days of history (well past any reasonable max_hold), while keeping a single
// position row from growing unboundedly if monitoring somehow runs far longer than
// expected. Oldest snapshots drop first; accrued_fee_usd itself is a running total that's
// never affected by trimming the audit array.
const MAX_SNAPSHOTS = 500;

export function hasOpenSimPositionForMint(mint) {
  return !!db.prepare("SELECT 1 FROM lp_sim_positions WHERE mint = ? AND status = 'open' LIMIT 1").get(mint);
}

export function openSimPosition({
  lpCandidateId, mint, symbol, poolAddress, binStep, timeframe, notionalUsd,
  entryActiveTvl, entryFeeActiveTvlRatio, entryVolumeWindow, entryDegenScore,
}) {
  const existing = db.prepare('SELECT id FROM lp_sim_positions WHERE lp_candidate_id = ?').get(lpCandidateId);
  if (existing) return existing.id; // idempotent — never open two sim positions for the same lp_candidate

  // One open position per underlying token at a time — not per pool. A mint can have
  // several real Meteora pools (pools_found > 1 isn't rare), and pool/screening.js's
  // pickBestPool() already picks the single best one per screening pass, so a second
  // pool for the same mint isn't a second thing worth tracking, it's the same asset.
  // Without this check, a mint that gets re-detected as a "new" candidate by any signal
  // source whose poll interval outlasts the 10-minute recentCandidate dedup window in
  // lpOrchestrator.js opens a fresh, fully-independent position every time it recurs —
  // confirmed directly in a real log: one token was re-flagged 11 times over ~3 hours
  // (re-poll intervals of 10.5-29.8 min, all just past the 10-min window), so when its
  // pool actually drained, 5 supposedly-independent positions all closed within 19
  // seconds of each other. That's 5 correlated re-observations of one real event, not 5
  // independent trials — exactly the kind of thing that quietly inflates backtest.js's
  // apparent sample size and confidence. This check stops it at the source.
  if (hasOpenSimPositionForMint(mint)) return null;

  const ts = now();
  const result = db.prepare(`
    INSERT INTO lp_sim_positions (
      lp_candidate_id, mint, symbol, pool_address, bin_step, timeframe, status, notional_usd,
      opened_at_ms, entry_active_tvl, entry_fee_active_tvl_ratio, entry_volume_window,
      entry_degen_score, last_snapshot_at_ms, last_active_tvl, last_fee_active_tvl_ratio,
      last_volume_window, last_fee_increase_at_ms, snapshots_json
    ) VALUES (
      @lpCandidateId, @mint, @symbol, @poolAddress, @binStep, @timeframe, 'open', @notionalUsd,
      @ts, @entryActiveTvl, @entryFeeActiveTvlRatio, @entryVolumeWindow, @entryDegenScore,
      @ts, @entryActiveTvl, @entryFeeActiveTvlRatio, @entryVolumeWindow, @ts, '[]'
    )
  `).run({
    lpCandidateId, mint, symbol: symbol || null, poolAddress, binStep: binStep ?? null, timeframe,
    notionalUsd, ts, entryActiveTvl: entryActiveTvl ?? null, entryFeeActiveTvlRatio: entryFeeActiveTvlRatio ?? null,
    entryVolumeWindow: entryVolumeWindow ?? null, entryDegenScore: entryDegenScore ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function openSimPositions() {
  return db.prepare("SELECT * FROM lp_sim_positions WHERE status = 'open' ORDER BY id ASC").all().map(hydrate);
}

/**
 * Apply one monitoring snapshot to an open position: append the snapshot, add whatever
 * fee accrued since the last snapshot, bump range-tracking counters, and update the
 * lifetime-fee-increase clock (ported from meridian's fee-stall-guard.js — see that
 * file's header comment for why "time since fees last increased" catches a stall that a
 * trailing average would miss). accrued_fee_usd IS the lifetime-fee total here (it only
 * ever grows via this function), so — unlike meridian, which reconciles separate
 * claimed/unclaimed figures to get that total — this period's feeAccruedUsd on its own
 * is already the "did it genuinely increase" signal: no claim-timing artifact to guard
 * against, since a dry-run position never actually claims anything.
 * Does NOT decide whether to close — that's the caller's job (see lpSimulator.js's exit-
 * rule checks), this just records state.
 */
export function recordSimSnapshot(id, {
  activeTvl, feeActiveTvlRatio, volumeWindow, inRange, feeAccruedUsd, consecutiveStallSnapshots,
}) {
  const row = db.prepare('SELECT * FROM lp_sim_positions WHERE id = ?').get(id);
  if (!row) return null;
  const ts = now();
  const snapshots = safeJson(row.snapshots_json, []);
  snapshots.push({
    at_ms: ts, active_tvl: activeTvl, fee_active_tvl_ratio: feeActiveTvlRatio,
    volume_window: volumeWindow, in_range: inRange, fee_accrued_usd: Number(feeAccruedUsd.toFixed(6)),
  });
  while (snapshots.length > MAX_SNAPSHOTS) snapshots.shift(); // see MAX_SNAPSHOTS note

  // Same epsilon meridian uses (1e-6) — floating-point noise from the rate math shouldn't
  // read as "genuine new accrual" and keep resetting the clock forever.
  const genuineIncrease = feeAccruedUsd > 1e-6;

  db.prepare(`
    UPDATE lp_sim_positions SET
      last_snapshot_at_ms = @ts, last_active_tvl = @activeTvl, last_fee_active_tvl_ratio = @feeActiveTvlRatio,
      last_volume_window = @volumeWindow, accrued_fee_usd = accrued_fee_usd + @feeAccruedUsd,
      in_range_snapshots = in_range_snapshots + @inRangeDelta, out_of_range_snapshots = out_of_range_snapshots + @outOfRangeDelta,
      consecutive_stall_snapshots = @consecutiveStallSnapshots,
      last_fee_increase_at_ms = CASE WHEN @genuineIncrease THEN @ts ELSE last_fee_increase_at_ms END,
      snapshots_json = @snapshotsJson
    WHERE id = @id
  `).run({
    id, ts, activeTvl: activeTvl ?? null, feeActiveTvlRatio: feeActiveTvlRatio ?? null, volumeWindow: volumeWindow ?? null,
    feeAccruedUsd, inRangeDelta: inRange ? 1 : 0, outOfRangeDelta: inRange ? 0 : 1,
    consecutiveStallSnapshots, genuineIncrease: genuineIncrease ? 1 : 0, snapshotsJson: json(snapshots),
  });
  return hydrate(db.prepare('SELECT * FROM lp_sim_positions WHERE id = ?').get(id));
}

export function closeSimPosition(id, reason) {
  const row = db.prepare('SELECT * FROM lp_sim_positions WHERE id = ?').get(id);
  if (!row || row.status === 'closed') return null;
  const ts = now();
  db.prepare(`
    UPDATE lp_sim_positions SET
      status = 'closed', closed_at_ms = @ts, close_reason = @reason,
      realized_fee_usd = accrued_fee_usd, hold_ms = @ts - opened_at_ms
    WHERE id = @id
  `).run({ id, ts, reason });
  return hydrate(db.prepare('SELECT * FROM lp_sim_positions WHERE id = ?').get(id));
}

export function recentSimPositions(limit = 20, status = null) {
  const rows = status
    ? db.prepare('SELECT * FROM lp_sim_positions WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM lp_sim_positions ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(hydrate);
}

function hydrate(row) {
  return { ...row, snapshots: safeJson(row.snapshots_json, []) };
}
