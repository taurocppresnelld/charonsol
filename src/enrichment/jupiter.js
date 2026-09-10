import axios from 'axios';
import { WSOL_MINT, JSON_HEADERS } from '../config.js';
import { now, exponentialBackoffMs } from '../utils.js';
import { createPriorityQueue, PRIORITY } from './priorityQueue.js';

// Separate instance from GMGN's queue (enrichment/gmgn.js) — never shared, each provider has
// its own independent rate limit. Jupiter previously had backoff (datapiBackoffActive) but no
// queue at all — this adds priority ordering specifically so an open position's price check
// can't get stuck behind a burst of speculative candidate-screening calls.
//
// isAllowed: while EITHER Jupiter backoff signal is active, only POSITION_MONITOR-and-above
// gets pulled — deliberately conservative rather than tracking which specific backoff applies
// to which endpoint type, since this queue is shared across asset/holders/chart/quote calls.
// Safe to reference datapiBackoffActive/quoteBackoffActive here despite them being defined
// below — function declarations hoist, and isAllowed is only ever invoked later (from
// _pickNext), well after the whole module has finished loading.
const jupiterQueue = createPriorityQueue('jupiter', {
  isAllowed: (priority) => priority >= PRIORITY.POSITION_MONITOR || !(datapiBackoffActive() || quoteBackoffActive()),
});

const jupiterAssetCache = new Map();
let datapiBackoffUntil = 0;
let datapiConsecutive429s = 0; // reset on any successful datapi request — see resetDatapiBackoffStreak

// Shared across fetchJupiterAsset, fetchJupiterHolders, and fetchJupiterChartWindow — all three
// hit datapi.jup.ag. 2026-08-13: found via a real log showing holders AND all three chart
// intervals 429ing simultaneously for the same mint — fetchJupiterChartContext fires 3 parallel
// requests via Promise.all with NO backoff at all, and fetchJupiterHolders had none either. Once
// any one of these three gets rate-limited, the others are very likely hitting the same limit —
// a single shared backoff (rather than three independent ones that don't know about each other)
// means a 429 on one stops all three, instead of continuing to hammer datapi.jup.ag 3-4x per
// candidate check the way this was actually happening. Was previously asset-only
// (jupiterAssetBackoffActive/setJupiterAssetBackoff) — renamed on broadening scope; nothing
// outside this file referenced the old names.
function datapiBackoffActive() {
  return now() < datapiBackoffUntil;
}

function resetDatapiBackoffStreak() {
  datapiConsecutive429s = 0;
}

function setDatapiBackoff(err, tag = 'datapi') {
  const status = err.response?.status;
  if (status === 429) {
    datapiConsecutive429s++;
    // Same fix as setQuoteBackoff above — see that function's comment for the full reasoning.
    // Real logs showed this exact endpoint hitting the identical, consistent ~2-hour-in-the-past
    // pattern, which the earlier sane-window check couldn't catch — it only detects the header
    // disagreeing with our own now(), not both being wrong together. No longer trusts the header
    // at all; always uses the exponential delay, relative to itself.
    const fallbackMs = exponentialBackoffMs(datapiConsecutive429s, { baseMs: 30_000, maxMs: 5 * 60_000 });
    datapiBackoffUntil = now() + fallbackMs;
    console.log(`[${tag}] backing off until ${new Date(datapiBackoffUntil).toISOString()} (429, consecutive=${datapiConsecutive429s})`);
    return;
  }
  // 2026-08-18: real logs showed chart/holders 5xx errors (server-side, not rate limiting) with
  // zero backoff at all — the shared backoff only ever checked for 429, so a run of 500s just
  // got hit again next cycle at full speed. Genuinely different from a 429: no x-ratelimit-reset
  // header to trust here, and a 500 is usually a transient hiccup rather than a deliberate
  // policy, so this uses a much shorter fixed window (10s) rather than the 429 case's 30s+.
  if (status >= 500 && status < 600) {
    datapiBackoffUntil = now() + 10_000;
    console.log(`[${tag}] backing off until ${new Date(datapiBackoffUntil).toISOString()} (${status})`);
  }
}

