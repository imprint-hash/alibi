#!/usr/bin/env node
// Scans recent REAL Pyth history of the in-scope spot feeds against Hyperliquid to find genuine incidents,
// then (with --remember) writes them to Walrus Memory (alibi-incidents) with their evidence.
// Usage: node src/scan.js [--days 10] [--feeds XAU,XAG,EURUSD] [--remember] [--max-writes 20] [--sources]
import { loadEnv } from './env.js';
import * as pyth from './pyth.js';
import { hyperliquidCandles } from './refs.js';
import * as D from './detect.js';
import * as mem from './memory.js';
import { parseSchedule, liquidityState, sessionForDay, isoDay, isOpen, zonedToUtc } from './sessions.js';
import { PYTH_CODES } from './rules.js';
import { calibrate } from './check.js';
import { calibrationFor, applyCalibration } from './calibration.js';
import { writeJson, path } from './store.js';

loadEnv();
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const days = Number(opt('--days', 10));
const maxWrites = Number(opt('--max-writes', 20));
const feedsWanted = opt('--feeds', 'XAU,XAG,EURUSD').split(',');
const doRemember = args.includes('--remember');
const doSources = args.includes('--sources');
const fromFile = args.includes('--from-file');
const minConfRatio = Number(opt('--min-conf-ratio', 6));

const now = Math.floor(Date.now() / 1000);
const from = now - days * 86400;
const list = await pyth.symbols();
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16) + 'Z';
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const all = [];
const facts = [];
const summary = [];

