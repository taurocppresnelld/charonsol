import axios from 'axios';
import { JSON_HEADERS, GRADUATED_LOOKBACK_MS, GRADUATED_POLL_MS } from '../config.js';
import { now, sleep } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { fetchGmgnTokenInfo, gmgnBackoffActive, setGmgnBackoff } from '../enrichment/gmgn.js';

export const graduated = new Map();
const watchedMints = new Map();
let pollTimer = null;

const PUMP_FUN_GRADUATION_LIQUIDITY_SOL = 85;
const PUMP_FUN_GRADUATION_MARKET_CAP_USD = Number(process.env.PUMP_FUN_GRADUATION_MCAP_USD || 69000);

function isGraduated(info) {
  if (!info) return false;
  const liquiditySol = Number(info.liquidity_sol ?? info.pool?.liquidity_sol ?? 0);
  const liquidityUsd = Number(info.liquidity ?? info.pool?.liquidity ?? 0);
  const marketCapUsd = Number(info.market_cap ?? info.mcap ?? 0);
  const openBook = info.pool?.open_book ?? info.open_book ?? null;
  const lpLocked = info.lp_locked ?? info.pool?.lp_locked ?? null;
  if (liquiditySol >= PUMP_FUN_GRADUATION_LIQUIDITY_SOL) return true;
  if (Number.isFinite(marketCapUsd) && marketCapUsd >= PUMP_FUN_GRADUATION_MARKET_CAP_USD) return true;
  if (openBook && openBook !== '' && openBook !== '0x0') return true;
  if (lpLocked === true || lpLocked === 1) return true;
  return false;
}

function getRecentPumpMints() {
  return new Set(watchedMints.keys());
}

export async function fetchGraduatedCoins() {
  // 2026-08-15: pump.fun's advanced-api-v2 domain now requires JWT auth on this endpoint (per
  // their own API spec's README — "Most APIs require JWT authentication... to ensure complete
  // data retrieval and avoid potential access issues"), which this bot has no way to obtain —
  // it's tied to a real pump.fun account/credential, not something fixable in code. Confirmed
  // via real logs: 100% failure rate, zero successful loads across a full 2-day capture. This
  // poll is also genuinely redundant — signals/pumpportal.js's own subscribeMigration websocket
  // already writes into this exact same `graduated` Map independently, so disabling this loop
  // loses no real functionality, just removes a poll that was silently failing every cycle.
  if (!boolSetting('graduated_pumpfun_feed_enabled', true)) return;
  try {
    const res = await axios.get('https://advanced-api-v2.pump.fun/coins/graduated', {
      timeout: 10_000,
      headers: JSON_HEADERS,
    });
    const coins = Array.isArray(res.data?.coins) ? res.data.coins : [];
    const cutoff = now() - GRADUATED_LOOKBACK_MS;
    for (const coin of coins) {
      const mint = coin?.coinMint;
      if (!mint) continue;
      const graduationDate = Number(coin.graduationDate || 0);
      if (graduationDate > 0 && graduationDate < cutoff) continue;
      graduated.set(mint, { ...coin, coinMint: mint, seenAt: now(), source: 'pump_graduated' });
    }
    for (const [mint, coin] of graduated) {
      const ts = Number(coin.graduationDate || coin.seenAt || 0);
      if (ts > 0 && ts < cutoff) graduated.delete(mint);
    }
    console.log(`[graduated] pump.fun loaded ${coins.length}, tracking ${graduated.size}`);
  } catch (err) {
    console.log(`[graduated] pump.fun fetch failed: ${err.message}`);
  }
}

export async function fetchLatestPumpCoins(limit = 50) {
  try {
    const res = await axios.get(`https://advanced-api-v2.pump.fun/coins/latest?limit=${limit}`, {
      timeout: 10_000,
      headers: JSON_HEADERS,
    });
    const coins = Array.isArray(res.data?.coins) ? res.data.coins : [];
    const cutoff = now() - GRADUATED_LOOKBACK_MS;
    let added = 0;
    for (const coin of coins) {
      const mint = coin?.coinMint || coin?.mint;
      if (!mint) continue;
      const createdAt = Number(coin.created_timestamp || coin.createdAt || 0);
      if (createdAt > 0 && createdAt < cutoff) continue;
      if (!watchedMints.has(mint)) {
        watchedMints.set(mint, { addedAt: now(), source: 'pump_latest' });
        added++;
      }
    }
    for (const [mint, entry] of watchedMints) {
      if (Number(entry.addedAt || 0) < cutoff) watchedMints.delete(mint);
    }
    if (added > 0) console.log(`[graduated] watching ${added} new pump mints (total ${watchedMints.size})`);
  } catch (err) {
    console.log(`[graduated] pump.latest fetch failed: ${err.message}`);
  }
}

