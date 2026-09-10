import axios from 'axios';

const RUGCHECK_API = 'https://api.rugcheck.xyz/v1/tokens';
const rugcheckCache = new Map();
const CACHE_TTL_MS = 15_000; // 15 second cache

function toNumOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function checkRugScore(mint) {
  const cached = rugcheckCache.get(mint);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const res = await axios.get(`${RUGCHECK_API}/${mint}/report/summary`, { timeout: 5000 });
    const risks = res.data?.risks || [];
    const data = {
      score: toNumOrNull(res.data?.score),
      scoreNormalised: toNumOrNull(res.data?.score_normalised),
      lpLockedPct: toNumOrNull(res.data?.lpLockedPct),
      risks,
      hasCriticalRisk: risks.some(r => r.level === 'danger' || r.level === 'critical'),
      at: Date.now(),
    };
    rugcheckCache.set(mint, data);
    return data;
  } catch (err) {
    console.log(`[rugcheck] ${mint.slice(0, 8)}... error: ${err.message}`);
    const data = { error: true, message: err.message, at: Date.now() };
    rugcheckCache.set(mint, data);
    return data;
  }
}

export function isRugRisk(scoreData) {
  if (!scoreData) return true;
  if (scoreData.error) return true;
  if (scoreData.score == null || scoreData.scoreNormalised == null) return true;
  if (scoreData.scoreNormalised > 500) return true;
  if (scoreData.hasCriticalRisk) return true;
  return false;
}
