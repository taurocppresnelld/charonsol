import { now, pruneSeen } from '../utils.js';
import { boolSetting, numSetting, setting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { upsertCandidate } from '../db/candidates.js';
import { upsertLpCandidate } from '../db/lpCandidates.js';
import { buildCandidate, filterCandidate } from './candidateBuilder.js';
import { preScoreCandidate } from './preScorer.js';
import { momentumFilter } from './momentumFilter.js';
import { screenPoolsForMint } from '../pool/poolDiscovery.js';
import { degenScore as computeDegenScore } from '../pool/screening.js';
import { getScreeningDefaultsForTimeframe } from '../pool/screeningScales.js';
import { openSimPositionForLpCandidate } from './lpSimulator.js';
import { hasOpenSimPositionForMint } from '../db/lpSimPositions.js';
import { parseCompoundGroups, evaluateCompoundGroups } from './candidateBuilder.js';

// Pool-side equivalent of candidateBuilder.js's filter_compound_groups — same small
// expression language (alias>=N / alias<=N, comma=AND, pipe=OR), same shared
// parser/evaluator, different setting key and alias set since these fields don't exist
// until AFTER pool screening runs (candidateBuilder.js's version can't see any of these —
// that's the whole reason this is a separate mechanism, added 2026-09-07 once a real
// pool-side OR-of-AND combo showed up that needed deploying). Short aliases matching
// backtest.js's own POOL_FILTERS naming style, not its internal `entry_*`/`d.*` field
// names — kept intentionally simple to type by hand.
const POOL_COMPOUND_FIELD_PATHS = {
  activeTvl: d => d.activeTvl,
  binStep: d => d.binStep,
  volumeWindow: d => d.volumeWindow,
  poolsFound: d => d.poolsFound,
  feeRatio: d => d.feeRatio,
  degenScore: d => d.degenScore,
};
import { graduated } from '../signals/graduated.js';
import {
  POOL_SCREENING_TIMEFRAME,
  POOL_MIN_TVL,
  POOL_MAX_TVL,
  POOL_MIN_FEE_ACTIVE_TVL_RATIO,
  POOL_MIN_VOLUME,
  POOL_MIN_DEGEN_SCORE,
  POOL_DISCOVERY_LIMIT,
  POOL_MIN_POOLS_FOUND,
} from '../config.js';

export const seenSignalCandidates = new Map();

let lastScreeningPausedLogMs = 0;
const SCREENING_PAUSED_LOG_INTERVAL_MS = 5 * 60 * 1000; // log at most once per 5min while paused, not once per incoming signal

/**
 * Stage 2 of Charonsol's pipeline: given a token candidate that already passed
 * charon's token-level filter, find its Meteora DLMM pool(s) and score them the way
 * meridian would, then persist the merged token+pool record. Never throws — a pool
 * lookup failure just records "no pool found" rather than aborting the run.
 *
 * Every threshold here is read live from `settings` on each call (numSetting/setting),
 * with the POOL_* env constants (config.js) as the fallback default — same pattern as
 * charon's own trending_min_volume_usd etc. in trending.js. That means these are
 * tunable via the settings table at runtime, no restart required, unlike a plain env
 * constant which only takes effect at process startup.
 */
export async function screenPoolsForCandidate(candidateId, candidate) {
  const mint = candidate.token.mint;
  const symbol = candidate.token.symbol;

  // Checked BEFORE any Meteora API call, not just before writing the position row — a
  // mint that already has an open lp_sim_positions row doesn't need re-screening at all;
  // pool/screening.js's pickBestPool() already picked the single best pool for it last
  // time. Real log evidence: one token got re-detected as a "new" candidate 11 times in
  // ~3 hours because its re-poll interval outlasted the 10-minute recentCandidate dedup
  // window in processCandidateFromSignals below — each one re-ran full pool discovery
  // and opened its own fully-independent position, so when the real pool eventually
  // drained, 5 supposedly-independent positions all closed within 19 seconds of each
  // other. This stops both the wasted API calls and the correlated-sample problem at
  // the source, before screenPoolsForMint's queued Meteora calls even fire.
  if (hasOpenSimPositionForMint(mint)) {
    console.log(`[lp-screen] ${symbol || mint.slice(0, 8)}... skipped — already tracking an open position for this mint`);
    return null;
  }

  const timeframe = setting('pool_screening_timeframe', POOL_SCREENING_TIMEFRAME);
  const minTvl = numSetting('pool_min_tvl', POOL_MIN_TVL);
  const maxTvl = numSetting('pool_max_tvl', POOL_MAX_TVL);
  const minDegenScore = numSetting('pool_min_degen_score', POOL_MIN_DEGEN_SCORE);
  const discoveryLimit = numSetting('pool_discovery_limit', POOL_DISCOVERY_LIMIT);
  const minPoolsFound = numSetting('pool_min_pools_found', POOL_MIN_POOLS_FOUND);
  const scales = getScreeningDefaultsForTimeframe(timeframe);

  // BUG FIX (2026-08-27): `scales.X ?? settingValue` looks like "prefer the timeframe-
  // scaled default, fall back to the setting" but numSetting() always returns a number
  // (never null/undefined — it falls back to its own default internally), so the ??
  // could never actually reach the setting for any timeframe in TIMEFRAME_SCREENING_SCALES
  // (i.e. every timeframe this ever resolves to). pool_min_fee_active_tvl_ratio and
  // pool_min_volume were consequently dead settings — always silently overridden by
  // screeningScales.js's hardcoded table. Fixed by checking the RAW settings-table value
  // (setting(key, null) — distinguishes "user explicitly set this" from "just reading the
  // JS constant default") so an explicit override actually wins; the timeframe-scaled
  // table is only used when the user hasn't set one.
  const feeRatioOverride = setting('pool_min_fee_active_tvl_ratio', null);
  const minFeeActiveTvlRatio = feeRatioOverride != null ? Number(feeRatioOverride) : (scales.minFeeActiveTvlRatio ?? POOL_MIN_FEE_ACTIVE_TVL_RATIO);
  const volumeOverride = setting('pool_min_volume', null);
  const minVolume = volumeOverride != null ? Number(volumeOverride) : (scales.minVolume ?? POOL_MIN_VOLUME);

  const { pools, best, error } = await screenPoolsForMint(mint, {
    minTvl,
    limit: discoveryLimit,
    timeframe,
  });

  if (error) {
    upsertLpCandidate({
      candidateId, mint, symbol, poolsFound: 0, bestPool: null, degenScore: null,
      poolScreenPassed: false, poolRejectReasons: [`pool discovery error: ${error}`],
      pools: [], bestPoolDetail: null,
    });
    console.log(`[lp-screen] ${symbol || mint.slice(0, 8)}... pool discovery failed: ${error}`);
    return null;
  }

  if (!best.pool) {
    upsertLpCandidate({
      candidateId, mint, symbol, poolsFound: 0, bestPool: null, degenScore: null,
      poolScreenPassed: false, poolRejectReasons: ['no Meteora DLMM/SOL pool found'],
      pools: [], bestPoolDetail: null,
    });
    console.log(`[lp-screen] ${symbol || mint.slice(0, 8)}... — no Meteora pool found`);
    return null;
  }

  const detail = best.detail || {};
  const activeTvl = Number(detail.active_tvl ?? best.pool.tvl ?? best.pool.liquidity ?? 0);
  const feeActiveTvlRatio = Number(detail.fee_active_tvl_ratio ?? 0);
  const volumeWindow = Number(detail.volume_window ?? detail.volume ?? 0);
  const degen = computeDegenScore({ ...detail, active_tvl: activeTvl }, {}, timeframe);

  const reasons = [];
  if (pools.length < minPoolsFound) reasons.push(`pools_found ${pools.length} < min ${minPoolsFound}`);
  if (activeTvl < minTvl) reasons.push(`active_tvl ${activeTvl} < min ${minTvl}`);
  if (maxTvl != null && maxTvl > 0 && activeTvl > maxTvl) reasons.push(`active_tvl ${activeTvl} > max ${maxTvl}`);
  if (feeActiveTvlRatio < minFeeActiveTvlRatio) {
    reasons.push(`fee_active_tvl_ratio ${feeActiveTvlRatio} < min ${minFeeActiveTvlRatio} (${timeframe})`);
  }
  if (volumeWindow < minVolume) {
    reasons.push(`volume ${volumeWindow} < min ${minVolume} (${timeframe})`);
  }
  if (degen < minDegenScore) reasons.push(`degen_score ${degen.toFixed(1)} < min ${minDegenScore}`);

  // pool_compound_groups (2026-09-07) — same mandatory-when-set, forgive-on-satisfy
  // shape as candidateBuilder.js's filter_compound_groups: a candidate must satisfy at
  // least one branch or gets rejected outright, and satisfying one forgives whatever the
  // 6 checks above already flagged (every current pool-level reason comes from exactly
  // those 6 checks, so "forgive" here just means "clear reasons" rather than needing a
  // curated known-keys list the way the token-side version does — there's nothing else
  // in this array it could be). Route-scoped exactly like the token-side version:
  // pool_compound_groups:${route} || pool_compound_groups, mandatory either way.
  const binStep = best.pool?.bin_step ?? best.pool?.pool_config?.bin_step ?? 0;
  const poolCompoundData = { activeTvl, binStep, volumeWindow, poolsFound: pools.length, feeRatio: feeActiveTvlRatio, degenScore: degen };
  const route = candidate.signals?.route || '';
  // Rescue-only semantics, same correction as filter_compound_groups above: only matters
  // for a candidate that already has ≥1 rejection reason from the checks above — never a
  // gate of its own for a candidate that would otherwise pass. reasons.length check does
  // double duty here (both "is there anything to rescue" and "what to forgive"), since
  // every current pool-level reason comes from exactly the 6 checks above — there's
  // nothing else in this array it could be, so unlike the token-side version there's no
  // separate known-keys list to intersect against.
  const poolCompoundSettingRoute = route ? setting(`pool_compound_groups:${route}`, '') : '';
  const poolCompoundSetting = poolCompoundSettingRoute || setting('pool_compound_groups', '');
  if (poolCompoundSetting && reasons.length) {
    const branches = parseCompoundGroups(poolCompoundSetting, POOL_COMPOUND_FIELD_PATHS, 'pool_compound_groups');
    if (branches.length && evaluateCompoundGroups(poolCompoundData, branches, POOL_COMPOUND_FIELD_PATHS)) {
      console.log(`[pool-compound] ${symbol || mint.slice(0, 8)}... (route=${route || 'none'}${poolCompoundSettingRoute ? ', route-specific' : ', global'}) satisfied a compound group — forgave [${reasons.join('; ')}]`);
      reasons.length = 0;
    }
    // Not satisfied -> no new reason added, no log — stays rejected for whatever it
    // already failed, same as if pool_compound_groups weren't set at all.
  }

  const passed = reasons.length === 0;

  upsertLpCandidate({
    candidateId, mint, symbol,
    poolsFound: pools.length,
    bestPool: best.pool,
    degenScore: Number(degen.toFixed(2)),
    poolScreenPassed: passed,
    poolRejectReasons: reasons,
    pools,
    bestPoolDetail: detail,
  });

  if (passed) {
    // lpCandidateId here is the lp_candidates row's own id, not candidates.id — fetch it
    // since upsertLpCandidate doesn't return it and openSimPositionForLpCandidate needs
    // the FK it actually declared (UNIQUE(candidate_id) means one lookup, not a race).
    const lpRow = db.prepare('SELECT id FROM lp_candidates WHERE candidate_id = ?').get(candidateId);
    if (lpRow) {
      openSimPositionForLpCandidate(lpRow.id, { mint, symbol, timeframe, best, bestPoolDetail: detail });
    }
  }

  console.log(
    `[lp-screen] ${symbol || mint.slice(0, 8)}... pools=${pools.length} tvl=${activeTvl.toFixed(0)} ` +
    `feeTvl=${feeActiveTvlRatio.toFixed(3)} degen=${degen.toFixed(1)} → ${passed ? 'LP_CANDIDATE' : 'rejected (' + reasons[0] + ')'}`,
  );

  return { pools, best, passed, reasons, degenScore: degen };
}

/**
 * Entry point wired to every charon signal source (pumpportal, graduated, trending,
 * pregrad, trenches, fee-claim, smart-money). Runs charon's own token-level build +
 * filter + pre-score + momentum stages unchanged, then — instead of handing off to an
 * LLM/execution layer — screens the surviving candidate's Meteora pools and persists
 * the merged result. Dry-run only: nothing here ever places an order.
 */
export async function processCandidateFromSignals(signals) {
  // Ported from charon (2026-08-31): a genuine kill switch for NEW entries only — every
  // signal source (pumpportal, pregrad, trending, trenches, meridian-tokens, fee-claim,
  // server) injects processCandidateFromSignals as its own candidateHandler, so this is
  // the ONE universal choke point every path into a new lp_sim_position funnels through.
  // Checked before ANY work happens. Does NOT touch monitorOpenSimPositions() at all (a
  // completely separate loop in lpSimulator.js) — tvl_drained/max_hold/fee_stall all keep
  // running normally on whatever's already open; this only pauses screening brand new
  // candidates. Rate-limited logging, same reason charon's does — pumpportal alone can
  // fire many times a minute, so logging every skipped signal while paused is pure noise.
  if (!boolSetting('screening_enabled', true)) {
    if (now() - lastScreeningPausedLogMs >= SCREENING_PAUSED_LOG_INTERVAL_MS) {
      lastScreeningPausedLogMs = now();
      console.log(`[lp-agent] screening_enabled=false — new candidates paused, open sim positions still fully monitored.`);
    }
    return;
  }

  // Bidirectional dedup — skip if this mint already got a candidate row from ANY route
  // in the last 10 minutes (mirrors charon's own dedup, minus the position-based checks,
  // which don't apply here since Charonsol phase 1 never opens positions).
  try {
    const recentCandidate = db.prepare(`
      SELECT id FROM candidates WHERE mint = ? AND created_at_ms > ? LIMIT 1
    `).get(signals.mint, Date.now() - 600_000);
    if (recentCandidate) {
      console.log(`[lp-agent] skipping ${signals.mint.slice(0, 8)}... — recent candidate (<10min) for any route`);
      return;
    }
  } catch (err) {
    // DB check failed — proceed anyway, same fail-open posture as charon
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);

  if (!candidate.filters.passed) {
    return; // already logged by filterCandidate() inside buildCandidate
  }

  // Same dry-run-only bypass flag candidateBuilder.js's filterCandidate() already honors
  // for hard-reject filters (candidate.filters.passed above is already bypass-aware) —
  // extended here to cover Charonsol's own two additional gates (prescore, momentum),
  // which candidateBuilder.js has no knowledge of and so can't bypass on its own. Same
  // trading_mode-gated posture: has zero effect unless trading_mode is genuinely
  // 'dry_run', so there's no path where this affects anything with real capital at risk
  // (moot for phase 1/2 either way, since neither exists yet).
  const bypassActive = boolSetting('bypass_hard_filters_dryrun_only', false) && setting('trading_mode', 'dry_run') === 'dry_run';

  // 2026-09-03 (charon): prescore_enabled (default true, preserves existing behavior) —
  // lets the whole prescore gate be bypassed via a setting, no code change needed to turn
  // it off. When false, every candidate that already passed filterCandidate proceeds
  // straight to the pre-pool-screening filter re-check below, regardless of smart-degen/
  // organic-score/etc. Distinct from bypassActive above (our own extension, not charon's):
  // that one bypasses a FAILED prescore result for data capture; this one skips running
  // prescore at all. Both can be true at once with no conflict — this check runs first.
  const preScoreCheckEnabled = boolSetting('prescore_enabled', true);
  if (preScoreCheckEnabled) {
    const preScore = preScoreCandidate(candidate);
    if (!preScore.passed && !bypassActive) {
      console.log(`[prescore] filtered ${candidate.token.mint.slice(0, 8)}... score ${preScore.score}/${preScore.threshold} (${preScore.reasons.slice(0, 2).join('; ')})`);
      return;
    }
    if (!preScore.passed && bypassActive) {
      console.log(`[prescore] bypassed (data capture) ${candidate.token.mint.slice(0, 8)}... score ${preScore.score}/${preScore.threshold}`);
    }
    if (preScore.passed) {
      console.log(`[prescore] passed ${candidate.token.mint.slice(0, 8)}... score ${preScore.score}/${preScore.threshold}`);
    }
  } else {
    console.log(`[prescore] bypassed ${candidate.token.mint.slice(0, 8)}... (prescore_enabled=false)`);
  }

  // Re-check filters right before the (relatively expensive) pool-screening call, same
  // "don't do more work on stale data" guard charon uses before its LLM call.
  filterCandidate(candidate);
  if (!candidate.filters.passed) {
    console.log(`[pre-pool-guard] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return; // bypass-aware already (candidate.filters.passed) — won't fire when bypassActive
  }

  const momentumFilterEnabled = boolSetting('momentum_filter_enabled', true);
  if (momentumFilterEnabled && !bypassActive) {
    const momentumResult = await momentumFilter(candidate, 0.5);
    if (!momentumResult.passed) {
      console.log(`[momentum] filtered ${candidate.token.mint.slice(0, 8)}... score ${momentumResult.score} < 0.5`);
      return;
    }
  } else if (momentumFilterEnabled && bypassActive) {
    console.log(`[momentum] bypassed (data capture) ${candidate.token.mint.slice(0, 8)}...`);
  }

  await screenPoolsForCandidate(candidateId, candidate);
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({ mint, graduatedCoin, trendingToken, route: 'graduated_trending' });
}
