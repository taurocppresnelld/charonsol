import { randomUUID } from 'node:crypto';
import { GMGN_API_KEY, GMGN_CACHE_TTL_MS, GMGN_ENABLED, JSON_HEADERS } from '../config.js';
import { now, sleep, exponentialBackoffMs } from '../utils.js';
import { numSetting, setting } from '../db/settings.js';
import { createPriorityQueue, PRIORITY } from './priorityQueue.js';

const gmgnCache = new Map();
let lastGmgnRequestAt = 0;
// 2026-08-21: was a plain FIFO chain (gmgnQueue.then(work, work)) with no concept of priority —
// every GMGN call competed equally regardless of how urgent it actually was. Same serial
// (one-in-flight-at-a-time) guarantee as before, now with priority ordering on top, plus a
// reserved fast lane for POSITION_MONITOR (see priorityQueue.js). Separate instance from
// Jupiter's queue (see enrichment/jupiter.js) — never shared, since each provider has its own
// independent rate limit.
//
// isAllowed: while GMGN backoff is active, only POSITION_MONITOR-and-above gets pulled. Safe to
// reference gmgnBackoffActive here despite it being defined below — function declarations
// hoist, and isAllowed is only ever invoked later, well after the whole module has loaded.
const gmgnQueue = createPriorityQueue('gmgn', {
  isAllowed: (priority) => priority >= PRIORITY.POSITION_MONITOR || !gmgnBackoffActive(),
});
const gmgnBackoff = {
  until: 0,
  reason: '',
};
let gmgnConsecutiveFailures = 0; // reset on any successful GMGN request — see resetGmgnBackoffStreak

async function paceGmgnRequest() {
  const delayMs = Math.max(0, numSetting('gmgn_request_delay_ms', 2500));
  if (!delayMs) return;
  const elapsed = now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = now();
}

