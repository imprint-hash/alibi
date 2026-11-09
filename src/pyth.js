// Pyth data access.
// - Public, no key: symbol metadata (https://pyth.dourolabs.app/v1/symbols) and Hermes feed list.
// - Needs PYTH_API_KEY (free Pyth Terminal account at app.pyth.com) since the Aug 2026 Core upgrade:
//   Hermes prices/updates/stream and the History API (1-minute OHLC candles, raw prints with confidence).
// - Also reads anything src/record.js captured into data/.
import { secret } from './env.js';
import { fetchJson, HttpError } from './http.js';
import { path, readJson, writeJson, readJsonl } from './store.js';
import { parseSchedule, sessionForDay, tradingDays, zonedParts } from './sessions.js';

const PRO = 'https://pyth.dourolabs.app/v1';
const HERMES = 'https://hermes.pyth.network';
const SYMBOLS_CACHE = path('cache', 'pyth-symbols.json');
const COUNTER = path('results', 'pyth-calls.json');

export class PythAuthError extends Error {
  constructor(what, kind = 'key') {
    super(kind === 'entitlement'
      ? `feed not readable on this key (Pyth entitlement): ${what}`
      : `Pyth ${what} needs PYTH_API_KEY (Hermes and the History API require a key since the Aug 2026 Core upgrade; free account at app.pyth.com)`);
    this.code = kind === 'entitlement' ? 'PYTH_NOT_ENTITLED' : 'PYTH_KEY_REQUIRED';
  }
}

export const hasKey = () => !!secret('PYTH_API_KEY');
const auth = () => ({ authorization: `Bearer ${secret('PYTH_API_KEY')}` });
function count(k) { const c = readJson(COUNTER, {}); c[k] = (c[k] || 0) + 1; writeJson(COUNTER, c); }

async function authed(url, what) {
  if (!hasKey()) throw new PythAuthError(what);
  count(what);
  try {
    return await fetchJson(url, { headers: auth(), minGapMs: 400, retries: 3 });
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) throw new PythAuthError(`${what}: ${String(e.body).slice(0, 120)}`, 'entitlement');
    if (e instanceof HttpError && e.status === 401) throw new PythAuthError(`${what} (key rejected: HTTP 401)`);
    throw e;
  }
}

/** All Pyth symbols (public). Cached for 12h. */
export async function symbols({ refresh = false } = {}) {
  const c = readJson(SYMBOLS_CACHE, null);
  if (!refresh && c && Date.now() - c.at < 12 * 3600e3) return c.symbols;
  count('symbols');
  const list = await fetchJson(`${PRO}/symbols`, { timeoutMs: 30000 });
  writeJson(SYMBOLS_CACHE, { at: Date.now(), symbols: list });
  return list;
}

const MONTHS = { JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12 };

