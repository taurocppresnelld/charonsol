import dotenv from 'dotenv';

dotenv.config();

export const APP_NAME = 'Charonsol';
export const DB_PATH = process.env.DB_PATH || './charonsol.sqlite';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const DISC_DIST_FEES = Buffer.from('a537817004b3ca28', 'hex');
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_MINT = 'So11111111111111111111111111111111111111111';

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const TELEGRAM_TOPIC_ID = process.env.TELEGRAM_TOPIC_ID;
export const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
export const GMGN_API_KEY = process.env.GMGN_API_KEY;
export const GMGN_ENABLED = process.env.GMGN_ENABLED !== 'false';
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
export const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const SOLANA_WS_URL = process.env.SOLANA_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const JUPITER_SWAP_BASE_URL = process.env.JUPITER_SWAP_BASE_URL || 'https://api.jup.ag/swap/v2';
export const JUPITER_SLIPPAGE_BPS = Number(process.env.JUPITER_SLIPPAGE_BPS || 300);
export const LIVE_MIN_SOL_RESERVE_LAMPORTS = Math.floor(Number(process.env.LIVE_MIN_SOL_RESERVE || 0.02) * 1_000_000_000);
export const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';
export const LLM_API_KEY = process.env.LLM_API_KEY || '';
export const LLM_MODEL = process.env.LLM_MODEL || 'MiniMax-M2.7';
export const LLM_MODEL_CHEAP = process.env.LLM_MODEL_CHEAP || '';
export const LLM_BASE_URL_CHEAP = process.env.LLM_BASE_URL_CHEAP || '';
export const LLM_API_KEY_CHEAP = process.env.LLM_API_KEY_CHEAP || '';
export const LLM_OPENROUTER_MODEL = process.env.LLM_OPENROUTER_MODEL || '';
export const LLM_OPENROUTER_API_KEY = process.env.LLM_OPENROUTER_API_KEY || '';
// Tertiary fallback: Zyloo (OpenAI-compatible gateway, catches any retryable error not just 402/401)
// Docs: https://zyloo.io/docs — base URL https://zyloo.io/v1
export const LLM_FALLBACK_BASE_URL = process.env.LLM_FALLBACK_BASE_URL || '';
export const LLM_FALLBACK_API_KEY = process.env.LLM_FALLBACK_API_KEY || '';
export const LLM_FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL || '';

export const GRADUATED_POLL_MS = Number(process.env.GRADUATED_POLL_MS || 30_000);
export const GRADUATED_LOOKBACK_MS = Number(process.env.GRADUATED_LOOKBACK_MS || 2 * 60 * 60 * 1000);
export const TRENDING_POLL_MS = Number(process.env.TRENDING_POLL_MS || 60_000);
export const TRENDING_LOOKBACK_MS = Number(process.env.TRENDING_LOOKBACK_MS || 10 * 60 * 1000);
// Was referenced by signals/smartMoney.js but never actually defined here — harmless while that
// module stays unwired (confirmed nothing currently imports it), but a real crash waiting to
// happen the moment it is. 10min, matching TRENDING_LOOKBACK_MS's timescale for a similar kind
// of "how fresh does this signal need to be" window.
export const SMART_MONEY_LOOKBACK_MS = Number(process.env.SMART_MONEY_LOOKBACK_MS || 10 * 60 * 1000);
export const GMGN_CACHE_TTL_MS = Number(process.env.GMGN_CACHE_TTL_MS || 5 * 60 * 1000);
export const POSITION_CHECK_MS = Number(process.env.POSITION_CHECK_MS || 10_000);
// Reduced from 60s — tokenrouter MiniMax-M3 normal response is 1-8s; 25s cap = hard upper bound on slow model hangs. LLM call was the biggest single delay in buy pipeline.
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 25_000);
export const ENABLE_LLM = process.env.ENABLE_LLM !== 'false';
export const SIGNAL_SERVER_URL = process.env.SIGNAL_SERVER_URL || '';
export const SIGNAL_SERVER_KEY = process.env.SIGNAL_SERVER_KEY || '';
export const SIGNAL_POLL_MS = Number(process.env.SIGNAL_POLL_MS || 30_000);
export const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY || '';
export const PUMPPORTAL_ENABLED = process.env.PUMPPORTAL_ENABLED !== 'false';
export const PREGRAD_POLL_MS = Number(process.env.PREGRAD_POLL_MS || 12_000);
export const PREGRAD_LOOKBACK_MS = Number(process.env.PREGRAD_LOOKBACK_MS || 30 * 60 * 1000);
export const PREGRAD_ENABLED = process.env.PREGRAD_ENABLED !== 'false';
export const PREGRAD_MIN_RSSR_SOL = Number(process.env.PREGRAD_MIN_RSSR_SOL || 76.5);
export const PREGRAD_MAX_RSSR_SOL = Number(process.env.PREGRAD_MAX_RSSR_SOL || 85);
export const PREGRAD_MAX_AGE_MS = Number(process.env.PREGRAD_MAX_AGE_MS || 12 * 60 * 60 * 1000);
export const PREGRAD_MAX_ATH_MULTIPLE = Number(process.env.PREGRAD_MAX_ATH_MULTIPLE || 1.2);

