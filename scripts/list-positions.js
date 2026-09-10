#!/usr/bin/env node
import { initDb, db } from '../src/db/connection.js';
import { safeJson } from '../src/utils.js';

initDb();

function parseLimitArg(argv) {
  const limitIdx = argv.findIndex(arg => arg === '-n' || arg === '--limit' || arg === '--n');
  if (limitIdx !== -1 && argv[limitIdx + 1]) {
    const val = Number(argv[limitIdx + 1]);
    if (Number.isInteger(val) && val > 0) {
      return val;
    }
  }
  const positionalVal = Number(argv[0]);
  if (Number.isInteger(positionalVal) && positionalVal > 0) {
    return positionalVal;
  }
  return 100;
}

function run() {
  const limit = parseLimitArg(process.argv.slice(2));

  const rows = db.prepare(`
    SELECT 
      s.id,
      s.status,
      s.notional_usd,
      s.realized_fee_usd,
      s.hold_ms,
      s.bin_step,
      s.opened_at_ms,
      s.closed_at_ms,
      s.close_reason,
      s.pool_address,
      c.candidate_json
    FROM lp_sim_positions s
    LEFT JOIN lp_candidates lc ON lc.id = s.lp_candidate_id
    LEFT JOIN candidates c ON c.id = lc.candidate_id
    ORDER BY s.id DESC
    LIMIT ?
  `).all(limit);

  if (!rows.length) {
    console.log('No positions found in database.');
    process.exit(0);
  }

  const formattedRows = rows.map(r => {
    const candidate = safeJson(r.candidate_json, {})?.candidate ?? safeJson(r.candidate_json, {});
    const symbol = candidate?.jupiterAsset?.symbol || candidate?.symbol || 'UNKNOWN';
    const pool = r.pool_address ? `${r.pool_address.slice(0, 4)}...${r.pool_address.slice(-4)}` : 'N/A';

    const notional = r.notional_usd || 0;
    const fee = r.realized_fee_usd || 0;
    const yieldPct = notional > 0 ? (fee / notional) * 100 : 0;

    // Hold time / Stalled Hours calculation using opened_at_ms
    const holdMs = r.status === 'closed'
      ? (r.hold_ms || (r.closed_at_ms && r.opened_at_ms ? r.closed_at_ms - r.opened_at_ms : 0))
      : (Date.now() - (r.opened_at_ms || Date.now()));
    
    const stalledHours = holdMs / (1000 * 60 * 60);

    // Range status derived from close_reason or current status
    let inRange = 'YES';
    let outRange = 'NO';
    if (r.close_reason === 'tvl_drained' || r.close_reason === 'out_of_range') {
      inRange = 'NO';
      outRange = 'YES';
    } else if (r.status === 'open') {
      inRange = 'YES';
      outRange = 'NO';
    }

    return {
      ID: r.id,
      Symbol: symbol,
      Pool: pool,
      'Bin Step': r.bin_step ?? 'N/A',
      Status: r.status ? r.status.toUpperCase() : 'UNKNOWN',
      'Fee ($)': `$${fee.toFixed(4)}`,
      'In Range': inRange,
      'Out Range': outRange,
      'Yield (%)': `${yieldPct.toFixed(3)}%`,
      'Stalled (h)': `${stalledHours.toFixed(1)}h`,
    };
  });

  console.log(`\n=== LAST ${rows.length} POSITIONS ===\n`);
  console.table(formattedRows);
}

run();