import { gmgnFetch, gmgnBackoffActive, setGmgnBackoff, normalizedTrendingRows } from '../enrichment/gmgn.js';
import { findMeteoraDlmmPoolsForMint } from '../pool/poolDiscovery.js';
import { PRIORITY } from '../enrichment/priorityQueue.js';
import { storeSignalEvent } from './trending.js';
import { now } from '../utils.js';
import { numSetting, setting, boolSetting } from '../db/settings.js';
import {
  MERIDIAN_TOKENS_ENABLED,
  MERIDIAN_TOKENS_INTERVAL,
  MERIDIAN_TOKENS_LIMIT,
  MERIDIAN_TOKENS_POOL_CHECK_LIMIT,
  POOL_MIN_TVL,
} from '../config.js';

export const meridianTokens = new Map();
let candidateHandler = null;

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

// Own settings namespace (meridian_tokens_*) — deliberately separate from trending.js's
// trending_* knobs, since this source's job (find something with real Meteora liquidity)
// is different enough from trending's (find fresh pump.fun momentum) that they shouldn't
// share thresholds.
function meridianTokenPass(row) {
  const volume = Number(row?.volume ?? 0);
  const liquidity = Number(row?.liquidity ?? 0);
  const marketCap = Number(row?.market_cap ?? 0);
  const holderCount = Number(row?.holder_count ?? 0);
  const rugRatio = Number(row?.rug_ratio ?? 0);
  const bundlerRate = Number(row?.bundler_rate ?? 0);
  const top10Rate = Number(row?.top_10_holder_rate ?? 0);

  const minVolume = numSetting('meridian_tokens_min_volume_usd', 20_000);
  const minLiquidity = numSetting('meridian_tokens_min_liquidity_usd', POOL_MIN_TVL);
  const minHolders = numSetting('meridian_tokens_min_holders', 50);
  const minMcap = numSetting('meridian_tokens_min_mcap_usd', 10_000);
  const maxMcap = numSetting('meridian_tokens_max_mcap_usd', 0); // 0 = no ceiling
  const maxRugRatio = numSetting('meridian_tokens_max_rug_ratio', 0.15);
  const maxBundlerRate = numSetting('meridian_tokens_max_bundler_rate', 0.35);
  const maxTop10Rate = numSetting('meridian_tokens_max_top10_rate', 0.35);

  if (minVolume > 0 && volume < minVolume) return false;
  if (minLiquidity > 0 && liquidity < minLiquidity) return false;
  if (minHolders > 0 && holderCount < minHolders) return false;
  if (minMcap > 0 && marketCap < minMcap) return false;
  if (maxMcap > 0 && marketCap > maxMcap) return false;
  if (maxRugRatio > 0 && rugRatio > maxRugRatio) return false;
  if (maxBundlerRate > 0 && bundlerRate > maxBundlerRate) return false;
  if (maxTop10Rate > 0 && top10Rate > maxTop10Rate) return false;
  if (row?.is_wash_trading === true || row?.is_wash_trading === 1) return false;
  return true;
}

/**
 * Poll cycle: fetch GMGN's broad market-rank (any Solana token, any platform — no
 * pump-suffix filter), apply a light sanity bar, then confirm a real Meteora/SOL pool
 * exists for each survivor (bounded to MERIDIAN_TOKENS_POOL_CHECK_LIMIT checks per cycle
 * to keep Meteora API usage reasonable) before ever forwarding it as a candidate.
 */
export async function fetchMeridianRankedTokens() {
  if (!MERIDIAN_TOKENS_ENABLED) return;
  if (gmgnBackoffActive('meridian_tokens')) return;

  const interval = setting('meridian_tokens_interval', MERIDIAN_TOKENS_INTERVAL);
  const limit = Math.max(1, Math.min(200, Math.floor(numSetting('meridian_tokens_limit', MERIDIAN_TOKENS_LIMIT))));
  const orderBy = setting('meridian_tokens_order_by', 'volume');

  let rows;
  try {
    const payload = await gmgnFetch('/v1/market/rank', {
      params: {
        chain: 'sol',
        interval,
        limit,
        order_by: orderBy,
        direction: 'desc',
        filters: ['renounced', 'frozen', 'not_wash_trading'],
        // No platforms restriction, unlike trending.js — that's the whole point of this
        // source: find real liquidity wherever it is, not just on pump.fun's bonding curve.
      },
    });
    rows = normalizedTrendingRows(payload);
  } catch (err) {
    setGmgnBackoff('meridian_tokens', err);
    const status = err.response?.status || '';
    if (status !== 403 && status !== 429) {
      console.log(`[meridian-tokens] rank fetch failed: ${status} ${err.response?.data?.message || err.message}`);
    }
    return;
  }

  const seenAt = now();
  let sanityPassed = 0;
  let poolChecked = 0;
  let poolConfirmed = 0;
  let forwarded = 0;

  for (const [index, row] of rows.entries()) {
    const mint = row?.address || row?.mint;
    if (!mint || meridianTokens.has(mint) || !meridianTokenPass(row)) continue;
    sanityPassed++;
    if (poolChecked >= MERIDIAN_TOKENS_POOL_CHECK_LIMIT) continue; // bound Meteora API calls per cycle

    poolChecked++;
    let pools = [];
    try {
      pools = await findMeteoraDlmmPoolsForMint(mint, { minTvl: numSetting('pool_min_tvl', POOL_MIN_TVL), limit: 1, priority: PRIORITY.GRADUATION_TRACKING });
    } catch (err) {
      console.log(`[meridian-tokens] pool check failed for ${mint.slice(0, 8)}...: ${err.message}`);
      continue;
    }
    if (pools.length === 0) continue; // no confirmed Meteora pool — skip, same as before this source existed
    poolConfirmed++;

    const token = { ...row, address: mint, interval, rank: index + 1, seenAt, source: 'meridian_gmgn_rank' };
    meridianTokens.set(mint, token);
    storeSignalEvent(mint, 'meridian_tokens', 'gmgn_market_rank', token);

    if (candidateHandler) {
      forwarded++;
      candidateHandler({ mint, trendingToken: token, route: 'meridian_gmgn_rank' }).catch(err =>
        console.log(`[meridian-tokens] candidate trigger failed for ${mint.slice(0, 8)}: ${err.message}`),
      );
    }
  }

  // Dedup map cleanup — same lookback pattern as trending.js, prevents unbounded growth.
  const cutoff = seenAt - 6 * 60 * 60 * 1000;
  for (const [mint, token] of meridianTokens) {
    if (Number(token.seenAt || 0) < cutoff) meridianTokens.delete(mint);
  }

  console.log(
    `[meridian-tokens] ranked ${rows.length} → ${sanityPassed} passed sanity filter → ` +
    `${poolChecked} pool-checked → ${poolConfirmed} confirmed Meteora pool → ${forwarded} forwarded ` +
    `(tracking ${meridianTokens.size})`,
  );
}
