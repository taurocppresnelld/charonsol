#!/usr/bin/env node
import { execSync } from 'child_process';

function selectBestPerCategory(filters) {
  const grouped = new Map();

  for (const filter of filters) {
    if (filter.pnl <= 0) continue;
    const cat = filter.category;
    if (!grouped.has(cat)) {
      grouped.set(cat, []);
    }
    grouped.get(cat).push(filter);
  }

  const selected = [];

  for (const [category, items] of grouped.entries()) {
    items.sort((a, b) => {
      if (b.pnl !== a.pnl) {
        return b.pnl - a.pnl;
      }
      return b.n - a.n;
    });

    selected.push(items[0]);
  }

  return selected;
}

function extractComboMembers(comboLabel) {
  const matches = comboLabel.match(/\(([^)]+)\)/g);
  if (!matches) return [];
  return matches.map(m => m.slice(1, -1).trim());
}

function comboHasAllMembers(comboLabel, selectedFilters) {
  const members = extractComboMembers(comboLabel);
  if (members.length === 0) return false;

  const selectedSet = new Set(selectedFilters.map(f => f.label));
  return members.every(member => selectedSet.has(member));
}

function mergeComboLabels(comboList) {
  if (!comboList || comboList.length === 0) return null;
  return comboList.map(c => `(${c.label})`).join(' OR ');
}

/**
 * Translates human-readable backtest filter expressions into JS code and DB settings.
 */
function translateFilterExpression(label) {
  if (!label) return { jsCode: null, dbSetting: null };

  let js = label;
  let db = label;

  // 1. Operator Replacements
  js = js.replace(/ AND /g, ' && ').replace(/ OR /g, ' || ');
  db = db.replace(/ AND /g, ',').replace(/ OR /g, '|');

  // 2. Pool-Level Filter Mapping
  const poolMappings = [
    { regex: /degen_score\s*>=\s*(\d+)/g, js: 'd.degen_score >= $1', db: 'degenScore>=$1' },
    { regex: /fee_a_tvl_ratio\s*>=\s*([\d.]+)/g, js: 'd.entry_fee_active_tvl_ratio >= $1', db: 'feeRatio>=$1' },
    { regex: /a_tvl\s*(\d+)K/g, js: (m, p1) => `d.entry_active_tvl <= ${Number(p1) * 1000}`, db: (m, p1) => `activeTvl<=${Number(p1) * 1000}` },
    { regex: /vol_window\s*>=\s*(\d+)K/g, js: (m, p1) => `d.entry_volume_window >= ${Number(p1) * 1000}`, db: (m, p1) => `volumeWindow>=${Number(p1) * 1000}` },
    { regex: /pools_found\s*>=\s*(\d+)/g, js: 'd.pools_found >= $1', db: 'poolsFound>=$1' },
    { regex: /bin_step\s*>\s*(\d+)/g, js: 'd.bin_step >= $1', db: 'binStep>=$1' }
  ];

  // 3. Token-Level Filter Mapping
  const tokenMappings = [
    { regex: /mcap\s*<\s*(\d+)K/g, js: (m, p1) => `d.ja_mcap <= ${Number(p1) * 1000}`, db: (m, p1) => `mcap<=${Number(p1) * 1000}` },
    { regex: /mcap\s*<\s*(\d+)M/g, js: (m, p1) => `d.ja_mcap <= ${Number(p1) * 1000000}`, db: (m, p1) => `mcap<=${Number(p1) * 1000000}` },
    { regex: /liq\s*>=\s*(\d+)K/g, js: (m, p1) => `d.me_liquidityUsd >= ${Number(p1) * 1000}`, db: (m, p1) => `liq>=${Number(p1) * 1000}` },
    { regex: /holders\s*>=\s*(\d+)/g, js: 'd.ho_count >= $1', db: 'ho>=$1' },
    { regex: /maxHolder\s*<\s*(\d+)%/g, js: 'd.ho_maxHolderPercent < $1', db: 'maxHolder<=$1' },
    { regex: /top20\s*<\s*(\d+)%/g, js: 'd.ho_top20Percent <= $1', db: 'top20<=$1' },
    { regex: /bondingCurve\s*>=\s*(\d+)/g, js: 'd.ja_bondingCurve >= $1', db: 'bondingCurve>=$1' },
    { regex: /organic\s*>=\s*(\d+)/g, js: 'd.ja_organicScore >= $1', db: 'organic>=$1' }
  ];

  const allMappings = [...poolMappings, ...tokenMappings];

  for (const map of allMappings) {
    if (typeof map.js === 'function') {
      js = js.replace(map.regex, map.js);
    } else {
      js = js.replace(map.regex, map.js);
    }

    if (typeof map.db === 'function') {
      db = db.replace(map.regex, map.db);
    } else {
      db = db.replace(map.regex, map.db);
    }
  }

  // Format JS thousand separators with underscore for readability
  js = js.replace(/\b(\d+000)\b/g, (m) => Number(m).toLocaleString('en-US').replace(/,/g, '_'));

  // Remove all parentheses from db-setting result
  db = db.replace(/[()]/g, '');

  return {
    jsCode: js.trim(),
    dbSetting: db.trim()
  };
}

function run() {
  try {
    const cmd = 'node scripts/backtest.js --combo-size 3 --min-n 50 --combo-op AND --json';
    const output = execSync(cmd, { encoding: 'utf-8' });
    const data = JSON.parse(output);

    const topPoolFilters = selectBestPerCategory(data.poolLevelFilters || []);
    const topTokenFilters = selectBestPerCategory(data.tokenLevelFilters || []);

    const topComboPoolFilters = (data.topCombosPoolLevel || [])
      .filter(c => c.pnl > 0 && comboHasAllMembers(c.label, topPoolFilters))
      .sort((a, b) => {
        if (b.pnl !== a.pnl) return b.pnl - a.pnl;
        return b.n - a.n;
      });

    const topComboTokenFilters = (data.topCombosTokenLevel || [])
      .filter(c => c.pnl > 0 && comboHasAllMembers(c.label, topTokenFilters))
      .sort((a, b) => {
        if (b.pnl !== a.pnl) return b.pnl - a.pnl;
        return b.n - a.n;
      });

    const mergeComboPoolFilters = mergeComboLabels(topComboPoolFilters);
    const mergeComboTokenFilters = mergeComboLabels(topComboTokenFilters);

    // Perform translation to JS code and DB setting
    const poolTranslation = translateFilterExpression(mergeComboPoolFilters);
    const tokenTranslation = translateFilterExpression(mergeComboTokenFilters);

    const result = {
      "top-pool-filters": topPoolFilters,
      "top-token-filters": topTokenFilters,
      "top-combo-pool-filters": topComboPoolFilters,
      "top-combo-token-filters": topComboTokenFilters,
      "merge-combo-pool-filters": mergeComboPoolFilters,
      "merge-combo-token-filters": mergeComboTokenFilters,
      "pool-filters-js-code": poolTranslation.jsCode,
      "pool-filters-db-setting": poolTranslation.dbSetting,
      "token-filters-js-code": tokenTranslation.jsCode,
      "token-filters-db-setting": tokenTranslation.dbSetting
    };

    console.log(JSON.stringify(result, null, 2));

  } catch (err) {
    console.error('Error running backtest:', err.message);
    process.exit(1);
  }
}

run();