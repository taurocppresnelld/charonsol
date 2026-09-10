// One-shot test run: hits every poll-based signal source exactly once, lets whatever
// candidates surface flow through the real screening pipeline (charon token filter ->
// meridian pool screening -> lp_candidates), then prints a summary and exits.
//
// Usage:
//   node scripts/test-cycle.js              # trenches + graduated + trending (+ pregrad,
//                                            # + server signals, if enabled/configured)
//   node scripts/test-cycle.js --with-ws     # also opens pumpportal + fee-claim
//                                            # websockets for 20s to catch live events
//
// This does NOT start any interval/setInterval polling or keep the process alive on its
// own — unlike `npm start`, it runs each source's fetch function once and exits.

import { setDefaultResultOrder } from 'node:dns';
import { validateConfig, SIGNAL_SERVER_URL, PREGRAD_ENABLED, PUMPPORTAL_API_KEY, PUMPPORTAL_ENABLED, MERIDIAN_TOKENS_ENABLED, LP_SIM_ENABLED } from '../src/config.js';
import { initDb, db } from '../src/db/connection.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from '../src/pipeline/lpOrchestrator.js';

setDefaultResultOrder('ipv4first');
validateConfig();
initDb();

const withWs = process.argv.includes('--with-ws');
const WS_WINDOW_MS = 20_000;

const before = {
  candidates: db.prepare('SELECT COUNT(*) n FROM candidates').get().n,
  lpCandidates: db.prepare('SELECT COUNT(*) n FROM lp_candidates').get().n,
};

async function runOnce(label, fn) {
  process.stdout.write(`→ ${label}... `);
  try {
    await fn();
    console.log('ok');
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
}

async function main() {
  console.log(`[test-cycle] starting single-pass screening run${withWs ? ' (with 20s websocket window)' : ''}\n`);

  const { fetchTrenches, setCandidateHandler: setTrenchesHandler } = await import('../src/signals/trenches.js');
  setTrenchesHandler(processCandidateFromSignals);
  await runOnce('trenches (GMGN)', fetchTrenches);

  const { fetchGraduatedCoins } = await import('../src/signals/graduated.js');
  await runOnce('graduated coins', fetchGraduatedCoins);

  const { fetchGmgnTrending, setTrendingCandidateHandler, setDegenHandler } = await import('../src/signals/trending.js');
  setTrendingCandidateHandler(processCandidateFromSignals);
  setDegenHandler(maybeProcessDegenCandidate);
  await runOnce('trending (Jupiter/GMGN)', fetchGmgnTrending);

  if (MERIDIAN_TOKENS_ENABLED) {
    const { fetchMeridianRankedTokens, setCandidateHandler: setMeridianTokensHandler } = await import('../src/signals/meridianTokens.js');
    setMeridianTokensHandler(processCandidateFromSignals);
    await runOnce('meridian token source (GMGN rank, Meteora-confirmed)', fetchMeridianRankedTokens);
  }

  if (PREGRAD_ENABLED) {
    const { fetchPregradTokens, setCandidateHandler: setPregradHandler } = await import('../src/signals/pumpfunPregrad.js');
    setPregradHandler(processCandidateFromSignals);
    await runOnce('pre-graduation scanner', fetchPregradTokens);
  }

  if (SIGNAL_SERVER_URL) {
    const { fetchServerSignals, setCandidateHandler, setDegenHandler: setServerDegenHandler } = await import('../src/signals/serverClient.js');
    setCandidateHandler(processCandidateFromSignals);
    setServerDegenHandler(maybeProcessDegenCandidate);
    await runOnce('signal server (fee-claim/smart-money)', fetchServerSignals);
  } else {
    console.log('  (skipping signal server — SIGNAL_SERVER_URL not set)');
  }

  if (LP_SIM_ENABLED) {
    const { monitorOpenSimPositions } = await import('../src/pipeline/lpSimulator.js');
    await runOnce('lp simulation monitor (existing open positions)', monitorOpenSimPositions);
  }

  if (withWs) {
    console.log(`\n[test-cycle] opening websocket sources for ${WS_WINDOW_MS / 1000}s...`);

    const { startWebsocket, setCandidateHandler: setFeeClaimHandler } = await import('../src/signals/feeClaim.js');
    setFeeClaimHandler(processCandidateFromSignals);
    startWebsocket();

    if (PUMPPORTAL_API_KEY && PUMPPORTAL_ENABLED) {
      const { startPumpportal, setCandidateHandler: setPumpportalHandler } = await import('../src/signals/pumpportal.js');
      setPumpportalHandler(processCandidateFromSignals);
      startPumpportal();
    } else {
      console.log('  (skipping pumpportal — no PUMPPORTAL_API_KEY / disabled)');
    }

    await new Promise((resolve) => setTimeout(resolve, WS_WINDOW_MS));
  } else {
    console.log('\n[test-cycle] skipping pumpportal + fee-claim websockets (pass --with-ws to include them)');
  }

  const after = {
    candidates: db.prepare('SELECT COUNT(*) n FROM candidates').get().n,
    lpCandidates: db.prepare('SELECT COUNT(*) n FROM lp_candidates').get().n,
  };
  const lpPassed = db.prepare('SELECT COUNT(*) n FROM lp_candidates WHERE pool_screen_passed = 1').get().n;

  console.log(`
[test-cycle] done.
  token candidates:     +${after.candidates - before.candidates} (${after.candidates} total)
  sent to pool screen:  +${after.lpCandidates - before.lpCandidates} (${after.lpCandidates} total)
  passed pool screen:   ${lpPassed} total (all-time)

  Inspect results with:
    node scripts/cli.js stats
    node scripts/cli.js lp-candidates --passed
`);

  process.exit(0);
}

main().catch((err) => {
  console.error('[test-cycle] fatal:', err);
  process.exit(1);
});