let quoteBackoffUntil = 0;
let quoteConsecutive429s = 0; // reset on any successful quote request — see resetQuoteBackoffStreak

function quoteBackoffActive() {
  return now() < quoteBackoffUntil;
}

function resetQuoteBackoffStreak() {
  quoteConsecutive429s = 0;
}

// 2026-08-18: real logs showed one single mint generating 276 quote 400s in a row — a 400 from
// this endpoint means "no route exists for this pair" (thin/zero liquidity, or the pool's gone),
// a fact about that SPECIFIC mint, not a rate-limit signal shared across everything hitting this
// endpoint. The existing quoteBackoffActive/setQuoteBackoff pair is domain-wide and only
// triggers on 429 — correctly leaves 400s alone, since backing off EVERYTHING because one mint
// has no route would be wrong. This is the missing piece: remember "this mint has no route" for
// a while, separate from the shared backoff, so we stop asking the same already-answered
// question every single check cycle on a still-open position. 5min TTL, not permanent — a pool
// can gain liquidity later, so this shouldn't be a lifetime ban, just a pause on wasted requests.
const noRouteMintCache = new Map(); // mint -> expiry ms
const NO_ROUTE_CACHE_MS = 5 * 60_000;

function mintHasNoRoute(mint) {
  const expiry = noRouteMintCache.get(mint);
  if (expiry == null) return false;
  if (now() >= expiry) { noRouteMintCache.delete(mint); return false; }
  return true;
}

function markMintNoRoute(mint) {
  noRouteMintCache.set(mint, now() + NO_ROUTE_CACHE_MS);
}

function setQuoteBackoff(err) {
  if (err.response?.status !== 429) return;
  quoteConsecutive429s++;
  // 2026-08-22: previously trusted x-ratelimit-reset if it landed within a sane window of our
  // own now() — but real logs showed EVERY single reading landing ~2 hours in the past, with a
  // consistent -7196 to -7199s gap (barely varying, meaning the small remainder is genuine
  // rate-limit-reset seconds riding on top of a constant ~2h offset). If our own clock were
  // reliable, that should have failed the sane-window check every time — it didn't, meaning this
  // process's own now() is very likely itself skewed by roughly the same amount, making the
  // header look sane from its own (wrong) perspective. No way to fix that from in here with
  // confidence, so this stops depending on the header's absolute value at all — always uses the
  // exponential delay below, measured purely relative to itself, which can't be skewed relative
  // to its own starting point regardless of what the system clock reads.
  const fallbackMs = exponentialBackoffMs(quoteConsecutive429s, { baseMs: 30_000, maxMs: 5 * 60_000 });
  quoteBackoffUntil = now() + fallbackMs;
  console.log(`[quote] backing off until ${new Date(quoteBackoffUntil).toISOString()} (429, consecutive=${quoteConsecutive429s})`);
}

let solUsdCache = { price: null, at: 0 };

function jupiterStatsForInterval(row, interval) {
  const key = `stats${interval}`;
  return row?.[key] || row?.stats5m || row?.stats1h || row?.stats24h || {};
}

