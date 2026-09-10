import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

export const db = new Database(DB_PATH);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- 2026-08-21: priority queue stats (src/enrichment/priorityQueue.js) live in-memory inside
    -- whichever process is actually running the bot — a separate CLI invocation can't see them
    -- just by importing the same module, since each process gets its own fresh instances. The
    -- main bot process periodically writes a snapshot here (see app.js); queue-status (cli.js)
    -- reads the snapshot instead of trying to access live in-memory state it has no way to reach.
    CREATE TABLE IF NOT EXISTS queue_stats (
      queue_name TEXT PRIMARY KEY,
      stats_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signature TEXT,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signature, mint)
    );
    -- Charonsol's own table: one row per token candidate that PASSED charon's token-level
    -- filter (candidates.status = 'candidate') and was then run through meridian's Meteora
    -- DLMM pool discovery + scoring. This is the merged token-screen + pool-screen record —
    -- the actual "LP candidate" data this project exists to collect. candidate_id links back
    -- to the charon candidates row (token-side data/filters); everything pool-side lives here.
    CREATE TABLE IF NOT EXISTS lp_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      pools_found INTEGER NOT NULL DEFAULT 0,
      best_pool_address TEXT,
      best_bin_step INTEGER,
      best_fee_active_tvl_ratio REAL,
      best_active_tvl REAL,
      best_volume_window REAL,
      degen_score REAL,
      pool_screen_passed INTEGER NOT NULL DEFAULT 0,
      pool_reject_reasons_json TEXT,
      pools_json TEXT NOT NULL,
      best_pool_detail_json TEXT,
      UNIQUE(candidate_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lp_candidates_mint ON lp_candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_lp_candidates_status ON lp_candidates(status);
    -- Phase 2: lightweight dry-run LP simulation. One row per simulated position, opened
    -- when a lp_candidates row passes pool screening. NEVER deploys real capital, holds no
    -- wallet, does no on-chain reads — fee accrual is estimated purely from Meteora's own
    -- public fee_active_tvl_ratio (pool-discovery-api), the same figure meridian's own
    -- definitions.js describes as "the current APY of the pool". This estimates FEE YIELD
    -- ONLY — there is no token-price data anywhere in this project, so impermanent loss is
    -- NOT modeled. Treat every number here as a fee-income estimate, never as full LP PnL.
    -- "In range" is approximated from pool health (active_tvl/fee_active_tvl_ratio staying
    -- above floor) since exact bin-level price tracking needs the real DLMM SDK + RPC, which
    -- this project deliberately doesn't have — see README's Phase 2 section for the caveat.
    CREATE TABLE IF NOT EXISTS lp_sim_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lp_candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      pool_address TEXT NOT NULL,
      bin_step INTEGER,
      timeframe TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      notional_usd REAL NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      entry_active_tvl REAL,
      entry_fee_active_tvl_ratio REAL,
      entry_volume_window REAL,
      entry_degen_score REAL,
      last_snapshot_at_ms INTEGER NOT NULL,
      last_active_tvl REAL,
      last_fee_active_tvl_ratio REAL,
      last_volume_window REAL,
      in_range_snapshots INTEGER NOT NULL DEFAULT 0,
      out_of_range_snapshots INTEGER NOT NULL DEFAULT 0,
      consecutive_stall_snapshots INTEGER NOT NULL DEFAULT 0,
      last_fee_increase_at_ms INTEGER NOT NULL,
      accrued_fee_usd REAL NOT NULL DEFAULT 0,
      snapshots_json TEXT NOT NULL DEFAULT '[]',
      closed_at_ms INTEGER,
      close_reason TEXT,
      realized_fee_usd REAL,
      hold_ms INTEGER,
      UNIQUE(lp_candidate_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lp_sim_positions_status ON lp_sim_positions(status);
    CREATE INDEX IF NOT EXISTS idx_lp_sim_positions_mint ON lp_sim_positions(mint);
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      llm_decision_id INTEGER,
      execution_mode TEXT DEFAULT 'dry_run',
      entry_signature TEXT,
      exit_signature TEXT,
      token_amount_raw TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tp_sl_rules (
      position_id INTEGER PRIMARY KEY,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      llm_decision_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      lessons_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    -- From migrations/001_decision_cache.sql — folded in directly since nothing
    -- previously ran that file automatically (a fresh DB hit "no such table:
    -- decision_cache" on every candidate until this was applied by hand).
    CREATE TABLE IF NOT EXISTS decision_cache (
      mint TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      route TEXT,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      mcap_snapshot REAL,
      holders_snapshot INTEGER,
      liq_snapshot REAL
    );
    CREATE INDEX IF NOT EXISTS idx_decision_cache_expires ON decision_cache(expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_decision_cache_mint_expires ON decision_cache(mint, expires_at_ms);

    -- Post-close tracking: after a position closes, keep watching the token for a while
    -- (default 30/60min checkpoints) to see what actually happened afterward — did SL/guard
    -- exits get out ahead of a real crash, or cut something that would've recovered? One row
    -- per checkpoint, not one row per position, so adding more checkpoints later (e.g. a 15min
    -- or 24h mark) never needs a schema change.
    CREATE TABLE IF NOT EXISTS post_close_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      checkpoint_label TEXT NOT NULL,
      scheduled_at_ms INTEGER NOT NULL,
      checked_at_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT,
      mcap REAL,
      price REAL,
      pnl_vs_exit_percent REAL,
      pnl_vs_entry_percent REAL
    );
    CREATE INDEX IF NOT EXISTS idx_post_close_status_scheduled ON post_close_tracking(status, scheduled_at_ms);
    CREATE INDEX IF NOT EXISTS idx_post_close_position ON post_close_tracking(position_id);

    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      target_price_usd REAL,
      target_mcap_usd REAL,
      target_ath_distance_percent REAL,
      candidate_json TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      triggered_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_mint_status ON dry_run_positions(mint, status);
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(selected_mint);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
    -- Retention job (src/db/retention.js) prunes by age on these tables —
    -- indexes keep the periodic DELETE fast instead of a full table scan.
    CREATE INDEX IF NOT EXISTS idx_candidates_created ON candidates(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_at ON decision_logs(at_ms);
    CREATE INDEX IF NOT EXISTS idx_signal_events_at ON signal_events(at_ms);
    -- LLM-driven filter tuner (2026-08-24): one row per "npm run filter-tune" (manual or
    -- scheduled) invocation, regardless of whether anything was actually applied — this is the
    -- audit trail for "why is this setting what it is right now", mirroring learning_runs/
    -- learning_applied above but scoped to per-route filter_or_groups / key:route settings
    -- instead of strategy config. filter_tuning_actions holds one row per individual
    -- setting change proposed within a run; applied=0 rows are proposals that were shown but
    -- not written (dry-run mode, or rejected by validation/clamping).
    CREATE TABLE IF NOT EXISTS filter_tuning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'manual',
      days REAL,
      backtest_json TEXT NOT NULL,
      llm_raw_json TEXT,
      apply_requested INTEGER NOT NULL DEFAULT 0,
      actions_proposed INTEGER NOT NULL DEFAULT 0,
      actions_applied INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS filter_tuning_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      route TEXT,
      setting_key TEXT NOT NULL,
      old_value TEXT,
      proposed_value TEXT NOT NULL,
      applied_value TEXT,
      applied INTEGER NOT NULL DEFAULT 0,
      reject_reason TEXT,
      confidence REAL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_filter_tuning_actions_run ON filter_tuning_actions(run_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_sent_at ON alerts(sent_at_ms);
    CREATE INDEX IF NOT EXISTS idx_llm_decisions_created ON llm_decisions(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_llm_batches_created ON llm_batches(created_at_ms);
  `);
  ensureColumn('candidates', 'signal_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL');
  // 2026-08-27: lifetime-fee-stall tracking (ported from meridian's fee-stall-guard.js) —
  // added after lp_sim_positions already existed for some users, so this needs a default
  // for ALTER TABLE to succeed on a non-empty table; openSimPosition always supplies the
  // real value explicitly on insert for fresh rows going forward.
  ensureColumn('lp_sim_positions', 'last_fee_increase_at_ms', 'INTEGER NOT NULL DEFAULT 0');
  // Backfill: any row that still shows the ALTER TABLE default of 0 predates this column
  // and would otherwise look "stalled since the Unix epoch" on the very next monitoring
  // pass — re-baseline it to its own last known snapshot instead, same reasoning as
  // fee-stall-guard.js's own restart behavior ("re-baselines from whatever the position's
  // current state is and starts the clock over from there").
  db.exec(`UPDATE lp_sim_positions SET last_fee_increase_at_ms = last_snapshot_at_ms WHERE last_fee_increase_at_ms = 0`);
  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'entry_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'token_amount_raw', 'TEXT');
  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'sniper'");
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'entry_nb5m', 'REAL'); // net buyers in the 5min before entry — feeds dynamic_max_hold
  ensureColumn('decision_logs', 'strategy_id', 'TEXT');

  const defaults = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '10',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || String(10 * 60 * 1000),
    llm_min_confidence: '75',
    sideways_timeout_minutes: '0',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    dry_run_buy_sol: '0.1',
    default_tp_percent: '50',
    default_sl_percent: '-25',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    min_fee_claim_sol: process.env.MIN_FEE_CLAIM_SOL || '2',
    min_mcap_usd: process.env.MIN_MCAP_USD || '25000',
    min_holders: process.env.MIN_HOLDERS || '30',
    max_mcap_usd: '0',
    min_gmgn_total_fee_sol: '0',
    min_graduated_volume_usd: '0',
    max_top20_holder_percent: '100',
    min_saved_wallet_holders: '0',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '2500',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
    trending_enabled: process.env.TRENDING_ENABLED || 'true',
    trending_source: process.env.TRENDING_SOURCE || 'jupiter',
    trending_allow_degen: process.env.TRENDING_ALLOW_DEGEN || 'false',
    trending_interval: process.env.TRENDING_INTERVAL || '5m',
    trending_limit: process.env.TRENDING_LIMIT || '100',
    trending_order_by: process.env.TRENDING_ORDER_BY || 'volume',
    trending_min_volume_usd: process.env.TRENDING_MIN_VOLUME_USD || '0',
    trending_min_swaps: process.env.TRENDING_MIN_SWAPS || '0',
    trending_max_rug_ratio: process.env.TRENDING_MAX_RUG_RATIO || '0.3',
    trending_max_bundler_rate: process.env.TRENDING_MAX_BUNDLER_RATE || '0.5',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);

  // Seed default strategies
  const stratInsert = db.prepare('INSERT OR IGNORE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)');
  const ts = Date.now();

  stratInsert.run('sniper', 'Sniper', 1, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 0,
    min_mcap_usd: 25000,
    max_mcap_usd: 0,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 30,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 1,
    trending_max_bundler_rate: 1,
    position_size_sol: 0.08,
    max_open_positions: 3,
    tp_percent: 25,
    sl_percent: -15,
    trailing_enabled: true,
    trailing_percent: 10,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 1800000,
    use_llm: true,
    llm_min_confidence: 40,
    momentum_threshold: 0.5,
  }), ts);

  stratInsert.run('dip_buy', 'Dip Buy', 0, JSON.stringify({
    entry_mode: 'wait_for_dip',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 25000,
    max_mcap_usd: 500000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 30,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: -40,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.05,
    max_open_positions: 3,
    tp_percent: 30,
    sl_percent: -20,
    trailing_enabled: true,
    trailing_percent: 15,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 60,
  }), ts);

  stratInsert.run('smart_money', 'Smart Money', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 25000,
    max_mcap_usd: 1000000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 30,
    max_top20_holder_percent: 50,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 5000,
    trending_min_swaps: 100,
    trending_max_rug_ratio: 0.2,
    trending_max_bundler_rate: 0.3,
    position_size_sol: 0.1,
    max_open_positions: 3,
    tp_percent: 100,
    sl_percent: -25,
    trailing_enabled: false,
    trailing_percent: 0,
    partial_tp: true,
    partial_tp_at_percent: 100,
    partial_tp_sell_percent: 50,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 70,
  }), ts);

  stratInsert.run('degen', 'Degen', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 3600000,
    min_mcap_usd: 25000,
    max_mcap_usd: 100000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 30,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.5,
    trending_max_bundler_rate: 0.7,
    position_size_sol: 0.05,
    max_open_positions: 5,
    tp_percent: 30,
    sl_percent: -15,
    trailing_enabled: true,
    trailing_percent: 10,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: false,
    llm_min_confidence: 0,
  }), ts);
}

export function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
