// Polymarket market lookup via the public gamma API.
import { fetchJson } from './http.js';

const GAMMA = 'https://gamma-api.polymarket.com';

/** Accepts a polymarket.com URL (event or market) or a bare slug. */
export function parseMarketRef(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('empty market reference');
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    // /event/<event-slug>[/<market-slug>] or /market/<slug>
    const i = parts.findIndex((p) => p === 'event' || p === 'market');
    if (i < 0 || !parts[i + 1]) throw new Error('unrecognised Polymarket URL');
    if (parts[i] === 'market') return { marketSlug: parts[i + 1] };
    return { eventSlug: parts[i + 1], marketSlug: parts[i + 2] };
  }
  return { marketSlug: s };
}

const parseList = (v) => { try { return Array.isArray(v) ? v : JSON.parse(v || '[]'); } catch { return []; } };

export function normaliseMarket(m) {
  const outcomes = parseList(m.outcomes);
  const prices = parseList(m.outcomePrices).map(Number);
  return {
    id: m.id,
    slug: m.slug,
    question: m.question,
    rules: m.description || '',
    resolutionSource: m.resolutionSource || '',
    startDate: m.startDate,
    endDate: m.endDate,
    eventStartTime: m.eventStartTime || null,
    closed: !!m.closed,
    active: !!m.active,
    outcomes: outcomes.map((name, i) => ({ name, price: prices[i] ?? null })),
    bestBid: m.bestBid ?? null,
    bestAsk: m.bestAsk ?? null,
    lastTradePrice: m.lastTradePrice ?? null,
    volume: Number(m.volume || m.volumeNum || 0),
    threshold: m.groupItemThreshold != null ? Number(m.groupItemThreshold) : null,
    conditionId: m.conditionId,
    eventSlug: m.events?.[0]?.slug || null,
    url: m.events?.[0]?.slug ? `https://polymarket.com/event/${m.events[0].slug}/${m.slug}` : `https://polymarket.com/market/${m.slug}`,
    fetchedAt: new Date().toISOString(),
  };
}

export async function getMarketBySlug(slug) {
  const r = await fetchJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`, { minGapMs: 250 });
  if (!Array.isArray(r) || !r.length) return null;
  return normaliseMarket(r[0]);
}

export async function getEvent(slug) {
  const r = await fetchJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, { minGapMs: 250 });
  return Array.isArray(r) && r.length ? r[0] : null;
}

/** Resolves URL or slug to one market. For an event URL with several markets, returns the first plus siblings. */
export async function getMarket(input) {
  const ref = parseMarketRef(input);
  if (ref.marketSlug) {
    const m = await getMarketBySlug(ref.marketSlug);
    if (m) return m;
  }
  const evSlug = ref.eventSlug || ref.marketSlug;
  const ev = await getEvent(evSlug);
  if (!ev || !ev.markets?.length) throw new Error(`no Polymarket market found for "${input}"`);
  const open = ev.markets.filter((m) => !m.closed);
  const m = normaliseMarket({ ...(open[0] || ev.markets[0]), events: [ev] });
  m.siblings = ev.markets.map((x) => x.slug);
  return m;
}

/** Search active markets; used to find Pyth-settled ones. */
export async function search(q, limit = 10) {
  const r = await fetchJson(`${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=${limit}&events_status=active`, { minGapMs: 250 });
  const out = [];
  for (const e of r.events || []) for (const m of e.markets || []) out.push({ slug: m.slug, question: m.question, endDate: m.endDate, eventSlug: e.slug, closed: m.closed });
  return out;
}
