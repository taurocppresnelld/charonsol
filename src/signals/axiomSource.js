import axios from 'axios';

export const axiom = new Map();

export async function fetchAxiomTrending(timePeriod = '1h') {
  try {
    const timestamp = Date.now();
    const url = `https://api8.axiom.trade/new-trending-v2?timePeriod=${encodeURIComponent(timePeriod)}&v=${timestamp}`;
    const headers = {
      accept: '*/*',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      origin: 'https://axiom.trade',
      referer: 'https://axiom.trade/',
    };
    const cfClearance = process.env.AXIOM_CF_CLEARANCE;
    if (cfClearance) {
      headers.cookie = `cf_clearance=${cfClearance}`;
    }

    const res = await axios.get(url, { timeout: 15_000, headers });
    const raw = Array.isArray(res.data) ? res.data : [];
    const seenAt = Date.now();

    const rows = raw.map(entry => {
      if (!Array.isArray(entry)) return null;
      const mint = entry[1];
      if (!mint) return null;
      return {
        address: mint,
        name: entry[2] || '',
        symbol: entry[3] || '',
        platform: entry[7] || null,
        createdAt: entry[9] || null,
        totalSupply: Number(entry[18] ?? 0),
        holder_count: Number(entry[22] ?? 0),
        volume: Number(entry[23] ?? 0),
        price: Number(entry[29] ?? 0),
        market_cap: 0,
        liquidity: 0,
        swaps: 0,
        buys: 0,
        sells: 0,
        top_10_holder_rate: null,
        rug_ratio: null,
        bundler_rate: null,
        hot_level: 0,
        smart_degen_count: 0,
        source: 'axiom_trending',
        interval: timePeriod,
        rank: 0,
        seenAt,
      };
    }).filter(Boolean);

    rows.forEach((row, index) => {
      row.rank = index + 1;
      axiom.set(row.address, row);
    });

    const cutoff = seenAt - 10 * 60 * 1000;
    for (const [mint, token] of axiom) {
      if (Number(token.seenAt || 0) < cutoff) axiom.delete(mint);
    }

    console.log(`[axiom] loaded ${rows.length}, tracking ${axiom.size}`);
    return rows;
  } catch (err) {
    console.log(`[axiom] ${err.response?.status || ''} ${err.message}`);
    return [];
  }
}
