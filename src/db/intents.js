import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';
import { numSetting } from './settings.js';

export function createTradeIntent(candidateId, candidate, decision, mode, status, side = 'buy') {
  const sizeSol = numSetting('dry_run_buy_sol', 0.1);
  const result = db.prepare(`
    INSERT INTO trade_intents (
      candidate_id, mint, mode, status, created_at_ms, updated_at_ms, side,
      size_sol, confidence, reason, llm_decision_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    candidate.token.mint,
    mode,
    status,
    now(),
    now(),
    side,
    sizeSol,
    decision.confidence,
    decision.reason,
    decision.id || null,
    json({ candidate, decision, mode, status }),
  );
  return Number(result.lastInsertRowid);
}

export function intentById(id) {
  const row = db.prepare('SELECT * FROM trade_intents WHERE id = ?').get(id);
  return row ? { ...row, payload: safeJson(row.payload_json, {}) } : null;
}
