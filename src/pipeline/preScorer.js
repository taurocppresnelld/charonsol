import { now } from '../utils.js';

/**
 * Rule-based pre-scorer — filters candidates BEFORE LLM call.
 * Returns { passed: boolean, score: number, reasons: string[] }
 *
 * Data comes from candidate.gmgn (already fetched during buildCandidate).
 * NO additional API calls — pure computation.
 */
export function preScoreCandidate(candidate) {
  const reasons = [];
  let score = 0;

  const gmgn = candidate.gmgn || {};
  const metrics = candidate.metrics || {};
  const trending = candidate.trending || {};
  const signals = candidate.signals || {};

  // 1. Smart degen count (0-30 points)
  const smartDegens = Number(trending.smart_degen_count || gmgn.smart_degen_count || 0);
  if (smartDegens >= 10) { score += 30; reasons.push(`smart_degen: ${smartDegens} (high)`); }
  else if (smartDegens >= 5) { score += 20; reasons.push(`smart_degen: ${smartDegens} (medium)`); }
  else if (smartDegens >= 3) { score += 10; reasons.push(`smart_degen: ${smartDegens} (low)`); }
  else { reasons.push(`smart_degen: ${smartDegens} (very low)`); }

  // 2. Organic score (0-25 points)
  const organic = Number(trending.organic_score || gmgn.organic_score || 0);
  if (organic >= 70) { score += 25; reasons.push(`organic: ${organic} (high)`); }
  else if (organic >= 50) { score += 15; reasons.push(`organic: ${organic} (medium)`); }
  else if (organic >= 30) { score += 5; reasons.push(`organic: ${organic} (low)`); }
  else { reasons.push(`organic: ${organic} (very low)`); }

  // 3. Bundler rate (0-20 points, lower is better)
  const bundlerRate = Number(trending.bundler_rate || gmgn.bundler_rate || 0);
  if (bundlerRate < 0.1) { score += 20; reasons.push(`bundler: ${(bundlerRate * 100).toFixed(0)}% (clean)`); }
  else if (bundlerRate < 0.3) { score += 10; reasons.push(`bundler: ${(bundlerRate * 100).toFixed(0)}% (ok)`); }
  else { reasons.push(`bundler: ${(bundlerRate * 100).toFixed(0)}% (high)`); }

  // 4. Market cap sweet spot (0-15 points)
  const mcap = Number(metrics.marketCapUsd || gmgn.usd_market_cap || 0);
  if (mcap >= 10000 && mcap <= 100000) { score += 15; reasons.push(`mcap: $${(mcap/1000).toFixed(0)}K (sweet spot)`); }
  else if (mcap >= 5000 && mcap <= 200000) { score += 8; reasons.push(`mcap: $${(mcap/1000).toFixed(0)}K (ok)`); }
  else { reasons.push(`mcap: $${(mcap/1000).toFixed(0)}K (outside range)`); }

  // 5. Holder count (0-10 points)
  const holders = Number(metrics.holderCount || gmgn.holder_count || 0);
  if (holders >= 50) { score += 10; reasons.push(`holders: ${holders} (good)`); }
  else if (holders >= 30) { score += 5; reasons.push(`holders: ${holders} (ok)`); }
  else { reasons.push(`holders: ${holders} (low)`); }

  // Check if passed (threshold: 35 points out of 100, loosened from 45 on 2026-06-22 for volume)
  const threshold = 35;
  const passed = score >= threshold;

  return { passed, score, reasons, threshold };
}

export default preScoreCandidate;