for (const [sym, map] of fromFile ? [] : Object.entries(PYTH_CODES).filter(([, m]) => m.spot && feedsWanted.includes(m.instrument))) {
  const feed = pyth.feedBySymbol(list, sym);
  const sched = parseSchedule(feed.schedule);
  const liq = (t) => liquidityState(sched, map.instrument, t * 1000);
  const openAt = (t) => isOpen(sched, t * 1000);
  const closeCandle = (day) => { const [y, m, d] = day.split('-').map(Number); return zonedToUtc(y, m, d, 16, 59, 'America/New_York') / 1000; };
  const bucket = (t) => {
    const s = sessionForDay(sched, isoDay(t * 1000, 'America/New_York'));
    const cc = closeCandle(isoDay(t * 1000, 'America/New_York'));
    if (t >= cc - 14 * 60 && t <= cc) return 'session-close';
    if (s && t - s.open / 1000 < 15 * 60 && t >= s.open / 1000) return 'session-open';
    return liq(t);
  };
  log(`${sym}: loading Pyth 1m candles (${feed.channel}) for ${days} days`);
  const pc = await pyth.candles(sym, from, now, '1', feed.channel);
  log(`${sym}: ${pc.length} Pyth candles; loading Hyperliquid ${map.hlCoin}`);
  const hl1 = await hyperliquidCandles(map.hlCoin, now - 5000 * 60, now, '1m');
  const hl5 = await hyperliquidCandles(map.hlCoin, from, now, '5m');
  const params = applyCalibration(calibrate(pc), calibrationFor(map.instrument));
  const t1 = hl1[0]?.t ?? now;
  const recent = pc.filter((c) => c.t >= t1);
  const older = pc.filter((c) => c.t < t1);
  const refName = `Hyperliquid ${map.hlCoin}`;
  const found = [];
  const base = { instrument: map.instrument, feed: sym, simulated: 'no', source: `scan:pyth-history(${feed.channel})+hyperliquid` };

  // 1) spike-and-revert, recent (1m vs 1m)
  const sr = D.spikeRevert(recent, [{ name: refName, candles: hl1 }], params);
  for (const e of sr.events.filter((x) => x.isolated)) found.push({ ...base, pattern: 'spike-revert', t: e.t, size_bps: e.sizeBps, dir: e.dir, ref: refName, ref_move_bps: e.refMoveBps, reverted_min: e.revertedAfterMin, sev: e.sizeBps / params.spikeBps, res: '1m' });
  // 2) spike-and-revert, older (Pyth 1m; confirm on Hyperliquid 5m)
  const H5 = new Map(hl5.map((c) => [c.t, c]));
  for (const e of D.spikeRevert(older, [], params).events) {
    const k = Math.floor(e.t / 300) * 300;
    const x = H5.get(k);
    const prior = [1, 2, 3].map((i) => H5.get(k - i * 300)).filter(Boolean).map((c) => c.c);
    if (!x || prior.length < 2) continue;
    const rb = D.median(prior);
    const mv = Math.max(Math.abs(D.bps(e.dir === 'up' ? x.h : x.l, rb)), Math.abs(D.bps(x.c, rb)));
    if (mv < e.sizeBps * 0.33) found.push({ ...base, pattern: 'spike-revert', t: e.t, size_bps: e.sizeBps, dir: e.dir, ref: `${refName} 5m`, ref_move_bps: Math.round(mv * 10) / 10, reverted_min: e.revertedAfterMin, sev: e.sizeBps / params.spikeBps, res: '1m-vs-5m' });
  }
  // 3) divergence episodes (settlement feed side only matters for settlement risk)
  const s1 = D.divergenceSeries(recent, hl1).map((x) => Math.abs(x.bps));
  const p95 = s1.length ? s1.sort((a, b) => a - b)[Math.floor(s1.length * 0.95)] : 5;
  const thr = Math.max(15, Math.round(4 * p95));
  for (const e of D.divergenceEpisodes(recent, hl1, { thresholdBps: thr })) if (e.side === 'pyth' || e.side === 'both') found.push({ ...base, pattern: 'divergence', t: e.peakT, size_bps: Math.abs(e.peakBps), side: e.side, minutes: e.minutes, ref: refName, pyth_move_bps: e.pythMoveBps, ref_move_bps: e.refMoveBps, threshold_bps: thr, sev: Math.abs(e.peakBps) / thr, res: '1m' });
  for (const e of D.divergenceEpisodes(D.aggregate(older, 5), hl5, { thresholdBps: Math.round(thr * 1.5), step: 300 })) if (e.side === 'pyth' || e.side === 'both') found.push({ ...base, pattern: 'divergence', t: e.peakT, size_bps: Math.abs(e.peakBps), side: e.side, minutes: e.minutes * 5, ref: `${refName} 5m`, pyth_move_bps: e.pythMoveBps, ref_move_bps: e.refMoveBps, threshold_bps: Math.round(thr * 1.5), sev: Math.abs(e.peakBps) / (thr * 1.5), res: '5m' });
  // 4) repeated identical prints and staleness (missing minutes while open), from Pyth alone
  for (const r of D.repeatedPrints(pc, liq, { repeatMinRun: 5 }).runs) found.push({ ...base, pattern: 'repeated', t: r.start, minutes: r.minutes, value: r.value, sev: r.minutes / 5 });
  for (const g of D.staleness(pc, [], liq, { from, to: now - 120 }).gaps.filter((g) => g.seconds >= 180)) found.push({ ...base, pattern: 'stale', t: g.from, gap_min: Math.round(g.seconds / 60), sev: g.seconds / 180 });
  // 5) confidence: sampled prints every 2h while open + every daily settlement minute (16:55–16:59 ET)
  const windows = new Set();
  for (let t = Math.ceil(from / 7200) * 7200; t < now - 60; t += 7200) if (openAt(t)) windows.add(t);
  const closeMinutes = [];
  for (let d = from; d < now; d += 86400) { const day = isoDay(d * 1000, 'America/New_York'); const cc = closeCandle(day); if (cc < now && openAt(cc)) { closeMinutes.push(cc); for (let k = 4; k >= 0; k--) windows.add(cc - k * 60); } }
  log(`${sym}: ${windows.size} sampled print windows`);
  const prints = [];
  for (const t of [...windows].sort((a, b) => a - b)) prints.push(...(await pyth.printsRange(feed.lazerId, t, t + 59, feed.channel)));
  const cb = D.confidenceBlowout(prints, { confRatio: params.confRatio ?? 4 });
  const byHour = new Map();
  for (const e of cb.events || []) { const k = Math.floor(e.t / 3600); if (!byHour.has(k) || byHour.get(k).ratio < e.ratio) byHour.set(k, e); }
  for (const e of byHour.values()) found.push({ ...base, pattern: 'confidence', t: Math.floor(e.t / 60) * 60, ratio: e.ratio, conf_bps: e.confBps, median_conf_bps: cb.medianConfBps, sev: e.ratio / 4 });
  // systematic fact: confidence at the 16:59 ET settlement candle vs all-day median
  const atClose = closeMinutes.map((t) => D.confidenceAt(prints, t)).filter(Boolean);
  if (atClose.length) facts.push({ instrument: map.instrument, feed: sym, fact: 'close-confidence', days: atClose.length, close_conf_bps: D.median(atClose.map((x) => x.medianConfBps)).toFixed(2), allday_median_conf_bps: cb.medianConfBps, min_publishers_at_close: (() => { const ps = atClose.map((x) => x.minPublishers).filter(Number.isFinite); return ps.length ? Math.min(...ps) : 'n/a'; })(), window: `${iso(from)}..${iso(now)}`, source: base.source });
  facts.push({ instrument: map.instrument, feed: sym, fact: 'calibration', median_1m_range_bps: params.median1mRangeBps, spike_bps: params.spikeBps, divergence_threshold_bps: thr, hl_basis_ratio: recent.length ? (D.median(D.divergenceSeries(recent, hl1).map((x) => x.ratio)) || 0).toFixed(5) : 'n/a', source: base.source });

  // cluster within 10 minutes: keep the strongest, note the others
  found.sort((a, b) => a.t - b.t);
  const clusters = [];
  for (const f of found) {
    const c = clusters.at(-1);
    if (c && f.t - c.last <= 600) { c.items.push(f); c.last = f.t; } else clusters.push({ last: f.t, items: [f] });
  }
  const incidents = clusters.map((c) => {
    const best = c.items.reduce((a, b) => (b.sev > a.sev ? b : a));
    const also = [...new Set(c.items.filter((x) => x !== best).map((x) => x.pattern))];
    return { ...best, also: also.length ? also.join('+') : undefined };
  });
  // evidence enrichment at the incident minute (prints with confidence/publishers/spread) + Pyth chart link
  incidents.sort((a, b) => b.sev - a.sev);
  for (const inc of incidents.slice(0, 15)) {
    const t = Math.floor(inc.t / 60) * 60;
    const p = prints.filter((x) => x.t >= t && x.t < t + 60).length ? prints.filter((x) => x.t >= t && x.t < t + 60) : await pyth.printsRange(feed.lazerId, t, t + 59, feed.channel);
    const c = pc.find((x) => x.t === t);
    const ci = D.confidenceAt(p, t);
    if (c) inc.pyth_ohlc = [c.o, c.h, c.l, c.c].map((v) => +v.toPrecision(7)).join('/');
    const h = hl1.find((x) => x.t === t) || H5.get(Math.floor(t / 300) * 300);
    if (h) inc.ref_ohlc = [h.o, h.h, h.l, h.c].map((v) => +v.toPrecision(7)).join('/');
    if (ci) { inc.conf_bps = inc.conf_bps ?? ci.medianConfBps; inc.publishers = ci.minPublishers; }
    const sp = p.filter((x) => x.bid && x.ask).map((x) => D.bps(x.ask, x.bid));
    if (sp.length) inc.spread_bps = Math.round(D.median(sp) * 10) / 10;
    inc.evidence = `https://pythdata.app/explore/${encodeURIComponent(sym)}?t=${t}`;
  }
  for (const i of incidents) { i.bucket = bucket(i.t); i.when = iso(i.t).replace('Z', ':00Z'); }
  summary.push({ feed: sym, candles: pc.length, hl1m: hl1.length, hl5m: hl5.length, prints: prints.length, params, divergenceThresholdBps: thr, raw: found.length, incidents: incidents.length, byPattern: incidents.reduce((m, i) => ((m[i.pattern] = (m[i.pattern] || 0) + 1), m), {}), byBucket: incidents.reduce((m, i) => ((m[i.bucket] = (m[i.bucket] || 0) + 1), m), {}) });
  all.push(...incidents);
}

