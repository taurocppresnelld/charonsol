// src/pipeline/lpSimulator.js

import { 
  createLpSimPosition, 
  updateLpSimPositionHealth, 
  closeLpSimPosition 
} from '../db/lpSimPositions.js';
import { calculateDlmmIL, fetchCurrentTokenPrice } from './lpSimulatorHelpers.js';

/**
 * Opens a simulated position and records initial entry price.
 */
export async function openSimulatedPosition(candidate) {
  const tokenMint = candidate.mintAddress;
  const entryPriceUsd = (await fetchCurrentTokenPrice(tokenMint)) || candidate.entryPriceUsd || 0;

  const positionId = createLpSimPosition({
    lpCandidateId: candidate.id,
    notionalUsd: candidate.notionalUsd || 100, // Default $100 sim position
    binStep: candidate.binStep || 20,
    poolAddress: candidate.poolAddress,
    entryPriceUsd,
  });

  return positionId;
}

/**
 * Evaluates open positions: tracks price movements, updates fees/IL, checks close conditions.
 */
export async function processActivePositions(openPositions) {
  for (const pos of openPositions) {
    const currentPriceUsd = (await fetchCurrentTokenPrice(pos.token_mint)) || pos.current_price_usd || pos.entry_price_usd;

    // 1. Calculate DLMM Impermanent Loss % and USD
    const ilPct = calculateDlmmIL(pos.entry_price_usd, currentPriceUsd, pos.bin_step);
    const ilUsd = pos.notional_usd * ilPct;

    // 2. Net PnL = Earned Fees + IL
    const netPnlUsd = pos.realized_fee_usd + ilUsd;

    // 3. Out of Range Check
    const priceChangePct = Math.abs((currentPriceUsd - pos.entry_price_usd) / (pos.entry_price_usd || 1));
    const isOutOfRange = priceChangePct > ((pos.bin_step / 10000) * 5);

    // 4. Update state in DB
    updateLpSimPositionHealth({
      id: pos.id,
      realizedFeeUsd: pos.realized_fee_usd,
      currentPriceUsd,
      ilUsd,
      netPnlUsd,
      isOutOfRange,
    });

    // 5. Net Stop-Loss Trigger (e.g., Close if Net PnL drops below -5% of notional)
    const netYieldPct = (netPnlUsd / pos.notional_usd) * 100;
    if (netYieldPct <= -5.0) {
      const holdMs = Date.now() - pos.opened_at_ms;
      closeLpSimPosition({
        id: pos.id,
        closeReason: 'stop_loss_net_pnl',
        realizedFeeUsd: pos.realized_fee_usd,
        currentPriceUsd,
        ilUsd,
        netPnlUsd,
        holdMs,
      });
    }
  }
}