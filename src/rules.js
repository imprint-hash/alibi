// Market rule text → settlement spec. A deterministic parser runs first. The AI extraction (cached per market)
// only cross-checks it and fills gaps; code validates every AI field, and disagreements are reported, not hidden.
import { extractJson } from './ai.js';
import { path, readJson, writeJson } from './store.js';

const CACHE = (slug) => path('cache', 'rules', `${slug}.json`);

// Pyth codes we know how to map to instruments. Unknown codes stay unknown (never assumed).
export const PYTH_CODES = {
  CLL: { instrument: 'WTI', venue: 'ICE Futures Europe', pythPrefix: 'CLL', hlCoin: 'xyz:CL', indexFeeds: ['Commodities.Index.LWTI1M/USD', 'Commodities.Index.WTI1M/USD'] },
  BRENT: { instrument: 'BRENT', venue: 'ICE Futures Europe', pythPrefix: 'BRENT', hlCoin: 'xyz:BRENTOIL', indexFeeds: ['Commodities.Index.BRENT1M/USD'] },
  // Spot feeds: one Pyth symbol, no contract roll.
  'Metal.XAU/USD': { instrument: 'XAU', venue: 'Pyth spot gold', spot: true, pythSymbol: 'Metal.XAU/USD', hlCoin: 'xyz:GOLD', indexFeeds: [] },
  'Metal.XAG/USD': { instrument: 'XAG', venue: 'Pyth spot silver', spot: true, pythSymbol: 'Metal.XAG/USD', hlCoin: 'xyz:SILVER', indexFeeds: [] },
  'FX.EUR/USD': { instrument: 'EURUSD', venue: 'Pyth spot FX', spot: true, pythSymbol: 'FX.EUR/USD', hlCoin: 'xyz:EUR', indexFeeds: [] },
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function findDate(text, fallbackYear) {
  const m = text.match(new RegExp(`(${MONTHS.join('|')})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, 'i'));
  if (!m) return null;
  const y = m[3] ? +m[3] : fallbackYear;
  return `${y}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Deterministic parse of the known Polymarket Pyth templates. Fields it cannot read are null. */
export function parseRulesDeterministic(market) {
  const q = market.question || '';
  const r = market.rules || '';
  const all = `${q}\n${r}\n${market.resolutionSource || ''}`;
  const year = market.endDate ? new Date(market.endDate).getUTCFullYear() : new Date().getUTCFullYear();
  const spec = {
    source: null, sourceUrl: null, pythCode: null, instrument: null, venue: null,
    monthRule: null, rollSessions: null, candle: null, field: null, kind: null,
    comparator: null, threshold: null, tieRule: null, window: null, timezone: null,
    fallbackSource: null, edgeCases: [], parsedBy: 'deterministic',
  };

  if (/resolution source for this market (?:will be|is) Pyth/i.test(r) || /pyth\.(com|network)/i.test(market.resolutionSource || '')) spec.source = 'pyth';
  else if (/binance/i.test(all)) spec.source = 'binance';
  else if (/chainlink/i.test(all)) spec.source = 'chainlink';
  if (!spec.source && /pythdata\.app/i.test(all)) spec.source = 'pyth';
  spec.sourceUrl = (r.match(/https:\/\/(?:app\.pyth\.com|pythdata\.app)\/[^\s)"]+/) || [market.resolutionSource || null])[0]?.replace(/[.,]$/, '') || null;
  const sym = (spec.sourceUrl || '').match(/explore\/((?:Metal|FX|Crypto|Equity|Commodities)\.[A-Za-z0-9]+(?:%2F|\/)[A-Za-z]+)/);
  if (sym) spec.pythCode = decodeURIComponent(sym[1]);

  const code = r.match(/denoted by Pyth as "([A-Z0-9]+)"/) || (spec.sourceUrl || '').match(/search=([A-Z0-9]+)/);
  if (code && !spec.pythCode) spec.pythCode = code[1];
  if (spec.pythCode && PYTH_CODES[spec.pythCode]) Object.assign(spec, { instrument: PYTH_CODES[spec.pythCode].instrument, venue: PYTH_CODES[spec.pythCode].venue });

  if (/Active Month/i.test(r)) spec.monthRule = 'active-month';
  else if (PYTH_CODES[spec.pythCode]?.spot) spec.monthRule = 'spot';
  const cc = r.match(/1-minute candle timestamped (\d{1,2}):(\d{2})\s*(AM|PM)\s*ET/i);
  if (cc) spec.closeCandleET = `${String((+cc[1] % 12) + (cc[3].toUpperCase() === 'PM' ? 12 : 0)).padStart(2, '0')}:${cc[2]}`;
  const roll = r.match(/except during that contract's final (\w+) trading sessions/i);
  if (roll) spec.rollSessions = { two: 2, three: 3, four: 4, five: 5 }[roll[1].toLowerCase()] ?? (Number(roll[1]) || null);
  if (/1-minute candle/i.test(r)) spec.candle = '1m';
  // Which earlier day is "prior": EUR/USD-style rules define a "reference day" as one whose session includes the
  // close candle; metals/WTI rules say "most recent prior trading day" (any day with a session, even an early close).
  spec.priorDayRule = /"reference day" is any day on which/i.test(r) ? 'reference-day' : 'trading-day';
  if (/typically begins at \d{1,2}:00 PM ET|All times are Eastern Time|\bET\b/i.test(r)) spec.timezone = 'America/New_York';

  // kind / field / comparator
  if (/resolve to "Up"/i.test(r) && /(most recent prior (trading|reference) day|previous (trading|reference) day)/i.test(r)) {
    Object.assign(spec, { kind: 'close-vs-prior-close', field: 'close', comparator: '>' });
    if (/exactly equal[^.]*?50-50/is.test(r)) spec.tieRule = '50-50';
  } else if (/Close price .*? is higher than the listed price/i.test(r)) {
    Object.assign(spec, { kind: 'close-above', field: 'close', comparator: '>' });
    if (/exactly equal, this market will resolve to "No"/i.test(r)) spec.tieRule = 'No';
  } else if (/final "High" or "Low" price equal to or beyond/i.test(r)) {
    const low = /\(LOW\)|↓/i.test(q);
    Object.assign(spec, { kind: low ? 'hit-low' : 'hit-high', field: low ? 'low' : 'high', comparator: low ? '<=' : '>=' });
  }

  // threshold
  const th = q.match(/\$\s?([\d,]+(?:\.\d+)?)/);
  if (th) spec.threshold = Number(th[1].replace(/,/g, ''));
  else if (market.threshold != null) spec.threshold = market.threshold;

  // window
  const weekOf = q.match(/Week of ([A-Za-z]+ \d{1,2}(?:,? \d{4})?)/i);
  const inMonth = q.match(/in (January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?\?/i);
  if (weekOf) {
    spec.window = { type: 'week', startDay: findDate(weekOf[1], year), endsAt: market.endDate };
    if (/during a trading session of [A-Za-z]+ \d{1,2} \d{4}/i.test(r)) spec.edgeCases.push('Rule text says "during a trading session of <one date>" while the title says "Week of"; Alibi uses the title and the market end date (whole week).');
  } else if (inMonth) {
    const mm = MONTHS.indexOf(inMonth[1].toLowerCase()) + 1;
    spec.window = { type: 'month', month: `${inMonth[2] || year}-${String(mm).padStart(2, '0')}`, endsAt: market.endDate };
  } else {
    const day = findDate(q, year);
    if (day) spec.window = { type: 'day', day };
  }
  if (spec.kind && spec.kind.startsWith('hit') && /at any point after market creation/i.test(r)) spec.window = { ...spec.window, notBefore: market.startDate };

  if (/official (?:daily high\/low|close) price published .*?ICE Futures Europe/i.test(r)) spec.fallbackSource = 'ICE Futures Europe official report (Report 10)';
  const cme = r.match(/COMEX ([A-Za-z]+) Futures \((\w+)\)/i);
  if (cme) spec.fallbackSource = `CME COMEX ${cme[1]} futures (${cme[2]}) official daily price`;

  // edge cases worth surfacing (quoted from the rules, not invented)
  const ec = [
    [/no valid Pyth Close value .*? last valid Pyth price/is, 'If the close candle has no valid Pyth Close, the last valid Pyth price before it is used.'],
    [/does not trade at all during the relevant trading session, the market will resolve 50-50/i, 'No trading at all that session → resolves 50-50.'],
    [/weekend sessions .*? do not include a 4:59 PM ET close/is, 'Weekend sessions have no 4:59 PM ET close, so Monday compares with Friday.'],
    [/(Historical 1-minute candles may be accessed)/i, 'The Pyth chart is the source; Alibi reads the same feed through the Pyth History API (which offers several channels whose 1-minute highs/lows can differ slightly).'],
    [/Active Month contract does not trade at all during the relevant trading session.*?50-50/is, 'No trading in the Active Month that session, or a non-trading day → resolves 50-50.'],
    [/If a listed date is not a trading day under the applicable trading-hours schedule[^.]*?resolve 50-50/i, 'A listed date that is not a trading day on the Pyth schedule → resolves 50-50.'],
    [/no valid Pyth price exists for that trading day[^.]*?official daily close price of the CME COMEX/is, 'If Pyth has no valid price at all that day (outage), the CME COMEX futures official daily close may be used instead.'],
    [/does not trade at all during the listed time frame, this market will resolve to "No"/i, 'No trading in the Active Month during the window → resolves "No".'],
    [/resolve based on adjusted prices as displayed on Pyth/i, 'A contract/feed change mid-window → resolves on adjusted prices as shown on Pyth.'],
    [/Both closing prices will reference the same underlying contract/i, 'Both closes use the contract that is Active Month at the end of the specified session (prior close may come from a non-active contract on roll days).'],
    [/Prices will be used exactly as published by Pyth, without rounding|used exactly as published by Pyth, without rounding/i, 'Pyth values are used exactly as published, no rounding: a single bad print counts.'],
  ];
  for (const [re, text] of ec) if (re.test(r)) spec.edgeCases.push(text);
  return spec;
}

const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'pythCode', 'field', 'kind', 'comparator', 'threshold', 'windowDescription', 'monthRule', 'rollSessions', 'tieRule', 'fallbackSource', 'edgeCases'],
  properties: {
    source: { type: 'string', enum: ['pyth', 'binance', 'chainlink', 'other', 'unknown'] },
    pythCode: { type: ['string', 'null'] },
    field: { type: ['string', 'null'], enum: ['close', 'high', 'low', null] },
    kind: { type: ['string', 'null'], enum: ['close-vs-prior-close', 'close-above', 'close-below', 'hit-high', 'hit-low', 'other', null] },
    comparator: { type: ['string', 'null'], enum: ['>', '>=', '<', '<=', null] },
    threshold: { type: ['number', 'null'] },
    windowDescription: { type: 'string' },
    monthRule: { type: ['string', 'null'], enum: ['active-month', 'fixed-contract', 'spot', null] },
    rollSessions: { type: ['integer', 'null'] },
    tieRule: { type: ['string', 'null'] },
    fallbackSource: { type: ['string', 'null'] },
    edgeCases: { type: 'array', items: { type: 'string' } },
  },
};

/** Validates AI output in code. Returns { ok:{...fields that pass}, rejected:[...] }. */
export function validateAiSpec(ai, market) {
  const ok = {};
  const rejected = [];
  if (!ai || typeof ai !== 'object') return { ok, rejected: ['no AI output'] };
  let text = `${market.question}\n${market.rules}\n${market.resolutionSource}`;
  try { text += '\n' + decodeURIComponent(text); } catch { /* keep raw */ }
  const enums = AI_SCHEMA.properties;
  for (const k of ['source', 'field', 'kind', 'comparator', 'monthRule']) {
    if (enums[k].enum.includes(ai[k])) ok[k] = ai[k]; else rejected.push(`${k}: not an allowed value`);
  }
  if (ai.pythCode != null) {
    if (/^[A-Za-z0-9./]{2,24}$/.test(ai.pythCode) && text.includes(ai.pythCode)) ok.pythCode = ai.pythCode;
    else rejected.push('pythCode: not found verbatim in the rules');
  }
  if (ai.threshold != null) {
    const shown = [String(ai.threshold), ai.threshold.toLocaleString('en-US')];
    if (Number.isFinite(ai.threshold) && shown.some((s) => text.includes(s))) ok.threshold = ai.threshold;
    else rejected.push('threshold: number not present in question/rules');
  }
  if (Number.isInteger(ai.rollSessions) && ai.rollSessions >= 0 && ai.rollSessions <= 10) ok.rollSessions = ai.rollSessions;
  if (Array.isArray(ai.edgeCases)) ok.edgeCases = ai.edgeCases.filter((s) => typeof s === 'string' && s.length < 400).slice(0, 10);
  for (const k of ['tieRule', 'fallbackSource', 'windowDescription']) if (typeof ai[k] === 'string') ok[k] = ai[k].slice(0, 300);
  return { ok, rejected };
}

/**
 * Full rules step. Cached per market slug (rules text hash) so we pay for extraction once.
 * opts.ai=false skips the model entirely.
 */
export async function extractRules(market, { ai = true } = {}) {
  const det = parseRulesDeterministic(market);
  const key = hash(market.rules + market.question);
  const cached = readJson(CACHE(market.slug), null);
  let aiPart = cached && cached.key === key ? cached.ai : null;
  if (!aiPart && ai && market.rules) {
    const res = await extractJson({
      system: 'You extract the settlement mechanics of a prediction market from its rules. Quote facts from the text; never guess. Use null when the text does not say.',
      user: `Question: ${market.question}\nResolution source field: ${market.resolutionSource}\n\nRules:\n${market.rules}`,
      schema: AI_SCHEMA,
      maxTokens: 1500,
    });
    aiPart = { provider: res.provider, model: res.model || null, raw: res.json, errors: res.errors, at: new Date().toISOString() };
    writeJson(CACHE(market.slug), { key, ai: aiPart });
  }
  const spec = { ...det, edgeCases: [...det.edgeCases] };
  const check = { provider: aiPart?.provider || null, cached: !!(cached && cached.key === key), agreements: [], disagreements: [], filledByAi: [], rejected: [] };
  if (aiPart?.raw) {
    const { ok, rejected } = validateAiSpec(aiPart.raw, market);
    check.rejected = rejected;
    for (const k of ['source', 'pythCode', 'field', 'kind', 'comparator', 'threshold', 'monthRule', 'rollSessions']) {
      if (!(k in ok) || ok[k] == null) continue; // AI "the text doesn't say" (null) is not a disagreement
      if (spec[k] == null) { spec[k] = ok[k]; check.filledByAi.push(k); }
      else if (String(spec[k]) === String(ok[k])) check.agreements.push(k);
      else check.disagreements.push({ field: k, parser: spec[k], ai: ok[k] });
    }
    for (const e of ok.edgeCases || []) if (!spec.edgeCases.some((x) => similar(x, e))) spec.edgeCases.push(`(AI-read) ${e}`);
    spec.windowDescription = ok.windowDescription || null;
  }
  spec.ruleCheck = check;
  spec.inScope = spec.source === 'pyth' && !!PYTH_CODES[spec.pythCode];
  spec.scopeNote = spec.source !== 'pyth' ? `Settles on ${spec.source || 'an unrecognised source'}; Alibi covers Pyth-settled markets only.` : !PYTH_CODES[spec.pythCode] ? `Pyth code "${spec.pythCode}" is not mapped yet.` : null;
  return spec;
}

const similar = (a, b) => {
  const w = (s) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) || []);
  const A = w(a), B = w(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / Math.max(1, Math.min(A.size, B.size)) > 0.6;
};
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
