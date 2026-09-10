// Priority-queued Meteora provider, mirroring enrichment/gmgn.js and enrichment/jupiter.js:
// one queue instance per provider, paced requests, shared backoff state on 429, exponential
// retry. Every Meteora API call in src/pool/ goes through meteoraFetch() here — never a raw
// fetch() to dlmm.datapi.meteora.ag / pool-discovery-api.datapi.meteora.ag — for the same
// reason charon queues Jupiter and GMGN: an unqueued call can't be paced, can't be paused
// during backoff, and can collide with other unqueued calls to the same provider.
//
// If Charonsol ever adds another external provider (a new pool source, a new enrichment
// API, anything), it gets its own file here shaped exactly like this one — a dedicated
// createPriorityQueue instance, its own backoff state, never sharing a queue with a
// different provider. See the module comment in priorityQueue.js for why queues are never
// shared/mixed across providers.

import { now, sleep, exponentialBackoffMs } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { createPriorityQueue, PRIORITY } from './priorityQueue.js';

const meteoraQueue = createPriorityQueue('meteora', {
  isAllowed: (priority) => priority >= PRIORITY.POSITION_MONITOR || !meteoraBackoffActive(),
});

const meteoraBackoff = { until: 0, reason: '' };
let meteoraConsecutiveFailures = 0;
let lastMeteoraRequestAt = 0;

async function paceMeteoraRequest() {
  const delayMs = Math.max(0, numSetting('meteora_request_delay_ms', 500));
  if (!delayMs) return;
  const elapsed = now() - lastMeteoraRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastMeteoraRequestAt = now();
}

export function meteoraBackoffActive() {
  return now() < Number(meteoraBackoff.until || 0);
}

function resetMeteoraBackoffStreak() {
  meteoraConsecutiveFailures = 0;
}

function setMeteoraBackoff(kind, status, message) {
  if (status !== 429 && status !== 403) return;
  meteoraConsecutiveFailures++;
  const baseMs = status === 403 ? 10 * 60 * 1000 : 60 * 1000;
  const maxMs = status === 403 ? 60 * 60 * 1000 : 5 * 60_000;
  const backoffMs = exponentialBackoffMs(meteoraConsecutiveFailures, { baseMs, maxMs });
  meteoraBackoff.until = now() + backoffMs;
  meteoraBackoff.reason = message;
  console.log(`[meteora:${kind}] backing off until ${new Date(meteoraBackoff.until).toISOString()} (${status} ${message}, consecutive=${meteoraConsecutiveFailures})`);
}

/**
 * Queued GET against a full Meteora API URL. `kind` is for logging only (e.g. 'pools',
 * 'detail'). Same retry/backoff shape as gmgnFetch: on 429, sleep (retry-after header if
 * present, else exponential) and retry up to maxRetries; other non-ok statuses throw with
 * `.response` attached so callers can inspect status.
 */
export async function meteoraFetch(url, { kind = 'pools', priority = PRIORITY.CANDIDATE_SCREENING } = {}) {
  return meteoraQueue.enqueue(async () => {
    const maxRetries = Math.max(0, Math.floor(numSetting('meteora_max_retries', 2)));
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await paceMeteoraRequest();
      let res;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw new Error(`meteora fetch timeout 10000ms (${kind})`);
        }
        throw err;
      }
      if (res.ok) {
        resetMeteoraBackoffStreak();
        return res.json();
      }
      const text = await res.text().catch(() => '');
      const rateLimited = res.status === 429 || res.status === 403;
      if (rateLimited && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoffMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(30_000, 3000 * 2 ** attempt);
        await sleep(backoffMs);
        continue;
      }
      setMeteoraBackoff(kind, res.status, text.slice(0, 200));
      const error = new Error(`Meteora ${kind} ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      error.response = { status: res.status, data: text };
      throw error;
    }
    throw new Error(`Meteora ${kind} failed after ${maxRetries + 1} attempt(s)`);
  }, priority);
}

export function getMeteoraQueueStats() {
  return meteoraQueue.stats();
}
