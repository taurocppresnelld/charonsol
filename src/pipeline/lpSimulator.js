// ── Charonsol phase 2: lightweight dry-run LP fee-yield simulation ─────────────────
//
// THE MODEL: fee_active_tvl_ratio, as returned by Meteora's own pool-discovery-api, is
// "total fees earned by the pool over the timeframe window, divided by active TVL" —
// meridian's own definitions.js describes the equivalent (fee_per_tvl_24h) as "the
// current APY of the pool." That's a real, Meteora-reported figure, not an estimate we
// invented. Every time an open position is monitored, we re-fetch this figure, convert
// it from "% return over the timeframe window" into a per-millisecond rate, and accrue
// notional_usd × rate × elapsed_ms since the last snapshot — so the accrual always
// reflects the pool's *actual current* fee/TVL conditions, not a static guess taken at
// entry and held constant.
//
// THE CAVEAT (read this before trusting a number out of this module): this estimates
// FEE INCOME ONLY. There is no token-price data anywhere in this project — impermanent
// loss, and the real DLMM mechanic of only earning fees while price sits inside your
// specific bin range, are NOT modeled. "In range" here is approximated from pool health
// (active_tvl and fee_active_tvl_ratio staying above a floor) rather than actual
// bin-level price tracking, which needs the real DLMM SDK + RPC — see README's Phase 2
// section. Every number this module produces is a fee-yield estimate, never full PnL.

import { now } from '../utils.js';
import { setting, numSetting } from '../db/settings.js';
import { openSimPosition, openSimPositions, recordSimSnapshot, closeSimPosition } from '../db/lpSimPositions.js';
import { fetchPoolDetail } from '../pool/poolDiscovery.js';
import { TIMEFRAME_MINUTES } from '../pool/screening.js';
import { PRIORITY } from '../enrichment/priorityQueue.js';
import {
  LP_SIM_ENABLED,
  LP_SIM_NOTIONAL_USD,
  LP_SIM_MAX_HOLD_MS,
  LP_SIM_MIN_ACTIVE_TVL,
  LP_SIM_FEE_STALL_THRESHOLD_HOURS,
  LP_SIM_FEE_STALL_MIN_AGE_MINUTES,
} from '../config.js';

function timeframeMs(timeframe) {
  const minutes = TIMEFRAME_MINUTES[timeframe] || TIMEFRAME_MINUTES['4h'];
  return minutes * 60_000;
}

/**
 * Called right after a lp_candidates row passes pool screening — opens a simulated
 * position at a fixed notional (lp_sim_notional_usd setting) using the best pool's
 * entry-time snapshot. Idempotent: openSimPosition() no-ops if one already exists for
 * this lp_candidate_id.
 */
export function openSimPositionForLpCandidate(lpCandidateId, { mint, symbol, timeframe, best, bestPoolDetail }) {
  if (!LP_SIM_ENABLED) return null;
  const poolAddress = best?.pool?.address || best?.pool?.pool_address;
  if (!poolAddress) return null;

  const notionalUsd = numSetting('lp_sim_notional_usd', LP_SIM_NOTIONAL_USD);
  const id = openSimPosition({
    lpCandidateId, mint, symbol,
    poolAddress,
    binStep: best?.pool?.bin_step ?? best?.pool?.pool_config?.bin_step ?? null,
    timeframe,
    notionalUsd,
    entryActiveTvl: bestPoolDetail?.active_tvl ?? null,
    entryFeeActiveTvlRatio: bestPoolDetail?.fee_active_tvl_ratio ?? null,
    entryVolumeWindow: bestPoolDetail?.volume_window ?? bestPoolDetail?.volume ?? null,
    entryDegenScore: null, // set by caller if it has it handy; not required for the sim itself
  });
  if (id == null) {
    console.log(`[lp-sim] skipped ${symbol || mint.slice(0, 8)}... — already tracking an open position for this mint`);
    return null;
  }
  console.log(`[lp-sim] opened #${id} ${symbol || mint.slice(0, 8)}... pool=${poolAddress.slice(0, 8)}... notional=$${notionalUsd}`);
  return id;
}

/**
 * One monitoring pass over every open simulated position: re-fetch the pool's current
 * fee_active_tvl_ratio, accrue fee income for the elapsed time since the last snapshot,
 * and apply exit rules. Never throws — a single position's fetch failure just skips
 * accrual for that position this cycle (still recorded as an out-of-range/unobserved
 * period) rather than aborting the whole sweep.
 */
