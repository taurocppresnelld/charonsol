#!/usr/bin/env node
// ── Charonsol backtest (Updated with Score Column, IL, Side-by-Side & Route Breakdown) ──
import { initDb, db } from '../src/db/connection.js';
import { safeJson } from '../src/utils.js';

initDb();

const SORT_KEY_LABELS = {
  score: 'Filter Score (Composite Rank, default)',
  net_pnl_delta: 'ΔNetPnL% (Fees + IL)',
  net_pnl: 'raw avgNetPnL%',
  yield_delta: 'ΔYield% (Fee Yield only)',
  yield: 'raw avgYield%',
  il_delta: 'ΔIL% (Impermanent Loss delta)',
  nonzero: 'nonZero% (fraction that earned any fee)',
  tvl_drained_delta: 'ΔtvlDrained% (ascending — lower is better)',
  n: 'raw N',
  pct_keep: '% of baseline kept',
  yield_tvl_ratio: 'avgYield% per tvlDrained% point',
};

function parseArgs(argv) {
  const isJson = argv.includes('--json');
  const daysIdx = argv.indexOf('--days');
  const sinceIdx = argv.indexOf('--since');
  if (daysIdx !== -1 && sinceIdx !== -1) {
    if (!isJson) console.log('--days and --since are mutually exclusive.');
    process.exit(1);
  }
  let sinceMs = null;
  if (daysIdx !== -1) {
    const days = Number(argv[daysIdx + 1]);
    if (!Number.isFinite(days)) {
      if (!isJson) console.log('--days needs a number, e.g. --days 7');
      process.exit(1);
    }
    sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  } else if (sinceIdx !== -1) {
    const d = new Date(argv[sinceIdx + 1]);
    if (Number.isNaN(d.getTime())) {
      if (!isJson) console.log('--since needs YYYY-MM-DD');
      process.exit(1);
    }
    sinceMs = d.getTime();
  }

  const comboIdx = argv.indexOf('--combo-size');
  const comboSize = comboIdx !== -1 ? Number(argv[comboIdx + 1]) : 2;

  const sortIdx = argv.indexOf('--sort-by');
  const sortBy = sortIdx !== -1 
    ? argv[sortIdx + 1].split(',').map(s => s.trim()).filter(Boolean) 
    : ['score'];

  const topIdx = argv.indexOf('--top');
  const top = topIdx !== -1 ? Number(argv[topIdx + 1]) : null;

  const minNIdx = argv.indexOf('--min-n');
  const minN = minNIdx !== -1 ? Number(argv[minNIdx + 1]) : null;

  const opIdx = argv.indexOf('--combo-op');
  const comboOp = opIdx !== -1 ? argv[opIdx + 1].toUpperCase() : 'BOTH';

  return { sinceMs, comboSize, sortBy, top, minN, comboOp, isJson };
}

function extract(row) {
  const candidate = safeJson(row.candidate_json, {})?.candidate ?? safeJson(row.candidate_json, {});
  const ja = candidate?.jupiterAsset || {};
  const ho = candidate?.holders || {};
  const me = candidate?.metrics || {};
  const si = candidate?.signals || {};
  const route = (row.signal_key || '').split(':')[0] || 'unknown';

  const notional = row.notional_usd || 0;
  const realizedFee = row.realized_fee_usd ?? 0;
  const ilUsd = row.il_usd ?? 0;
  const netPnlUsd = row.net_pnl_usd ?? (realizedFee + ilUsd);

  const yieldPct = notional > 0 ? (realizedFee / notional) * 100 : 0;
  const ilPct = notional > 0 ? (ilUsd / notional) * 100 : 0;
  const netPnlPct = notional > 0 ? (netPnlUsd / notional) * 100 : 0;

  const holdMs = row.hold_ms || 0;
  const holdDays = holdMs / (24 * 60 * 60 * 1000);
  const annualizedYieldPct = holdMs >= 60 * 60 * 1000 ? yieldPct * (365 / holdDays) : null;

  return {
    yield_pct: yieldPct,
    il_pct: ilPct,
    net_pnl_pct: netPnlPct,
    annualized_yield_pct: annualizedYieldPct,
    realized_fee_usd: realizedFee,
    il_usd: ilUsd,
    net_pnl_usd: netPnlUsd,
    close_reason: row.close_reason || '',
    hold_min: holdMs / 60_000,
    route,
    degen_score: row.entry_degen_score ?? 0,
    entry_fee_active_tvl_ratio: row.entry_fee_active_tvl_ratio ?? 0,
    entry_active_tvl: row.entry_active_tvl ?? 0,
    entry_volume_window: row.entry_volume_window ?? 0,
    pools_found: row.pools_found ?? 0,
    bin_step: row.bin_step ?? 0,
    ja_bondingCurve: ja.bondingCurve || 0,
    ja_liquidity: ja.liquidity || 0,
    ja_mcap: ja.mcap || 0,
    ja_organicScore: ja.organicScore || 0,
    ho_count: ho.count || 0,
    ho_maxHolderPercent: ho.maxHolderPercent || 0,
    ho_top20Percent: ho.top20Percent || 0,
    me_gmgnTotalFeesSol: me.gmgnTotalFeesSol || 0,
    me_liquidityUsd: me.liquidityUsd || 0,
    me_trendingVolumeUsd: me.trendingVolumeUsd || 0,
    me_marketCapUsd: me.marketCapUsd || 0,
    si_hasTrending: si.hasTrending ? 1 : 0,
  };
}

