import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';
import { numSetting } from './settings.js';

export function storeDecision(candidateId, candidate, decision) {
  const result = db.prepare(`
    INSERT INTO llm_decisions (candidate_id, mint, created_at_ms, verdict, confidence, reason, risks_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    candidate.token.mint,
    now(),
    decision.verdict,
    decision.confidence,
    decision.reason || null,
    json(decision.risks || []),
    json(decision),
  );
  
  // FIX #1: Cache WATCH/PASS decisions to prevent redundant LLM calls
  if (decision.verdict === 'WATCH' || decision.verdict === 'PASS') {
    const cacheTtlMs = decision.verdict === 'PASS' ? 60 * 60 * 1000 : 10 * 60 * 1000; // PASS=60min, WATCH=10min
    const nowMs = now();
    db.prepare(`
      INSERT OR REPLACE INTO decision_cache 
      (mint, verdict, confidence, reason, route, created_at_ms, expires_at_ms, mcap_snapshot, holders_snapshot, liq_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.token.mint,
      decision.verdict,
      decision.confidence,
      decision.reason || null,
      candidate.signals?.route || null,
      nowMs,
      nowMs + cacheTtlMs,
      candidate.metrics?.marketCapUsd || null,
      candidate.metrics?.holderCount || null,
      candidate.metrics?.liquidityUsd || null,
    );
  }
  
  return Number(result.lastInsertRowid);
}

export function storeBatchDecision(triggerCandidateId, rows, batchDecision) {
  const selectedRow = batchDecision.selected_row;
  const result = db.prepare(`
    INSERT INTO llm_batches (created_at_ms, trigger_candidate_id, selected_candidate_id, selected_mint, verdict, confidence, reason, risks_json, raw_json, candidate_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now(),
    triggerCandidateId,
    selectedRow?.id || null,
    selectedRow?.candidate?.token?.mint || null,
    batchDecision.verdict,
    batchDecision.confidence,
    batchDecision.reason || null,
    json(batchDecision.risks || []),
    json(batchDecision),
    json(rows.map(row => row.id)),
  );
  return Number(result.lastInsertRowid);
}

export function batchById(batchId) {
  const batch = db.prepare('SELECT * FROM llm_batches WHERE id = ?').get(batchId);
  if (!batch) return null;
  const candidateIds = safeJson(batch.candidate_ids_json, []);
  const rows = candidateIds.map(id => {
    const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
    return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
  }).filter(Boolean);
  return { ...batch, rows };
}

/**
 * Check decision cache for a given mint. Returns cached decision if:
 * 1. Cache entry exists and not expired
 * 2. Market conditions haven't changed significantly (mcap <20%, holders <30%)
 */
export function checkDecisionCache(mint, currentMcap = null, currentHolders = null) {
  const cached = db.prepare(`
    SELECT * FROM decision_cache 
    WHERE mint = ? AND expires_at_ms > ?
    LIMIT 1
  `).get(mint, now());
  
  if (!cached) return null;
  
  // Check if market conditions changed significantly
  if (currentMcap && cached.mcap_snapshot) {
    const mcapChange = Math.abs((currentMcap - cached.mcap_snapshot) / cached.mcap_snapshot);
    if (mcapChange > 0.20) {
      // Mcap changed >20% — invalidate cache
      return null;
    }
  }
  
  if (currentHolders && cached.holders_snapshot) {
    const holderChange = Math.abs((currentHolders - cached.holders_snapshot) / cached.holders_snapshot);
    if (holderChange > 0.30) {
      // Holders changed >30% — invalidate cache
      return null;
    }
  }
  
  return {
    verdict: cached.verdict,
    confidence: cached.confidence,
    reason: cached.reason,
    route: cached.route,
    cachedAt: cached.created_at_ms,
    expiresAt: cached.expires_at_ms,
  };
}

/**
 * Prune expired cache entries (maintenance, can be called periodically)
 */
export function pruneExpiredCache() {
  const result = db.prepare('DELETE FROM decision_cache WHERE expires_at_ms < ?').run(now());
  return result.changes;
}

export function logDecisionEvent({
  batchId = null,
  triggerCandidateId = null,
  selectedRow = null,
  rows = [],
  decision = {},
  mode = 'dry_run',
  action,
  guardrails = {},
  execution = {},
}) {
  const selectedCandidate = selectedRow?.candidate || null;
  const strategyId = selectedCandidate?.filters?.strategy
    || rows.find(row => row?.candidate?.filters?.strategy)?.candidate?.filters?.strategy
    || null;
  db.prepare(`
    INSERT INTO decision_logs (
      at_ms, batch_id, trigger_candidate_id, selected_candidate_id, selected_mint,
      mode, action, verdict, confidence, reason, guardrails_json, token_json,
      candidate_json, batch_json, execution_json, strategy_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now(),
    batchId,
    triggerCandidateId,
    selectedRow?.id || null,
    selectedCandidate?.token?.mint || decision.selected_mint || null,
    mode,
    action,
    decision.verdict || null,
    decision.confidence ?? null,
    decision.reason || null,
    json(guardrails),
    json(selectedCandidate?.token || null),
    json(selectedCandidate || null),
    json(rows.map(row => {
      if (!row) return null;
      const c = row.candidate;
      return {
        candidateId: row.id,
        mint: c.token?.mint,
        route: c.signals?.route,
        signals: c.signals,
        token: c.token,
        metrics: c.metrics,
        feeClaim: c.feeClaim,
        trending: c.trending,
        holders: {
          count: c.holders?.count,
          top20Percent: c.holders?.top20Percent,
          maxHolderPercent: c.holders?.maxHolderPercent,
          top20: c.holders?.top20,
        },
        chart: c.chart,
        savedWalletExposure: c.savedWalletExposure,
        twitterNarrative: c.twitterNarrative,
        filters: c.filters,
        createdAtMs: c.createdAtMs,
      };
    })),
    json(execution),
    strategyId,
  );
}
