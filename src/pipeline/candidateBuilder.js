import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol, computeRsiPercent } from '../utils.js';
import { db } from '../db/connection.js';
import { activeStrategy, numSetting, boolSetting, setting } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { gmgnLink } from '../format.js';
import { effectivePositionSizeSol } from './llm.js';
import { openPositionCount } from '../db/positions.js';

// Route-scoped filter overrides (2026-08-14) — lets a filter use a DIFFERENT threshold per
// route (e.g. `min_bonding_curve_progress:pumpportal_graduated` = 80 vs
// `min_bonding_curve_progress:trending` = 85), on top of the existing global/per-strategy
// value for any route that doesn't have an override set. Purely additive — a route with no
// scoped setting falls straight through to whatever the filter already used before this
// existed, so nothing changes for routes you haven't explicitly configured.
function routeFilterOverride(key, route) {
  if (!route) return null;
  const raw = setting(`${key}:${route}`, '');
  if (raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

// Detect freshly graduated tokens: route is pumpportal_graduated (token just graduated, filters relaxed)
function isFreshlyGraduated(candidate) {
  const route = candidate.signals?.route || '';
  return route.includes('pumpportal_graduated') || route.includes('pumpfun_pregrad');
}

// Ported from charon (2026-09-01, made mandatory 2026-09-03) — compound OR-of-AND filter
// groups, e.g. "(bondingCurve>=40 AND top20<=40) OR (liq>=10000 AND mcap<=40000)".
// filter_or_groups (below) can only express a flat "any ONE of these keys passing forgives
// the rest" — no way to require TWO conditions together before treating a branch as
// satisfied, so a genuine AND-within-OR combo discovered via scripts/backtest.js's
// POOL_FILTERS/TOKEN_FILTERS combos (e.g. "liq>=5K + holders>=50 + maxHolder<20%")
// couldn't be deployed as a real filter without this.
//
// Deliberately its OWN independent field-alias system, NOT layered on the existing 8
// tunable filter keys — confirmed directly against backtest.js's own extract() function
// that several fields read DIFFERENT paths than the similarly-named existing hard filters:
// `ho` reads candidate.holders.count, but the existing min_holders filter reads
// candidate.metrics.holderCount (a different enrichment source entirely); `top20` reads
// candidate.holders.top20Percent (sum of the top 20 holders), but the existing
// max_top20_holder_percent filter reads candidate.holders.maxHolderPercent (the single
// biggest holder — a completely different signal despite the similar name). Reusing the
// existing keys here would silently test the WRONG field relative to whatever backtest.js
// actually measured — these aliases match backtest.js's own field sources exactly, so a
// combo that looked good in the backtest tests the same data live.
const COMPOUND_FIELD_PATHS = {
  mcap: c => c.metrics?.marketCapUsd,
  gmgnFees: c => c.metrics?.gmgnTotalFeesSol,
  ho: c => c.holders?.count,
  top20: c => c.holders?.top20Percent,
  maxHolder: c => c.holders?.maxHolderPercent,
  liq: c => c.metrics?.liquidityUsd,
  bondingCurve: c => c.jupiterAsset?.bondingCurve,
  organic: c => c.jupiterAsset?.organicScore,
};

// "alias>=value" or "alias<=value" only — same two operators backtest.js's own filter
// list exclusively uses, keeping this a small, predictable language rather than a general
// expression parser. Pipe separates OR-branches, comma separates AND-conditions within a
// branch: "bondingCurve>=40,top20<=40|liq>=10000,mcap<=40000". Malformed or unknown-alias
// conditions are skipped with a warning (typo-tolerant, matching filter_or_groups' own
// defensive posture) rather than throwing — a bad compound_groups setting should degrade
// to "no effect", never crash candidate screening.
//
// Both functions take `fieldPaths` as a parameter (2026-09-07) rather than hardcoding
// COMPOUND_FIELD_PATHS, so the same small expression language (alias>=N / alias<=N,
// comma=AND, pipe=OR) is shared between this token-level mechanism and
// pool_compound_groups (lpOrchestrator.js) instead of being duplicated — one parser, one
// evaluator, two different alias maps and two different setting keys.
const COMPOUND_CONDITION_RE = /^([a-zA-Z][a-zA-Z0-9]*)(>=|<=)(-?\d+\.?\d*)$/;
export function parseCompoundGroups(raw, fieldPaths, settingLabel = 'filter_compound_groups') {
  if (!raw) return [];
  const branches = [];
  for (const rawBranch of raw.split('|')) {
    const conditions = [];
    for (const rawCond of rawBranch.split(',')) {
      const trimmed = rawCond.trim();
      if (!trimmed) continue;
      const match = COMPOUND_CONDITION_RE.exec(trimmed);
      if (!match) {
        console.log(`[filter-compound] ignoring malformed condition "${trimmed}" in ${settingLabel} (expected alias>=N or alias<=N)`);
        continue;
      }
      const [, alias, op, valueStr] = match;
      if (!fieldPaths[alias]) {
        console.log(`[filter-compound] ignoring unknown alias "${alias}" in ${settingLabel} — known aliases: ${Object.keys(fieldPaths).join(', ')}`);
        continue;
      }
      conditions.push({ alias, op, value: Number(valueStr) });
    }
    if (conditions.length >= 1) branches.push(conditions);
  }
  return branches;
}

// Missing/non-finite data makes a condition FALSE regardless of operator — deliberately
// stricter than backtest.js's own "missing -> 0" convention (which would let a missing
// value spuriously pass ANY "<= threshold" check). A live screening decision with missing
// data should be more conservative than a historical correlation search, not equally
// permissive.
export function evaluateCompoundGroups(dataObject, branches, fieldPaths) {
  for (const conditions of branches) {
    const branchPasses = conditions.every(({ alias, op, value }) => {
      const raw = fieldPaths[alias](dataObject);
      const num = Number(raw);
      if (!Number.isFinite(num)) return false;
      return op === '>=' ? num >= value : num <= value;
    });
    if (branchPasses) return true;
  }
  return false;
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const route = candidate.signals?.route || '';
  const failures = [];
  // 2026-08-24: filter_or_groups support — parallel map from a small, curated set of filter
  // keys to the exact failure message that key produced (if any), so the OR-group post-check
  // below can remove a specific failure without touching the other, unrelated failures in the
  // array. Only the 8 keys actually wired below are ever populated here — this is deliberately
  // NOT a general retrofit of every hard filter in this function (there are 20+, most disabled
  // or route-specific already); these 8 (mcap min/max, liquidity, holders, max-holder
  // concentration, bonding curve, organic score, GMGN fees) are the ones this session's
  // backtests actually validated as individually predictive, and the ones a user is
  // realistically choosing between.
  const failureMessagesByKey = {};
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);
  const freshGrad = isFreshlyGraduated(candidate);

  // Fresh grad insufficient data check: v40 pre-filter relies on jupiterAsset.audit (botHolders%, top10, devMigrations).
  // When audit is null/empty, v40 pre-filter is bypassed and LLM makes blind decisions. Reject fresh grads with
  // no Jupiter data, zero liquidity/holders, or 0-second migration (impossible for organic activity).
  // 2026-08-19: this fires heavily whenever datapi.jup.ag is rate-limited (jupiterAsset comes back
  // null during backoff) — bypass_fresh_grad_check lets you test with just the standard hard
  // filters, independent of bypass_hard_filters_dryrun_only which clears everything at once.
  if (freshGrad && !boolSetting('bypass_fresh_grad_check', false)) {
    const reasons = [];
    if (candidate.jupiterAsset === null || candidate.jupiterAsset === undefined) {
      reasons.push('no jupiterAsset');
    } else {
      const liquidityUsd = Number(candidate.jupiterAsset.liquidity ?? 0);
      const holderCount = Number(candidate.jupiterAsset.holderCount ?? 0);
      if (liquidityUsd === 0) reasons.push('liquidity=$0');
      if (holderCount === 0) reasons.push('holders=0');
    }
    if (Array.isArray(candidate.graduation?.patternFlags)
        && candidate.graduation.patternFlags.includes('fast_migration_0s')) {
      reasons.push('fast_migration_0s');
    }
    if (reasons.length > 0) {
      failures.push(`fresh grad insufficient data: ${reasons.join(', ')}`);
    }
  }

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap checks — skip min_mcap for freshly graduated (tokens just graduated, mcap is tiny)
  const minMcapUsd = routeFilterOverride('min_mcap_usd', route) ?? strat.min_mcap_usd;
  const maxMcapUsd = routeFilterOverride('max_mcap_usd', route) ?? strat.max_mcap_usd;
  if (minMcapUsd > 0 && (!Number.isFinite(mcap) || mcap < minMcapUsd)) {
    if (!freshGrad) {
      const msg = `market cap min: ${mcap} < ${minMcapUsd}`;
      failures.push(msg);
      failureMessagesByKey.min_mcap_usd = msg;
    }
  }
  if (maxMcapUsd > 0 && Number.isFinite(mcap) && mcap > maxMcapUsd) {
    const msg = `market cap max: ${mcap} > ${maxMcapUsd}`;
    failures.push(msg);
    failureMessagesByKey.max_mcap_usd = msg;
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  const minGmgnTotalFeeSol = routeFilterOverride('min_gmgn_total_fee_sol', route) ?? strat.min_gmgn_total_fee_sol;
  if (minGmgnTotalFeeSol > 0 && candidate.gmgn !== null && totalFees < minGmgnTotalFeeSol) {
    const msg = `GMGN total fees: ${totalFees} < ${minGmgnTotalFeeSol}`;
    failures.push(msg);
    failureMessagesByKey.min_gmgn_total_fee_sol = msg;
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count — skip for freshly graduated (brand new tokens have few holders)
  const minHolders = routeFilterOverride('min_holders', route) ?? strat.min_holders;
  if (!freshGrad && minHolders > 0 && holderCount < minHolders) {
    const msg = `holders: ${holderCount} < ${minHolders}`;
    failures.push(msg);
    failureMessagesByKey.min_holders = msg;
  }

  // Top holder concentration
  const maxTop20HolderPercent = routeFilterOverride('max_top20_holder_percent', route) ?? strat.max_top20_holder_percent;
  if (maxTop20HolderPercent < 100 && Number.isFinite(maxHolder) && maxHolder > maxTop20HolderPercent) {
    const msg = `max top holder: ${maxHolder}% > ${maxTop20HolderPercent}%`;
    failures.push(msg);
    failureMessagesByKey.max_top20_holder_percent = msg;
  }

  // RSI(period) entry filter — reject if already overbought going into the trade.
  // Global setting (not per-strategy), same as the RSI exit — see execution/positions.js.
  // Fail-open when chart data isn't available (freshly-graduated routes explicitly skip
  // chart fetching — no data to judge on isn't the same as failing the check) rather than
  // silently blocking every fresh-grad candidate the moment this is turned on.
  const entryRsiEnabled = boolSetting('entry_rsi_filter_enabled', false);
  if (entryRsiEnabled) {
    const entryRsiPeriod = numSetting('entry_rsi_period', 2);
    const entryRsiMax = numSetting('entry_rsi_max', 60);
    const entryRsi = computeRsiPercent(candidate.chart?.windows, entryRsiPeriod);
    if (entryRsi != null && entryRsi >= entryRsiMax) {
      failures.push(`RSI(${entryRsiPeriod}): ${entryRsi.toFixed(1)} >= ${entryRsiMax}`);
    }
  }

  // === AUDIT MODE: All hard filters disabled for 3-day data collection (2026-07-05) ===

  // Pumpportal bot dominance check — DISABLED for audit
  // const botHolders = Number(candidate.jupiterAsset?.audit?.botHoldersCount ?? 0);
  // if (botHolders >= 50 && candidate.signals?.route === 'pumpportal_graduated') {
  //   failures.push(`pumpportal bot-dominated: ${botHolders} bots >= 50`);
  // }

  // Audit-based hard rejects — DISABLED for audit
  // const top10Pct = Number(candidate.jupiterAsset?.audit?.topHoldersPercentage ?? null);
  // const devMigrations = Number(candidate.jupiterAsset?.audit?.devMigrations ?? null);
  // if (Number.isFinite(top10Pct) && top10Pct >= 50) {
  //   failures.push(`top10 holders: ${top10Pct.toFixed(1)}% >= 50% (too concentrated)`);
  // }
  // const devMigThreshold = freshGrad ? 15 : 7;
  // if (Number.isFinite(devMigrations) && devMigrations >= devMigThreshold) {
  //   failures.push(`dev migrations: ${devMigrations} >= ${devMigThreshold} (serial rugger${freshGrad ? ', fresh grad' : ''})`);
  // }

  // === Tier 1 Universal Filters / Option C Hybrid Strategy ===
  // Re-enabled 2026-08-07 — merged from a sibling fork's more recent codebase. Was disabled
  // here as part of the broader 2026-07-05 "AUDIT MODE" 3-day data-collection window (see the
  // older, still-disabled blocks above/below this one) and never re-enabled afterward.
  // Backtest evidence (634 trades, 30 days — see TIER1_FILTERS.md / OPTION_C_IMPLEMENTATION.md):
  //   Bot >=25%:        275 trades, 32.7% WR, -11.77 SOL  vs  Bot <25%: 359 trades, 45.7% WR, +16.77 SOL
  //   Holders [100,400]: 393 trades, 36.0% WR, -13.33 SOL (U-shaped: <100 and >700 both profitable)
  //   Dev migrations >=20: 96 trades, 33.3% WR, -6.28 SOL vs <20: 538 trades, 41.1% WR, +11.28 SOL
  // Hybrid design: bot>=25% is a HARD REJECT (highest confidence signal); the other two are SOFT
  // FLAGS that cut position size 50% via the risk-severity mechanism already active in
  // db/positions.js (createDryRunPosition/createLivePosition — that part was never disabled).
  const top10 = Number(candidate.jupiterAsset?.audit?.topHoldersPercentage ?? null);
  const devMig = Number(candidate.jupiterAsset?.audit?.devMigrations ?? null);
  const botPct = Number(candidate.jupiterAsset?.audit?.botHoldersPercentage ?? null);

  // TIER 1A: Bot holders >=25% = HARD REJECT
  // MEMORY FIX (2026-08-08, real incident): a token was correctly hard-rejected here at 28.8%
  // bot holders, then bought 10 minutes later on a later candidate rebuild for the SAME mint —
  // audit data (candidate.jupiterAsset.audit) was apparently unavailable on that second pass,
  // Number.isFinite(botPct) was false, and the hard-reject silently failed open. It crashed
  // -99.9% within the same second it opened. A missing audit fetch should never let a mint we
  // already know is bad slip back through — check whether this exact mint was hard-rejected for
  // bot concentration recently, and if so, re-apply that rejection regardless of what (or
  // whether) fresh audit data is available on this pass.
  const hardRejectMemoryEnabled = boolSetting('hard_reject_memory_enabled', true);
  const hardRejectMemoryMinutes = numSetting('hard_reject_memory_minutes', 60);
  const maxBotHoldersPercent = numSetting('max_bot_holders_percent', 25);
  if (Number.isFinite(botPct) && botPct >= maxBotHoldersPercent) {
    failures.push(`bot holders death zone: ${botPct.toFixed(1)}% >= ${maxBotHoldersPercent}% (HARD REJECT, -11.77 SOL historical)`);
  } else if (hardRejectMemoryEnabled && candidate.token?.mint) {
    const priorReject = db.prepare(`
      SELECT filter_result_json, created_at_ms FROM candidates
      WHERE mint = ? AND created_at_ms >= ? AND filter_result_json LIKE '%bot holders death zone%'
      ORDER BY id DESC LIMIT 1
    `).get(candidate.token.mint, now() - hardRejectMemoryMinutes * 60_000);
    if (priorReject) {
      const ageMin = ((now() - priorReject.created_at_ms) / 60_000).toFixed(0);
      failures.push(`bot holders death zone: hard-rejected ${ageMin}min ago, audit data unavailable this pass — staying rejected`);
    }
  }

  // TIER 1B: Holder count deadzone [100,400] = SOFT FLAG (50% size cut)
  if (holderCount >= 100 && holderCount <= 400) {
    candidate.riskFlags = candidate.riskFlags || [];
    candidate.riskFlags.push({
      type: 'holder_deadzone',
      severity: 2,
      reason: `holder count ${holderCount} in deadzone [100,400], historical 36% WR`,
    });
  }

  // TIER 1C: Dev migrations >=20 = SOFT FLAG (50% size cut)
  if (Number.isFinite(devMig) && devMig >= 20) {
    candidate.riskFlags = candidate.riskFlags || [];
    candidate.riskFlags.push({
      type: 'serial_rugger',
      severity: 1,
      reason: `dev migrations ${devMig} >= 20, historical 33% WR`,
    });
  }

  // Per-route filters — DISABLED for audit
  // if (signalRoute === 'pumpportal_graduated') {
  //   if (Number.isFinite(top10) && top10 >= 15 && top10 < 25) {
  //     failures.push(`pumpportal top10 rug zone: ${top10.toFixed(1)}% in [15,25)`);
  //   }
  //   if (!freshGrad && Number.isFinite(devMig) && devMig > 10) {
  //     failures.push(`pumpportal dev_migrations: ${devMig} > 10 (serial rugger)`);
  //   }
  //   if (Number.isFinite(botPct) && botPct > 30) {
  //     failures.push(`pumpportal bot-dominated: ${botPct.toFixed(1)}% > 30%`);
  //   }
  // }

  // if (signalRoute === 'fee_trending') {
  //   if (!freshGrad && Number.isFinite(devMig) && devMig > 10) {
  //     failures.push(`fee_trending dev_migrations: ${devMig} > 10 (serial rugger)`);
  //   }
  //   if (Number.isFinite(botPct) && botPct > 30) {
  //     failures.push(`fee_trending bot-dominated: ${botPct.toFixed(1)}% > 30%`);
  //   }
  // }

  // if (signalRoute === 'trenches_completed') {
  //   if (Number.isFinite(top10) && top10 >= 25 && top10 < 35) {
  //     failures.push(`trenches top10 rug zone: ${top10.toFixed(1)}% in [25,35)`);
  //   }
  // }

  // Trenches route: mcap is already checked by strategy max_mcap_usd — no extra cap needed

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // ATH distance (dip buy strategy) — skip for freshly graduated (chart data from Jupiter is meaningless at graduation)
  if (!freshGrad && strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    // BACKTEST 2026-07-07 (B-1): trending_min_volume_usd was INVERTED — it admitted the
    // worse half (trendingVol>=5000 -> -13.87 SOL vs <5000 -> -3.41 SOL). Higher trending
    // volume monotonically correlates with LOSS here. Disabled as a floor. Do NOT re-enable
    // as a minimum; if used at all it should be a CAP. See BACKTEST_EDGE_2026-07-07.md.
    // if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
    //   failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    // }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  // Token age check — reject tokens older than token_age_max_ms (default 12 hours)
  const tokenAgeMs = strat.token_age_max_ms ?? 43200000; // 12 hours default
  if (tokenAgeMs > 0) {
    const trenchesCreatedTs = candidate.trenchesEntry?.created_timestamp;
    const graduatedTs = candidate.graduation?.graduationDate || candidate.graduation?.seenAt;
    const tokenCreatedTs = trenchesCreatedTs || graduatedTs;
    if (tokenCreatedTs > 0) {
      const tokenAgeMsActual = now() - (tokenCreatedTs > 1e12 ? tokenCreatedTs : tokenCreatedTs * 1000);
      if (tokenAgeMsActual > tokenAgeMs) {
        const ageH = (tokenAgeMsActual / 3600000).toFixed(1);
        failures.push(`token age: ${ageH}h > max ${tokenAgeMs / 3600000}h`);
      }
    }
  }

  // Buy pressure check — need buy/sell ratio > 1.0 (skip for freshly graduated: no data)
  const buyVol = Number(candidate.gmgn?.buy_vol_24h || candidate.gmgn?.buy_volume || 0);
  const sellVol = Number(candidate.gmgn?.sell_vol_24h || candidate.gmgn?.sell_volume || 0);
  if (!freshGrad && buyVol > 0 && sellVol > 0 && (buyVol / sellVol) < 1.0) {
    failures.push(`buy pressure weak: buy/sell ratio ${(buyVol/sellVol).toFixed(2)} < 1.0`);
  }

  // Liquidity check — BACKTEST 2026-07-07: raised floor from $2K to $6K.
  // liq>=6000 across ALL routes = +5.36 SOL / 932 trades vs baseline +1.08 / 1150,
  // and it holds in both time-halves (H1 +6.11, H2 -0.75 vs base H2 -4.00). It is
  // monotonic (every neighboring threshold behaves the same) — a real signal, not a
  // lucky bucket. Fresh-grads are NOT exempted: their liq<6000 subset lost -2.43 SOL
  // (WR 31%), so exempting them cut total to +2.94. Read from candidate.metrics.liquidityUsd
  // (same field the backtest measured). See BACKTEST_EDGE_2026-07-07.md.
  const liquidity = Number(candidate.metrics?.liquidityUsd || candidate.gmgn?.pool?.liquidity || candidate.gmgn?.liquidity || 0);
  const minDexLiquidityUsd = routeFilterOverride('min_dex_liquidity_usd', route) ?? numSetting('min_dex_liquidity_usd', 6000);
  if (liquidity > 0 && liquidity < minDexLiquidityUsd) {
    const msg = `DEX liquidity too low: $${liquidity.toFixed(0)} < $${minDexLiquidityUsd}`;
    failures.push(msg);
    failureMessagesByKey.min_dex_liquidity_usd = msg;
  }

  // === FLOW FILTER (2026-07-17, thresholds re-tuned 2026-08-04) ===
  // Original backtest: 1,415 trades, 11 days. Filter: s1h_priceChange >= 0 & net_buyer_ratio_5m >= 0.2
  // Result: 945 trades (67% keep), 47.9% WR, +14.09 SOL (+3.45 delta), 100% daily consistency.
  // Re-run 2026-08-04, 621 trades / 3 days, same fields — the >=0 / >=0.2 floors from July had gone
  // stale: s1h_priceChange >= 50 alone (329 trades, 53% keep) delivered +1.166 SOL over baseline,
  // 3/3 days positive independently. net_buyer_ratio_5m >= 0.4 similarly outperformed the 0.2 floor.
  // Both now settings-driven instead of hardcoded so they can be re-tuned the same way without a
  // code change next time the backtest is re-run. Uses Jupiter stats (not GMGN — better coverage).
  // Applies to ALL routes including fresh grads.
  //
  // NOT added: a tr_change5m filter, despite it appearing in the best backtest combo. candidate.trending
  // is only populated for route === 'trending' (buildCandidate's trendingToken param) — every other
  // route's tr_change5m defaults to 0 in the backtest script, which trivially passes a >=0 check. The
  // combo's apparent lift is mostly "trending-route candidates with their own negative change5m get
  // filtered" — not a real cross-route signal. trending is already flagged as the weakest route
  // (general_filter_backtest.py: excluding it entirely nets +0.311 SOL) — worth addressing directly
  // (route-level, or a stricter trending-only filter) rather than via this proxy.
  const s1hPriceChange = Number(candidate.jupiterAsset?.stats1h?.priceChange ?? null);
  const s5mNumNetBuyers = Number(candidate.jupiterAsset?.stats5m?.numNetBuyers ?? null);
  const s5mNumTraders = Number(candidate.jupiterAsset?.stats5m?.numTraders ?? null);
  const minS1hPriceChange = numSetting('min_s1h_price_change_percent', 50);
  const minNetBuyerRatio5m = numSetting('min_net_buyer_ratio_5m', 0.4);

  // Only reject when Jupiter data is available (don't penalize missing data)
  if (Number.isFinite(s1hPriceChange) && s1hPriceChange < minS1hPriceChange) {
    failures.push(`flow: 1h price change ${s1hPriceChange.toFixed(1)}% < ${minS1hPriceChange}%`);
  }

  if (Number.isFinite(s5mNumNetBuyers) && Number.isFinite(s5mNumTraders) && s5mNumTraders > 0) {
    const netBuyerRatio = s5mNumNetBuyers / s5mNumTraders;
    if (netBuyerRatio < minNetBuyerRatio5m) {
      failures.push(`flow: net buyer ratio ${netBuyerRatio.toFixed(2)} < ${minNetBuyerRatio5m}`);
    }
  }

  // === FLOW FILTER addition (2026-08-09) — 281 trades, 4 days ===
  // s5m_numNetBuyers: a raw COUNT (net buyers in the last 5 minutes), not a ratio like the
  // check above — a genuinely different signal, not something already filtered. Standout of
  // this backtest: >=20 was 4/4 days positive (100% consistency), the only field in the whole
  // sweep to hit that on 4 days, keeping 54% of volume for +1.457 SOL ΔPnL. Deliberately kept
  // independent of the ratio check above — a token can have plenty of net buyers in absolute
  // terms while still failing (or passing) the ratio bar, they catch different things.
  const minS5mNetBuyers = numSetting('min_s5m_net_buyers', 20);
  // Explicit check on the raw path, not just Number.isFinite(s5mNumNetBuyers) — that variable is
  // already coerced via Number(x ?? null), and Number(null) is 0 in JS, so a genuinely missing
  // stats5m block would otherwise be indistinguishable from "0 net buyers" and fail this filter
  // instead of skipping it. Same bug class as the bonding-curve filter fix from 2026-08-07.
  if (candidate.jupiterAsset?.stats5m?.numNetBuyers != null && Number.isFinite(s5mNumNetBuyers) && s5mNumNetBuyers < minS5mNetBuyers) {
    failures.push(`flow: 5m net buyers ${s5mNumNetBuyers} < ${minS5mNetBuyers}`);
  }

  // === FLOW FILTER additions (2026-08-07) — 305 trades, 3 days ===
  // net_buyer_ratio_1h: same formula as the 5m version above (numNetBuyers/numTraders), just on
  // the 1h window — a field that had never been filtered at all before this. Backtest: >=0.6
  // was the #1 single filter by ΔPnL (+1.007 SOL, 106 trades, 60.4% WR), 3/3 days positive with
  // an ACCELERATING per-trade delta across the window (+0.008 -> +0.015 -> +0.027/trade).
  // bondingCurve progress: also never filtered before. Backtest: >=70 kept 93% of trade volume
  // (barely touches frequency) while still delivering +0.606 SOL ΔPnL — one of the most
  // cost-efficient filters found so far. >=85 keeps 85% of volume for +0.702 ΔPnL and is the
  // field behind the single best combo found (buy_sell_ratio_1h>=1.2 & bondingCurve>=85,
  // +1.318 ΔPnL, 3/3 daily consistency) — buy_sell_ratio_1h itself isn't added as its own filter
  // yet since it wasn't tested alone with the same rigor; bondingCurve alone already captures
  // most of that combo's value without depending on an unvalidated second field.
  const s1hNumNetBuyers = Number(candidate.jupiterAsset?.stats1h?.numNetBuyers ?? null);
  const s1hNumTraders = Number(candidate.jupiterAsset?.stats1h?.numTraders ?? null);
  const minNetBuyerRatio1h = numSetting('min_net_buyer_ratio_1h', 0.6);
  if (Number.isFinite(s1hNumNetBuyers) && Number.isFinite(s1hNumTraders) && s1hNumTraders > 0) {
    const netBuyerRatio1h = s1hNumNetBuyers / s1hNumTraders;
    if (netBuyerRatio1h < minNetBuyerRatio1h) {
      failures.push(`flow: net buyer ratio 1h ${netBuyerRatio1h.toFixed(2)} < ${minNetBuyerRatio1h}`);
    }
  }

  // Explicit null-check before Number() — Number(null) is 0 in JS, which would otherwise make
  // "no data" indistinguishable from "genuinely 0% progress" (a real state for a just-launched
  // token) and silently fail every candidate with missing bondingCurve data instead of skipping.
  const bondingCurveRaw = candidate.jupiterAsset?.bondingCurve;
  const bondingCurveProgress = bondingCurveRaw != null ? Number(bondingCurveRaw) : null;
  const minBondingCurveProgress = routeFilterOverride('min_bonding_curve_progress', route) ?? numSetting('min_bonding_curve_progress', 70);
  if (Number.isFinite(bondingCurveProgress) && bondingCurveProgress < minBondingCurveProgress) {
    const msg = `flow: bonding curve ${bondingCurveProgress.toFixed(0)} < ${minBondingCurveProgress}`;
    failures.push(msg);
    failureMessagesByKey.min_bonding_curve_progress = msg;
  }

  // NEW (2026-08-14): organic score as a hard filter — previously only fed soft-scoring
  // (computeSoftScore, via candidate.trending?.organic_score, a different field from a different
  // source). This uses jupiterAsset.organicScore directly instead — same family as bondingCurve/
  // liquidity/audit above, and the field already confirmed present in real production data.
  // Explicit null-check before Number(), same reason as bondingCurve just above: Number(null) is
  // 0 in JS, which would otherwise make "no data" indistinguishable from "genuinely low score."
  // Route-aware from the start, no global default needed (0 = off, matches every other filter's
  // "0/100 disables it" convention) since nothing previously depended on a hard organic-score gate.
  const organicScoreRaw = candidate.jupiterAsset?.organicScore;
  const organicScore = organicScoreRaw != null ? Number(organicScoreRaw) : null;
  const minOrganicScore = routeFilterOverride('min_organic_score', route) ?? numSetting('min_organic_score', 0);
  // 2026-08-20: was missing the same !freshGrad exemption min_holders/max_ath_distance_pct
  // already have — real data confirmed organicScore reads 0 for 100% of candidates under
  // 30min old (Jupiter's algorithm needs real trading history to compute a score at all, not a
  // quality signal for brand-new liquidity), meaning this filter was unconditionally hard-
  // rejecting every freshly-graduated candidate regardless of any other quality signal.
  if (!freshGrad && minOrganicScore > 0 && Number.isFinite(organicScore) && organicScore < minOrganicScore) {
    const msg = `organic score: ${organicScore.toFixed(0)} < ${minOrganicScore}`;
    failures.push(msg);
    failureMessagesByKey.min_organic_score = msg;
  }

  // === v45 Soft Scoring System ===
  // Score each candidate on a 0-100 scale. Route-aware weights.
  // Score >= soft_threshold: PASS to LLM. Below: REJECT (unless hard_floor_override).
  const softScore = computeSoftScore(candidate, strat, freshGrad);
  
  // Dynamic threshold: tighten when many positions open, loosen when idle
  const softThreshold = softScoreThreshold(strat);
  
  if (softScore < softThreshold && !boolSetting('bypass_soft_score', false)) {
    failures.push(`soft score: ${softScore} < threshold ${softThreshold}`);
  }
  
  // 2026-08-24: filter_or_groups — lets a candidate pass on EITHER of two (or more) filters
  // instead of requiring both. Format: "key1,key2|key3,key4,key5" — pipe-separated groups,
  // comma-separated keys within each group. Supported keys are exactly the 8 tagged above
  // (min_dex_liquidity_usd, min_holders, max_top20_holder_percent, min_bonding_curve_progress,
  // min_organic_score, min_mcap_usd, max_mcap_usd, min_gmgn_total_fee_sol) — any other key is ignored (typo-safe: a bad key just means that group
  // does nothing, not a crash). A group only has an effect if at least one of its members
  // FAILED (nothing to forgive if everything in the group already passed) AND at least one
  // member PASSED (nothing to forgive if the whole group failed too — that's a genuine reject,
  // not an OR situation). Runs after every individual check above, before wouldHaveFailed is
  // captured, so bypassed/wouldHaveFailed downstream (position_open events) reflect the
  // OR-adjusted result, not the pre-OR one.
  // Route-scoped, same key:route convention as routeFilterOverride() elsewhere in this file
  // (e.g. min_dex_liquidity_usd:trending) — filter_or_groups:<route> takes priority when set,
  // otherwise falls back to the plain global filter_or_groups. routeFilterOverride() itself
  // isn't reused here since it's numeric-only (Number(raw)) and this setting is a string.
  const orGroupsSettingRoute = route ? setting(`filter_or_groups:${route}`, '') : '';
  const orGroupsSetting = orGroupsSettingRoute || setting('filter_or_groups', '');
  if (orGroupsSetting) {
    const knownKeys = new Set(['min_dex_liquidity_usd', 'min_holders', 'max_top20_holder_percent', 'min_bonding_curve_progress', 'min_organic_score', 'min_mcap_usd', 'max_mcap_usd', 'min_gmgn_total_fee_sol']);
    for (const rawGroup of orGroupsSetting.split('|')) {
      const groupKeys = rawGroup.split(',').map(k => k.trim()).filter(k => knownKeys.has(k));
      if (groupKeys.length < 2) continue; // need at least 2 real keys for an OR to mean anything
      const failedInGroup = groupKeys.filter(k => failureMessagesByKey[k] != null);
      const passedInGroup = groupKeys.filter(k => failureMessagesByKey[k] == null);
      if (failedInGroup.length > 0 && passedInGroup.length > 0) {
        for (const key of failedInGroup) {
          const idx = failures.indexOf(failureMessagesByKey[key]);
          if (idx !== -1) failures.splice(idx, 1);
        }
        console.log(`[filter-or] ${candidate.token?.mint?.slice(0, 8) || '?'}... (route=${route || 'none'}${orGroupsSettingRoute ? ', route-specific group' : ', global group'}) forgave [${failedInGroup.join(', ')}] — passed via [${passedInGroup.join(', ')}] in the same OR group`);
      }
    }
  }

  // Ported from charon (2026-09-01, mandatory since 2026-09-03) — when the setting
  // (route-specific if present, else global) is non-empty, a candidate must satisfy at
  // least one branch or gets rejected outright — regardless of whether it would have
  // passed every individual filter on its own. When it DOES satisfy a branch, it also
  // forgives any of the 8 known-key failures already recorded above (same mechanism
  // filter_or_groups uses, applied via a genuine AND-within-OR condition instead of a
  // flat "any one of these" list). Route precedence matches filter_or_groups exactly:
  // compoundGroupsSettingRoute || global — a route with its own setting is judged
  // against ONLY that, never the global one, mandatory either way.
  // Rescue-only semantics (corrected 2026-09-07): filter_compound_groups only ever
  // matters for a candidate that ALREADY failed ≥1 of the 8 known keys — it's an
  // alternate path for THAT candidate to still get through, never a gate of its own.
  // A candidate with zero known-key failures is completely unaffected by this setting,
  // regardless of whether it would satisfy any branch — there's nothing for it to be
  // rescued from, so the branches aren't even evaluated for it. This replaces the
  // "mandatory when set" behavior charon's own 2026-09-03 revision uses (which rejects
  // EVERY candidate that doesn't satisfy a branch, even ones with nothing to forgive —
  // confirmed directly in a real filter-report: 459 of 674 candidates were rejected
  // specifically by "compound group required but not satisfied" in one hour, most of
  // which likely had none of the 8 known failures to begin with). Charonsol's own choice
  // to diverge from charon here, not a porting mistake.
  const compoundGroupsSettingRoute = route ? setting(`filter_compound_groups:${route}`, '') : '';
  const compoundGroupsSetting = compoundGroupsSettingRoute || setting('filter_compound_groups', '');
  if (compoundGroupsSetting) {
    const knownKeys = ['min_dex_liquidity_usd', 'min_holders', 'max_top20_holder_percent', 'min_bonding_curve_progress', 'min_organic_score', 'min_mcap_usd', 'max_mcap_usd', 'min_gmgn_total_fee_sol'];
    const failedKnown = knownKeys.filter(k => failureMessagesByKey[k] != null);
    if (failedKnown.length) {
      const branches = parseCompoundGroups(compoundGroupsSetting, COMPOUND_FIELD_PATHS, 'filter_compound_groups');
      if (branches.length && evaluateCompoundGroups(candidate, branches, COMPOUND_FIELD_PATHS)) {
        for (const key of failedKnown) {
          const idx = failures.indexOf(failureMessagesByKey[key]);
          if (idx !== -1) failures.splice(idx, 1);
        }
        console.log(`[filter-compound] ${candidate.token?.mint?.slice(0, 8) || '?'}... (route=${route || 'none'}${compoundGroupsSettingRoute ? ', route-specific' : ', global'}) satisfied a compound group — forgave [${failedKnown.join(', ')}]`);
      }
      // Not satisfied -> no new failure added, no log — the candidate just stays
      // rejected for whichever of failedKnown (and anything else) it already failed,
      // same as if filter_compound_groups weren't set at all.
    }
  }

  const wouldHaveFailed = failures.slice();
  const bypassRequested = boolSetting('bypass_hard_filters_dryrun_only', false);
  const bypassActive = bypassRequested && setting('trading_mode', 'dry_run') === 'dry_run';
  const effectiveFailures = bypassActive ? [] : failures;

  if (failures.length > 0) {
    // See the bypass block above — bypassActive candidates still had real failures (wouldHaveFailed),
    // but effectiveFailures is empty for them, so the log below correctly distinguishes a genuine
    // rejection from one that's being let through for data capture, instead of calling both "filtered."
    const label = bypassActive ? 'bypassed (data capture)' : 'filtered';
    console.log(`[candidate] ${label} ${candidate.token.mint.slice(0, 8)}... ${failures.join('; ')} (soft=${softScore}/${softThreshold})`);
  } else {
    // Ported from charon (2026-08-31, "the PASS case was completely silent here"): candidates
    // that pass every filter never printed anything at all — filterCandidate() only ever logged
    // rejections/bypasses, so a genuinely good candidate (the whole point of screening) was
    // invisible in real-time logs, only visible retroactively by querying the DB. This is the
    // pass-case counterpart.
    console.log(`[candidate] detected good candidate ${candidate.token.mint.slice(0, 8)}... route=${candidate.signals?.route || 'unknown'} (soft=${softScore}/${softThreshold})`);
  }

  // 2026-08-18: dry-run-only bypass for data capture — lets every candidate flow through
  // regardless of hard-reject filters, so you can see what a broader population of tokens
  // actually does (post-close outcomes, peak PnL, etc.) instead of only ever observing survivors
  // of the current filter set. Every individual filter check above is completely untouched —
  // this only overrides the FINAL verdict, and only when trading_mode is genuinely 'dry_run'.
  // bypass_hard_filters_dryrun_only=true has zero effect if trading_mode is 'live' — not a
  // warning, not a soft check, bypassActive above is structurally false in that case regardless
  // of the setting's value, so there's no path where this can affect real money.
  return {
    passed: effectiveFailures.length === 0,
    failures: effectiveFailures,
    wouldHaveFailed,
    bypassed: bypassActive && wouldHaveFailed.length > 0,
    strategy: strat.id,
    softScore,
    softThreshold,
  };
}

// ============================================================
// v45 Soft Scoring Engine
// ============================================================

function computeSoftScore(candidate, strat, isFreshGrad) {
  let score = 100;
  const route = candidate.signals?.route || '';
  
  const mcap = Number(candidate.metrics?.marketCapUsd || candidate.jupiterAsset?.marketCapUsd || 0);
  const liquidityUsd = Number(candidate.metrics?.liquidityUsd || candidate.jupiterAsset?.liquidityUsd || candidate.gmgn?.liquidity || 0);
  const holderCount = Number(candidate.metrics?.holderCount || candidate.jupiterAsset?.holderCount || candidate.gmgn?.holder_count || 0);
  const botHolders = Number(candidate.jupiterAsset?.audit?.botHoldersCount || 0);
  const botPct = candidate.jupiterAsset?.audit?.botHoldersPercentage;
  const top10Pct = candidate.jupiterAsset?.audit?.topHoldersPercentage;
  const devMigrations = candidate.jupiterAsset?.audit?.devMigrations;
  const athDistance = candidate.chart?.distanceFromAthPercent;
  const smartDegens = Number(candidate.trending?.smart_degen_count || 0);
  const organicScore = Number(candidate.trending?.organic_score || 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate || 0);

  // --- NEGATIVE: Liquidity (all routes) ---
  if (liquidityUsd > 0) {
    if (liquidityUsd < 3000) { score -= 35; }
    else if (liquidityUsd < 5000) { score -= 25; }
    else if (liquidityUsd < 10000) { score -= 10; }
  }

  // --- NEGATIVE: Bot holders (route-specific weight) ---
  if (route === 'pumpportal_graduated') {
    if (botHolders >= 80) { score -= 40; }
    else if (botHolders >= 50) { score -= 30; }
    else if (botHolders >= 30) { score -= 15; }
  } else if (route === 'trenches_completed') {
    // Trenches: high bot = more tolerant (smart money + bots coexist)
    if (botHolders >= 100) { score -= 25; }
    else if (botHolders >= 50) { score -= 10; }
  } else if (route === 'fee_trending') {
    if (botHolders >= 100) { score -= 30; }
    else if (botHolders >= 50) { score -= 15; }
  }

  // --- NEGATIVE: Bot percentage (all routes) ---
  if (botPct != null && botPct > 0) {
    if (botPct > 50) { score -= 25; }
    else if (botPct > 30) { score -= 15; }
  }

  // --- NEGATIVE: Top10 concentration (route-specific zones) ---
  if (top10Pct != null && top10Pct > 0) {
    if (route === 'pumpportal_graduated') {
      if (top10Pct >= 15 && top10Pct < 25) { score -= 30; } // Rug zone
      else if (top10Pct >= 50) { score -= 20; }
    } else if (route === 'trenches_completed') {
      if (top10Pct >= 25 && top10Pct < 35) { score -= 20; } // Trenches rug zone
      else if (top10Pct >= 50) { score -= 15; }
    } else {
      if (top10Pct >= 50) { score -= 20; }
    }
  }

  // --- NEGATIVE: Dev migrations (non-fresh, all routes) ---
  if (!isFreshGrad && devMigrations != null) {
    if (devMigrations >= 15) { score -= 30; }
    else if (devMigrations >= 7) { score -= 20; }
    else if (devMigrations >= 3) { score -= 5; }
  }

  // --- NEGATIVE: Holder count (non-fresh, route-specific) ---
  if (!isFreshGrad && holderCount > 0) {
    if (route === 'pumpportal_graduated') {
      if (holderCount < 30) { score -= 20; }
      else if (holderCount < 50) { score -= 10; }
    } else if (route === 'trenches_completed') {
      if (holderCount < 30) { score -= 10; }
    }
  }

  // --- NEGATIVE: ATH distance (non-fresh) ---
  if (!isFreshGrad && athDistance != null) {
    if (athDistance > -20) { score -= 15; }
    else if (athDistance > -30) { score -= 10; }
  }

  // --- NEGATIVE: Mcap range (route-specific) ---
  if (route === 'trenches_completed') {
    if (mcap > 0 && mcap < 25000) { score -= 15; }
  } else if (route === 'fee_trending') {
    if (mcap > 0 && mcap < 40000) { score -= 15; }
  }

  // --- NEGATIVE: Bundler rate ---
  if (bundlerRate != null) {
    if (bundlerRate > 0.5) { score -= 20; }
    else if (bundlerRate > 0.3) { score -= 10; }
  }

  // --- POSITIVE: Smart money ---
  if (smartDegens >= 10) { score += 25; }
  else if (smartDegens >= 5) { score += 15; }
  else if (smartDegens >= 2) { score += 5; }

  // --- POSITIVE: Organic score ---
  if (organicScore >= 70) { score += 20; }
  else if (organicScore >= 50) { score += 10; }
  else if (organicScore >= 30) { score += 5; }

  // --- POSITIVE: Clean bundler ---
  if (bundlerRate != null && bundlerRate < 0.1) { score += 15; }
  else if (bundlerRate != null && bundlerRate < 0.3) { score += 5; }

  // --- POSITIVE: Fresh grad momentum ---
  if (isFreshGrad && route === 'pumpportal_graduated') {
    score += 10;
  }

  return Math.max(0, Math.min(150, score));
}

function softScoreThreshold(strat) {
  // Dynamic threshold based on current load
  const baseThreshold = 30; // Default threshold (loosen from 50 — too aggressive)
  
  // Tighten when many positions open
  const openCount = globalOpenPositionCount();
  const maxOpen = strat.max_open_positions || 3;
  
  if (openCount >= maxOpen - 1) return baseThreshold + 10; // Tighten: 60
  if (openCount === 0) return baseThreshold - 10; // Loosen: 40
  return baseThreshold; // Normal: 50
}

function globalOpenPositionCount() {
  // BACKTEST 2026-07-07 (B-4): the old body did require('./positions.js') inside a
  // try/catch. In this ESM project require is undefined AND the path was wrong
  // (positions.js lives in ../db/), so it ALWAYS threw and returned 0 — pinning the
  // soft-score threshold at the loosest branch (20) forever. Now uses a static ESM
  // import so the dynamic tighten-when-full logic actually works.
  try {
    return openPositionCount();
  } catch {
    return 0;
  }
}
export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, trenchesEntry = null, pregradToken = null, route }) {
  const strat = activeStrategy();
  const isFreshlyGraduated = route === 'pumpportal_graduated';

  let gmgn, jupiterAsset, holders, chart, savedWalletExposure, twitterNarrative;

  if (isFreshlyGraduated) {
    console.log(`[candidate] fast path for freshly graduated ${mint.slice(0, 8)}...`);
    const [jupAsset, jupHolders] = await Promise.all([
      fetchJupiterAsset(mint),
      fetchJupiterHolders(mint),
    ]);
    jupiterAsset = jupAsset;
    holders = jupHolders;
    gmgn = null;
    chart = null;
    twitterNarrative = null;
    savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  } else {
    // 2026-08-19: fetchJupiterChartContext is the one soft-score input that's a genuinely
    // separate, expensive network call (3 parallel requests) rather than data already fetched
    // for a hard filter — liquidity/bot%/top10%/holderCount all feed hard filters too and get
    // fetched regardless. skip_soft_score_chart_fetch lets this specific call be skipped when
    // testing hard-filters-only, for a real reduction in datapi.jup.ag request volume, not just
    // ignoring the resulting soft-score verdict (see bypass_soft_score above, which only does
    // that). Losing this data also removes the rare "dip buy" max_ath_distance_pct hard-filter
    // and the topBlastRisk context the LLM would otherwise see — acceptable trade-offs for a
    // momentum/sniper strategy, worth knowing about for a dip-buy one.
    const skipChartFetch = boolSetting('skip_soft_score_chart_fetch', false) || !boolSetting('jupiter_chart_context_enabled', true);
    // 2026-08-21: gmgn_token_lookup_enabled was previously only wired to pumpportal.js's
    // graduation-detection path — this call, and three others (positions.js x2, graduated.js's
    // pollLoop), ran unconditionally regardless of the setting. With GMGN actively IP-banned
    // (real log: "IP is temporarily banned due to repeated rate limit violations"), every one of
    // those unguarded calls was a guaranteed-failing request. jupiterAsset already provides a
    // parallel data source here, so gating this is safe.
    const gmgnTokenLookupEnabled = boolSetting('gmgn_token_lookup_enabled', true);
    // Stage 1: parallel — gmgn, asset, holders, chart (4 calls)
    [gmgn, jupiterAsset, holders, chart] = await Promise.all([
      gmgnTokenLookupEnabled ? fetchGmgnTokenInfo(mint) : Promise.resolve(null),
      fetchJupiterAsset(mint),
      fetchJupiterHolders(mint),
      skipChartFetch ? Promise.resolve(null) : fetchJupiterChartContext(mint),
    ]);
    // Stage 2: depends on stage 1 — wallet exposure (needs holders) + twitter (needs asset/gmgn)
    [savedWalletExposure, twitterNarrative] = await Promise.all([
      fetchSavedWalletExposure(mint, holders),
      fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn),
    ]);
  }
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price, trenchesEntry?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
    trenchesEntry?.market_cap,
    trenchesEntry?.marketCap,
    trenchesEntry?.fdv,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    pregradToken ? 'pregrad' : null,
    trendingToken ? 'trending' : null,
    trenchesEntry ? 'trenches' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? trenchesEntry?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? trenchesEntry?.holder_count ?? trenchesEntry?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? trenchesEntry?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? trenchesEntry?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? trenchesEntry?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? trenchesEntry?.smart_degen_count ?? 0),
      pregradRssrSol: Number(pregradToken?.real_sol_reserves_sol ?? 0),
      pregradRssrPctToGrad: Number(pregradToken?.rssr_pct_to_grad ?? 0),
      pregradReplyCount: Number(pregradToken?.reply_count ?? 0),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken || trenchesEntry),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken || trenchesEntry),
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    trenchesEntry,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    createdAtMs: now(),
  };
  candidate.filters = filterCandidate(candidate);
  return candidate;
}