if (fromFile) {
  const saved = (await import('node:fs')).readFileSync(path('results', 'scan-latest.json'), 'utf8');
  const j = JSON.parse(saved);
  all.push(...j.incidents); facts.push(...j.facts); summary.push(...j.summary);
}
for (const i of all) i.bucket = relabel(i);
all.sort((a, b) => b.sev - a.sev);
if (!fromFile) writeJson(path('results', 'scan-latest.json'), { at: new Date().toISOString(), days, summary, facts, incidents: all });
console.log(JSON.stringify({ summary, facts }, null, 2));
console.log('\nTop incidents:');
for (const i of all.slice(0, 30)) console.log(`  ${i.when} ${i.feed.padEnd(14)} ${i.pattern.padEnd(12)} ${i.bucket.padEnd(13)} sev=${i.sev.toFixed(2)} ${i.size_bps != null ? `${i.size_bps}bps` : ''}${i.ratio ? `conf×${i.ratio}` : ''}${i.gap_min ? `gap ${i.gap_min}min` : ''}${i.minutes ? ` ${i.minutes}min` : ''} ${i.side || i.dir || ''} ${i.also ? `(+${i.also})` : ''}`);

/** 17:00–17:05 ET is right after the 16:59 ET settlement candle: Sunday = weekly open, weekdays = FX daily rollover. */
function relabel(i) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(i.t * 1000));
  const g = Object.fromEntries(p.map((x) => [x.type, x.value]));
  const min = +g.hour * 60 + +g.minute;
  if (min >= 17 * 60 && min <= 17 * 60 + 5) return g.weekday === 'Sun' ? 'session-open' : 'post-close';
  return i.bucket;
}
/** Genuine enough to remember: strong confidence blow-outs, anything next to a settlement minute, every confirmed spike/divergence/stale/repeat. */
const worthRemembering = (i) => i.pattern !== 'confidence' || i.ratio >= minConfRatio || ['session-close', 'post-close', 'session-open'].includes(i.bucket);