function analyze(subset) {
  const n = subset.length;
  if (n === 0) return null;
  const nonZero = subset.filter(d => d.realized_fee_usd > 1e-6).length;
  const avgYieldPct = subset.reduce((s, d) => s + d.yield_pct, 0) / n;
  const avgIlPct = subset.reduce((s, d) => s + d.il_pct, 0) / n;
  const avgNetPnlPct = subset.reduce((s, d) => s + d.net_pnl_pct, 0) / n;

  const annualizable = subset.filter(d => d.annualized_yield_pct != null);
  const avgAnnualizedYieldPct = annualizable.length
    ? annualizable.reduce((s, d) => s + d.annualized_yield_pct, 0) / annualizable.length
    : null;

  const avgHoldMin = subset.reduce((s, d) => s + d.hold_min, 0) / n;
  const tvlDrainedPct = subset.filter(d => d.close_reason === 'tvl_drained').length / n * 100;
  const yieldPerTvlDrain = tvlDrainedPct > 0 ? avgYieldPct / tvlDrainedPct : (avgYieldPct > 0 ? Infinity : 0);

  return { 
    n, 
    nAnnualizable: annualizable.length, 
    nonZeroPct: nonZero / n * 100, 
    avgYieldPct, 
    avgIlPct, 
    avgNetPnlPct, 
    avgAnnualizedYieldPct, 
    avgHoldMin, 
    tvlDrainedPct, 
    yieldPerTvlDrain 
  };
}

function computeScore(r, baseline) {
  const netPnlDelta = r.avgNetPnlPct - baseline.avgNetPnlPct;
  const pctKeep = (r.n / baseline.n) * 100;
  const samplePenalty = r.n < 30 ? 10 * (1 - (r.n / 30)) : 0;
  const score = (netPnlDelta * 0.6) + (pctKeep * 0.05) - samplePenalty;
  return Number(score.toFixed(3));
}

const fmtApy = (v) => v == null ? 'n/a' : `${v.toFixed(1)}%`;

