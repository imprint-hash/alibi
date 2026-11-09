// Independent references for the same instrument and window.
// Hyperliquid trade candles are free; neighbouring Pyth contract months and Pyth index feeds need PYTH_API_KEY.
import { fetchJson } from './http.js';
import { path, readJsonl } from './store.js';
import * as pyth from './pyth.js';
import { PYTH_CODES } from './rules.js';

const HL = 'https://api.hyperliquid.xyz/info';

/** Hyperliquid 1m candles, chunked (the API caps one reply near 5000 bars). t in seconds. */
export async function hyperliquidCandles(coin, fromSec, toSec, interval = '1m') {
  const out = [];
  const iv = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 }[interval] || 60;
  const step = 4000 * iv;
  for (let s = fromSec; s < toSec; s += step) {
    const e = Math.min(toSec, s + step);
    const r = await fetchJson(HL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime: s * 1000, endTime: e * 1000 } }),
      minGapMs: 300,
    });
    for (const c of r || []) out.push({ t: Math.floor(c.t / 1000), o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v, n: c.n });
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.t) ? false : seen.add(c.t))).sort((a, b) => a.t - b.t);
}

/** Recorded HL candles from src/record.js (used when the window is older than the API keeps). */
export function recordedHyperliquid(coin, fromSec, toSec) {
  return readJsonl(path('data', `hl-${coin.replace(/[^A-Za-z0-9]+/g, '_')}.jsonl`)).filter((c) => c.t >= fromSec && c.t <= toSec);
}

/** Current Hyperliquid context (mark, oracle, mid) for a coin on the xyz dex. */
export async function hyperliquidContext(coin) {
  const dex = coin.includes(':') ? coin.split(':')[0] : '';
  const [meta, ctxs] = await fetchJson(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs', dex }), minGapMs: 300 });
  const i = meta.universe.findIndex((u) => u.name === coin);
  if (i < 0) return null;
  const c = ctxs[i];
  return { coin, markPx: +c.markPx, oraclePx: +c.oraclePx, midPx: +c.midPx, prevDayPx: +c.prevDayPx, dayNtlVlm: +c.dayNtlVlm, at: Math.floor(Date.now() / 1000) };
}

/**
 * Gathers every reference we can for this spec/window. Never throws for one missing source; records why.
 * Returns [{ name, kind, independent, candles, note, error }].
 */
export async function references(spec, active, fromSec, toSec, symbolsList) {
  const map = PYTH_CODES[spec.pythCode];
  const out = [];
  if (map?.hlCoin) {
    const ref = { name: `Hyperliquid ${map.hlCoin}${map.hlThin ? ' (thin: ~$2M/day)' : ''}`, kind: 'hyperliquid', independent: true, thin: !!map.hlThin, candles: [], note: `Perp traded on Hyperliquid (trade.xyz dex); trades 24/7. Alibi compares after removing the recent basis.${map.hlThin ? ' Thin reference: low volume, so its prices carry less weight as evidence.' : ''}`, error: null };
    try {
      ref.candles = await hyperliquidCandles(map.hlCoin, fromSec, toSec);
      if (!ref.candles.length) ref.candles = recordedHyperliquid(map.hlCoin, fromSec, toSec);
    } catch (e) {
      ref.error = e.message;
      ref.candles = recordedHyperliquid(map.hlCoin, fromSec, toSec);
    }
    out.push(ref);
  }
  // Neighbouring Pyth contract and index feeds: same publisher network, so "independent: false".
  const pythRefs = [];
  if (active?.next) pythRefs.push({ symbol: active.next.symbol, kind: 'pyth-next-month', note: 'Next contract month on Pyth; spreads move slowly, so a one-sided jump in the settlement contract stands out.' });
  for (const s of map?.indexFeeds || []) pythRefs.push({ symbol: s, kind: 'pyth-index', note: 'Pyth constant-maturity index for the same crude grade.' });
  for (const p of pythRefs) {
    const ref = { name: `Pyth ${p.symbol}`, kind: p.kind, independent: false, candles: [], note: p.note, error: null };
    if (!pyth.hasKey()) { ref.error = 'needs PYTH_API_KEY'; ref.candles = pyth.recorded(p.symbol, fromSec, toSec).candles; }
    else {
      try { ref.candles = await pyth.candles(p.symbol, fromSec, toSec, '1'); } catch (e) { ref.error = e.message; }
    }
    out.push(ref);
  }
  return out;
}
