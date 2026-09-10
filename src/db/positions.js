import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy, slippageAdjustedMcap } from './settings.js';
import { fetchEntryPriceImpactPct } from '../enrichment/jupiter.js';

// 2026-08-20: rolling window of recent entry-quote latencies, feeding
// reject_on_slow_entry_quote below. In-memory, resets on restart — same tradeoff as
// priceSampleHistory/slHitStreaks in execution/positions.js (fine here since this is about
// recent, current network conditions, not something that needs to survive a restart).
const entryQuoteLatencyWindow = [];
const ENTRY_QUOTE_WINDOW_MAX = 100;

function recordEntryQuoteLatency(ms) {
  entryQuoteLatencyWindow.push(ms);
  if (entryQuoteLatencyWindow.length > ENTRY_QUOTE_WINDOW_MAX) entryQuoteLatencyWindow.shift();
}

function entryQuoteLatencyMean() {
  if (entryQuoteLatencyWindow.length === 0) return null;
  return entryQuoteLatencyWindow.reduce((a, b) => a + b, 0) / entryQuoteLatencyWindow.length;
}

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function hasClosedPosition(mint) {
  const row = db.prepare(`
    SELECT 1 FROM dry_run_positions WHERE mint = ? AND status = 'closed' LIMIT 1
  `).get(mint);
  return !!row;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function positionsByStatus(status, limit = 2000) {
  if (status !== 'open' && status !== 'closed') {
    return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
  }
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit);
}