function gmgnErrorText(status, payload, fallback) {
  const raw = String(payload?.raw || payload?.message || payload?.error || fallback || '');
  if (/<title>\s*Just a moment/i.test(raw) || /challenge-platform|cf_chl/i.test(raw)) {
    return 'Cloudflare managed challenge';
  }
  return `${status || ''} ${payload?.code || ''} ${raw}`.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter(item => item != null && item !== '')) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { method = 'GET', params = {}, body = null } = {}, priority = PRIORITY.CANDIDATE_SCREENING) {
  if (!GMGN_ENABLED) throw new Error('GMGN disabled');
  return gmgnQueue.enqueue(async () => {
    const url = new URL(`https://openapi.gmgn.ai${pathname}`);
    appendParams(url, params);
    const maxRetries = Math.max(0, Math.floor(numSetting('gmgn_max_retries', 2)));
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await paceGmgnRequest();
      url.searchParams.set('timestamp', String(Math.floor(now() / 1000)));
      url.searchParams.set('client_id', randomUUID());
      const fetchOpts = {
        method,
        headers: {
          'X-APIKEY': GMGN_API_KEY,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      };
      if (body) fetchOpts.body = JSON.stringify(body);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      fetchOpts.signal = controller.signal;
      let res;
      try {
        res = await fetch(url, fetchOpts);
      } catch (err) {
        if (err?.name === 'AbortError') {
          throw new Error('gmgn fetch timeout 8000ms');
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
      const text = await res.text().catch(() => '');
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (res.ok) {
        resetGmgnBackoffStreak();
        return payload;
      }
      const message = gmgnErrorText(res.status, payload, `GMGN ${pathname} ${res.status}`);
      const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
      if (rateLimited && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoffMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : /temporarily banned/i.test(String(message))
            ? 60_000
            : Math.min(30_000, 3000 * 2 ** attempt);
        await sleep(backoffMs);
        continue;
      }
      const error = new Error(message);
      error.response = { status: res.status, data: payload, headers: Object.fromEntries(res.headers.entries()) };
      throw error;
    }
    throw new Error(`GMGN ${pathname} failed`);
  });
}

// Consolidated 2026-08-13: 'token' and 'trending' used to track backoff separately, even though
// they're the same provider (openapi.gmgn.ai) — meaning a 429 on one never protected the other.
// Same reasoning as the datapi.jup.ag consolidation in enrichment/jupiter.js. Kept the `kind`
// param on every function below (used for logging only now) so existing callers didn't need
// their call sites changed — gmgnBackoffActive('token') and gmgnBackoffActive('trending') now
// both just check the one shared timer.
function gmgnBackoffActive(_kind) {
  return now() < Number(gmgnBackoff.until || 0);
}

function resetGmgnBackoffStreak() {
  gmgnConsecutiveFailures = 0;
}

function setGmgnBackoff(kind, err) {
  const status = err.response?.status;
  if (status !== 403 && status !== 429) return;
  gmgnConsecutiveFailures++;
  const body = err.response?.data || {};
  const challenge = /Cloudflare managed challenge/i.test(String(err.message));
  const baseMs = challenge ? 30 * 60 * 1000 : status === 403 ? 10 * 60 * 1000 : 60 * 1000;
  // 2026-08-22: was a fixed fallback (30min/10min/1min by status) regardless of how many
  // failures already happened in a row — real logs kept showing rapid, repeated 429s even after
  // the clock-skew fix, meaning the fixed windows weren't clearing the limit. Cap scales with
  // the base (a 429 streak tops out at 5min; a Cloudflare challenge streak, already starting
  // much higher, tops out at 2h) rather than one fixed ceiling for every status type.
  const maxMs = challenge ? 2 * 60 * 60 * 1000 : status === 403 ? 60 * 60 * 1000 : 5 * 60_000;
  const fallbackMs = exponentialBackoffMs(gmgnConsecutiveFailures, { baseMs, maxMs });
  // Same fix as setQuoteBackoff/setDatapiBackoff (jupiter.js) — see that function's comment for
  // the full reasoning. Real data showed the same consistent ~2h-in-the-past pattern this
  // provider's reset_at too, which the sane-window check (comparing against our own now())
  // couldn't catch if this process's own clock is itself skewed by roughly the same amount. No
  // longer trusts reset_at's absolute value at all; always uses the exponential delay.
  const until = now() + fallbackMs;
  const reason = gmgnErrorText(status, body, err.message);
  gmgnBackoff.until = until;
  gmgnBackoff.reason = reason;
  console.log(`[gmgn:${kind}] backing off until ${new Date(until).toISOString()} (${reason}, consecutive=${gmgnConsecutiveFailures})`);
}

function gmgnStatusText(_kind) {
  if (!GMGN_ENABLED) return 'off';
  if (!gmgnBackoffActive()) return 'ok';
  const seconds = Math.max(1, Math.ceil((Number(gmgnBackoff.until) - now()) / 1000));
  return `blocked ${seconds}s`;
}

function marketCapFromGmgn(info) {
  const direct = Number(info?.market_cap ?? info?.mcap);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const price = Number(info?.price);
  const supply = Number(info?.circulating_supply ?? info?.total_supply);
  return Number.isFinite(price) && Number.isFinite(supply) ? price * supply : null;
}

function tokenPriceFromGmgn(info) {
  const price = Number(info?.price);
  return Number.isFinite(price) ? price : null;
}

async function fetchGmgnTokenInfo(mint, useCache = true) {
  if (!GMGN_ENABLED) return null;
  const cached = gmgnCache.get(mint);
  if (useCache && cached && now() - cached.at < GMGN_CACHE_TTL_MS) return cached.data;
  if (gmgnBackoffActive('token')) {
    gmgnCache.set(mint, { at: now(), data: null });
    return null;
  }

  try {
    const payload = await gmgnFetch('/v1/token/info', {
      params: { chain: 'sol', address: mint },
    }, PRIORITY.GRADUATION_TRACKING);
    const data = payload?.data?.data || payload?.data || payload;
    gmgnCache.set(mint, { at: now(), data });
    return data;
  } catch (err) {
    setGmgnBackoff('token', err);
    if (err.response?.status !== 403 && err.response?.status !== 429) {
      console.log(`[gmgn] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    }
    gmgnCache.set(mint, { at: now(), data: null });
    return null;
  }
}

function normalizedTrendingRows(payload) {
  const rows = payload?.data?.data?.rank
    || payload?.data?.rank
    || payload?.rank
    || payload?.data?.data
    || payload?.data
    || [];
  return Array.isArray(rows) ? rows : [];
}

export {
  gmgnFetch,
  fetchGmgnTokenInfo,
  gmgnBackoffActive,
  setGmgnBackoff,
  gmgnStatusText,
  marketCapFromGmgn,
  tokenPriceFromGmgn,
  normalizedTrendingRows,
};

export function getGmgnQueueStats() {
  return gmgnQueue.stats();
}
