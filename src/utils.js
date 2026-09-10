export function now() {
  return Date.now();
}

export function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function json(value) {
  return JSON.stringify(value ?? null);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}

export function pruneSeen(map, ttlMs) {
  const at = now();
  for (const [key, ts] of map) {
    if (at - ts > ttlMs) map.delete(key);
  }
}

export function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

export function marketCapFromGmgn(info) {
  const direct = Number(info?.market_cap ?? info?.mcap);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const price = Number(info?.price);
  const supply = Number(info?.circulating_supply ?? info?.total_supply);
  return Number.isFinite(price) && Number.isFinite(supply) ? price * supply : null;
}

export function tokenPriceFromGmgn(info) {
  const price = Number(info?.price);
  return Number.isFinite(price) ? price : null;
}

export function base58Encode(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (const b of bytes) {
    if (b !== 0) break;
    digits.push(0);
  }
  return digits.reverse().map(x => alphabet[x]).join('');
}

export function readPubkey(buf, offset) {
  return base58Encode(buf.subarray(offset, offset + 32));
}

export function readU64(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

export function readI64(buf, offset) {
  return buf.readBigInt64LE(offset);
}

export function lamToSol(lamports) {
  return Number(lamports) / 1_000_000_000;
}

export function discMatch(buf, disc) {
  return disc.every((b, i) => buf[i] === b);
}

export function parseDistFees(data) {
  let offset = 8;
  const timestamp = readI64(data, offset); offset += 8;
  const mint = readPubkey(data, offset); offset += 32;
  const bondingCurve = readPubkey(data, offset); offset += 32;
  const sharingConfig = readPubkey(data, offset); offset += 32;
  const admin = readPubkey(data, offset); offset += 32;
  const count = data.readUInt32LE(offset); offset += 4;
  const shareholders = [];
  for (let i = 0; i < count && offset + 34 <= data.length; i++) {
    const pubkey = readPubkey(data, offset); offset += 32;
    const bps = data.readUInt16LE(offset); offset += 2;
    shareholders.push({ pubkey, bps });
  }
  const distributed = data.length >= offset + 8 ? readU64(data, offset) : 0n;
  return { timestamp, mint, bondingCurve, sharingConfig, admin, shareholders, distributed };
}

export function strictJsonFromText(text) {
  const clean = stripThinking(text);
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced || clean.match(/\{[\s\S]*\}/)?.[0] || clean;
  return JSON.parse(raw);
}

export function parseNumericInput(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[$,%\s,_]/g, '');
  if (raw === 'off' || raw === 'none' || raw === 'disable') return 0;
  const match = raw.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/);
  if (!match) return null;
  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  const parsed = Number(match[1]) * (multipliers[match[2]] || 1);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseWindowMs(value = '12h') {
  const raw = String(value || '12h').trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(m|h|d)?$/);
  if (!match) return 12 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2] || 'h';
  const multipliers = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  return Math.max(5 * 60_000, Math.min(30 * 24 * 60 * 60_000, amount * multipliers[unit]));
}

