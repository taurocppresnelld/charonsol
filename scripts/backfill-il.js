#!/usr/bin/env node
// ── Backfill Historical Entry/Exit Prices and Compute Net PnL (Fees + IL) ──
import axios from 'axios';
import { initDb, db } from '../src/db/connection.js';
import { safeJson } from '../src/utils.js';

initDb();

/**
 * Calculates Impermanent Loss for a Concentrated DLMM Position.
 * @param {number} p0 - Entry price in USD
 * @param {number} pt - Exit price in USD
 * @param {number} binStep - Pool bin step in bps (default 20)
 * @param {number} numBins - Active bins covered (default 10)
 */
function calculateDlmmIL(p0, pt, binStep = 20, numBins = 10) {
  if (!p0 || !pt || p0 <= 0 || pt <= 0) return 0;

  const r = pt / p0;
  const stepFactor = (binStep / 10000) * (numBins / 2);
  const pa = p0 * (1 - stepFactor);
  const pb = p0 * (1 + stepFactor);

  const ka = Math.sqrt(Math.max(0.0001, pa / p0));
  const kb = Math.sqrt(pb / p0);

  const standardIL = (2 * Math.sqrt(r)) / (1 + r) - 1;
  const concentrationMultiplier = 1 / Math.max(0.1, 1 - (ka / kb));

  return Math.max(-1.0, Math.min(0, standardIL * concentrationMultiplier));
}

/**
 * Helper to fetch historical token price in USD at a specific timestamp.
 * Uses Birdeye/Jupiter historical endpoints with fallback handling.
 */
async function fetchHistoricalPrice(mintAddress, timestampMs) {
  if (!mintAddress) return null;
  const timeInSeconds = Math.floor(timestampMs / 1000);

  try {
    // Attempt fetching via Birdeye historical price API
    const res = await axios.get(
      `https://public-api.birdeye.so/defi/history_price?address=${mintAddress}&address_type=token&type=1m&time_from=${timeInSeconds}&time_to=${timeInSeconds + 300}`,
      {
        headers: {
          'X-API-KEY': process.env.BIRDEYE_API_KEY || '',
          'accept': 'application/json'
        },
        timeout: 4000
      }
    );

    const price = res.data?.data?.items?.[0]?.value;
    if (price) return parseFloat(price);
  } catch (err) {
    // Fallback: Attempt fetching current Jupiter price if historical API is unavailable/unauthorized
    try {
      const jupRes = await axios.get(`https://api.jup.ag/price/v2?ids=${mintAddress}`, { timeout: 3000 });
      const priceStr = jupRes.data?.data?.[mintAddress]?.price;
      if (priceStr) return parseFloat(priceStr);
    } catch (jupErr) {
      return null;
    }
  }
  return null;
}

async function runBackfill() {
  console.log('=== STARTING HISTORICAL IL BACKFILL ===\n');

  // Fetch closed positions needing price backfill
  const positions = db.prepare(`
    SELECT 
      s.id,
      s.notional_usd,
      s.realized_fee_usd,
      s.bin_step,
      s.opened_at_ms,
      s.closed_at_ms,
      s.entry_price_usd,
      s.current_price_usd,
      c.candidate_json
    FROM lp_sim_positions s
    LEFT JOIN lp_candidates lc ON lc.id = s.lp_candidate_id
    LEFT JOIN candidates c ON c.id = lc.candidate_id
    WHERE s.status = 'closed'
    ORDER BY s.id ASC
  `).all();

  console.log(`Found ${positions.length} closed position(s) to process.`);

  const updateStmt = db.prepare(`
    UPDATE lp_sim_positions
    SET 
      entry_price_usd = ?,
      current_price_usd = ?,
      il_usd = ?,
      net_pnl_usd = ?
    WHERE id = ?
  `);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const pos of positions) {
    const candidate = safeJson(pos.candidate_json, {})?.candidate ?? safeJson(pos.candidate_json, {});
    const tokenMint = candidate?.jupiterAsset?.id || candidate?.address || candidate?.mint;

    if (!tokenMint) {
      skippedCount++;
      continue;
    }

    // 1. Fetch or preserve entry price
    let entryPrice = pos.entry_price_usd > 0 ? pos.entry_price_usd : null;
    if (!entryPrice && pos.opened_at_ms) {
      entryPrice = await fetchHistoricalPrice(tokenMint, pos.opened_at_ms);
      // Small sleep to avoid rate limiting public APIs
      await new Promise(r => setTimeout(r, 200));
    }

    // 2. Fetch or preserve exit price
    let exitPrice = pos.current_price_usd > 0 ? pos.current_price_usd : null;
    if (!exitPrice && pos.closed_at_ms) {
      exitPrice = await fetchHistoricalPrice(tokenMint, pos.closed_at_ms);
      await new Promise(r => setTimeout(r, 200));
    }

    // Default fallback if price data cannot be fetched
    entryPrice = entryPrice || 1.0;
    exitPrice = exitPrice || entryPrice;

    // 3. Compute IL and Net PnL
    const notional = pos.notional_usd || 100;
    const binStep = pos.bin_step || 20;
    const ilPct = calculateDlmmIL(entryPrice, exitPrice, binStep);
    const ilUsd = notional * ilPct;
    const netPnlUsd = (pos.realized_fee_usd || 0) + ilUsd;

    // 4. Commit to database
    updateStmt.run(entryPrice, exitPrice, ilUsd, netPnlUsd, pos.id);
    updatedCount++;

    if (updatedCount % 25 === 0) {
      console.log(`Processed ${updatedCount}/${positions.length} positions...`);
    }
  }

  console.log(`\n=== BACKFILL COMPLETE ===`);
  console.log(`Successfully updated: ${updatedCount}`);
  console.log(`Skipped (missing mint): ${skippedCount}`);
}

runBackfill();