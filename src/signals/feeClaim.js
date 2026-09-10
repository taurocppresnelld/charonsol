import WebSocket from 'ws';
import { PUMP_PROGRAM, PUMP_AMM, DISC_DIST_FEES, SOLANA_WS_URL } from '../config.js';
import { now, pruneSeen, lamToSol, discMatch, parseDistFees, exponentialBackoffMs } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { storeSignalEvent } from './trending.js';
import { graduated } from './graduated.js';
import { trending } from './trending.js';
import { buildFeeSnapshot } from '../pipeline/candidateBuilder.js';

export const seenFeeClaims = new Map();
let candidateHandler = null;

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

export async function handleFeeClaim(fee, signature) {
  const sol = lamToSol(fee.distributed);
  if (sol < numSetting('min_fee_claim_sol', 2)) return;
  const graduatedCoin = graduated.get(fee.mint) || null;
  const trendingToken = boolSetting('trending_enabled', true) ? trending.get(fee.mint) || null : null;
  if (!graduatedCoin && !trendingToken) return;

  const key = `${signature}:${fee.mint}:${fee.distributed}`;
  pruneSeen(seenFeeClaims, 10 * 60 * 1000);
  if (seenFeeClaims.has(key)) return;
  seenFeeClaims.set(key, now());
  storeSignalEvent(fee.mint, 'fee_claim', 'pump_logs', { signature, fee: buildFeeSnapshot(fee, signature) });
  const route = graduatedCoin && trendingToken
    ? 'fee_graduated_trending'
    : graduatedCoin
      ? 'fee_graduated'
      : 'fee_trending';
  if (candidateHandler) {
    await candidateHandler({
      mint: fee.mint,
      fee,
      signature,
      graduatedCoin,
      trendingToken,
      route,
    });
  }
}

async function processLog(logInfo) {
  const { signature, logs, err } = logInfo;
  if (err || !logs) return;
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let data;
    try {
      data = Buffer.from(line.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (data.length < 8 || !discMatch(data, DISC_DIST_FEES)) continue;
    try {
      await handleFeeClaim(parseDistFees(data), signature);
    } catch (error) {
      console.log(`[fee] parse/alert failed: ${error.message}`);
    }
  }
}

export function startWebsocket() {
  const wsUrl = SOLANA_WS_URL;
  let ws;
  let pingTimer;
  // 2026-09-07: the previous version reconnected on a flat, hardcoded 5s delay every
  // time, with no backoff — if the close is actually caused by the RPC provider
  // rate-limiting the connection (confirmed: real logs showing 429s "all the time"), a
  // fixed 5s retry hammers the same limit indefinitely and can itself prolong the
  // rate-limiting rather than recovering from it. Same exponentialBackoffMs utility
  // enrichment/gmgn.js and enrichment/meteora.js already use for their own HTTP
  // rate-limit backoff — consistent behavior across every provider in this project now.
  //
  // First attempt at this reset consecutiveFailures on every 'open' event, which turned
  // out to be wrong — confirmed directly with a real WebSocket server in a test: if the
  // rate-limit kicks in AFTER a successful handshake (server accepts the connection, then
  // closes it almost immediately) rather than rejecting the handshake itself, 'open'
  // still fires, resetting the counter every time — so the backoff never actually
  // escalated (logged consecutive=1 on all 29 reconnects in a 6s test window). Only reset
  // the counter once a connection has stayed open and stable for a real minimum duration;
  // a connection that opens and closes right away still counts as a continued failure.
  let consecutiveFailures = 0;
  let connectedAt = 0;
  const MIN_STABLE_CONNECTION_MS = 10_000;
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      connectedAt = now();
      console.log('[ws] connected');
      for (const [id, program] of [[1, PUMP_PROGRAM], [2, PUMP_AMM]]) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'logsSubscribe',
          params: [{ mentions: [program] }, { commitment: 'confirmed' }],
        }));
      }
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
    });
    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const value = msg.params?.result?.value;
      if (msg.method === 'logsNotification' && value) {
        processLog(value).catch(error => console.log(`[ws] process failed: ${error.message}`));
      }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      const wasStable = connectedAt > 0 && (now() - connectedAt) >= MIN_STABLE_CONNECTION_MS;
      connectedAt = 0;
      consecutiveFailures = wasStable ? 0 : consecutiveFailures + 1;
      const baseMs = numSetting('ws_reconnect_base_ms', 5_000);
      const maxMs = numSetting('ws_reconnect_max_ms', 5 * 60_000);
      const delayMs = exponentialBackoffMs(Math.max(consecutiveFailures, 1), { baseMs, maxMs });
      console.log(`[ws] closed, reconnecting in ${(delayMs / 1000).toFixed(1)}s (consecutive=${consecutiveFailures}${wasStable ? ', was stable — backoff reset' : ''})`);
      setTimeout(connect, delayMs);
    });
    ws.on('error', error => console.log(`[ws] ${error.message}`));
  }
  connect();
}
