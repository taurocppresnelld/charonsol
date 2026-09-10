#!/usr/bin/env node
// ── Charonsol CLI ─────────────────────────────────────────────────────────
// Same shape as charon's own scripts/cli.js: a `commands` object dispatched by
// process.argv[2], each also reachable via `npm run <command>`. Only the subcommands
// that actually apply to a screening-only project are ported — charon's position/
// execution/strategy/LLM-learning commands (positions, candidate, sl, strategy,
// stratset, filters, setfilter, wallets, pnl, lessons, learn, mode, filter-tune,
// scheduler, routes, report) don't apply here since Charonsol never opens a
// position or executes a trade; `setting`/`unset` cover generic settings-table
// access for everything this project actually has.
//
// Usage:
//   node scripts/cli.js <command> [args]
//   npm run <command> [-- args]
//
// Run `node scripts/cli.js help` for the full list.

import { initDb, db } from '../src/db/connection.js';
import { DB_PATH } from '../src/config.js';
import { numSetting, setting, setSetting } from '../src/db/settings.js';
import { strategyById, allStrategies, updateStrategyConfig } from '../src/db/settings.js';
import { recentLpCandidates } from '../src/db/lpCandidates.js';
import { recentSimPositions } from '../src/db/lpSimPositions.js';
import { pruneOldRows, vacuumDb, dbStats } from '../src/db/retention.js';
import { parseWindowMs, formatWindow, now, safeJson } from '../src/utils.js';
import { PRIORITY } from '../src/enrichment/priorityQueue.js';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_LOG_PATH = join(__dirname, '..', 'logs', 'events.jsonl');

initDb();

function line(char = '─', n = 60) {
  return char.repeat(n);
}

function printLpCandidateRow(r) {
  const flag = r.pool_screen_passed ? '✅ LP_CANDIDATE' : `❌ ${r.status}`;
  console.log(
    `#${r.id} ${r.symbol || r.mint.slice(0, 8)}  ${flag}\n` +
    `   mint=${r.mint}\n` +
    `   pools_found=${r.pools_found} best_pool=${r.best_pool_address || '-'} bin_step=${r.best_bin_step ?? '-'}\n` +
    `   active_tvl=${r.best_active_tvl ?? '-'} fee_active_tvl_ratio=${r.best_fee_active_tvl_ratio ?? '-'} degen_score=${r.degen_score ?? '-'}\n` +
    (r.pool_reject_reasons_json && r.pool_reject_reasons_json !== '[]' ? `   reject: ${r.pool_reject_reasons_json}\n` : '') +
    `   ${new Date(r.created_at_ms).toISOString()}`,
  );
}

function printSimPositionRow(r) {
  const tag = r.status === 'open' ? '🟢 OPEN' : `⚪ CLOSED (${r.close_reason})`;
  const pct = r.notional_usd > 0 ? ((r.status === 'open' ? r.accrued_fee_usd : r.realized_fee_usd ?? 0) / r.notional_usd) * 100 : 0;
  const feeUsd = r.status === 'open' ? r.accrued_fee_usd : (r.realized_fee_usd ?? 0);
  const stalledHours = ((r.last_snapshot_at_ms ?? r.opened_at_ms) - r.last_fee_increase_at_ms) / 3_600_000;
  console.log(
    `#${r.id} ${r.symbol || r.mint.slice(0, 8)}  ${tag}\n` +
    `   pool=${r.pool_address.slice(0, 8)}... bin_step=${r.bin_step ?? '-'} timeframe=${r.timeframe} notional=$${r.notional_usd}\n` +
    `   fee=$${feeUsd.toFixed(4)} (${pct.toFixed(4)}%)  in_range=${r.in_range_snapshots} out_of_range=${r.out_of_range_snapshots}  stalled=${stalledHours.toFixed(1)}h\n` +
    `   opened=${new Date(r.opened_at_ms).toISOString()}${r.closed_at_ms ? `  closed=${new Date(r.closed_at_ms).toISOString()} (${Math.round((r.hold_ms ?? 0) / 60_000)}min)` : ''}`,
  );
}