export async function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const fnStart = now();
  const strat = activeStrategy();
  let sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  
  // OPTION C HYBRID: Risk-based position sizing
  // Calculate total risk severity from candidate.riskFlags
  const riskFlags = candidate.riskFlags || [];
  const totalRiskSeverity = riskFlags.reduce((sum, flag) => sum + (flag.severity || 0), 0);
  
  if (totalRiskSeverity >= 2) {
    // High risk (severity ≥2) → cut size to 50%
    const originalSize = sizeSol;
    sizeSol *= 0.5;
    console.log(`[position] risk-adjusted size: ${originalSize} → ${sizeSol} SOL (total risk severity: ${totalRiskSeverity}, flags: ${riskFlags.map(f => f.type).join(', ')})`);
  }

  const markPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const rawMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;

  // Fill-to-fill entry pricing (2026-08-07): use an executable Jupiter buy quote sized to our
  // actual position amount, instead of assuming a clean fill at the mark price. Combined with
  // the fee simulation below, this is meant to make dry-run results track live execution more
  // closely — see the exit-side equivalent (exit_quote_enabled) this mirrors.
  //
  // HARDENING (2026-08-07, after a live report of positions never opening post-deploy): this
  // call sits directly on the critical path between a BUY verdict and the position actually
  // getting recorded — axios has its own 10s timeout inside fetchEntryPriceImpactPct, but
  // that's one library's word that it can never hang on this specific host/network. Racing it
  // against an independent, hard-coded timeout here means even if that assumption turns out to
  // be wrong for some network condition we haven't seen, this function still can't hang forever
  // on a network call that was only ever meant to be an optional pricing refinement.
  const entryQuoteEnabled = boolSetting('dry_run_entry_quote_enabled', true);
  let priceImpactPct = null;
  let entryQuoteMs = 0;
  if (entryQuoteEnabled && markPrice) {
    const amountLamports = Math.floor(sizeSol * 1_000_000_000);
    const controller = new AbortController();
    const hardTimeoutId = setTimeout(() => controller.abort(), 8000);
    const quoteStart = now();
    try {
      priceImpactPct = await fetchEntryPriceImpactPct(candidate.token.mint, amountLamports, { signal: controller.signal }).catch(() => null);
    } finally {
      clearTimeout(hardTimeoutId);
      entryQuoteMs = now() - quoteStart;
    }

    // 2026-08-20: reject_on_slow_entry_quote — an abnormally slow quote can mean the pricing
    // data behind this trade is already stale by the time it lands (the token may have moved
    // meaningfully in that extra time), so it's a genuine "this specific fill might not be
    // trustworthy" signal, not just a latency nuisance. Compares against a ROLLING window of
    // recent quote times, not a fixed number — "twice normal" adapts as real network conditions
    // shift, rather than needing manual retuning. Off by default: this changes what actually
    // gets traded, not just logging, so it's opt-in same as everything else this session with
    // real trading-behavior impact.
    const priorMean = entryQuoteLatencyMean();
    const priorCount = entryQuoteLatencyWindow.length;
    recordEntryQuoteLatency(entryQuoteMs); // record regardless of whether this rejects — a slow
    // period should still update the baseline, or the check could get permanently stuck
    // comparing against a baseline from before conditions genuinely changed.

    const rejectOnSlowQuote = boolSetting('reject_on_slow_entry_quote', false);
    const slowQuoteMultiplier = numSetting('slow_entry_quote_multiplier', 2);
    const minSamples = numSetting('slow_entry_quote_min_samples', 10);
    if (rejectOnSlowQuote && priorCount >= minSamples && priorMean > 0 && entryQuoteMs > priorMean * slowQuoteMultiplier) {
      console.log(`[position] REJECTED entry for ${candidate.token.mint.slice(0, 8)}... — entry-quote took ${entryQuoteMs}ms, over ${slowQuoteMultiplier}x the recent mean (${priorMean.toFixed(0)}ms across ${priorCount} samples). Pricing may already be stale.`);
      return {
        id: null,
        isNew: false,
        rejectedSlowQuote: true,
        entryQuoteMs,
        meanEntryQuoteMs: priorMean,
        sampleCount: priorCount,
      };
    }
  }

  // Simulated execution cost: a % platform/aggregator fee (dry_run_fee_bps, applied to trade
  // value) plus a flat network/priority fee (dry_run_network_fee_sol, applied per transaction).
  // These are estimates — tune both to match your actual Jupiter fee arrangement and chosen
  // priority-fee level once you know them, for genuine live-parity rather than a guess.
  const feeBps = numSetting('dry_run_fee_bps', 20);
  const networkFeeSol = numSetting('dry_run_network_fee_sol', 0.0005);
  const feePct = (feeBps / 10000) + (sizeSol > 0 ? networkFeeSol / sizeSol : 0);

  // Both effects make the effective entry cost MORE (worse for us) than the raw mark price —
  // price impact and fees are both costs paid on the way in, never a benefit.
  const impactPct = Number.isFinite(priceImpactPct) ? Math.abs(priceImpactPct) : 0;
  const totalCostPct = impactPct + feePct;
  const entryPrice = markPrice != null ? markPrice * (1 + totalCostPct) : null;
  let entryMcap = rawMcap != null ? rawMcap * (1 + totalCostPct) : null;
  // Existing manual slippage setting (default 0) layers on top, independent of the new
  // quote-based mechanism above — kept as-is so any prior configuration still applies.
  entryMcap = slippageAdjustedMcap(entryMcap, 'entry');
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };

    // Dedup: block re-entry if this token has been closed within 24 hours
    const recentClosed = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
    `).get(candidate.token.mint, now() - 86400000);
    if (recentClosed) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — closed <24h ago`);
      return { id: recentClosed.id, isNew: false };
    }

    // Block re-entry if this mint had a winning trade in the last WIN_BLOCK_DAYS days (avoid round-trip losses)
    const WIN_BLOCK_DAYS = 7;
    const pastWin = db.prepare(`
      SELECT id, pnl_sol, closed_at_ms FROM dry_run_positions
      WHERE mint = ? AND status = 'closed' AND pnl_percent > 0
        AND closed_at_ms > ?
      ORDER BY closed_at_ms DESC LIMIT 1
    `).get(candidate.token.mint, now() - WIN_BLOCK_DAYS * 86400000);
    if (pastWin) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — past WIN exists`);
      return { id: pastWin.id, isNew: false, blockedBy: 'past_win', pastWinPnlSol: pastWin.pnl_sol, pastWinClosedAtMs: pastWin.closed_at_ms };
    }

    // Feeds dynamic_max_hold (execution/positions.js) — the strongest single entry-time signal
    // we've found for predicting whether a position resolves into a real move vs times out
    // (300+ sample backtest: median 7 net-buyers for MAX_HOLD exits vs 19 for TRAILING_TP wins).
    // Explicit null-check, not Number(x ?? null) — same reasoning as every other place this
    // session: Number(null) is 0 in JS, which would make "no data" indistinguishable from a
    // real, meaningful zero.
    const entryNb5mRaw = candidate.jupiterAsset?.stats5m?.numNetBuyers;
    const entryNb5m = entryNb5mRaw != null ? Number(entryNb5mRaw) : null;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json, entry_nb5m
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
      entryNb5m,
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({
      candidateId,
      decision,
      markPrice,
      priceImpactPct,
      feeBps,
      networkFeeSol,
      totalCostPct,
    }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return {
      id: positionId,
      isNew: true,
      // 2026-08-20: entryQuoteMs isolates the one real, meaningfully-slow network call in this
      // function (fetchEntryPriceImpactPct, up to an 8s hard timeout) from everything else here
      // (DB writes, risk sizing) which is fast/local. totalMs is the whole function, so
      // totalMs - entryQuoteMs is roughly "everything except the network call" for comparison.
      timing: { entryQuoteMs, totalMs: now() - fnStart },
    };
  })();
}

// SECURITY FIX (audit finding C2, 2026-07-07): createLivePosition's dedup guard (existing open /
// recently-closed <24h / past-win) only ran AFTER executeJupiterSwap already spent real SOL —
// a guard hit meant tokens were bought but never tracked (orphaned, never monitored for TP/SL).
// This is the same three checks, read-only, so router.js can call it BEFORE the swap and abort
// without spending anything. The in-transaction checks inside createLivePosition stay as-is —
// this doesn't replace them, it's a fast-fail in front of them for the common case.
export function wouldBlockLiveEntry(mint) {
  const existing = db.prepare(`SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1`).get(mint);
  if (existing) return { blocked: true, reason: 'existing_open_position', positionId: existing.id };

  const recentClosed = db.prepare(`
    SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
  `).get(mint, now() - 86400000);
  if (recentClosed) return { blocked: true, reason: 'closed_within_24h', positionId: recentClosed.id };

  const pastWin = db.prepare(`SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND pnl_percent > 0 LIMIT 1`).get(mint);
  if (pastWin) return { blocked: true, reason: 'past_win_exists', positionId: pastWin.id };

  return { blocked: false };
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };

    // Dedup: block re-entry if this token has been closed within 24 hours
    const recentClosed = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
    `).get(candidate.token.mint, now() - 86400000);
    if (recentClosed) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — closed <24h ago (live)`);
      return { id: recentClosed.id, isNew: false };
    }

    // Block re-entry if this mint ever had a winning trade (avoid round-trip losses)
    const pastWin = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND pnl_percent > 0 LIMIT 1
    `).get(candidate.token.mint);
    if (pastWin) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — past WIN exists (live)`);
      return { id: pastWin.id, isNew: false };
    }

    const entryNb5mRaw = candidate.jupiterAsset?.stats5m?.numNetBuyers;
    const entryNb5m = entryNb5mRaw != null ? Number(entryNb5mRaw) : null;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json, entry_nb5m
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
      entryNb5m,
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}