const POOL_FILTERS = [
  ['mix', 'pool-mix', d => ((d.bin_step >= 90) && (d.entry_fee_active_tvl_ratio >= 1.0) && (d.entry_volume_window >= 100_000)) || ((d.bin_step >= 90) && (d.pools_found >= 2) && (d.entry_volume_window >= 100_000)) || ((d.entry_fee_active_tvl_ratio >= 1.0) && (d.pools_found >= 2) && (d.entry_volume_window >= 100_000)) || ((d.bin_step >= 90) && (d.entry_fee_active_tvl_ratio >= 1.0) && (d.pools_found >= 2))],
  ['degen_score', 'degen_score >= 15', d => d.degen_score >= 15],
  ['degen_score', 'degen_score >= 30', d => d.degen_score >= 30],
  ['degen_score', 'degen_score >= 50', d => d.degen_score >= 50],
  ['degen_score', 'degen_score >= 70', d => d.degen_score >= 70],
  ['degen_score', 'degen_score >= 85', d => d.degen_score >= 85],
  ['fee_ratio', 'fee_a_tvl_ratio >= 0.3', d => d.entry_fee_active_tvl_ratio >= 0.3],
  ['fee_ratio', 'fee_a_tvl_ratio >= 0.5', d => d.entry_fee_active_tvl_ratio >= 0.5],
  ['fee_ratio', 'fee_a_tvl_ratio >= 0.7', d => d.entry_fee_active_tvl_ratio >= 0.7],
  ['fee_ratio', 'fee_a_tvl_ratio >= 1.0', d => d.entry_fee_active_tvl_ratio >= 1.0],
  ['active_tvl', 'a_tvl 10K', d => d.entry_active_tvl <= 10_000],
  ['active_tvl', 'a_tvl 50K', d => d.entry_active_tvl <= 50_000],
  ['active_tvl', 'a_tvl 100K', d => d.entry_active_tvl <= 100_000],
  ['active_tvl', 'a_tvl 150K', d => d.entry_active_tvl <= 150_000],
  ['active_tvl', 'a_tvl 500K', d => d.entry_active_tvl >= 500_000],
  ['volume', 'vol_window >= 5K', d => d.entry_volume_window >= 5_000],
  ['volume', 'vol_window >= 20K', d => d.entry_volume_window >= 20_000],
  ['volume', 'vol_window >= 50K', d => d.entry_volume_window >= 50_000],
  ['volume', 'vol_window >= 100K', d => d.entry_volume_window >= 100_000],
  ['pools_found', 'pools_found >= 1', d => d.pools_found >= 1],
  ['pools_found', 'pools_found >= 2', d => d.pools_found >= 2],
  ['pools_found', 'pools_found >= 5', d => d.pools_found >= 5],
  ['pools_found', 'pools_found >= 10', d => d.pools_found >= 10],
  ['bin_step', 'bin_step > 10', d => d.bin_step >= 10],
  ['bin_step', 'bin_step > 30', d => d.bin_step >= 30],
  ['bin_step', 'bin_step > 50', d => d.bin_step >= 50],
  ['bin_step', 'bin_step > 70', d => d.bin_step >= 70],
  ['bin_step', 'bin_step > 90', d => d.bin_step >= 90],
];