// Trimmed from charon's own NUMERIC_FILTER_KEYS/BOOL_FILTER_KEYS — dropped everything
// tied to execution/positions that doesn't apply here (tp_percent, sl_percent,
// position_size_sol, max_open_positions, trailing_*, partial_tp_*, llm_min_confidence,
// use_llm, use_dynamic_sl). What's left is exactly the strategy-config fields
// candidateBuilder.js's filterCandidate() actually reads.
const NUMERIC_STRAT_KEYS = new Set([
  'min_mcap_usd', 'max_mcap_usd', 'min_holders', 'max_top20_holder_percent',
  'min_fee_claim_sol', 'min_gmgn_total_fee_sol', 'max_ath_distance_pct',
  'token_age_max_ms', 'min_graduated_volume_usd', 'min_saved_wallet_holders',
  'min_source_count',
]);
const BOOL_STRAT_KEYS = new Set(['require_fee_claim']);

const commands = {
  help() {
    console.log(`Charonsol CLI\n${line()}`);
    console.log(`  lp-candidates [limit] [--passed]   Recent lp_candidates rows (screening results)`);
    console.log(`  stats                               Token/pool screening + sim funnel counts`);
    console.log(`  lp-sim [limit] [--open|--closed]    Recent lp_sim_positions rows (fee-yield sim)`);
    console.log(`  lp-sim-report                        Aggregate dry-run LP fee-yield report`);
    console.log(`  filter-report [window]               Rejection-funnel report: which filters/thresholds block the most candidates`);
    console.log(`  (backtest is a separate script: npm run backtest -- see README's "Backtest" section)`);
    console.log(`  events [n]                          Tail logs/events.jsonl (default 20)`);
    console.log(`  setting [key] [value]               List/get/set a settings-table key`);
    console.log(`  unset <key>                          Remove a settings-table override`);
    console.log(`  stratshow [id]                       List strategies, or show one's full filter config`);
    console.log(`  stratset <id> <key> <value>           Change one strategy filter field`);
    console.log(`  reset [--yes]                        Wipe screening/sim history for a fresh trial (keeps settings/strategies)`);
    console.log(`  queue-status                        Jupiter/GMGN/Meteora queue health snapshot`);
    console.log(`  dbsize                              DB file size + row counts per table`);
    console.log(`  prune                               Delete telemetry rows past retention window`);
    console.log(`  vacuum                              Reclaim disk space after a prune`);
  },

  'lp-candidates'(args) {
    const onlyPassed = args.includes('--passed');
    const limit = Number(args.find(a => /^\d+$/.test(a))) || 20;
    const rows = recentLpCandidates(limit, onlyPassed);
    console.log(`\n${rows.length} lp_candidates row(s)${onlyPassed ? ' (passed only)' : ''}:\n`);
    rows.forEach(printLpCandidateRow);
  },

  stats() {
    const total = db.prepare('SELECT COUNT(*) n FROM candidates').get().n;
    const tokenPassed = db.prepare("SELECT COUNT(*) n FROM candidates WHERE status = 'candidate'").get().n;
    const lpTotal = db.prepare('SELECT COUNT(*) n FROM lp_candidates').get().n;
    const lpPassed = db.prepare('SELECT COUNT(*) n FROM lp_candidates WHERE pool_screen_passed = 1').get().n;
    const noPool = db.prepare("SELECT COUNT(*) n FROM lp_candidates WHERE status = 'no_pool_found'").get().n;
    const simOpen = db.prepare("SELECT COUNT(*) n FROM lp_sim_positions WHERE status = 'open'").get().n;
    const simClosed = db.prepare("SELECT COUNT(*) n FROM lp_sim_positions WHERE status = 'closed'").get().n;
    console.log(`
Token candidates seen:     ${total}
  passed token filter:     ${tokenPassed}
Sent to pool screening:    ${lpTotal}
  no Meteora pool found:   ${noPool}
  passed pool screening:   ${lpPassed}  <- merged LP candidates
Sim positions opened:      ${simOpen + simClosed}
  still open:               ${simOpen}
  closed:                   ${simClosed}
`);
  },

  'lp-sim'(args) {
    const status = args.includes('--open') ? 'open' : args.includes('--closed') ? 'closed' : null;
    const limit = Number(args.find(a => /^\d+$/.test(a))) || 20;
    const rows = recentSimPositions(limit, status);
    console.log(`\n${rows.length} lp_sim_positions row(s)${status ? ` (${status} only)` : ''}:\n`);
    rows.forEach(printSimPositionRow);
  },

  'lp-sim-report'() {
    const closed = db.prepare("SELECT * FROM lp_sim_positions WHERE status = 'closed'").all();
    const open = db.prepare("SELECT * FROM lp_sim_positions WHERE status = 'open'").all();
    console.log(`Charonsol phase 2 — dry-run LP fee-yield simulation report\n${line()}`);
    console.log(`FEE YIELD ONLY — no token-price data anywhere in this project, so impermanent`);
    console.log(`loss is NOT modeled. These numbers are what the pool's own reported fee/TVL`);
    console.log(`would have paid a proportional depositor; they are not full LP PnL.\n`);

    console.log(`Open positions:   ${open.length}`);
    console.log(`Closed positions: ${closed.length}`);
    if (!closed.length) { console.log('\nNothing closed yet — nothing to report on.'); return; }

    const totalNotional = closed.reduce((s, r) => s + r.notional_usd, 0);
    const totalFees = closed.reduce((s, r) => s + (r.realized_fee_usd ?? 0), 0);
    const avgYieldPct = closed.reduce((s, r) => s + ((r.realized_fee_usd ?? 0) / r.notional_usd) * 100, 0) / closed.length;
    const avgHoldMs = closed.reduce((s, r) => s + (r.hold_ms ?? 0), 0) / closed.length;
    // Extrapolate each position's realized yield to an annualized rate, same "APY" framing
    // meridian itself uses for fee_active_tvl_ratio — only meaningful for positions that
    // held long enough to not be dominated by noise (skips anything under 1h held).
    const annualizable = closed.filter(r => (r.hold_ms ?? 0) >= 60 * 60 * 1000);
    const avgApyPct = annualizable.length
      ? annualizable.reduce((s, r) => {
          const pct = ((r.realized_fee_usd ?? 0) / r.notional_usd) * 100;
          const holdDays = r.hold_ms / (24 * 60 * 60 * 1000);
          return s + (holdDays > 0 ? pct * (365 / holdDays) : 0);
        }, 0) / annualizable.length
      : null;

    console.log(`\nTotal notional (closed):  $${totalNotional.toFixed(2)}`);
    console.log(`Total realized fees:      $${totalFees.toFixed(4)}`);
    console.log(`Avg realized yield:       ${avgYieldPct.toFixed(4)}% per position`);
    console.log(`Avg hold time:            ${(avgHoldMs / 60_000).toFixed(0)} min`);
    if (avgApyPct != null) console.log(`Avg annualized yield*:    ${avgApyPct.toFixed(1)}%  (*positions held ≥1h, extrapolated — not a real forward guarantee)`);

    const byReason = {};
    closed.forEach(r => {
      const reason = r.close_reason || 'unknown';
      if (!byReason[reason]) byReason[reason] = { count: 0, fees: 0, notional: 0 };
      byReason[reason].count++;
      byReason[reason].fees += r.realized_fee_usd ?? 0;
      byReason[reason].notional += r.notional_usd;
    });
    console.log(`\nClose reasons:`);
    console.log(`  ${'reason'.padEnd(16)} ${'n'.padStart(4)}  ${'avg yield%'.padStart(11)}`);
    Object.entries(byReason).sort((a, b) => b[1].count - a[1].count).forEach(([reason, r]) => {
      const avgPct = r.notional > 0 ? (r.fees / r.notional) * 100 : 0;
      console.log(`  ${reason.padEnd(16)} ${String(r.count).padStart(4)}  ${avgPct.toFixed(4).padStart(11)}`);
    });
  },

  // Token-side patterns ported verbatim from charon's own scripts/cli.js filter-report —
  // matched exactly against every failures.push(...) in src/pipeline/candidateBuilder.js
  // (that file is unchanged from charon, so these still apply as-is). Ordered so more-
  // specific patterns are checked before general ones that would otherwise also match.
  'filter-report'(args) {
    const TOKEN_FILTER_PATTERNS = [
      ['fresh grad: insufficient data', /^fresh grad insufficient data/],
      ['fee claim: missing', /^fee claim: missing/],
      ['fee claim: too low', /^fee claim:/],
      ['market cap: below min', /^market cap min:/],
      ['market cap: above max', /^market cap max:/],
      ['GMGN total fees: too low', /^GMGN total fees:/],
      ['graduated volume: too low', /^graduated volume:/],
      ['holder count: too low', /^holders:/],
      ['top holder concentration: too high', /^max top holder:/],
      ['entry RSI: overbought', /^RSI\(\d+\):/],
      ['bot holders death zone (HARD REJECT)', /^bot holders death zone:/],
      ['saved wallet holders: too low', /^saved wallet holders:/],
      ['ATH distance: too far', /^ATH distance:/],
      ['trending: swaps too low', /^trending swaps:/],
      ['trending: rug ratio too high', /^trending rug ratio:/],
      ['trending: bundler rate too high', /^trending bundler rate:/],
      ['trending: wash trading', /^trending wash trading/],
      ['token age: too old', /^token age:/],
      ['buy pressure: weak', /^buy pressure weak/],
      ['DEX liquidity: too low', /^DEX liquidity too low/],
      ['flow: 1h price change too low', /^flow: 1h price change/],
      ['flow: net buyer ratio 1h too low', /^flow: net buyer ratio 1h/],
      ['flow: net buyer ratio 5m too low', /^flow: net buyer ratio \d/],
      ['flow: 5m net buyers (count) too low', /^flow: 5m net buyers/],
      ['flow: bonding curve too low', /^flow: bonding curve/],
      ['organic score too low', /^organic score:/],
      ['soft score: below threshold', /^soft score:/],
      ['compound group required but not satisfied', /^compound group required but not satisfied/], // dead going forward (rescue-only semantics, 2026-09-07) — kept for old log/DB data that still has this message
    ];
    // Pool-side patterns, Charonsol-specific — matched against the exact reasons.push(...)
    // strings in src/pipeline/lpOrchestrator.js's screenPoolsForCandidate().
    const POOL_FILTER_PATTERNS = [
      ['pool pools_found: too few', /^pools_found /],
      ['pool active_tvl: too low', /^active_tvl .* < min/],
      ['pool active_tvl: too high', /^active_tvl .* > max/],
      ['pool fee_active_tvl_ratio: too low', /^fee_active_tvl_ratio/],
      ['pool volume: too low', /^volume /],
      ['pool degen_score: too low', /^degen_score/],
      ['no Meteora pool found', /^no Meteora DLMM\/SOL pool found/],
      ['pool discovery error', /^pool discovery error:/],
      ['pool compound group required but not satisfied', /^pool compound group required but not satisfied/], // dead going forward, same reason as above
    ];
    function classify(patterns, failure) {
      for (const [label, re] of patterns) if (re.test(failure)) return label;
      return `other: ${failure.split(':')[0]}`;
    }
    function tally(rows, getFailures) {
      const rejectCounts = new Map();
      const soleBlockerCounts = new Map();
      let passed = 0, failed = 0;
      for (const row of rows) {
        const failures = getFailures(row);
        if (!failures || failures.length === 0) { passed++; continue; }
        failed++;
        const labels = failures.map(f => classify(row.__patterns, f));
        for (const label of labels) rejectCounts.set(label, (rejectCounts.get(label) || 0) + 1);
        if (labels.length === 1) soleBlockerCounts.set(labels[0], (soleBlockerCounts.get(labels[0]) || 0) + 1);
      }
      return { rejectCounts, soleBlockerCounts, passed, failed };
    }
    function printTable(rejectCounts, soleBlockerCounts) {
      const allLabels = new Set([...rejectCounts.keys(), ...soleBlockerCounts.keys()]);
      const sorted = Array.from(allLabels).sort((a, b) => (soleBlockerCounts.get(b) || 0) - (soleBlockerCounts.get(a) || 0));
      console.log(`${'Filter'.padEnd(42)} ${'Rejected'.padStart(9)}  ${'Sole blocker'.padStart(13)}`);
      console.log(line('·'));
      for (const label of sorted) {
        console.log(`${label.padEnd(42)} ${String(rejectCounts.get(label) || 0).padStart(9)}  ${String(soleBlockerCounts.get(label) || 0).padStart(13)}`);
      }
    }

    const windowMs = parseWindowMs(args[0] || '24h');
    const cutoff = now() - windowMs;

    // ── Token-level funnel ──────────────────────────────────────────────────────────
    const candidateRows = db.prepare('SELECT mint, signal_key, filter_result_json FROM candidates WHERE created_at_ms >= ?').all(cutoff);
    console.log(`Filter report — last ${formatWindow(windowMs)}\n${line()}\n`);
    if (!candidateRows.length) {
      console.log(`No candidates recorded in this window.`);
      return;
    }
    for (const row of candidateRows) row.__patterns = TOKEN_FILTER_PATTERNS;
    const tokenParsed = candidateRows.map(row => {
      let fr; try { fr = JSON.parse(row.filter_result_json); } catch { fr = null; }
      return { ...row, __failures: fr?.passed ? [] : (Array.isArray(fr?.failures) ? fr.failures : []) };
    });
    const tokenStats = tally(tokenParsed, r => r.__failures);
    console.log(`TOKEN-LEVEL (charon's filterCandidate) — ${candidateRows.length} candidates seen: ${tokenStats.passed} passed, ${tokenStats.failed} rejected\n`);
    printTable(tokenStats.rejectCounts, tokenStats.soleBlockerCounts);
    console.log(`\n"Rejected" = candidates that failed this filter (may have also failed others).`);
    console.log(`"Sole blocker" = candidates that failed ONLY this filter — loosening it is what`);
    console.log(`would actually let more candidates through, vs a filter that's rarely the only`);
    console.log(`thing blocking a candidate.`);

    // ── Pool-level funnel (Charonsol-specific) ─────────────────────────────────────
    const lpRows = db.prepare('SELECT mint, pool_screen_passed, pool_reject_reasons_json FROM lp_candidates WHERE created_at_ms >= ?').all(cutoff);
    console.log(`\n${line()}\nPOOL-LEVEL (Meteora screening) — ${lpRows.length} sent to pool screening: ` +
      `${lpRows.filter(r => r.pool_screen_passed).length} passed, ${lpRows.filter(r => !r.pool_screen_passed).length} rejected\n`);
    if (lpRows.length) {
      for (const row of lpRows) row.__patterns = POOL_FILTER_PATTERNS;
      const poolParsed = lpRows.map(row => ({ ...row, __failures: row.pool_screen_passed ? [] : safeJson(row.pool_reject_reasons_json, []) }));
      const poolStats = tally(poolParsed, r => r.__failures);
      printTable(poolStats.rejectCounts, poolStats.soleBlockerCounts);
    } else {
      console.log(`(nothing reached pool screening in this window — every candidate was rejected at the token level, or none have passed yet)`);
    }

    // ── Funnel summary ───────────────────────────────────────────────────────────────
    const simRows = db.prepare(`
      SELECT s.status, s.close_reason FROM lp_sim_positions s
      JOIN lp_candidates lc ON lc.id = s.lp_candidate_id
      WHERE lc.created_at_ms >= ?
    `).all(cutoff);
    console.log(`\n${line()}\nFunnel summary — last ${formatWindow(windowMs)}`);
    console.log(`  ${candidateRows.length} token candidates → ${tokenStats.passed} passed token filter → ` +
      `${lpRows.length} pool-screened → ${lpRows.filter(r => r.pool_screen_passed).length} LP candidates → ` +
      `${simRows.length} sim positions opened (${simRows.filter(r => r.status === 'open').length} open, ${simRows.filter(r => r.status === 'closed').length} closed)`);

    // ── Per-route breakdown ──────────────────────────────────────────────────────────
    const byRoute = new Map();
    for (const row of tokenParsed) {
      const route = (row.signal_key || '').split(':')[0] || 'unknown';
      if (!byRoute.has(route)) byRoute.set(route, { seen: 0, tokenPassed: 0, poolPassed: 0 });
      const r = byRoute.get(route);
      r.seen++;
      if (row.__failures.length === 0) r.tokenPassed++;
    }
    // lp_candidates doesn't carry signal_key directly — join back through candidates for the route.
    const lpByMint = new Map(lpRows.map(r => [r.mint, r]));
    for (const row of tokenParsed) {
      const lp = lpByMint.get(row.mint);
      if (lp?.pool_screen_passed) {
        const route = (row.signal_key || '').split(':')[0] || 'unknown';
        byRoute.get(route).poolPassed++;
      }
    }
    if (byRoute.size > 1) {
      console.log(`\nBy source:`);
      console.log(`  ${'route'.padEnd(24)} ${'seen'.padStart(6)}  ${'token-pass'.padStart(10)}  ${'pool-pass'.padStart(9)}`);
      Array.from(byRoute.entries()).sort((a, b) => b[1].seen - a[1].seen).forEach(([route, r]) => {
        console.log(`  ${route.padEnd(24)} ${String(r.seen).padStart(6)}  ${String(r.tokenPassed).padStart(10)}  ${String(r.poolPassed).padStart(9)}`);
      });
    }
  },

  events(args) {
    const n = args.find(a => /^\d+$/.test(a));
    const count = n ? Number(n) : 20;
    if (!existsSync(EVENTS_LOG_PATH)) { console.log('No events logged yet (logs/events.jsonl not found).'); return; }
    const lines = readFileSync(EVENTS_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) { console.log('logs/events.jsonl is empty.'); return; }
    lines.slice(-count).forEach(l => {
      try {
        const { ts, type, ...rest } = JSON.parse(l);
        console.log(`${ts}  [${type}]  ${JSON.stringify(rest)}`);
      } catch { console.log(l); }
    });
  },

  // Same behavior as charon's own `setting` command: no key -> list everything stored;
  // key only -> show that one; key + value -> write it. 'off' is shorthand for '0'.
  setting(args) {
    const [key, ...rest] = args;
    const value = rest.join(' ');
    const valueProvided = rest.length > 0;

    if (!key) {
      const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
      if (!rows.length) { console.log('No settings stored in the DB yet — everything is using its code/.env default.'); return; }
      console.log(`${rows.length} setting(s) in the DB:\n${line()}`);
      rows.forEach(r => console.log(`  ${r.key.padEnd(32)} ${r.value}`));
      return;
    }

    if (!valueProvided) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row) {
        console.log(`"${key}" is not set in the DB — using its code/.env default (see src/config.js or the call site).`);
        return;
      }
      console.log(`${key} = ${row.value}`);
      return;
    }

    const stored = value === 'off' ? '0' : value;
    setSetting(key, stored);
    console.log(stored === '' ? `Cleared ${key} (now empty)` : `Set ${key} = ${stored}`);
  },

  unset(args) {
    const [key] = args;
    if (!key) { console.log('Usage: npm run unset -- <key>'); return; }
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) {
      console.log(`"${key}" isn't stored in the DB — nothing to unset, already using its code/.env default.`);
      return;
    }
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    console.log(`Removed ${key} (was "${row.value}") — will use its code/.env default on next read.`);
  },

  stratshow(args) {
    const [id] = args;
    const strats = allStrategies();
    if (!id) {
      console.log(`Strategies\n${line()}`);
      strats.forEach(s => console.log(`  ${s.id.padEnd(16)} ${s.name.padEnd(16)} ${s.enabled ? '✅ enabled' : '  disabled'}`));
      console.log(`\n${strats.find(s => s.enabled)?.id ?? '(none enabled — buildCandidate falls back to the sniper default)'} is what filterCandidate() actually uses right now.`);
      console.log(`\nnpm run stratshow -- <id>          full config for one strategy`);
      console.log(`npm run stratset -- <id> <key> <value>   change one field`);
      return;
    }
    const strat = strategyById(id);
    if (!strat) { console.log(`Unknown strategy "${id}". Valid: ${strats.map(s => s.id).join(', ')}`); return; }
    console.log(`${strat.id} (${strat.name})\n${line()}`);
    for (const [key, value] of Object.entries(strat)) {
      if (key === 'id' || key === 'name') continue;
      const relevant = NUMERIC_STRAT_KEYS.has(key) || BOOL_STRAT_KEYS.has(key);
      console.log(`  ${key.padEnd(28)} ${JSON.stringify(value)}${relevant ? '' : '  (not read by candidateBuilder.js\'s filterCandidate — leftover from charon, has no effect here)'}`);
    }
    console.log(`\nChange any filter field: npm run stratset -- ${strat.id} <key> <value>`);
  },

  stratset(args) {
    const [id, key, ...rest] = args;
    const value = rest.join(' ');
    if (!id || !key || value === '') {
      console.log('Usage: npm run stratset -- <strategy_id> <key> <value>');
      console.log(`Numeric keys: ${[...NUMERIC_STRAT_KEYS].join(', ')}`);
      console.log(`Boolean keys: ${[...BOOL_STRAT_KEYS].join(', ')}`);
      return;
    }
    const strat = strategyById(id);
    if (!strat) { console.log(`Strategy "${id}" not found. Run npm run stratshow to list them.`); return; }
    if (!NUMERIC_STRAT_KEYS.has(key) && !BOOL_STRAT_KEYS.has(key)) {
      console.log(`"${key}" isn't a field candidateBuilder.js's filterCandidate() reads (or it's an execution-only`);
      console.log(`field left over from charon that has no effect here) — setting it would silently do nothing.`);
      console.log(`Numeric keys: ${[...NUMERIC_STRAT_KEYS].join(', ')}`);
      console.log(`Boolean keys: ${[...BOOL_STRAT_KEYS].join(', ')}`);
      return;
    }
    const newConfig = { ...strat };
    delete newConfig.id;
    delete newConfig.name;
    if (NUMERIC_STRAT_KEYS.has(key)) newConfig[key] = Number(value);
    else newConfig[key] = value === 'true' || value === '1' || value === 'yes';
    updateStrategyConfig(id, newConfig);
    console.log(`Updated ${id}.${key} = ${newConfig[key]}`);
  },

  reset(args) {
    // Ported from charon's own reset-history — same exclusion policy (settings, strategies,
    // saved_wallets are genuine user config, never touched) and same table set, PLUS the two
    // tables Charonsol added that charon doesn't have at all: lp_candidates and
    // lp_sim_positions. Everything else in charon's original list is included too even
    // though most of it (dry_run_positions, dry_run_trades, tp_sl_rules, learning_lessons,
    // learning_runs, trade_intents, post_close_tracking, filter_tuning_runs,
    // filter_tuning_actions, price_alerts) is permanently empty in Charonsol — no execution/
    // LLM-learning layer was ported, so nothing ever writes to those tables. Kept in the list
    // for completeness/future-proofing rather than silently diverging from charon's own
    // audited table set.
    const TABLES = [
      'dry_run_positions', 'dry_run_trades', 'tp_sl_rules', 'candidates', 'decision_logs',
      'llm_decisions', 'llm_batches', 'learning_lessons', 'learning_runs', 'signal_events',
      'alerts', 'decision_cache', 'trade_intents', 'post_close_tracking',
      'filter_tuning_runs', 'filter_tuning_actions', 'price_alerts', 'queue_stats',
      'lp_candidates', 'lp_sim_positions',
    ];

    if (!args.includes('--yes')) {
      console.log(`This permanently deletes ALL screening/simulation history from ${DB_PATH}:`);
      TABLES.forEach(t => console.log(`  - ${t}`));
      console.log(`\nDoes NOT touch settings, strategies, or saved_wallets — those are config, not history.`);
      console.log(`\nBack it up first if you might want this data later (e.g. for backtest.js):`);
      console.log(`  cp ${DB_PATH} ${DB_PATH}.backup-$(date +%Y%m%d)`);
      console.log(`\nRe-run with --yes to actually do this: npm run reset -- --yes`);
      return;
    }

    console.log(`Resetting ${DB_PATH}...\n${line()}`);
    const results = {};
    const resetTxn = db.transaction(() => {
      for (const table of TABLES) {
        const result = db.prepare(`DELETE FROM ${table}`).run();
        results[table] = result.changes;
      }
    });
    resetTxn();
    Object.entries(results).forEach(([table, n]) => console.log(`  ${table.padEnd(22)} ${n} row(s) deleted`));

    console.log(`\nRunning VACUUM to reclaim disk space (rewrites the whole file, may take a moment)...`);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    console.log(`Done. Settings and strategies were left untouched — same thresholds you just tuned are still active for the new trial.`);
  },

  'queue-status'() {
    const priorityName = (p) => Object.entries(PRIORITY).find(([, v]) => v === Number(p))?.[0] || `p${p}`;

    function printQueue(name, stats, ageMs) {
      if (!stats) {
        console.log(`${name} queue — no snapshot found yet.`);
        console.log(`  The main bot process writes this every ${numSetting('queue_stats_snapshot_interval_ms', 15_000) / 1000}s — either it hasn't`);
        console.log(`  written one yet (just started?), or it isn't running.`);
        return;
      }
      const staleness = ageMs > 60_000 ? `  [STALE — last updated ${Math.round(ageMs / 1000)}s ago, is the bot process actually running?]` : '';
      console.log(`${name} queue — draining: ${stats.draining}  fast-lane draining: ${stats.fastLaneDraining}  suspended passes: ${stats.suspendedPasses}${staleness}`);
      const priorities = Object.keys(stats.byPriority || {}).map(Number).sort((a, b) => b - a);
      if (!priorities.length) { console.log('  (no activity yet)'); return; }
      console.log(`  ${'priority'.padEnd(20)}${'pending'.padStart(9)}${'enqueued'.padStart(10)}${'completed'.padStart(11)}${'failed'.padStart(8)}${'timedOut'.padStart(10)}${'avgWait'.padStart(10)}${'maxWait'.padStart(10)}`);
      for (const p of priorities) {
        const s = stats.byPriority[p];
        const pending = (stats.pending || {})[p] || 0;
        console.log(`  ${priorityName(p).padEnd(20)}${String(pending).padStart(9)}${String(s.enqueued).padStart(10)}${String(s.completed).padStart(11)}${String(s.failed).padStart(8)}${String(s.timedOut || 0).padStart(10)}${(s.avgWaitMs + 'ms').padStart(10)}${(s.maxWaitMs + 'ms').padStart(10)}`);
      }
    }

    console.log(`Queue status\n${line()}`);
    const rows = db.prepare('SELECT queue_name, stats_json, updated_at_ms FROM queue_stats').all();
    const byName = Object.fromEntries(rows.map(r => [r.queue_name, r]));
    const nowMs = Date.now();

    for (const name of ['jupiter', 'gmgn', 'meteora']) {
      const row = byName[name];
      printQueue(name, row ? JSON.parse(row.stats_json) : null, row ? nowMs - row.updated_at_ms : null);
      console.log();
    }
  },

  dbsize() {
    const { counts, fileBytes, reclaimableBytes } = dbStats();
    const fmtBytes = (b) => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`;
    console.log(`DB file size: ${fmtBytes(fileBytes)}${reclaimableBytes > 0 ? `  (${fmtBytes(reclaimableBytes)} reclaimable — run 'npm run vacuum')` : ''}`);
    console.log(line());
    Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([table, n]) => {
      console.log(`  ${table.padEnd(20)} ${n} row(s)`);
    });
  },

  prune() {
    console.log('Pruning telemetry tables past their retention window...');
    const result = pruneOldRows();
    const total = Object.values(result).reduce((sum, n) => sum + n, 0);
    Object.entries(result).forEach(([table, n]) => { if (n > 0) console.log(`  ${table}: deleted ${n}`); });
    console.log(total > 0 ? `\nDeleted ${total} row(s) total. Run 'npm run vacuum' to reclaim disk space.` : '\nNothing to prune.');
  },

  vacuum() {
    console.log('Running VACUUM — this rewrites the whole DB file, may take a moment on a large DB...');
    const before = dbStats().fileBytes;
    vacuumDb();
    const after = dbStats().fileBytes;
    const fmtBytes = (b) => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`;
    console.log(`Done. ${fmtBytes(before)} -> ${fmtBytes(after)} (freed ${fmtBytes(Math.max(0, before - after))})`);
  },
};

const [, , cmd, ...args] = process.argv;

if (!cmd || !commands[cmd]) {
  if (cmd) console.log(`Unknown command "${cmd}".\n`);
  commands.help();
  process.exit(cmd && !commands[cmd] ? 1 : 0);
}

Promise.resolve(commands[cmd](args)).catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
