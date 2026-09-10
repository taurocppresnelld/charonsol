import { gmgnFetch, gmgnBackoffActive, setGmgnBackoff } from '../enrichment/gmgn.js';
import { SMART_MONEY_LOOKBACK_MS } from '../config.js';
import { now } from '../utils.js';
import { boolSetting } from '../db/settings.js';

export const smartMoneySignals = new Map();
let candidateHandler = null;
const triggeredMints = new Map();

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

export async function fetchSmartMoney() {
  if (!boolSetting('smart_money_enabled', true)) {
    smartMoneySignals.clear();
    return;
  }
  // Was completely unprotected — same gap as gmgnSignal.js (both call the same
  // /v1/market/token_signal endpoint) — found while extending the GMGN backoff consolidation.
  if (gmgnBackoffActive('signal')) return;

  try {
    // POST with groups in body; gmgnFetch adds timestamp+client_id to URL
    const payload = await gmgnFetch('/v1/market/token_signal', {
      method: 'POST',
      body: {
        chain: 'sol',
        groups: [{ signal_type: [12] }],
        limit: 50,
      },
    });

    const signals = Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.data?.data) ? payload.data.data
      : [];
    const cutoff = now() - SMART_MONEY_LOOKBACK_MS;
    const seenAt = now();

    for (const signal of signals) {
      const mint = signal?.token_address || signal?.mint || signal?.address;
      if (!mint) continue;
      smartMoneySignals.set(mint, { ...signal, mint, seenAt });
    }

    for (const [mint, entry] of smartMoneySignals) {
      if (Number(entry.seenAt || 0) < cutoff) smartMoneySignals.delete(mint);
    }

    if (candidateHandler) {
      for (const [mint, signal] of smartMoneySignals) {
        if (triggeredMints.has(mint)) continue;
        candidateHandler({ mint, smartMoneySignal: signal, route: 'smart_money' })
          .then(() => { triggeredMints.set(mint, now()); })
          .catch(err =>
            console.log(`[smart_money] candidate trigger failed for ${mint}: ${err.message}`),
          );
      }
    }
    const pruneCutoff = now() - SMART_MONEY_LOOKBACK_MS;
    for (const [mint, ts] of triggeredMints) {
      if (ts < pruneCutoff) triggeredMints.delete(mint);
    }

    console.log(`[smart_money] loaded ${signals.length}, tracking ${smartMoneySignals.size}, triggered ${triggeredMints.size}`);
  } catch (err) {
    setGmgnBackoff('signal', err);
    console.log(`[smart_money] fetch error: ${err.message}`);
  }
}