const TOKEN_FILTERS = [
  ['mix', 'token-mix', d => ((d.me_liquidityUsd >= 20_000) && (d.ho_maxHolderPercent < 20) && (d.ja_organicScore >= 70)) || ((d.me_liquidityUsd >= 20_000) && (d.ho_maxHolderPercent < 20) && (d.ja_mcap <= 5_000_000)) || ((d.me_liquidityUsd >= 20_000) && (d.ja_mcap <= 5_000_000) && (d.ja_organicScore >= 70)) || ((d.ho_maxHolderPercent < 20) && (d.ja_mcap <= 5_000_000) && (d.ja_organicScore >= 70)) || ((d.ho_count >= 50) && (d.me_liquidityUsd >= 20_000) && (d.ho_maxHolderPercent < 20)) || ((d.ho_count >= 50) && (d.me_liquidityUsd >= 20_000) && (d.ja_mcap <= 5_000_000)) || ((d.ja_bondingCurve >= 60) && (d.me_liquidityUsd >= 20_000) && (d.ja_mcap <= 5_000_000)) || ((d.ho_count >= 50) && (d.me_liquidityUsd >= 20_000) && (d.ja_organicScore >= 70)) || ((d.ho_count >= 50) && (d.ho_maxHolderPercent < 20) && (d.ja_organicScore >= 70)) || ((d.ja_bondingCurve >= 60) && (d.ja_mcap <= 5_000_000) && (d.ja_organicScore >= 70)) || ((d.ja_bondingCurve >= 60) && (d.ho_count >= 50) && (d.ja_mcap <= 5_000_000)) || ((d.ho_count >= 50) && (d.ho_maxHolderPercent < 20) && (d.ja_mcap <= 5_000_000)) || ((d.ho_count >= 50) && (d.ja_mcap <= 5_000_000) && (d.ja_organicScore >= 70)) || ((d.ja_bondingCurve >= 60) && (d.ho_maxHolderPercent < 20) && (d.ja_mcap <= 5_000_000)) || ((d.ja_bondingCurve >= 60) && (d.me_liquidityUsd >= 20_000) && (d.ja_organicScore >= 70)) || ((d.ja_bondingCurve >= 60) && (d.ho_count >= 50) && (d.me_liquidityUsd >= 20_000)) || ((d.ja_bondingCurve >= 60) && (d.me_liquidityUsd >= 20_000) && (d.ho_maxHolderPercent < 20)) || ((d.ja_bondingCurve >= 60) && (d.ho_maxHolderPercent < 20) && (d.ja_organicScore >= 70)) || ((d.ja_bondingCurve >= 60) && (d.ho_count >= 50) && (d.ja_organicScore >= 70)) || ((d.ja_bondingCurve >= 60) && (d.ho_count >= 50) && (d.ho_maxHolderPercent < 20))],
  ['mcap', 'mcap < 100K', d => d.ja_mcap <= 100_000],
  ['mcap', 'mcap < 250K', d => d.ja_mcap <= 250_000],
  ['mcap', 'mcap < 500K', d => d.ja_mcap <= 500_000],
  ['mcap', 'mcap < 2M', d => d.ja_mcap <= 2_000_000],
  ['mcap', 'mcap < 5M', d => d.ja_mcap <= 5_000_000],
  ['liq', 'liq >= 5K', d => d.me_liquidityUsd >= 5_000],
  ['liq', 'liq >= 10K', d => d.me_liquidityUsd >= 10_000],
  ['liq', 'liq >= 15K', d => d.me_liquidityUsd >= 15_000],
  ['liq', 'liq >= 20K', d => d.me_liquidityUsd >= 20_000],
  ['ho', 'holders >= 50', d => d.ho_count >= 50],
  ['ho', 'holders >= 100', d => d.ho_count >= 100],
  ['ho', 'holders >= 150', d => d.ho_count >= 150],
  ['maxHolder', 'maxHolder < 30%', d => d.ho_maxHolderPercent < 30],
  ['maxHolder', 'maxHolder < 20%', d => d.ho_maxHolderPercent < 20],
  ['maxHolder', 'maxHolder < 15%', d => d.ho_maxHolderPercent < 15],
  ['top20', 'top20 < 30%', d => d.ho_top20Percent <= 30],
  ['top20', 'top20 < 20%', d => d.ho_top20Percent <= 20],
  ['top20', 'top20 < 15%', d => d.ho_top20Percent <= 15],
  ['bondingCurve', 'bondingCurve >= 60', d => d.ja_bondingCurve >= 60],
  ['bondingCurve', 'bondingCurve >= 70', d => d.ja_bondingCurve >= 70],
  ['bondingCurve', 'bondingCurve >= 85', d => d.ja_bondingCurve >= 85],
  ['organic', 'organic >= 30', d => d.ja_organicScore >= 30],
  ['organic', 'organic >= 50', d => d.ja_organicScore >= 50],
  ['organic', 'organic >= 70', d => d.ja_organicScore >= 70],
];

const ROUTE_FILTERS = [
  ['route', 'route: meridian_gmgn_rank', d => d.route === 'meridian_gmgn_rank'],
  ['route', 'route: pumpportal_graduated', d => d.route === 'pumpportal_graduated'],
  ['route', 'route: pumpfun_pregrad', d => d.route === 'pumpfun_pregrad'],
  ['route', 'route: trending', d => d.route === 'trending'],
  ['route', 'route: graduated_trending', d => d.route === 'graduated_trending'],
  ['route', 'route: trenches_* (any kind)', d => d.route.startsWith('trenches_')],
  ['route', 'route: dual_source', d => d.route === 'dual_source'],
  ['route', 'route: multi_source', d => d.route === 'multi_source'],
  ['route', 'route: single_source', d => d.route === 'single_source'],
  ['route', 'route: fee_graduated_trending', d => d.route === 'fee_graduated_trending'],
  ['route', 'route: fee_graduated', d => d.route === 'fee_graduated'],
  ['route', 'route: fee_trending', d => d.route === 'fee_trending'],
];

const ASCENDING_SORT_KEYS = new Set(['tvl_drained_delta']);
function sortKeyFns(baseline) {
  return {
    score: r => r.score,
    net_pnl_delta: r => r.netPnlDelta,
    net_pnl: r => r.avgNetPnlPct,
    yield_delta: r => r.yieldDelta,
    yield: r => r.avgYieldPct,
    il_delta: r => r.ilDelta,
    nonzero: r => r.nonZeroPct,
    tvl_drained_delta: r => r.tvlDrainedPct - baseline.tvlDrainedPct,
    n: r => r.n,
    pct_keep: r => r.pctKeep,
    yield_tvl_ratio: r => r.yieldPerTvlDrain,
  };
}

