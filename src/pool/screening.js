// Ported from meridiancx's tools/screening.js — pool scoring only (scoreCandidate,
// degenScore). Everything else in that file (blacklists, dev-block, chart indicators,
// agent-meridian) is meridian's own trade-decision machinery and doesn't apply to
// Charonsol's phase-1 job, which is just: score the pools a candidate token has, so
// the merged token+pool record captures something comparable to what meridian would
// have scored them at.

const TIMEFRAME_MINUTES = {
  '5m': 5, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '12h': 720, '24h': 1440,
};
export { TIMEFRAME_MINUTES };
const DEGEN_REFERENCE_MINUTES = 30;

export function scoreCandidate(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
}

/**
 * Degen Score — a pool's efficiency relative to its liquidity, on a 0..100 scale.
 * Geometric mean of four liquidity-relative sub-scores (trading activity, LP activity,
 * fee yield, liquidity floor) so a high score requires balance across all four.
 * See meridiancx/tools/screening.js for the full derivation notes.
 */
export function degenScore(pool, targets = {}, timeframe = '4h') {
  const {
    targetVolRatio = 20,
    targetLpCount = 40,
    targetFeeRatio = 0.20,
    targetLiquidity = 20000,
  } = targets;

  const La = Number(pool.active_tvl ?? pool.tvl ?? 0);
  if (!Number.isFinite(La) || La <= 0) return 0;

  const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

  const tfMinutes = TIMEFRAME_MINUTES[timeframe] || DEGEN_REFERENCE_MINUTES;
  const tfScale = DEGEN_REFERENCE_MINUTES / tfMinutes;

  const volRatio = Number(pool.volume_active_tvl_ratio);
  const tradingRatio = (Number.isFinite(volRatio) ? volRatio : Number(pool.volume_window || 0) / La) * tfScale;
  const feeRatio = (Number.isFinite(Number(pool.fee_active_tvl_ratio))
    ? Number(pool.fee_active_tvl_ratio)
    : Number(pool.fee_window || 0) / La) * tfScale;
  const lpActivity = (Number(pool.unique_lps || 0) + Number(pool.positions_created || 0)) * tfScale;

  const sTrading = clamp01(tradingRatio / targetVolRatio);
  const sLp      = clamp01(lpActivity / targetLpCount);
  const sFees    = clamp01(feeRatio / targetFeeRatio);
  const sLiq     = clamp01(Math.log10(La) / Math.log10(targetLiquidity));

  return (sTrading * sLp * sFees * sLiq) ** 0.25 * 100;
}