/** Parses "PYTH PRICE IN USD FOR WTI CRUDE 19 NOVEMBER 2026" → '2026-11-19' (the contract's last trading day). */
export function lastTradingDayFromDescription(desc) {
  const m = String(desc).match(/(\d{1,2})\s+(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(\d{4})/i);
  if (!m) return null;
  return `${m[3]}-${String(MONTHS[m[2].toUpperCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Dated contracts for a Pyth code like "CLL" (WTI on ICE) or "BRENT". */
export function contractsFromSymbols(list, code) {
  const re = new RegExp(`^Commodities\\.${code}[FGHJKMNQUVXZ]\\d/USD$`);
  return list
    .filter((s) => re.test(s.symbol))
    .map((s) => ({ symbol: s.symbol, lazerId: s.pyth_lazer_id, hermesId: s.hermes_id, state: s.state, description: s.description, lastTradingDay: lastTradingDayFromDescription(s.description), schedule: s.schedule, exponent: s.exponent, channel: s.min_channel || 'real_time' }))
    .filter((c) => c.lastTradingDay)
    .sort((a, b) => a.lastTradingDay.localeCompare(b.lastTradingDay));
}

/**
 * Active Month per the Polymarket rule: nearest listed contract, except during its final `rollSessions`
 * trading sessions, when the next contract becomes active. `dayStr` is the trading day (YYYY-MM-DD).
 */
export function activeContract(contracts, dayStr, rollSessions = 3) {
  for (let i = 0; i < contracts.length; i++) {
    const c = contracts[i];
    if (c.lastTradingDay < dayStr) continue;
    const sched = parseSchedule(c.schedule);
    // trading days from dayStr through LTD inclusive; if dayStr is within the final N, roll.
    const left = tradingDays(sched, dayStr, c.lastTradingDay);
    if (left.length > rollSessions) return { contract: c, next: contracts[i + 1] || null, sessionsLeft: left.length };
  }
  return { contract: null, next: null, sessionsLeft: 0 };
}

/** A single spot feed (metals, FX) by symbol. */
export function feedBySymbol(list, symbol) {
  const s = list.find((x) => x.symbol === symbol);
  if (!s) return null;
  return { symbol: s.symbol, lazerId: s.pyth_lazer_id, hermesId: s.hermes_id, state: s.state, description: s.description, schedule: s.schedule, exponent: s.exponent, channel: s.min_channel || 'real_time', spot: true };
}

/** Non-contract companions used as references (index feeds). */
export function indexFeeds(list, symbolsWanted) {
  return symbolsWanted.map((w) => list.find((s) => s.symbol === w)).filter(Boolean).map((s) => ({ symbol: s.symbol, lazerId: s.pyth_lazer_id, hermesId: s.hermes_id, state: s.state, schedule: s.schedule, description: s.description }));
}

/** 1-minute (or other) OHLC candles from the History API. Returns [{t,o,h,l,c,v}] with t in seconds. */
export async function candles(symbol, fromSec, toSec, resolution = '1', channel = 'real_time') {
  const out = [];
  // one call per <=1 day keeps replies small
  for (let s = fromSec; s <= toSec; s += 86400) {
    const e = Math.min(toSec, s + 86400 - 1);
    const u = `${PRO}/${channel}/history?symbol=${encodeURIComponent(symbol)}&from=${s}&to=${e}&resolution=${resolution}`;
    const r = await authed(u, 'history');
    if (r.s === 'ok' && Array.isArray(r.t)) r.t.forEach((t, i) => out.push({ t, o: r.o[i], h: r.h[i], l: r.l[i], c: r.c[i], v: r.v?.[i] ?? 0 }));
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.t) ? false : seen.add(c.t))).sort((a, b) => a.t - b.t);
}

/** Raw prints (price, confidence, publish time) for <=60s windows. Returns [{t, price, conf, publishTime}] (seconds). */
export async function printsRange(lazerId, startSec, endSec, channel = 'real_time', { everySec = 60 } = {}) {
  const out = [];
  for (let s = startSec; s < endSec; s += Math.max(60, everySec)) {
    const e = Math.min(endSec, s + 59);
    let after = '';
    for (let page = 0; page < 5; page++) {
      const u = `${PRO}/${channel}/price/range?ids=${lazerId}&start_timestamp=${s * 1e6}&end_timestamp=${e * 1e6}&limit=1000${after ? `&after=${after}` : ''}`;
      const r = await authed(u, 'price-range');
      for (const d of r.data || []) {
        const k = 10 ** d.exponent;
        out.push({ t: d.publish_time / 1e6, price: d.price * k, conf: d.confidence * k, publishTime: d.publish_time / 1e6, publishers: d.publisher_count ?? null, bid: d.best_bid_price != null ? d.best_bid_price * k : null, ask: d.best_ask_price != null ? d.best_ask_price * k : null, session: d.market_session ?? null });
      }
      if (!r.next) break;
      after = r.next;
    }
  }
  return out;
}

/** Latest price from Hermes (needs key). */
export async function latest(hermesIds) {
  const q = hermesIds.map((id) => `ids[]=${id}`).join('&');
  const r = await authed(`${HERMES}/v2/updates/price/latest?${q}&parsed=true`, 'hermes-latest');
  return (r.parsed || []).map((p) => ({
    id: p.id,
    price: Number(p.price.price) * 10 ** p.price.expo,
    conf: Number(p.price.conf) * 10 ** p.price.expo,
    publishTime: p.price.publish_time,
  }));
}

/** Candles and prints captured locally by src/record.js. */
export function recorded(symbol, fromSec, toSec) {
  const safe = symbol.replace(/[^A-Za-z0-9]+/g, '_');
  const prints = readJsonl(path('data', `pyth-${safe}.jsonl`)).filter((p) => p.t >= fromSec && p.t <= toSec);
  return { prints, candles: printsToCandles(prints) };
}

/** Builds 1-minute OHLC from prints. */
export function printsToCandles(prints) {
  const by = new Map();
  for (const p of prints) {
    const t = Math.floor(p.t / 60) * 60;
    const c = by.get(t);
    if (!c) by.set(t, { t, o: p.price, h: p.price, l: p.price, c: p.price, v: 1 });
    else { c.h = Math.max(c.h, p.price); c.l = Math.min(c.l, p.price); c.c = p.price; c.v++; }
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

/**
 * Loads the settlement series for a contract and window: History API when a key exists, else local recording.
 * Never throws for missing access; returns { candles, prints, source, error }.
 */
export async function settlementSeries(contract, fromSec, toSec, { withPrints = false, sampleEverySec = 3600, denseFrom = null, denseTo = null, isOpen = null } = {}) {
  const res = { candles: [], prints: [], source: null, error: null, channel: contract.channel || 'real_time' };
  if (hasKey()) {
    try {
      res.candles = await candles(contract.symbol, fromSec, toSec, '1', res.channel);
      res.source = `pyth-history-api (${res.channel})`;
      if (withPrints) {
        // sampled 60s windows across the data (only while open), plus a dense block near the end/settlement
        const starts = [];
        for (let t = Math.floor(fromSec / 60) * 60; t < toSec - 60; t += sampleEverySec) if (!isOpen || isOpen(t)) starts.push(t);
        const dF = denseFrom ?? Math.max(fromSec, toSec - 10 * 60), dT = denseTo ?? toSec;
        for (let t = Math.floor(dF / 60) * 60; t < dT; t += 60) if (!isOpen || isOpen(t)) starts.push(t);
        for (const t of [...new Set(starts)].sort((a, b) => a - b)) res.prints.push(...(await printsRange(contract.lazerId, t, t + 59, res.channel)));
        res.printsSampling = { windows: new Set(starts).size, everySec: sampleEverySec };
      }
      return res;
    } catch (e) {
      res.error = e.message;
    }
  } else {
    res.error = new PythAuthError('history').message;
  }
  const rec = recorded(contract.symbol, fromSec, toSec);
  if (rec.candles.length) {
    res.candles = rec.candles;
    res.prints = rec.prints;
    res.source = 'local-recording (Hermes stream)';
  }
  return res;
}

/** Session close (UTC ms) of a trading day for a contract. */
export function sessionClose(contract, dayStr) {
  const s = sessionForDay(parseSchedule(contract.schedule), dayStr);
  return s ? s.close : null;
}

export { zonedParts };