function compareByKeys(a, b, sortByList, baseline) {
  const fns = sortKeyFns(baseline);
  for (const sortBy of sortByList) {
    const fn = fns[sortBy];
    const av = fn(a), bv = fn(b);
    if (av === bv) continue;
    const ascending = ASCENDING_SORT_KEYS.has(sortBy);
    return ascending ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
  }
  return 0;
}

function sortResults(results, sortByList, baseline) {
  results.sort((a, b) => compareByKeys(a, b, sortByList, baseline));
}

function rankSingles(filterList, data, baseline, sortBy) {
  const results = filterList.map(([category, label, fn]) => {
    const subset = data.filter(fn);
    const r = analyze(subset);
    if (!r) return null;
    const res = { 
      category, 
      label, 
      fn, 
      ...r, 
      netPnlDelta: r.avgNetPnlPct - baseline.avgNetPnlPct,
      yieldDelta: r.avgYieldPct - baseline.avgYieldPct, 
      ilDelta: r.avgIlPct - baseline.avgIlPct,
      pctKeep: r.n / baseline.n * 100 
    };
    res.score = computeScore(res, baseline);
    return res;
  }).filter(Boolean);
  sortResults(results, sortBy, baseline);
  return results;
}

function printSingles(title, results, sortBy, top) {
  const limit = top ?? 30;
  console.log(`\n=== ${title} ===`);
  console.log(`Sorted by: ${sortBy.map(k => `${k} (${SORT_KEY_LABELS[k]})`).join(', then ')}`);
  console.log(
    `${'Filter'.padEnd(36)} | ${'Score'.padStart(6)} | ${'N'.padStart(4)} | ${'nonZero%'.padStart(8)} | ` +
    `${'avgNetPnL%'.padStart(10)} | ${'ΔNetPnL%'.padStart(9)} | ${'avgYield%'.padStart(9)} | ${'%keep'.padStart(5)}`
  );
  console.log('-'.repeat(110));
  for (const r of results.slice(0, limit)) {
    console.log(
      `${r.label.padEnd(36)} | ${r.score.toFixed(3).padStart(6)} | ${String(r.n).padStart(4)} | ${r.nonZeroPct.toFixed(1).padStart(7)}% | ` +
      `${r.avgNetPnlPct.toFixed(3).padStart(9)}% | ` +
      `${(r.netPnlDelta >= 0 ? '+' : '') + r.netPnlDelta.toFixed(3)}%`.padStart(10) + ` | ` +
      `${r.avgYieldPct.toFixed(3).padStart(8)}% | ${r.pctKeep.toFixed(0).padStart(4)}%`
    );
  }
}

function generateCombos(filterList, comboSize, data, baseline, sortBy, groupLabel, minN, comboOp = 'BOTH') {
  const byCategory = new Map();
  for (const [category, label, fn] of filterList) {
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push([label, fn]);
  }
  const categories = Array.from(byCategory.keys()).sort();
  if (comboSize > categories.length) return [];

  const opDefs = {
    AND: fns => d => fns.every(f => f(d)),
    OR: fns => d => fns.some(f => f(d)),
  };
  const activeOps = comboOp === 'BOTH' ? ['AND', 'OR'] : [comboOp];

  const catCombinations = combinations(categories, comboSize);
  const comboResults = [];
  for (const catTuple of catCombinations) {
    const filterLists = catTuple.map(c => byCategory.get(c));
    for (const combo of cartesianProduct(filterLists)) {
      const labels = combo.map(pair => pair[0]);
      const fns = combo.map(pair => pair[1]);
      for (const opName of activeOps) {
        const combine = opDefs[opName](fns);
        const subset = data.filter(combine);
        const r = analyze(subset);
        if (!r || (minN != null && r.n < minN)) continue;
        const label = labels.map(l => `(${l})`).join(` ${opName} `);
        const res = { 
          label, 
          fn: combine, 
          op: opName, 
          ...r, 
          netPnlDelta: r.avgNetPnlPct - baseline.avgNetPnlPct,
          yieldDelta: r.avgYieldPct - baseline.avgYieldPct, 
          ilDelta: r.avgIlPct - baseline.avgIlPct,
          pctKeep: r.n / baseline.n * 100 
        };
        res.score = computeScore(res, baseline);
        comboResults.push(res);
      }
    }
  }
  sortResults(comboResults, sortBy, baseline);
  return comboResults;
}

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