export async function monitorOpenSimPositions() {
  if (!LP_SIM_ENABLED) return { checked: 0, closed: 0 };
  const positions = openSimPositions();
  if (positions.length === 0) return { checked: 0, closed: 0 };

  const minActiveTvl = numSetting('lp_sim_min_active_tvl', LP_SIM_MIN_ACTIVE_TVL);
  const maxHoldMs = numSetting('lp_sim_max_hold_ms', LP_SIM_MAX_HOLD_MS);
  const feeStallThresholdMs = Math.max(1, numSetting('lp_sim_fee_stall_threshold_hours', LP_SIM_FEE_STALL_THRESHOLD_HOURS)) * 3_600_000;
  const feeStallMinAgeMs = Math.max(0, numSetting('lp_sim_fee_stall_min_age_minutes', LP_SIM_FEE_STALL_MIN_AGE_MINUTES)) * 60_000;

  let closed = 0;
  for (const pos of positions) {
    let detail = null;
    try {
      detail = await fetchPoolDetail(pos.pool_address, pos.timeframe, { priority: PRIORITY.POSITION_MONITOR });
    } catch (err) {
      console.log(`[lp-sim] #${pos.id} snapshot fetch failed: ${err.message}`);
    }

    const nowMs = now();
    const elapsedMs = Math.min(nowMs - pos.last_snapshot_at_ms, timeframeMs(pos.timeframe) * 3); // cap: don't extrapolate a stale rate over an excessive gap (e.g. bot downtime)

    const activeTvl = detail ? Number(detail.active_tvl ?? 0) : null;
    const feeActiveTvlRatio = detail ? Number(detail.fee_active_tvl_ratio ?? 0) : null;
    const volumeWindow = detail ? Number(detail.volume_window ?? detail.volume ?? 0) : null;

    const inRange = detail != null && activeTvl >= minActiveTvl && feeActiveTvlRatio > 0;
    const rateFraction = inRange ? feeActiveTvlRatio / 100 : 0;
    const ratePerMs = rateFraction / timeframeMs(pos.timeframe);
    const feeAccruedUsd = inRange ? pos.notional_usd * ratePerMs * elapsedMs : 0;

    // consecutive_stall_snapshots is kept for observability only (visible via `lp-sim`) —
    // the actual close decision below uses the lifetime-fee-increase clock instead, same
    // switch meridian made for the reason explained in fee-stall-guard.js's header: a
    // per-snapshot or trailing-average check can read "OK" on a position that earned well
    // early and has been completely dead since.
    const consecutiveStall = (detail != null && feeActiveTvlRatio <= 0) ? pos.consecutive_stall_snapshots + 1 : 0;

    const updated = recordSimSnapshot(pos.id, {
      activeTvl, feeActiveTvlRatio, volumeWindow, inRange, feeAccruedUsd, consecutiveStallSnapshots: consecutiveStall,
    });
    if (!updated) continue;

    // Exit rules, most urgent first.
    let closeReason = null;
    if (detail != null && activeTvl < minActiveTvl) {
      closeReason = 'tvl_drained';
    } else if (nowMs - pos.opened_at_ms >= maxHoldMs) {
      closeReason = 'max_hold';
    } else {
      const ageMs = nowMs - pos.opened_at_ms;
      const stalledForMs = nowMs - updated.last_fee_increase_at_ms;
      if (ageMs >= feeStallMinAgeMs && stalledForMs >= feeStallThresholdMs) {
        closeReason = 'fee_stall';
        console.log(
          `[lp-sim] #${pos.id} fee stall: no new fees earned in ${(stalledForMs / 3_600_000).toFixed(1)}h ` +
          `(limit ${(feeStallThresholdMs / 3_600_000).toFixed(1)}h) — lifetime fees stuck at $${updated.accrued_fee_usd.toFixed(4)}`,
        );
      }
    }

    if (closeReason) {
      const closedRow = closeSimPosition(pos.id, closeReason);
      closed++;
      const pct = closedRow.notional_usd > 0 ? (closedRow.realized_fee_usd / closedRow.notional_usd) * 100 : 0;
      console.log(
        `[lp-sim] closed #${pos.id} ${pos.symbol || pos.mint.slice(0, 8)}... reason=${closeReason} ` +
        `hold=${Math.round(closedRow.hold_ms / 60_000)}m realized_fee=$${closedRow.realized_fee_usd.toFixed(4)} (${pct.toFixed(3)}%)`,
      );
    }
  }

  console.log(`[lp-sim] monitored ${positions.length} open position(s), closed ${closed}`);
  return { checked: positions.length, closed };
}
