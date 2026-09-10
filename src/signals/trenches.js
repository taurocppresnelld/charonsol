import { gmgnFetch, gmgnBackoffActive, setGmgnBackoff } from '../enrichment/gmgn.js';
import { GRADUATED_LOOKBACK_MS } from '../config.js';
import { now } from '../utils.js';
import { boolSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { storeSignalEvent } from './trending.js';

export const trenches = new Map();
let candidateHandler = null;
const triggeredMints = new Map();
const MAX_CANDIDATES_PER_CYCLE = 3;

// ── Rate-limit backoff ──────────────────────────────────────────────────────
// 2026-08-07: real logs showed "IP is temporarily banned" repeatedly, most
// gaps between hits matching the outer 60s setInterval exactly — meaning the
// bot just kept re-hitting a banned endpoint every single tick, never giving
// the ban a chance to expire. Worse: gmgnFetch (enrichment/gmgn.js) already
// retries internally with its own ~60s sleep on a ban — since that can take
// longer than the outer 60s interval, the NEXT scheduled tick can fire before
// the previous one's internal retry even finishes, producing overlapping
// concurrent requests against the same banned IP (matches the handful of
// real gaps under 15s in that log, which a clean 60s interval alone can't
// produce). This mirrors the same backoff pattern already used for Jupiter
// quotes (see quoteBackoffActive/setQuoteBackoff in enrichment/jupiter.js):
// once we know we're rate-limited, skip the network call entirely — no
// gmgnFetch call at all, so no internal retry loop to overlap with the next
// tick — until the cooldown expires. Grows on repeated hits, resets on the
// first clean success.
let trenchesBackoffUntil = 0;
let trenchesBackoffStrikes = 0;
const TRENCHES_BACKOFF_BASE_MS = 3 * 60_000; // 3 minutes
const TRENCHES_BACKOFF_MAX_MS = 15 * 60_000; // 15 minutes

function trenchesBackoffActive() {
  return now() < trenchesBackoffUntil;
}

function setTrenchesBackoff(err) {
  const banned = /rate limit|temporarily banned|429/i.test(String(err?.message || ''));
  if (!banned) return;
  trenchesBackoffStrikes += 1;
  const backoffMs = Math.min(TRENCHES_BACKOFF_MAX_MS, TRENCHES_BACKOFF_BASE_MS * 2 ** (trenchesBackoffStrikes - 1));
  trenchesBackoffUntil = now() + backoffMs;
  console.log(`[trenches] rate-limited (strike ${trenchesBackoffStrikes}) — backing off ${Math.round(backoffMs / 1000)}s until ${new Date(trenchesBackoffUntil).toISOString()}`);
}

// GMGN trenches config (from gmgn-cli source)
const TRENCHES_PLATFORMS = [
  'Pump.fun', 'pump_mayhem', 'pump_mayhem_agent', 'pump_agent',
  'letsbonk', 'bonkers', 'bags', 'memoo', 'liquid', 'bankr', 'zora',
  'surge', 'anoncoin', 'moonshot_app', 'wendotdev', 'heaven', 'sugar',
  'token_mill', 'believe', 'trendsfun', 'trends_fun', 'jup_studio',
  'Moonshot', 'boop', 'ray_launchpad', 'meteora_virtual_curve', 'xstocks',
];
const QUOTE_ADDRESS_TYPES = [4, 5, 3, 1, 13, 0];

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

function buildTrenchesBody(limit = 80) {
  return {
    version: 'v2',
    completed: {
      filters: ['offchain', 'onchain'],
      launchpad_platform: TRENCHES_PLATFORMS,
      quote_address_type: QUOTE_ADDRESS_TYPES,
      launchpad_platform_v2: true,
      limit,
      min_smart_degen_count: 4,
    },
  };
}

export async function fetchTrenches() {
  if (!boolSetting('trenches_enabled', true)) {
    trenches.clear();
    return;
  }
  // 2026-08-13: bridged with the shared GMGN backoff (enrichment/gmgn.js) — trenches previously
  // tracked bans entirely independently, even though token-info/trending/signal/smart-money
  // calls all hit the same provider and now share one backoff timer. Checking both here means a
  // ban on ANY GMGN endpoint protects trenches too, not just repeated bans on this one.
  // trenchesBackoffActive's own escalating-strikes logic is kept as-is underneath — it's more
  // sophisticated than the shared one (doubles per consecutive strike) and stays valuable for
  // the specific "this exact endpoint keeps getting banned" case.
  if (trenchesBackoffActive() || gmgnBackoffActive('trenches')) return; // skip entirely — no network call, nothing to overlap with the next tick

  try {
    const payload = await gmgnFetch('/v1/trenches', {
      method: 'POST',
      params: { chain: 'sol' },
      body: buildTrenchesBody(80),
    });
    trenchesBackoffStrikes = 0; // clean fetch — reset, next ban (if any) starts back at the base delay

    const data = payload?.data || {};
    const seenAt = now();
    const cutoff = seenAt - GRADUATED_LOOKBACK_MS;
    let completedCount = 0;

    const rows = Array.isArray(data.completed) ? data.completed : [];
    for (const row of rows) {
      const mint = row?.address || row?.mint || row?.token_address;
      if (!mint || !String(mint).endsWith('pump')) continue;
      completedCount++;
      if (!trenches.has(mint)) {
        trenches.set(mint, { ...row, mint, kind: 'completed', seenAt });
      }
    }

    // Prune old entries
    for (const [mint, entry] of trenches) {
      if (Number(entry.seenAt || 0) < cutoff) trenches.delete(mint);
    }

    // Trigger candidates — but check if pump.fun already detected graduation first
    // This prioritizes pump.fun direct source over GMGN trenches
    let candidatesTriggered = 0;
    if (candidateHandler) {
      for (const [mint, entry] of trenches) {
        if (triggeredMints.has(mint)) continue;
        if (candidatesTriggered >= MAX_CANDIDATES_PER_CYCLE) break;

        // Skip if already detected by pump.fun (more reliable source)
        const { graduated } = await import('./graduated.js');
        if (graduated.has(mint)) {
          triggeredMints.set(mint, now());
          console.log(`[trenches] skipping ${mint.slice(0, 8)}... — already in graduated map`);
          continue;
        }

        // Skip if mint already has an open or recently-closed position
        try {
          const existingPos = db.prepare(
            'SELECT id, status, closed_at_ms FROM dry_run_positions WHERE mint = ? ORDER BY id DESC LIMIT 1'
          ).get(mint);
          if (existingPos) {
            if (existingPos.status === 'open') {
              triggeredMints.set(mint, now());
              continue;
            }
            if (existingPos.status === 'closed' && existingPos.closed_at_ms > (now() - 86400000)) {
              triggeredMints.set(mint, now());
              continue;
            }
          }
        } catch { /* DB query failed — proceed anyway */ }

        const kind = entry.kind || '';
        const route = `trenches_${kind}`;

        // Lesson 2: pause trenches_completed when recent win rate < 30% (last 24h, min 5 closed)
        // TEMPORARILY DISABLED per user request — un-pause
        /*
        try {
          const stats = db.prepare(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN p.pnl_percent > 0 THEN 1 ELSE 0 END) as wins
            FROM dry_run_positions p
            JOIN signal_events se ON se.mint = p.mint AND se.source = 'trenches_completed'
            WHERE p.status = 'closed'
              AND p.closed_at_ms > (?)
          `).get(now() - 86400000);
          const total = Number(stats?.total || 0);
          const wins = Number(stats?.wins || 0);
          if (total >= 5) {
            const wr = (wins * 100.0) / total;
            if (wr < 30) {
              console.log(`[trenches] paused — win rate ${wr.toFixed(1)}% < 30% (last 24h, ${total} closed)`);
              continue;
            }
          }
        } catch (err) {
          console.log(`[trenches] win-rate check failed: ${err.message}`);
        }
        */

        triggeredMints.set(mint, now());
        storeSignalEvent(mint, 'trenches', route, entry);
        candidatesTriggered++;

        candidateHandler({ mint, trenchesEntry: entry, route })
          .then(() => {})
          .catch(err =>
            console.log(`[trenches] candidate trigger failed for ${mint}: ${err.message}`),
          );
      }
    }
    const pruneCutoff = now() - 3600000;  // 1 hour — never re-trigger tokens within an hour
    for (const [mint, ts] of triggeredMints) {
      if (ts < pruneCutoff) triggeredMints.delete(mint);
    }

    console.log(`[trenches] completed (smart-money) ${completedCount}, tracking ${trenches.size}, triggered ${candidatesTriggered}`);
  } catch (err) {
    console.log(`[trenches] fetch error: ${err.message}`);
    setTrenchesBackoff(err);
    setGmgnBackoff('trenches', err);
  }
}