function cartesianProduct(arrays) {
  return arrays.reduce((acc, arr) => acc.flatMap(a => arr.map(b => [...a, b])), [[]]);
}

function printCombos(title, comboResults, comboSize, sortBy, top) {
  const limit = top ?? 20;
  console.log(`\n=== TOP ${comboSize}-FILTER COMBOS: ${title} — ${comboResults.length} combo(s) ===`);
  console.log(`Sorted by: ${sortBy.map(k => `${k} (${SORT_KEY_LABELS[k]})`).join(', then ')}`);
  console.log(
    `${'Combo'.padEnd(64)} | ${'Score'.padStart(6)} | ${'N'.padStart(4)} | ${'nonZero%'.padStart(8)} | ` +
    `${'avgNetPnL%'.padStart(10)} | ${'ΔNetPnL%'.padStart(9)} | ${'avgYield%'.padStart(9)} | ${'%keep'.padStart(5)}`
  );
  console.log('-'.repeat(138));
  for (const r of comboResults.slice(0, limit)) {
    console.log(
      `${r.label.padEnd(64)} | ${r.score.toFixed(3).padStart(6)} | ${String(r.n).padStart(4)} | ${r.nonZeroPct.toFixed(1).padStart(7)}% | ` +
      `${r.avgNetPnlPct.toFixed(3).padStart(9)}% | ` +
      `${(r.netPnlDelta >= 0 ? '+' : '') + r.netPnlDelta.toFixed(3)}%`.padStart(10) + ` | ` +
      `${r.avgYieldPct.toFixed(3).padStart(8)}% | ${r.pctKeep.toFixed(0).padStart(4)}%`
    );
  }
}

function printSideBySide(groupLabel, singles, combos, sortByList, baseline) {
  if (!singles.length || !combos.length) return;
  const s = singles[0];
  const c = combos[0];
  const comboBetter = compareByKeys(c, s, sortByList, baseline) < 0;
  const primaryFn = sortKeyFns(baseline)[sortByList[0]];
  const sVal = primaryFn(s), cVal = primaryFn(c);
  const fmtVal = (v) => v === Infinity ? '∞' : v.toFixed(3);
  const sortLabel = sortByList.join(', ');
  console.log(`\n=== SIDE-BY-SIDE (${groupLabel}): top single filter vs. top combo, sorted by ${sortLabel} ===`);
  console.log(`  Top SINGLE : ${s.label.padEnd(42)} | Score ${s.score.toFixed(3)} | ΔNetPnL% ${(s.netPnlDelta >= 0 ? '+' : '') + s.netPnlDelta.toFixed(3)} | n=${s.n} (${s.pctKeep.toFixed(0)}% kept)`);
  console.log(`  Top COMBO  : ${c.label.padEnd(70)} | Score ${c.score.toFixed(3)} | ΔNetPnL% ${(c.netPnlDelta >= 0 ? '+' : '') + c.netPnlDelta.toFixed(3)} | n=${c.n} (${c.pctKeep.toFixed(0)}% kept)`);
  if (comboBetter) {
    console.log(`  -> The top combo ranks ahead of the top single filter on ${sortLabel} (primary key ${sortByList[0]}: ${fmtVal(cVal)} vs ${fmtVal(sVal)}).`);
  } else {
    console.log(`  -> The top single filter still ranks ahead of every ${groupLabel} combo tested on ${sortLabel}`);
    console.log(`     (primary key ${sortByList[0]}: ${fmtVal(sVal)} vs ${fmtVal(cVal)}) — combining signals didn't find anything better than`);
    console.log(`     acting on the strongest one alone here.`);
  }
}

function printRouteBreakdown(label, fn, data) {
  const subset = data.filter(fn);
  const byRoute = new Map();
  for (const d of subset) {
    if (!byRoute.has(d.route)) byRoute.set(d.route, []);
    byRoute.get(d.route).push(d);
  }
  const top = analyze(subset);
  console.log(`\n  [${label}] — ${top.n} positions, ${top.avgNetPnlPct.toFixed(3)}% avg Net PnL (${top.avgYieldPct.toFixed(3)}% yield, ${fmtApy(top.avgAnnualizedYieldPct)} APY, n=${top.nAnnualizable})`);
  Array.from(byRoute.entries())
    .map(([route, ds]) => [route, analyze(ds)])
    .sort((a, b) => b[1].avgNetPnlPct - a[1].avgNetPnlPct)
    .forEach(([route, r]) => {
      console.log(`    ${route.padEnd(28)} | ${String(r.n).padStart(4)} positions | ${r.avgNetPnlPct.toFixed(3).padStart(7)}% avg Net PnL | ${r.avgYieldPct.toFixed(3).padStart(7)}% yield | ${fmtApy(r.avgAnnualizedYieldPct)} APY`);
    });
}

