// "TRY" chips: real, currently open Polymarket markets that settle on Pyth gold, silver and EUR/USD.
// Looks them up on Polymarket's public gamma API by their daily/weekly slug pattern; falls back to known slugs.
const GAMMA = 'https://gamma-api.polymarket.com';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const FALLBACK = [
  { id: 'gold', label: 'Gold up or down today', slug: 'xauusd-up-or-down-on-november-9-2026' },
  { id: 'silver', label: 'Silver this week', slug: 'xagusd-up-or-down-on-november-9-2026' },
  { id: 'eur', label: 'EUR/USD today', slug: 'eurusd-up-or-down-on-november-9-2026' },
];

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
async function openMarket(slug) {
  const r = await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  const m = Array.isArray(r) ? r[0] : null;
  return m && !m.closed ? m : null;
}
const urlOf = (m) => (m.events?.[0]?.slug ? `https://polymarket.com/event/${m.events[0].slug}/${m.slug}` : `https://polymarket.com/market/${m.slug}`);

async function firstOpenDaily(prefix) {
  const now = Date.now();
  for (const off of [0, 1, 2, 3, -1]) {
    const m = await openMarket(daySlug(prefix, etDate(now + off * 86400000)));
    if (m) return m;
  }
  return null;
}

async function silverWeek() {
  // Weekly "What will Silver hit" event, keyed by that week's Monday (ET). Pick the most undecided line.
  const now = Date.now();
  for (let back = 0; back < 7; back++) {
    const dt = etDate(now - back * 86400000);
    if (dt.wd !== 'Mon') continue;
    const ev = await getJson(`${GAMMA}/events?slug=will-xagusd-hit-week-of-${MONTHS[dt.m - 1]}-${dt.d}-${dt.y}`);
    const markets = (Array.isArray(ev) && ev[0]?.markets || []).filter((m) => !m.closed);
    if (!markets.length) return null;
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
  for (const f of FALLBACK) if (!out.some((o) => o.id === f.id)) out.push({ ...f, url: `https://polymarket.com/market/${f.slug}`, live: false });
  const order = ['gold', 'silver', 'eur'];
  out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  memo = { at: Date.now(), value: { at: new Date().toISOString(), chips: out } };
  return memo.value;
}