// Memory text: drop internal fields, keep it short.
export const toRecord = (i) => { const { t, sev, res, source, ...rest } = i; return { ...rest, severity: sev.toFixed(2), res, src: 'pyth-history+hyperliquid' }; };

if (doRemember) {
  const ready = await mem.walrusReady();
  if (!ready.ok) { console.log(`not remembering: ${ready.reason}`); process.exit(0); }
  let n = 0;
  if (doSources) for (const f of facts) { const w = await mem.remember(mem.NS.sources, 'source', f); n++; console.log(`remembered source ${w.blobId}: ${w.text.slice(0, 120)}`); }
  const chosen = all.filter(worthRemembering).slice(0, maxWrites);
  console.log(`remembering ${chosen.length} of ${all.length} incidents (filter: confidence ratio >= ${minConfRatio} or next to a settlement minute)`);
  for (const i of chosen) {
    try { const w = await mem.remember(mem.NS.incidents, 'incident', toRecord(i)); n++; console.log(`remembered ${w.blobId}: ${w.text.slice(0, 140)}`); }
    catch (e) { console.log(`write failed: ${e.message}`); if (/cap reached/.test(e.message)) break; }
  }
  console.log(`memory writes this run: ${n}; total so far: ${mem.writesSoFar()}`);
}
