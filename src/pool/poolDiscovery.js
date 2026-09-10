// Ported from meridiancx's tools/gmgn.js: given a token mint, find its Meteora DLMM
// pool(s) paired against SOL, then fetch fee/TVL detail for each so they can be scored.
// Meteora bin_step pools for a pair aren't derivable on-chain the way e.g. Uniswap v4
// pools are (different bin_step = a genuinely separate pool) — the datapi search below
// is the same mechanism meridian itself uses for "every pool a token has".
//
// Every network call here goes through enrichment/meteora.js's meteoraFetch() — a
// priority-queued, paced, backoff-aware wrapper, same pattern as every Jupiter/GMGN call
// elsewhere in this project. Never call fetch() directly against Meteora's API from here
// or anywhere else.

import { WSOL_MINT } from '../config.js';
import { meteoraFetch } from '../enrichment/meteora.js';
import { PRIORITY } from '../enrichment/priorityQueue.js';

const METEORA_DLMM_API = 'https://dlmm.datapi.meteora.ag';
const POOL_DISCOVERY_API = 'https://pool-discovery-api.datapi.meteora.ag';

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Search Meteora for DLMM pools where token_x = mint and token_y = SOL, sorted by TVL.
 * Returns the raw pool search results (up to `limit`), or [] if none found.
 */
export async function findMeteoraDlmmPoolsForMint(mint, { minTvl = 0, limit = 5, priority = PRIORITY.CANDIDATE_SCREENING } = {}) {
  const filterBy = minTvl > 0 ? `&filter_by=${encodeURIComponent(`tvl>${minTvl}`)}` : '';
  const url = `${METEORA_DLMM_API}/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent('tvl:desc')}${filterBy}`;
  const data = await meteoraFetch(url, { kind: 'pools', priority });
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools
    .filter((pool) => {
      const baseMatches = pool?.token_x?.address === mint || pool?.token_x_mint === mint;
      const quoteIsSol =
        pool?.token_y?.address === WSOL_MINT ||
        pool?.token_y_mint === WSOL_MINT ||
        pool?.token_y?.symbol === 'SOL';
      return baseMatches && quoteIsSol;
    })
    .slice(0, limit);
}

/**
 * Fetch fee/TVL/volume detail for one pool address, windowed to `timeframe`
 * (5m/30m/1h/2h/4h/12h/24h — see pool/screeningScales.js). Returns null on any failure
 * so the caller can treat "no detail" as a soft signal, not a hard error.
 */
export async function fetchPoolDetail(poolAddress, timeframe = '4h', { priority = PRIORITY.CANDIDATE_SCREENING } = {}) {
  const url = `${POOL_DISCOVERY_API}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(timeframe)}`;
  try {
    const data = await meteoraFetch(url, { kind: 'detail', priority });
    return (data?.data || [])[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Given a set of pool search results, fetch detail for each and pick the one with the
 * best fee/active-TVL ratio (falling back to raw TVL as a tiebreaker). Returns
 * { pool, detail } for the winner, or { pool: null, detail: null } if given no pools.
 */
export async function pickBestPool(pools, timeframe = '4h', { priority = PRIORITY.CANDIDATE_SCREENING } = {}) {
  if (!pools || pools.length === 0) return { pool: null, detail: null };
  const details = await Promise.all(
    pools.map((pool) => fetchPoolDetail(pool.address || pool.pool_address, timeframe, { priority })),
  );
  if (pools.length === 1) return { pool: pools[0], detail: details[0] ?? null };

  const scored = pools.map((pool, i) => {
    const d = details[i];
    const activeTvl = numOr0(d?.active_tvl ?? pool.active_tvl ?? pool.tvl ?? pool.liquidity);
    const feeActiveTvlRatio = Number(d?.fee_active_tvl_ratio) > 0
      ? Number(d.fee_active_tvl_ratio)
      : (activeTvl > 0 ? (numOr0(d?.fee) / activeTvl) * 100 : 0);
    return { pool, detail: d, feeActiveTvlRatio, activeTvl };
  });
  scored.sort((a, b) => b.feeActiveTvlRatio - a.feeActiveTvlRatio || b.activeTvl - a.activeTvl);
  return { pool: scored[0].pool, detail: scored[0].detail };
}

/**
 * Full mint -> best-scored-pool pipeline: search, fetch detail for every candidate pool,
 * and pick the best one. Returns { pools, best: { pool, detail } }. Never throws —
 * search/detail failures come back as an empty result so a bad pool lookup can't take
 * down the token-level screening loop calling this.
 */
export async function screenPoolsForMint(mint, { minTvl = 0, limit = 5, timeframe = '4h', priority = PRIORITY.CANDIDATE_SCREENING } = {}) {
  try {
    const pools = await findMeteoraDlmmPoolsForMint(mint, { minTvl, limit, priority });
    if (pools.length === 0) return { pools: [], best: { pool: null, detail: null } };
    const best = await pickBestPool(pools, timeframe, { priority });
    return { pools, best };
  } catch (err) {
    console.log(`[pool-discovery] ${mint.slice(0, 8)}... failed: ${err.message}`);
    return { pools: [], best: { pool: null, detail: null }, error: err.message };
  }
}