export function formatWindow(ms) {
  if (ms % (24 * 60 * 60_000) === 0) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

export function makeFailureTracker(name, alertFn, threshold = 3) {
  let count = 0;
  return async (fn) => {
    try {
      await fn();
      count = 0;
    } catch (err) {
      count++;
      console.log(`[${name}] ${err.message}`);
      if (count >= threshold) {
        alertFn(`⚠️ <b>${name}</b> failed ${count}x in a row: ${err.message}`).catch(() => {});
        count = 0;
      }
    }
  };
}

// Ported from charonhood (2026-09, found via real production log analysis there): a
// setInterval poller has no idea whether its own previous invocation has finished —
// it just fires on a fixed schedule. If a cycle's real work (network calls, especially
// under rate-limit backoff — confirmed directly in this project's own logs, GMGN
// backoffs stretching well past a minute) ever takes longer than its own poll interval,
// the next tick starts a SECOND, fully concurrent run of the same cycle, competing for
// the exact same rate-limited queues its predecessor is still waiting on — actively
// worsening the timeout it was already having, not just wasting a tick. Wrap any poller
// whose interval isn't comfortably larger than its worst-case runtime with this.
export function guardCycle(label, fn) {
  let running = false;
  return async () => {
    if (running) {
      console.log(`[${label}] skipping this tick — previous cycle still running`);
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}

function trueRange(candle) {
  const high = Number(candle?.high);
  const low = Number(candle?.low);
  const prevClose = Number(candle?.prevClose ?? candle?.close);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  if (Number.isFinite(prevClose)) {
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return high - low;
}

export function computeAtrPercent(chartWindows = [], period = 14) {
  const windows = Array.isArray(chartWindows) ? chartWindows : [];
  for (const window of windows) {
    const candles = Array.isArray(window?.candles) ? window.candles : null;
    if (!candles || candles.length < 3) continue;
    const rawCandles = candles.map(c => ({
      high: Number(c?.h ?? c?.high),
      low: Number(c?.l ?? c?.low),
      close: Number(c?.c ?? c?.close),
    }));
    for (let i = 0; i < rawCandles.length; i++) {
      rawCandles[i].prevClose = i === 0 ? null : rawCandles[i - 1].close;
      const tr = trueRange(rawCandles[i]);
      rawCandles[i].tr = tr != null ? tr : 0;
    }
    const lastN = rawCandles.slice(-period);
    const atr = lastN.reduce((sum, candle) => sum + Number(candle.tr || 0), 0) / lastN.length;
    const lastClose = rawCandles[rawCandles.length - 1]?.close;
    if (atr > 0 && Number.isFinite(lastClose) && lastClose > 0) {
      return (atr / lastClose) * 100;
    }
  }
  return null;
}

// ATR-to-SL mapping. Previously: clamp atrPercent to [minAtrPercent, maxAtrPercent] (e.g. 4-30),
// then linear multiplier, then clamp the result to [floorPercent, ceilingPercent]. Problem found
// analyzing real SL exits: with multiplier=1.5 and maxAtrPercent=30, ANY atrPercent >= 20 maps to
// the exact same -45% stop — a 46% ATR token and a 124% ATR token got literally identical
// protection despite one being ~3x more volatile. The 30% input cap was the binding constraint,
// not the -50% floor.
//
// Replaced with an exponential saturation curve: magnitude grows smoothly with ATR and
// asymptotically approaches floorPercent, but never plateaus to an identical value the way a hard
// clamp does — a 124% ATR token still ends up closer to the floor than a 46% one, just both large.
// No more maxAtrPercent input clamp needed; minAtrPercent is kept as a floor on the input so a
// near-zero/noisy ATR reading doesn't collapse the stop to an unrealistically tight ceiling.
export function dynamicStopLossPercent({ baseSlPercent, atrPercent, multiplier = 1.5, floorPercent = -50, ceilingPercent = -8, minAtrPercent = 4 }) {
  const base = Number(baseSlPercent);
  if (!Number.isFinite(base)) return -25;
  if (!Number.isFinite(Number(atrPercent)) || Number(atrPercent) <= 0) {
    return Math.max(floorPercent, Math.min(ceilingPercent, base));
  }
  const atr = Math.max(minAtrPercent, Number(atrPercent));
  const ceilingMag = Math.abs(ceilingPercent);
  const floorMag = Math.abs(floorPercent);
  const range = Math.max(1, floorMag - ceilingMag);
  const saturation = 1 - Math.exp(-(atr * multiplier) / range);
  const magnitude = ceilingMag + range * saturation;
  return -Math.max(ceilingMag, Math.min(floorMag, magnitude));
}

// Wilder's RSI over the closing prices of the first chart window with enough
// candles (same window-selection pattern as computeAtrPercent — usually the
// 5-minute window). period=2 is intentionally short/twitchy by design (the
// classic Larry Connors RSI(2) mean-reversion signal) — expect it to pin
// near 0/100 often on volatile meme-coin price action.
export function computeRsiPercent(chartWindows = [], period = 2) {
  const windows = Array.isArray(chartWindows) ? chartWindows : [];
  for (const window of windows) {
    const candles = Array.isArray(window?.candles) ? window.candles : null;
    if (!candles || candles.length < period + 1) continue;
    const closes = candles.map(c => Number(c?.c ?? c?.close)).filter(Number.isFinite);
    if (closes.length < period + 1) continue;
    const rsi = computeRsi(closes, period);
    if (rsi != null) return rsi;
  }
  return null;
}

// Plain RSI over an array of closes, most recent last. Returns null if there
// isn't enough data. Exported separately from computeRsiPercent so it can be
// unit-tested or reused directly against an arbitrary close-price series.
export function computeRsi(closes, period = 2) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// 2026-08-22: shared by setQuoteBackoff/setDatapiBackoff (jupiter.js) and setGmgnBackoff
// (gmgn.js) — all three previously used a fixed fallback delay (30s/10s/1min-30min depending on
// status) regardless of how many 429s had already happened in a row. Real logs kept showing
// rapid, repeated 429s even after the clock-skew fix, meaning the fixed windows genuinely
// weren't long enough to clear the rate limit — the same wall got hit again almost immediately.
// Doubles the delay on each consecutive failure (capped at maxMs), resets to baseMs the moment a
// request succeeds. Jitter (+/- jitterFraction) avoids every pending request retrying at exactly
// the same instant once the window clears, which would just recreate the burst that caused the
// 429 in the first place.
export function exponentialBackoffMs(consecutiveFailures, { baseMs = 30_000, maxMs = 5 * 60_000, jitterFraction = 0.2 } = {}) {
  const n = Math.max(1, consecutiveFailures);
  const exponential = Math.min(baseMs * Math.pow(2, n - 1), maxMs);
  const jitter = exponential * jitterFraction * (Math.random() * 2 - 1);
  return Math.max(baseMs, Math.round(exponential + jitter));
}
