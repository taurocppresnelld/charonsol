#!/usr/bin/env node
// ── Migration Script: Add IL & Price Tracking Columns to lp_sim_positions ────
import { initDb, db } from '../src/db/connection.js';

initDb();

function runMigration() {
  console.log('Starting DB migration for IL & Price tracking...');

  const columnsToAdd = [
    { name: 'entry_price_usd', type: 'REAL DEFAULT 0' },
    { name: 'current_price_usd', type: 'REAL DEFAULT 0' },
    { name: 'il_usd', type: 'REAL DEFAULT 0' },
    { name: 'net_pnl_usd', type: 'REAL DEFAULT 0' },
    { name: 'is_out_of_range', type: 'INTEGER DEFAULT 0' },
  ];

  // Fetch existing table info
  const tableInfo = db.prepare(`PRAGMA table_info(lp_sim_positions)`).all();
  const existingColumns = new Set(tableInfo.map(col => col.name));

  db.transaction(() => {
    for (const col of columnsToAdd) {
      if (!existingColumns.has(col.name)) {
        db.prepare(`ALTER TABLE lp_sim_positions ADD COLUMN ${col.name} ${col.type}`).run();
        console.log(`+ Added column: ${col.name}`);
      } else {
        console.log(`- Column already exists: ${col.name}`);
      }
    }
  })();

  console.log('Migration completed successfully.');
}

runMigration();