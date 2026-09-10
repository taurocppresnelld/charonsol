import { db } from '../db/connection.js';
import { now } from '../utils.js';

export function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}

export async function fetchSavedWalletExposure(mint, holders) {
  const wallets = savedWallets();
  if (!wallets.length || !holders?.holders?.length) {
    return { holderCount: 0, checked: wallets.length, wallets: [] };
  }
  const holderSet = new Set(holders.holders.map(h => h.address));
  const matched = wallets.filter(wallet => holderSet.has(wallet.address));
  return {
    holderCount: matched.length,
    checked: wallets.length,
    wallets: matched.map(w => w.label),
  };
}

export async function fetchWalletPnl(address) {
  try {
    const url = `https://datapi.jup.ag/v1/pnl?addresses=${encodeURIComponent(address)}&includeClosed=false`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.[address] ?? data?.data?.[address] ?? data;
    if (!d || typeof d !== 'object') return null;
    return {
      totalTrades: Number(d.totalTrades ?? d.total_trades ?? 0),
      wins: Number(d.wins ?? d.winCount ?? d.win_count ?? 0),
      winRate: Number(d.winRate ?? d.win_rate ?? 0),
      totalPnlPercent: Number(d.totalPnlPercent ?? d.total_pnl_percent ?? d.totalPnlUsd ?? 0),
    };
  } catch {
    return null;
  }
}