// ── Charonsol pool-screening (meridian-derived) ──────────────────────────────────────
// A token candidate that passes charon's token-level filter gets its Meteora DLMM
// pool(s) looked up and scored using these thresholds, ported from meridiancx's
// config.screening block. Same knobs, same defaults — see pool/screeningScales.js for
// the timeframe-scaled variants of minFeeActiveTvlRatio/minVolume.
export const POOL_SCREENING_TIMEFRAME = process.env.POOL_SCREENING_TIMEFRAME || '4h';
export const POOL_MIN_TVL = Number(process.env.POOL_MIN_TVL || 10_000);
export const POOL_MAX_TVL = process.env.POOL_MAX_TVL !== undefined ? Number(process.env.POOL_MAX_TVL) : 150_000;
export const POOL_MIN_FEE_ACTIVE_TVL_RATIO = Number(process.env.POOL_MIN_FEE_ACTIVE_TVL_RATIO || 0.05);
export const POOL_MIN_VOLUME = Number(process.env.POOL_MIN_VOLUME || 500);
export const POOL_MIN_DEGEN_SCORE = Number(process.env.POOL_MIN_DEGEN_SCORE || 0);
export const POOL_DISCOVERY_LIMIT = Number(process.env.POOL_DISCOVERY_LIMIT || 5);
// Backtest finding (2026-08-28, N=433 vs N=444 for pools_found==1, +6.2% vs -6.1% yield
// delta — internally consistent, not noise): tokens with 2+ Meteora pools meaningfully
// outperform single-pool tokens. Default 1 = off (matches every other filter's "no
// additional restriction" convention); the backtest supports raising this to 2.
export const POOL_MIN_POOLS_FOUND = Number(process.env.POOL_MIN_POOLS_FOUND || 1);

// ── Charonsol meridian-style token source ─────────────────────────────────────────
// Every one of charon's existing signal sources (trenches.js, trending.js's GMGN branch)
// hard-filters to mints ending in "pump" — i.e. pump.fun tokens only. That's a real gap
// for Charonsol specifically: pump.fun graduates land on PumpSwap/Raydium far more often
// than Meteora, so the pump.fun-only universe rarely produces a token that actually has
// a Meteora pool. This source queries GMGN's broad market-rank endpoint with NO pump-
// suffix restriction (any Solana token, any platform) and, crucially, confirms a real
// Meteora/SOL pool exists for a token BEFORE ever proposing it as a candidate — mirroring
// how meridian's own tools/gmgn.js discoverGmgnPools() finds tokens in the first place.
export const MERIDIAN_TOKENS_ENABLED = process.env.MERIDIAN_TOKENS_ENABLED !== 'false';
export const MERIDIAN_TOKENS_INTERVAL = process.env.MERIDIAN_TOKENS_INTERVAL || '1h';
export const MERIDIAN_TOKENS_LIMIT = Number(process.env.MERIDIAN_TOKENS_LIMIT || 100);
export const MERIDIAN_TOKENS_POOL_CHECK_LIMIT = Number(process.env.MERIDIAN_TOKENS_POOL_CHECK_LIMIT || 15);
export const MERIDIAN_TOKENS_POLL_MS = Number(process.env.MERIDIAN_TOKENS_POLL_MS || 90_000);

// ── Charonsol phase 2: lightweight dry-run LP simulation ───────────────────────────
// Estimates FEE YIELD ONLY from Meteora's own public fee_active_tvl_ratio — no wallet,
// no RPC, no token-price data anywhere, so impermanent loss is NOT modeled. See
// src/pipeline/lpSimulator.js and the README's Phase 2 section for the full model and
// its caveats. All deploy-time defaults below are also live-tunable via `settings`
// (lp_sim_* keys), same pattern as the POOL_* block above.
export const LP_SIM_ENABLED = process.env.LP_SIM_ENABLED !== 'false';
export const LP_SIM_NOTIONAL_USD = Number(process.env.LP_SIM_NOTIONAL_USD || 100);
export const LP_SIM_MAX_HOLD_MS = Number(process.env.LP_SIM_MAX_HOLD_MS || 24 * 60 * 60 * 1000);
export const LP_SIM_MIN_ACTIVE_TVL = Number(process.env.LP_SIM_MIN_ACTIVE_TVL || 5_000);
// Fee-stall threshold ported from meridian's fee-stall-guard.js: TIME SINCE FEES LAST
// GENUINELY INCREASED (lifetime total), not a count of low readings — same defaults
// meridian itself uses (6h threshold, 60min min age before the check applies at all).
export const LP_SIM_FEE_STALL_THRESHOLD_HOURS = Number(process.env.LP_SIM_FEE_STALL_THRESHOLD_HOURS || 6);
export const LP_SIM_FEE_STALL_MIN_AGE_MINUTES = Number(process.env.LP_SIM_FEE_STALL_MIN_AGE_MINUTES || 60);
export const LP_SIM_MONITOR_POLL_MS = Number(process.env.LP_SIM_MONITOR_POLL_MS || 15 * 60 * 1000);

export const JSON_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

export function validateConfig() {
  // Telegram is optional — Charon can run schedule-only (cron/pm2, no one
  // watching chat). Missing/broken Telegram config must never block startup
  // or interrupt the trading pipeline; see src/telegram/bot.js for the
  // safety wrapper that makes every bot.* call a non-throwing no-op/best-effort call.
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[config] TELEGRAM_BOT_TOKEN not set — running schedule-only, Telegram fully disabled.');
  } else if (!TELEGRAM_CHAT_ID) {
    console.warn('[config] TELEGRAM_CHAT_ID not set — Telegram sends will fail safely and be skipped.');
  }
  if (!HELIUS_API_KEY && (!process.env.SOLANA_RPC_URL || !process.env.SOLANA_WS_URL)) {
    throw new Error('HELIUS_API_KEY is required unless SOLANA_RPC_URL and SOLANA_WS_URL are set.');
  }
  if (GMGN_ENABLED && !GMGN_API_KEY) throw new Error('GMGN_API_KEY is required unless GMGN_ENABLED=false.');
}