export async function pollGraduationStatus() {
  if (gmgnBackoffActive('token')) return;
  if (!boolSetting('graduation_polling_enabled', true)) return;
  const batchSize = Math.max(1, Math.min(20, Math.floor(numSetting('graduation_poll_batch_size', 8))));
  const cutoff = now() - GRADUATED_LOOKBACK_MS;
  const mints = [...watchedMints.keys()]
    .filter(mint => !graduated.has(mint))
    .sort((a, b) => Number(watchedMints.get(a)?.addedAt || 0) - Number(watchedMints.get(b)?.addedAt || 0))
    .slice(0, batchSize);
  if (!mints.length) return;

  let detected = 0;
  const gmgnTokenLookupEnabled = boolSetting('gmgn_token_lookup_enabled', true);
  for (const mint of mints) {
    if (graduated.has(mint)) continue;
    // 2026-08-21: previously unconditional — gmgn_token_lookup_enabled was only ever wired to
    // pumpportal.js's separate graduation-tracking path, not this one. With this off, graduation
    // detection through this specific watched-mints mechanism simply pauses (no info this cycle,
    // same as any other failed lookup) rather than calling a known-failing/banned endpoint.
    const info = gmgnTokenLookupEnabled ? await fetchGmgnTokenInfo(mint, false) : null;
    if (!info) continue;
    if (!isGraduated(info)) continue;
    const entry = watchedMints.get(mint) || {};
    graduated.set(mint, {
      coinMint: mint,
      name: info.name || entry.name || '',
      ticker: info.symbol || entry.symbol || '',
      marketCap: Number(info.market_cap ?? info.mcap ?? 0) || null,
      usd_market_cap: Number(info.market_cap ?? info.mcap ?? 0) || null,
      numHolders: Number(info.holder_count ?? 0) || null,
      liquidity: Number(info.liquidity ?? 0) || null,
      liquidity_sol: Number(info.liquidity_sol ?? 0) || null,
      graduationDate: now(),
      seenAt: now(),
      detectedAt: now(),
      source: 'gmgn_polling',
      gmgnInfo: info,
    });
    detected++;
    console.log(`[graduated] detected via gmgn /v1/token/info: ${mint.slice(0, 8)}... liquidity=${info.liquidity_sol ?? info.liquidity} mcap=${info.market_cap ?? info.mcap}`);
  }
  for (const [mint, coin] of graduated) {
    const ts = Number(coin.graduationDate || coin.seenAt || 0);
    if (ts > 0 && ts < cutoff) graduated.delete(mint);
  }
  if (detected > 0) console.log(`[graduated] poll detected ${detected} new graduates (tracking ${graduated.size})`);
}

function handleGraduationPollError(err) {
  if (err?.response?.status) setGmgnBackoff('token', err);
  console.log(`[graduated] poll cycle error: ${err.message}`);
}

async function pollLoop() {
  try {
    // fetchLatestPumpCoins removed — endpoint /coins/latest returns 404
    // Only poll GMGN token/info for mints already in graduated map
    await pollGraduationStatus();
  } catch (err) {
    handleGraduationPollError(err);
  }
}

export function startGraduationPolling() {
  if (pollTimer) return;
  if (!boolSetting('graduation_polling_enabled', true)) {
    console.log('[graduated] polling disabled by setting');
    return;
  }
  pollGraduationStatus().catch(err => handleGraduationPollError(err));
  // fetchLatestPumpCoins removed — endpoint /coins/latest returns 404
  pollTimer = setInterval(() => pollLoop().catch(err => handleGraduationPollError(err)), GRADUATED_POLL_MS);
  console.log(`[graduated] polling started (interval ${GRADUATED_POLL_MS}ms)`);
}

export function stopGraduationPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function _internalForTest() {
  return { graduated, watchedMints, isGraduated, getRecentPumpMints };
}

if (process.env.CHARON_GRADUATED_TEST === '1') {
  const mint = process.env.CHARON_TEST_MINT;
  if (mint) {
    fetchGmgnTokenInfo(mint, false).then(info => {
      console.log(JSON.stringify({ mint, isGraduated: isGraduated(info), info }, null, 2));
    }).catch(err => console.error(err.message));
  } else {
    isGraduated({ liquidity_sol: 90, market_cap: 70000 });
  }
}
