import { gmgnFetch, gmgnBackoffActive, setGmgnBackoff } from '../enrichment/gmgn.js';
import { now } from '../utils.js';
import { boolSetting } from '../db/settings.js';
import { storeSignalEvent } from './trending.js';

export const gmgnSignals = new Map();
let candidateHandler = null;
const triggeredMints = new Map();
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

function routeForSignalType(type) {
  if (type === 12) return 'gmgn_smart_money';
  return null;
}

export async function fetchGmgnSignals() {
  console.log('[gmgn:signal] fetchGmgnSignals called');
  if (!boolSetting('gmgn_signal_enabled', true)) {
    gmgnSignals.clear();
    return;
  }
  // Was completely unprotected — same gap as smartMoney.js (both call the same
  // /v1/market/token_signal endpoint) — found while extending the GMGN backoff consolidation.
  if (gmgnBackoffActive('signal')) return;

  try {
    const payload = await gmgnFetch('/v1/market/token_signal', {
      method: 'POST',
      body: {
        chain: 'sol',
        groups: [{ signal_type: [12] }],
      },
    });

    const signals = Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.data?.data) ? payload.data.data
      : [];
    const seenAt = now();
    let smartMoneyCount = 0;

    for (const signal of signals) {
      const mint = signal?.token_address || signal?.mint || signal?.address;
      if (!mint || !String(mint).endsWith('pump')) continue;
      gmgnSignals.set(mint, { ...signal, mint, seenAt });
      const route = routeForSignalType(signal?.signal_type);
      if (route === 'gmgn_smart_money') smartMoneyCount++;
    }

    const cutoff = seenAt - DEDUP_WINDOW_MS;
    for (const [mint, entry] of gmgnSignals) {
      if (Number(entry.seenAt || 0) < cutoff) gmgnSignals.delete(mint);
    }

    if (candidateHandler) {
      for (const [mint, signal] of gmgnSignals) {
        if (triggeredMints.has(mint)) continue;
        triggeredMints.set(mint, now());
        const route = routeForSignalType(signal?.signal_type);
        if (!route) continue;
        storeSignalEvent(mint, route, 'gmgn_signal', signal);
        candidateHandler({ mint, gmgnSignal: signal, route }).catch(err =>
          console.log(`[gmgn:signal] candidate trigger failed for ${mint}: ${err.message}`),
        );
      }
      const pruneCutoff = now() - DEDUP_WINDOW_MS;
      for (const [mint, ts] of triggeredMints) {
        if (ts < pruneCutoff) triggeredMints.delete(mint);
      }
    }

    console.log(`[gmgn:signal] smart_money ${smartMoneyCount}, tracking ${gmgnSignals.size}`);
  } catch (err) {
    setGmgnBackoff('signal', err);
    console.log(`[gmgn:signal] fetch error: ${err.message}`);
  }
}
