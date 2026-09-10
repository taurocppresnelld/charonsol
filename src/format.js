export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function short(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function fmtSol(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : '?';
}

export function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '?';
}

export function gmgnLink(mint) {
  return `https://gmgn.ai/sol/token/${mint}`;
}

export function txLink(signature) {
  return `https://solscan.io/tx/${signature}`;
}

export function accountLink(address) {
  return `https://solscan.io/account/${address}`;
}
