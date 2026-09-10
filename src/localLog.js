import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { json } from './utils.js';

// ── Local, Telegram-independent trade log ───────────────────────────────────
// Telegram is now best-effort (see src/telegram/bot.js) — a send can silently
// fail with no other trace of what happened. This module is the replacement
// paper trail: every meaningful trade-lifecycle event (BUY signal, position
// opened, position closed, buy rejected/failed) gets written here, always,
// regardless of whether Telegram is configured or reachable.
//
// Two files, same event stream:
//   logs/events.jsonl  — one JSON object per line, for later parsing/analysis
//                        (jq, pandas, grep -c, whatever)
//   logs/trades.log    — one human-readable line per line, for `tail -f`
//
// Like the Telegram layer, this must never be able to break the trading flow:
// every write is wrapped and failures just get console.log'd.

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.LOCAL_LOG_DIR || join(__dirname, '..', 'logs');
const EVENTS_PATH = join(LOG_DIR, 'events.jsonl');
const TRADES_PATH = join(LOG_DIR, 'trades.log');

let dirReady = false;
function ensureLogDir() {
  if (dirReady) return;
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    dirReady = true;
  } catch (err) {
    console.log(`[locallog] could not create log dir: ${err.message}`);
  }
}

function tsIso() {
  return new Date().toISOString();
}

// Structured event — always call this for anything you might want to
// query/analyze later (pnl stats, win rate, error rates, etc).
export function logEvent(type, data = {}) {
  try {
    ensureLogDir();
    appendFileSync(EVENTS_PATH, `${json({ ts: tsIso(), type, ...data })}\n`);
  } catch (err) {
    console.log(`[locallog] failed to write event (${type}): ${err.message}`);
  }
}

// Human-readable one-liner — always call this alongside logEvent for
// anything worth a glance in `tail -f logs/trades.log` without tooling.
export function logLine(text) {
  try {
    ensureLogDir();
    appendFileSync(TRADES_PATH, `${tsIso()} ${text}\n`);
  } catch (err) {
    console.log(`[locallog] failed to write line: ${err.message}`);
  }
}

// Convenience: fire both at once for the common case (structured + readable).
// position_open/position_close also get echoed to console — these are the two
// moments someone watching `pm2 logs` actually wants to see; the rest
// (buy_signal, rejections, etc.) stay file-only so pm2 logs don't get flooded
// with noise nobody asked to see there.
const CONSOLE_MIRRORED_TYPES = new Set(['position_open', 'position_close', 'post_close_finalized']);

export function logTradeEvent(type, data, line) {
  logEvent(type, data);
  logLine(line);
  if (CONSOLE_MIRRORED_TYPES.has(type)) console.log(line);
}