function normalizeJupiterTrendingRow(row, interval, rank) {
  const stats = jupiterStatsForInterval(row, interval);
  const buyVolume = Number(stats.buyVolume ?? 0);
  const sellVolume = Number(stats.sellVolume ?? 0);
  const numBuys = Number(stats.numBuys ?? 0);
  const numSells = Number(stats.numSells ?? 0);
  const topHolders = Number(row?.audit?.topHoldersPercentage);
  const botHolders = Number(row?.audit?.botHoldersPercentage);
  return {
    ...row,
    address: row?.id,
    price: Number(row?.usdPrice ?? 0),
    volume: buyVolume + sellVolume,
    liquidity: Number(row?.liquidity ?? 0),
    market_cap: Number(row?.mcap ?? row?.fdv ?? 0),
    swaps: numBuys + numSells,
    buys: numBuys,
    sells: numSells,
    holder_count: Number(row?.holderCount ?? 0),
    top_10_holder_rate: Number.isFinite(topHolders) ? topHolders / 100 : null,
    launchpad_platform: row?.launchpad || null,
    launchpad_status: row?.graduatedAt ? '2' : null,
    smart_degen_count: Number(stats.numOrganicBuyers ?? 0),
    hot_level: Number(row?.organicScore ?? 0),
    rug_ratio: null,
    bundler_rate: Number.isFinite(botHolders) ? botHolders / 100 : null,
    source: 'jupiter_toptrending',
    interval,
    rank,
    stats,
  };
}