function main() {
  const { sinceMs, comboSize, sortBy, top, minN, comboOp, isJson } = parseArgs(process.argv.slice(2));

  const timeClause = sinceMs != null ? 'AND s.closed_at_ms >= ?' : '';
  const params = sinceMs != null ? [sinceMs] : [];
  const rows = db.prepare(`
    SELECT s.notional_usd, s.realized_fee_usd, s.il_usd, s.net_pnl_usd,
           s.close_reason, s.hold_ms,
           s.entry_degen_score, s.entry_fee_active_tvl_ratio, s.entry_active_tvl,
           s.entry_volume_window, s.bin_step,
           lc.pools_found,
           c.signal_key, c.candidate_json
    FROM lp_sim_positions s
    JOIN lp_candidates lc ON lc.id = s.lp_candidate_id
    LEFT JOIN candidates c ON c.id = lc.candidate_id
    WHERE s.status = 'closed' ${timeClause}
    ORDER BY s.closed_at_ms
  `).all(...params);

  const data = rows.map(extract);
  if (data.length < 10) {
    if (isJson) console.log(JSON.stringify({ error: "Insufficient positions", count: data.length }));
    else console.log(`Only ${data.length} closed position(s) — need at least 10 for backtesting.`);
    process.exit(0);
  }

  const baseline = analyze(data);

  const poolSingles = rankSingles(POOL_FILTERS, data, baseline, sortBy);
  const tokenSingles = rankSingles(TOKEN_FILTERS, data, baseline, sortBy);
  const routeSingles = rankSingles(ROUTE_FILTERS, data, baseline, sortBy);

  const poolCombos = generateCombos(POOL_FILTERS, comboSize, data, baseline, sortBy, 'POOL-LEVEL', minN, comboOp);
  const tokenCombos = generateCombos(TOKEN_FILTERS, comboSize, data, baseline, sortBy, 'TOKEN-LEVEL', minN, comboOp);

  if (isJson) {
    const stripFn = (list) => list.map(({ fn, ...rest }) => ({
      ...rest,
      pnl: rest.netPnlDelta,
      score: rest.score
    }));

    console.log(JSON.stringify({
      baseline,
      poolLevelFilters: stripFn(poolSingles),
      tokenLevelFilters: stripFn(tokenSingles),
      topCombosPoolLevel: stripFn(poolCombos),
      topCombosTokenLevel: stripFn(tokenCombos)
    }, null, 2));
  } else {
    console.log(`\nBASELINE: ${baseline.n} pos | Net PnL: ${baseline.avgNetPnlPct.toFixed(2)}% | Fee Yield: ${baseline.avgYieldPct.toFixed(2)}% | IL: ${baseline.avgIlPct.toFixed(2)}%`);

    printSingles('POOL-LEVEL FILTERS', poolSingles, sortBy, top);
    printSingles('TOKEN-LEVEL FILTERS', tokenSingles, sortBy, top);
    printSingles('BY SOURCE', routeSingles, sortBy, top);

    printCombos('POOL-LEVEL', poolCombos, comboSize, sortBy, top);
    printCombos('TOKEN-LEVEL', tokenCombos, comboSize, sortBy, top);

    printSideBySide('POOL-LEVEL', poolSingles, poolCombos, sortBy, baseline);
    printSideBySide('TOKEN-LEVEL', tokenSingles, tokenCombos, sortBy, baseline);

    console.log(`\n--- Per-route breakdown of the top single-filter pick in each group ---`);
    if (poolSingles[0]) printRouteBreakdown(`POOL: ${poolSingles[0].label}`, poolSingles[0].fn, data);
    if (tokenSingles[0]) printRouteBreakdown(`TOKEN: ${tokenSingles[0].label}`, tokenSingles[0].fn, data);
  }
}

main();