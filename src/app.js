import { setDefaultResultOrder } from 'node:dns';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, PUMPPORTAL_API_KEY, PUMPPORTAL_ENABLED, PREGRAD_ENABLED, TRENDING_POLL_MS, MERIDIAN_TOKENS_ENABLED, MERIDIAN_TOKENS_POLL_MS, LP_SIM_ENABLED, LP_SIM_MONITOR_POLL_MS, validateConfig } from './config.js';
import { initDb } from './db/connection.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from './pipeline/lpOrchestrator.js';
import { sendTelegram } from './telegram/send.js';
import { makeFailureTracker, guardCycle } from './utils.js';
import { pruneOldRows } from './db/retention.js';
import { numSetting } from './db/settings.js';

setDefaultResultOrder('ipv4first');
validateConfig();

export async function startCharonsol() {
  initDb();

  if (SIGNAL_SERVER_URL) {
    // ── Server mode: fetch fee/smart-money signals from charon's signal server ──────────
    const { fetchServerSignals, setCandidateHandler, setDegenHandler } = await import('./signals/serverClient.js');

    setCandidateHandler(processCandidateFromSignals);
    setDegenHandler(maybeProcessDegenCandidate);

    const alert = (msg) => sendTelegram(msg);
    const trackServer = makeFailureTracker('server signals', alert);
    const trackDip = makeFailureTracker('dip monitor', alert);

    const runServerCycle = guardCycle('server', () => trackServer(() => fetchServerSignals()));
    await runServerCycle();
    setInterval(runServerCycle, SIGNAL_POLL_MS);

    const { fetchTrenches, setCandidateHandler: setTrenchesHandler } = await import('./signals/trenches.js');
    setTrenchesHandler(processCandidateFromSignals);
    const trackTrenches = makeFailureTracker('gmgn trenches', alert);
    const runTrenchesCycle = guardCycle('trenches', () => trackTrenches(() => fetchTrenches()));
    await runTrenchesCycle();
    setInterval(runTrenchesCycle, numSetting('trenches_poll_ms', 60_000));

    const { monitorPriceAlerts, cleanupAlerts, setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
    setAlertHandler(processCandidateFromSignals);
    const runDipCycle = guardCycle('dip-monitor', () => trackDip(() => monitorPriceAlerts()));
    setInterval(runDipCycle, numSetting('dip_alert_poll_ms', 10_000));
    setInterval(() => cleanupAlerts(), numSetting('alert_cleanup_interval_ms', 60 * 60 * 1000));

    console.log(`[bot] ${APP_NAME} started (server mode: ${SIGNAL_SERVER_URL})`);
  } else {
    // ── Trenches-only mode: direct polling of GMGN trenches, no signal server key needed ──
    const { fetchTrenches, setCandidateHandler } = await import('./signals/trenches.js');
    setCandidateHandler(processCandidateFromSignals);
    const runTrenchesCycle = guardCycle('trenches', () => fetchTrenches().catch(error => console.log(`[trenches] ${error.message}`)));
    await runTrenchesCycle();
    setInterval(runTrenchesCycle, numSetting('trenches_poll_ms', 60_000));
    console.log(`[bot] ${APP_NAME} started (trenches-only mode)`);
  }

  // Graduation polling — runs in both modes
  const { startGraduationPolling, fetchGraduatedCoins } = await import('./signals/graduated.js');
  const trackGraduation = makeFailureTracker('graduation poll', (msg) => sendTelegram(msg));
  const runGraduationCycle = guardCycle('graduated', () => trackGraduation(() => fetchGraduatedCoins()));
  runGraduationCycle();
  setInterval(runGraduationCycle, numSetting('graduation_poll_ms', 60_000));
  startGraduationPolling();

  // Trending polling — runs in both modes
  const { fetchGmgnTrending, setTrendingCandidateHandler, setDegenHandler } = await import('./signals/trending.js');
  setTrendingCandidateHandler(processCandidateFromSignals);
  setDegenHandler(maybeProcessDegenCandidate);
  const trackTrending = makeFailureTracker('trending poll', (msg) => sendTelegram(msg));
  const runTrendingCycle = guardCycle('trending', () => trackTrending(() => fetchGmgnTrending()));
  runTrendingCycle();
  setInterval(runTrendingCycle, TRENDING_POLL_MS);

  // Meridian-style token source — runs in both modes. Broad GMGN market-rank, no
  // pump.fun-suffix restriction, pre-filtered to tokens with a confirmed Meteora pool.
  // See src/signals/meridianTokens.js for why this exists alongside the pump.fun-only sources.
  if (MERIDIAN_TOKENS_ENABLED) {
    const { fetchMeridianRankedTokens, setCandidateHandler: setMeridianTokensHandler } = await import('./signals/meridianTokens.js');
    setMeridianTokensHandler(processCandidateFromSignals);
    const trackMeridianTokens = makeFailureTracker('meridian token source', (msg) => sendTelegram(msg));
    const runMeridianTokensCycle = guardCycle('meridian-tokens', () => trackMeridianTokens(() => fetchMeridianRankedTokens()));
    runMeridianTokensCycle();
    setInterval(runMeridianTokensCycle, numSetting('meridian_tokens_poll_ms', MERIDIAN_TOKENS_POLL_MS));
  }

  // Phase 2: dry-run LP fee-yield simulation monitor — re-snapshots every open
  // lp_sim_positions row and applies exit rules. See src/pipeline/lpSimulator.js.
  if (LP_SIM_ENABLED) {
    const { monitorOpenSimPositions } = await import('./pipeline/lpSimulator.js');
    const trackLpSim = makeFailureTracker('lp simulation monitor', (msg) => sendTelegram(msg));
    // Most at-risk cycle in this project for the overlap this guards against: it makes
    // one Meteora call PER open position, sequentially — a real log showed 600+ open
    // positions at once, which comfortably exceeds the default 15min interval under any
    // Meteora backoff at all.
    const runLpSimCycle = guardCycle('lp-sim', () => trackLpSim(() => monitorOpenSimPositions()));
    setTimeout(runLpSimCycle, 30_000); // let the first screening pass find something before the first sweep
    setInterval(runLpSimCycle, numSetting('lp_sim_monitor_poll_ms', LP_SIM_MONITOR_POLL_MS));
  }

  // Fee-claim signals — WebSocket, runs in both modes
  {
    const { startWebsocket, setCandidateHandler: setFeeClaimHandler } = await import('./signals/feeClaim.js');
    setFeeClaimHandler(processCandidateFromSignals);
    startWebsocket();
  }

  if (PREGRAD_ENABLED) {
    const { startPumpfunPregrad, setCandidateHandler: setPregradHandler } = await import('./signals/pumpfunPregrad.js');
    setPregradHandler(processCandidateFromSignals);
    const trackPregrad = makeFailureTracker('pumpfun pregrad', (msg) => sendTelegram(msg));
    startPumpfunPregrad(trackPregrad);
  }

  if (PUMPPORTAL_API_KEY && PUMPPORTAL_ENABLED) {
    const { startPumpportal, setCandidateHandler: setPumpportalHandler } = await import('./signals/pumpportal.js');
    setPumpportalHandler(processCandidateFromSignals);
    startPumpportal();
  }

  // Queue stats snapshot — same pattern as charon, useful for watching enrichment throughput.
  {
    const { getJupiterQueueStats } = await import('./enrichment/jupiter.js');
    const { getGmgnQueueStats } = await import('./enrichment/gmgn.js');
    const { getMeteoraQueueStats } = await import('./enrichment/meteora.js');
    const { db } = await import('./db/connection.js');
    const writeStmt = db.prepare(`
      INSERT INTO queue_stats (queue_name, stats_json, updated_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(queue_name) DO UPDATE SET stats_json = excluded.stats_json, updated_at_ms = excluded.updated_at_ms
    `);
    const writeQueueStats = () => {
      try {
        const ts = Date.now();
        writeStmt.run('jupiter', JSON.stringify(getJupiterQueueStats()), ts);
        writeStmt.run('gmgn', JSON.stringify(getGmgnQueueStats()), ts);
        writeStmt.run('meteora', JSON.stringify(getMeteoraQueueStats()), ts);
      } catch (err) {
        console.log(`[queue-stats] snapshot write failed: ${err.message}`);
      }
    };
    writeQueueStats();
    setInterval(writeQueueStats, numSetting('queue_stats_snapshot_interval_ms', 15_000));
  }

  // DB retention — prunes telemetry tables on a rolling window (src/db/retention.js).
  setTimeout(() => {
    try {
      const result = pruneOldRows();
      const totalDeleted = Object.values(result).reduce((sum, n) => sum + n, 0);
      if (totalDeleted > 0) console.log(`[retention] pruned ${totalDeleted} old row(s): ${JSON.stringify(result)}`);
    } catch (err) {
      console.log(`[retention] prune failed (non-fatal): ${err.message}`);
    }
  }, 60_000);
  setInterval(() => {
    try {
      const result = pruneOldRows();
      const totalDeleted = Object.values(result).reduce((sum, n) => sum + n, 0);
      if (totalDeleted > 0) console.log(`[retention] pruned ${totalDeleted} old row(s): ${JSON.stringify(result)}`);
    } catch (err) {
      console.log(`[retention] prune failed (non-fatal): ${err.message}`);
    }
  }, numSetting('retention_prune_interval_ms', 6 * 60 * 60 * 1000));
}