async function fetchJupiterAsset(mint, { useCache = true, ttlMs = 20_000, priority = PRIORITY.CANDIDATE_SCREENING } = {}) {
  const cached = jupiterAssetCache.get(mint);
  if (useCache && cached && now() - cached.at < ttlMs) return cached.data;
  if (datapiBackoffActive()) return cached?.data || null;
  return jupiterQueue.enqueue(async () => {
    try {
      const url = new URL('https://datapi.jup.ag/v1/assets/search');
      url.searchParams.set('query', mint);
      const res = await axios.get(url.toString(), {
        timeout: 10_000,
        headers: JSON_HEADERS,
      });
      const rows = Array.isArray(res.data) ? res.data : [];
      const data = rows.find(row => row?.id === mint) || rows[0] || null;
      jupiterAssetCache.set(mint, { at: now(), data });
      resetDatapiBackoffStreak();
      return data;
    } catch (err) {
      setDatapiBackoff(err, 'asset');
      if (err.response?.status !== 429) console.log(`[asset] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
      return cached?.data || null;
    }
  }, priority);
}

// 2026-08-21: deliberately NOT queued, unlike everything else in this file. Confirmed directly
// that nesting an enqueue() call inside an already-running queued task's callback deadlocks the
// queue permanently (draining stays true forever, freezing every future request on this
// provider) — and fetchTokenSpotViaQuote/fetchEntryPriceImpactPct (both queued) call
// fetchSolUsdPriceCached() internally. Queuing this function would deadlock the very first
// cold-cache quote call. It's a single global value (not per-mint), already naturally
// self-throttled by its own 60s cache below — safe and correct to leave outside the queue.
async function fetchSolUsdPrice() {
  try {
    const res = await axios.get(`https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`, {
      timeout: 5000,
      headers: JSON_HEADERS,
    });
    const price = Number(res.data?.[WSOL_MINT]?.usdPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (err) {
    console.log(`[sol-price] ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

async function estimateTokenAmountFromSol(sizeSol, entryPrice) {
  if (!Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0) return null;
  const solUsd = await fetchSolUsdPrice();
  if (!Number.isFinite(Number(solUsd)) || Number(solUsd) <= 0) return null;
  return Number(sizeSol) * solUsd / Number(entryPrice);
}

async function fetchJupiterHolders(mint, { priority = PRIORITY.CANDIDATE_SCREENING } = {}) {
  const emptyResult = { count: 0, holders: [], top20: [], top20Percent: null, maxHolderPercent: null };
  if (datapiBackoffActive()) return emptyResult;
  return jupiterQueue.enqueue(async () => {
    try {
      const res = await axios.get(`https://datapi.jup.ag/v1/holders/${mint}`, {
        timeout: 10_000,
        headers: JSON_HEADERS,
      });
      const holders = Array.isArray(res.data?.holders) ? res.data.holders : [];
      const total = holders.reduce((sum, holder) => sum + Number(holder.amount || 0), 0);
      const mapped = holders.map((holder, index) => {
        const pct = total > 0 ? Number(holder.amount || 0) / total * 100 : null;
        return {
          address: holder.address,
          rank: index + 1,
          amount: Number(holder.amount || 0),
          percent: pct,
          tags: (holder.tags || []).map(tag => tag.name || tag.id).filter(Boolean),
        };
      });
      const top20 = mapped.slice(0, 20);
      resetDatapiBackoffStreak();
      return {
        count: holders.length,
        holders: mapped,
        top20,
        top20Percent: top20.reduce((sum, holder) => sum + Number(holder.percent || 0), 0),
        maxHolderPercent: Math.max(0, ...top20.map(holder => Number(holder.percent || 0))),
      };
    } catch (err) {
      setDatapiBackoff(err, 'holders');
      if (err.response?.status !== 429) console.log(`[holders] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
      return emptyResult;
    }
  }, priority);
}

function summarizeCandles(label, candles) {
  if (!candles.length) return { label, available: false };
  const first = candles[0];
  const last = candles[candles.length - 1];
  const high = Math.max(...candles.map(candle => Number(candle.high || 0)));
  const low = Math.min(...candles.map(candle => Number(candle.low || Infinity)));
  const volumeNative = candles.reduce((sum, candle) => sum + Number(candle.volume || 0), 0);
  const current = Number(last.close);
  const start = Number(first.open);
  return {
    label,
    available: true,
    purpose: label === 'ath_context_24h_5m' ? 'ath_context' : 'range_context',
    // BUGFIX: this used to be `candles: candles.length` (a number), which shadowed the raw
    // array under the same key. computeAtrPercent()/computeRsi() both read window.candles
    // expecting an array — under the old shape Array.isArray(window.candles) was always
    // false, so ATR (and now RSI) silently never computed. Count moved to candleCount;
    // candles now holds the actual candle array.
    candleCount: candles.length,
    candles,
    fromTime: first.time,
    toTime: last.time,
    current,
    high,
    low,
    volumeNative,
    changePercent: start > 0 ? (current / start - 1) * 100 : null,
    belowHighPercent: high > 0 ? (current / high - 1) * 100 : null,
    aboveLowPercent: low > 0 && Number.isFinite(low) ? (current / low - 1) * 100 : null,
  };
}

async function fetchJupiterChartWindow(mint, interval, candles, label) {
  if (datapiBackoffActive()) {
    const err = new Error('skipped — datapi backoff active');
    err.skippedDueToBackoff = true;
    throw err;
  }
  const url = new URL(`https://datapi.jup.ag/v2/charts/${mint}`);
  url.searchParams.set('interval', interval);
  url.searchParams.set('to', String(now()));
  url.searchParams.set('candles', String(candles));
  url.searchParams.set('type', 'price');
  url.searchParams.set('quote', 'native');
  const res = await axios.get(url.toString(), {
    timeout: 10_000,
    headers: JSON_HEADERS,
  });
  resetDatapiBackoffStreak();
  return summarizeCandles(label, Array.isArray(res.data?.candles) ? res.data.candles : []);
}

// fetchJupiterChartWindow deliberately NOT queued — it's only ever called from inside this
// function (below), which IS queued. Queuing both would nest an enqueue() call inside an
// already-running queued task, the same deadlock confirmed on fetchSolUsdPrice above.
async function fetchJupiterChartContext(mint, { priority = PRIORITY.CANDIDATE_SCREENING } = {}) {
  return jupiterQueue.enqueue(async () => {
    const windows = [
      ['5_MINUTE', 288, 'ath_context_24h_5m'],
      ['1_HOUR', 168, 'swing_7d_1h'],
      ['4_HOUR', 180, 'long_30d_4h'],
    ];
    const results = await Promise.all(windows.map(([interval, candles, label]) => (
      fetchJupiterChartWindow(mint, interval, candles, label).catch((err) => {
        // setDatapiBackoff no-ops on anything that isn't a real 429 (including the synthetic
        // skip-error above, which has no .response at all) — safe to call unconditionally rather
        // than needing to branch on skippedDueToBackoff here.
        setDatapiBackoff(err, 'chart');
        if (!err.skippedDueToBackoff) console.log(`[chart] ${mint.slice(0, 8)}... ${interval} ${err.message}`);
        return { label, available: false, error: err.message };
      })
    )));
    const available = results.filter(row => row.available);
    const currentNative = available[0]?.current ?? null;
    const rangeHigh = available.length ? Math.max(...available.map(row => Number(row.high || 0))) : null;
    const topBlastRisk = Number.isFinite(Number(currentNative)) && Number.isFinite(Number(rangeHigh)) && rangeHigh > 0
      ? currentNative / rangeHigh >= 0.85
      : null;
    return {
      quote: 'native',
      purpose: 'ATH/range context, not momentum scoring',
      currentNative,
      rangeHighNative: rangeHigh,
      belowRangeHighPercent: currentNative && rangeHigh ? (currentNative / rangeHigh - 1) * 100 : null,
      distanceFromAthPercent: currentNative && rangeHigh ? (currentNative / rangeHigh - 1) * 100 : null,
      topBlastRisk,
      windows: results,
    };
  }, priority);
}

const IGNORED_PNL_MINTS = new Set([
  'So11111111111111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

async function fetchSolUsdPriceCached() {
  if (solUsdCache.price != null && now() - solUsdCache.at < 60_000) return solUsdCache.price;
  const price = await fetchSolUsdPrice();
  solUsdCache = { price, at: now() };
  return price;
}

// Fixed 1000-token reference amount ignores price impact for large sizes —
// upgrade to position-sized quotes when size_sol > 1.
//
// MIGRATED TO SWAP API V2 (2026-08-10): v2 has no separate /quote endpoint — /order without a
// `taker` param IS the quote-only call (confirmed against dev.jup.ag/api-reference: "If not
// provided, the response will contain a quote but no transaction"). outAmount is the same field
// name in both versions, so this part of the migration is a pure URL change.
async function fetchTokenSpotViaQuote(mint, { priority = PRIORITY.CANDIDATE_SCREENING } = {}) {
  if (quoteBackoffActive() || mintHasNoRoute(mint)) return null;
  return jupiterQueue.enqueue(async () => {
    try {
      const url = new URL('https://api.jup.ag/swap/v2/order');
      url.searchParams.set('inputMint', mint);
      url.searchParams.set('outputMint', WSOL_MINT);
      url.searchParams.set('amount', '1000000000');
      url.searchParams.set('slippageBps', '100');
      const [solUsd, quoteRes] = await Promise.all([
        fetchSolUsdPriceCached(),
        axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS }),
      ]);
      resetQuoteBackoffStreak();
      const outAmount = quoteRes.data?.outAmount;
      if (!outAmount) return null;
      const outSol = Number(outAmount) / 1e9;
      if (!Number.isFinite(solUsd) || solUsd <= 0) return null;
      return (outSol / 1000) * solUsd;
    } catch (err) {
      if (err.response?.status === 400) markMintNoRoute(mint);
      setQuoteBackoff(err);
      if (err.response?.status !== 429 && err.response?.status !== 400) console.log(`[quote] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
      return null;
    }
  }, priority);
}

// Entry-side counterpart to fetchTokenSpotViaQuote, for fill-to-fill dry-run pricing (see
// db/positions.js createDryRunPosition). Quotes SOL -> token sized to the ACTUAL position
// amount (not a fixed reference size like the sell-side function above), so a thin pool shows
// real price impact for the size we'd actually buy. Deliberately does not try to derive an
// absolute token price from outAmount — that would require knowing the token's decimals, which
// this function has no reliable way to get. Returns a price-impact fraction and lets the caller
// apply it as an adjustment to a price it already trusts (the enrichment mark price) — this
// works regardless of decimals and regardless of Jupiter's exact sign convention, since the
// caller only uses the magnitude.
//
// MIGRATED TO SWAP API V2 (2026-08-10): v1's priceImpactPct (used here previously) was a decimal
// fraction (confirmed via Jupiter's own example: "priceImpactPct": "0.0001" = 0.01%). v2 renamed
// the field to priceImpact AND changed the scale — v2's official spec describes it as "in
// percentage points (e.g. -0.1 = -0.1%)", i.e. already a percent number, not a fraction.
// priceImpactPct still exists in the v2 response but is explicitly marked deprecated. Divides by
// 100 here specifically so the RETURNED value keeps the exact same decimal-fraction convention
// this function has always returned — nothing downstream (createDryRunPosition's math) needed to
// change, only the parsing of whichever API version fed it. Also added a sanity bound: this
// function's core job is protecting against a bad reading (see the bonding-curve and DUMB-token
// fixes earlier this project) — a fraction this large from a real quote would be implausible, so
// treat it as suspect rather than trust an unbounded parsed value on a migration this sandbox's
// network can't verify live.
async function fetchEntryPriceImpactPct(mint, solAmountLamports, { signal, priority = PRIORITY.ENTRY_EXECUTION } = {}) {
  if (quoteBackoffActive() || mintHasNoRoute(mint)) return null;
  if (!(solAmountLamports > 0)) return null;
  return jupiterQueue.enqueue(async () => {
    try {
      const url = new URL('https://api.jup.ag/swap/v2/order');
      url.searchParams.set('inputMint', WSOL_MINT);
      url.searchParams.set('outputMint', mint);
      url.searchParams.set('amount', String(Math.floor(solAmountLamports)));
      url.searchParams.set('slippageBps', '100');
      const res = await axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS, signal });
      resetQuoteBackoffStreak();
      const priceImpactPercentPoints = Number(res.data?.priceImpact);
      if (!Number.isFinite(priceImpactPercentPoints)) return null;
      const priceImpactFraction = priceImpactPercentPoints / 100;
      if (Math.abs(priceImpactFraction) > 5) {
        console.log(`[entry-quote] ${mint.slice(0, 8)}... implausible price impact ${priceImpactPercentPoints}% — discarding, falling back to fee-only pricing`);
        return null;
      }
      return priceImpactFraction;
    } catch (err) {
      if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') return null; // our own hard-timeout abort, not a real failure to log
      if (err.response?.status === 400) markMintNoRoute(mint);
      setQuoteBackoff(err);
      if (err.response?.status !== 429 && err.response?.status !== 400) console.log(`[entry-quote] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
      return null;
    }
  }, priority);
}

async function fetchJupiterWalletPnl(walletAddress, { priority = PRIORITY.POSITION_MONITOR } = {}) {
  return jupiterQueue.enqueue(async () => {
    try {
      const url = new URL('https://datapi.jup.ag/v1/pnl');
      url.searchParams.set('addresses', walletAddress);
      url.searchParams.set('includeClosed', 'false');
      const res = await axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS });
      const data = res.data?.[walletAddress] || {};
      for (const mint of IGNORED_PNL_MINTS) delete data[mint];
      return data;
    } catch (err) {
      console.log(`[pnl] ${err.response?.status || ''} ${err.message}`);
      return {};
    }
  }, priority);
}

export {
  jupiterStatsForInterval,
  normalizeJupiterTrendingRow,
  fetchJupiterAsset,
  fetchSolUsdPrice,
  estimateTokenAmountFromSol,
  fetchJupiterHolders,
  summarizeCandles,
  fetchJupiterChartWindow,
  fetchJupiterChartContext,
  fetchJupiterWalletPnl,
  fetchTokenSpotViaQuote,
  fetchEntryPriceImpactPct,
  datapiBackoffActive,
  setDatapiBackoff,
  quoteBackoffActive,
  setQuoteBackoff,
  jupiterQueue,
};

export function getJupiterQueueStats() {
  return jupiterQueue.stats();
}
