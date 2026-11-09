// "TRY" chips: real, currently open Polymarket markets that settle on Pyth gold, silver and EUR/USD.
// Looks them up on Polymarket's public gamma API by their daily/weekly slug pattern; falls back to known slugs.
const GAMMA = 'https://gamma-api.polymarket.com';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];


function etDate(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, wd: p.weekday };
}
const daySlug = (prefix, { y, m, d }) => `${prefix}-up-or-down-on-${MONTHS[m - 1]}-${d}-${y}`;

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'alibi-web/0.1' } }); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
}
// Open = not closed and its end time still ahead (after 22:00 UTC today's daily market is over, so try tomorrow's).
const stillOpen = (m) => m && !m.closed && (!m.endDate || Date.parse(m.endDate) > Date.now());
async function openMarket(slug) {
  const r = await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  const m = Array.isArray(r) ? r[0] : null;
  return stillOpen(m) ? m : null;
}
const urlOf = (m) => (m.events?.[0]?.slug ? `https://polymarket.com/event/${m.events[0].slug}/${m.slug}` : `https://polymarket.com/market/${m.slug}`);

async function firstOpenDaily(prefix) {
  const now = Date.now();
  for (const off of [0, 1, 2, 3, 4]) {
    const m = await openMarket(daySlug(prefix, etDate(now + off * 86400000)));
    if (m) return m;
  }
  return null;
}

async function silverWeek() {
  // Weekly "What will Silver hit" event, keyed by that week's Monday (ET). Pick the most undecided line.
  const now = Date.now();
  for (const back of [0, 1, 2, 3, 4, 5, 6, -1, -2, -3, -4, -5, -6, -7]) { // this week's Monday, else next week's
    const dt = etDate(now - back * 86400000);
    if (dt.wd !== 'Mon') continue;
    const ev = await getJson(`${GAMMA}/events?slug=will-xagusd-hit-week-of-${MONTHS[dt.m - 1]}-${dt.d}-${dt.y}`);
    const markets = (Array.isArray(ev) && ev[0]?.markets || []).filter(stillOpen);
    if (!markets.length) continue;
    const mid = (m) => { try { return Math.abs(Number(JSON.parse(m.outcomePrices)[0]) - 0.5); } catch { return 1; } };
    markets.sort((a, b) => mid(a) - mid(b));
    return { ...markets[0], events: ev };
  }
  return null;
}

let memo = null;
export async function samples() {
  if (memo && Date.now() - memo.at < 30 * 60 * 1000) return memo.value;
  const [gold, silverW, silverD, eur] = await Promise.all([firstOpenDaily('xauusd'), silverWeek(), firstOpenDaily('xagusd'), firstOpenDaily('eurusd')]);
  const out = [];
  const add = (id, label, m) => { if (m) out.push({ id, label, question: m.question, slug: m.slug, url: urlOf(m), endDate: m.endDate, live: true }); };
  add('gold', 'Gold up or down', gold);
  if (silverW) add('silver', 'Silver this week', silverW); else add('silver', 'Silver up or down', silverD);
  add('eur', 'EUR/USD up or down', eur);
  // No open market found for a feed (or Polymarket unreachable): leave that chip out rather than offer a closed market.
  const order = ['gold', 'silver', 'eur'];
  out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  memo = { at: out.length ? Date.now() : Date.now() - 25 * 60 * 1000, value: { at: new Date().toISOString(), chips: out } };
  return memo.value;
}
