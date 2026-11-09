// One full check of a Polymarket market: rules → settlement feed → references → detectors → memory → score.
import { getMarket } from './polymarket.js';
import { extractRules, PYTH_CODES } from './rules.js';
import * as pyth from './pyth.js';
import { references } from './refs.js';
import * as D from './detect.js';
import { applyMemories, etMinute } from './learn.js';
import { onchainRecord } from './onchain.js';
import { calibrationFor, applyCalibration } from './calibration.js';
import * as mem from './memory.js';
import { parseSchedule, sessionForDay, tradingDays, liquidityState, isoDay, isOpen, zonedToUtc, LIQUIDITY } from './sessions.js';

const H = 3600;

/** Settlement windows (sessions) the market cares about, per its parsed rules. */
export function settlementPlan(spec, contracts, market, nowSec) {
  const any = contracts.find((c) => c.state === 'stable') || contracts[0];
  const sched = parseSchedule(any.schedule);
  const plan = { days: [], kind: spec.kind, sessions: [], notes: [] };
  const w = spec.window || {};
  if (w.type === 'day') plan.days = [w.day];
  else if (w.type === 'week' && w.startDay) plan.days = tradingDays(sched, w.startDay, isoDay(Date.parse(w.endsAt) - 1000, sched.tz));
  else if (w.type === 'month' && w.month) {
    const [y, m] = w.month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    plan.days = tradingDays(sched, `${w.month}-01`, `${w.month}-${String(last).padStart(2, '0')}`);
  }
  for (const day of plan.days) {
    const a = contracts.length === 1 && contracts[0].spot ? { contract: contracts[0], next: null } : pyth.activeContract(contracts, day, spec.rollSessions ?? 3);
    const sc = a.contract ? parseSchedule(a.contract.schedule) : null;
    const s = sc ? sessionForDay(sc, day) : null;
    if (!s) { plan.notes.push(`${day}: no trading session in the Pyth schedule (rules: 50-50 or "No" depending on market type).`); continue; }
    const settleT = closeCandleT(spec, day) ?? s.close / 1000 - 60;
    if (spec.closeCandleET && !isOpen(sc, settleT * 1000)) plan.notes.push(`${day}: the ${spec.closeCandleET} ET close candle falls outside the Pyth session (rules: last valid price before it is used).`);
    let open = s.open / 1000;
    let close = Math.max(s.close / 1000, settleT + 60);
    if (spec.closeCandleET && /^FX\./.test(a.contract.symbol)) {
      // FX trades around the clock on Pyth; the market's day is the 24h ending at its close candle (17:00 ET → 17:00 ET).
      const [py, pm, pd] = new Date(Date.parse(day + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10).split('-').map(Number);
      open = zonedToUtc(py, pm, pd, 17, 0, 'America/New_York') / 1000;
      close = settleT + 60;
    }
    plan.sessions.push({ day, contract: a.contract, next: a.next, open, close, settleT });
  }
  const symbolsUsed = [...new Set(plan.sessions.map((s) => s.contract.symbol))];
  if (symbolsUsed.length > 1) plan.notes.push(`The Active Month changes inside this window (${symbolsUsed.join(' → ')}); prices before and after the roll come from different contracts.`);
  if (w.notBefore) plan.notBefore = Date.parse(w.notBefore) / 1000;
  plan.windowFrom = Math.max(plan.sessions[0]?.open ?? nowSec, plan.notBefore ?? 0);
  plan.windowTo = plan.sessions.at(-1)?.close ?? nowSec;
  plan.final = plan.sessions.at(-1) || null;
  plan.started = nowSec >= plan.windowFrom;
  plan.ended = nowSec >= plan.windowTo;
  return plan;
}

/** The rule's own close candle (e.g. 16:59 ET) for a day, in seconds; null when the rule doesn't name one. */
export function closeCandleT(spec, day) {
  if (!spec.closeCandleET) return null;
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = spec.closeCandleET.split(':').map(Number);
  return zonedToUtc(y, m, d, hh, mm, 'America/New_York') / 1000;
}

/**
 * The prior day an up/down market compares with.
 * - 'trading-day' rules (metals, WTI): the most recent prior day with any Pyth session, even an early close
 *   (e.g. Thanksgiving 00:00–14:30 ET); its effective close is then the last valid price before the close candle.
 * - 'reference-day' rules (EUR/USD): the most recent prior day whose session includes the close candle.
 */
export function priorReferenceDay(spec, sched, day) {
  let t = Date.parse(day + 'T12:00:00Z');
  for (let i = 0; i < 10; i++) {
    t -= 86400000;
    const d = new Date(t).toISOString().slice(0, 10);
    if (!sessionForDay(sched, d)) continue;
    if (spec.priorDayRule === 'reference-day') {
      const ct = closeCandleT(spec, d);
      if (ct != null && !isOpen(sched, ct * 1000)) continue;
    }
    return d;
  }
  return null;
}

/**
 * Effective close for a day: the close candle's Close, else the last candle before it within that day's session
 * (rules: "last valid Pyth price ... prior to 4:59 PM ET during that trading day"). Never reaches into an earlier session.
 */
export function effectiveClose(candles, { settleT, sessionOpen }) {
  const exact = candles.find((c) => c.t === settleT);
  if (exact) return { candle: exact, exact: true };
  const before = [...candles].reverse().find((c) => c.t < settleT && c.t >= sessionOpen);
  return before ? { candle: before, exact: false } : null;
}

export function bucketAt(session, tSec, sched, instrument) {
  if (session) {
    if (session.close - tSec <= 15 * 60 && tSec < session.close) return 'session-close';
    if (tSec - session.open < 15 * 60 && tSec >= session.open) return 'session-open';
  }
  return liquidityState(sched, instrument, tSec * 1000);
}

/**
 * Runs a check. opts: { ai=true, memory=true, nowSec, lookbackHours=48 }.
 * Returns a plain object that report.js renders. Never throws for a missing data source; records it.
 */
export async function runCheck(input, opts = {}) {
  const o = { ai: true, memory: true, lookbackHours: 48, ...opts };
  const nowSec = o.nowSec ?? Math.floor(Date.now() / 1000);
  const out = { input, at: new Date(nowSec * 1000).toISOString(), dataSources: [], gaps: [] };
  const market = await getMarket(input);
  out.market = market;
  const spec = await extractRules(market, { ai: o.ai });
  out.spec = spec;
  if (!spec.inScope) { out.outOfScope = spec.scopeNote; return out; }

  const map = PYTH_CODES[spec.pythCode];
  const list = await pyth.symbols();
  const contracts = map.spot ? [pyth.feedBySymbol(list, map.pythSymbol)].filter(Boolean) : pyth.contractsFromSymbols(list, map.pythPrefix);
  out.dataSources.push({ name: 'Pyth symbol metadata (public)', ok: contracts.length > 0, detail: map.spot ? `${map.pythSymbol}: id ${contracts[0]?.lazerId}, channel ${contracts[0]?.channel}, schedule from Pyth` : `${contracts.length} ${map.pythPrefix} contracts with last trading days and schedules` });
  if (!contracts.length) { out.gaps.push(`Pyth symbol ${map.pythSymbol || map.pythPrefix} not found`); return out; }
  const plan = settlementPlan(spec, contracts, market, nowSec);
  out.plan = { ...plan, sessions: plan.sessions.map((s) => ({ day: s.day, contract: s.contract.symbol, next: s.next?.symbol || null, open: s.open, close: s.close, settleT: s.settleT })) };
  const final = plan.final;
  if (!final) { out.gaps.push('No trading session found for the market window.'); return out; }
  const active = { contract: final.contract, next: final.next };
  const sched = parseSchedule(final.contract.schedule);
  const liquidityAt = (t) => liquidityState(sched, map.instrument, t * 1000);

  // Data window: the market window if it has started, else the most recent lookback of the same feed.
  const dataTo = Math.min(nowSec, plan.windowTo);
  const dataFrom = plan.started ? Math.max(plan.windowFrom, dataTo - 4 * 24 * H) : nowSec - o.lookbackHours * H;
  out.dataWindow = { from: dataFrom, to: dataTo, mode: plan.ended ? 'settled-window' : plan.started ? 'live-window' : 'lookback-before-window' };

  // Prior close for up/down markets.
  let priorSession = null;
  if (spec.kind === 'close-vs-prior-close') {
    const pd = priorReferenceDay(spec, sched, final.day);
    if (pd) { const s = sessionForDay(sched, pd); priorSession = { day: pd, open: s.open / 1000, close: s.close / 1000, settleT: closeCandleT(spec, pd) ?? s.close / 1000 - 60 }; }
    out.priorSession = priorSession;
  }
  const seriesFrom = Math.min(dataFrom, priorSession ? priorSession.settleT - 3 * H : dataFrom);

  const openAt = (t) => isOpen(sched, t * 1000);
  const settleSoon = final.settleT <= dataTo;
  const target = await pyth.settlementSeries(final.contract, seriesFrom, dataTo, {
    withPrints: true, sampleEverySec: o.sampleEverySec ?? 3600, isOpen: openAt,
    denseFrom: settleSoon ? final.settleT - 9 * 60 : priorSession ? priorSession.settleT - 4 * 60 : null,
    denseTo: settleSoon ? final.settleT + 60 : priorSession ? priorSession.settleT + 60 : null,
  });
  out.dataSources.push({ name: `Pyth ${final.contract.symbol} (settlement feed)`, ok: target.candles.length > 0, detail: target.source ? `${target.candles.length} 1m candles + ${target.prints.length} prints (${target.printsSampling?.windows ?? 0} sampled 60s windows) via ${target.source}` : target.error });
  if (!target.candles.length) out.gaps.push(`Settlement feed ${final.contract.symbol} not readable: ${target.error || 'no data recorded yet'}`);

  const refs = await references(spec, active, seriesFrom, dataTo, list);
  for (const r of refs) out.dataSources.push({ name: r.name, ok: r.candles.length > 0, detail: r.error ? r.error : `${r.candles.length} 1m candles`, independent: r.independent });

  // Detectors
  const inWindow = (c) => c.t >= dataFrom && c.t <= dataTo;
  const tc = target.candles.filter(inWindow);
  const rc = refs.map((r) => ({ ...r, candles: r.candles.filter(inWindow) }));
  const settleInData = tc.some((c) => c.t === final.settleT) ? final.settleT : null;
  const params = applyCalibration(calibrate(tc), calibrationFor(map.instrument)); // 90-day p99 thresholds when available
  out.params = params;
  const factors = {};
  factors.divergence = D.divergence(tc, rc, { field: spec.field === 'low' || spec.field === 'high' ? spec.field : 'close', settleT: settleInData, ...params });
  factors.spikeRevert = D.spikeRevert(tc, rc, params);
  factors.repeated = D.repeatedPrints(tc, liquidityAt);
  factors.staleness = tc.length ? D.staleness(tc, target.prints, liquidityAt, { from: dataFrom, to: dataTo, samplingGapSec: 90, printStaleSec: 5 }) : { measured: false, severity: 0 };
  factors.confidence = D.confidenceBlowout(target.prints.filter((p) => p.t >= dataFrom - 86400), params);
  if (factors.confidence.measured) factors.confidence.atSettle = D.confidenceAt(target.prints, final.settleT);
  const minutes = [];
  for (let t = final.open; t < final.close; t += 60) minutes.push(t);
  factors.thin = D.thinHours(minutes, liquidityAt, spec.kind?.startsWith('hit') ? null : final.settleT);
  if (!tc.length) for (const k of ['divergence', 'spikeRevert', 'repeated', 'staleness']) factors[k] = { measured: false, severity: 0, note: 'settlement feed not readable' };

  // Distance to threshold: Pyth price if we have it, else a clearly-labelled proxy.
  const hl = refs.find((r) => r.kind === 'hyperliquid');
  const priceSrc = tc.length ? { name: final.contract.symbol, candles: tc, proxy: false } : hl?.candles.length ? { name: `${hl.name} (proxy, not the settlement feed; basis to ${final.contract.symbol} unknown)`, candles: hl.candles.filter(inWindow), proxy: true } : null;
  let threshold = spec.threshold;
  let thresholdNote = null;
  if (spec.kind === 'close-vs-prior-close' && priorSession) {
    const src = tc.length ? target.candles : hl?.candles || [];
    const ec = effectiveClose(src, { settleT: priorSession.settleT, sessionOpen: priorSession.open });
    const pc = ec?.candle;
    threshold = pc ? pc.c : null;
    thresholdNote = pc ? `prior close ${priorSession.day} (${tc.length ? 'Pyth' : 'proxy'} candle ${new Date(pc.t * 1000).toISOString().slice(11, 16)}Z${ec.exact ? '' : ', last valid price before the close candle'})` : 'prior close not available';
  }
  if (priceSrc && priceSrc.candles.length && threshold != null) {
    const cs = priceSrc.candles;
    const inMkt = cs.filter((c) => c.t >= plan.windowFrom);
    // Close-type markets: never use a price after the settlement candle (FX keeps trading after 16:59 ET).
    const lastUpToSettle = (cs.filter((c) => c.t <= final.settleT).at(-1) || cs.at(-1)).c;
    const price = !plan.started || !inMkt.length ? lastUpToSettle : spec.kind === 'hit-high' ? Math.max(...inMkt.map((c) => c.h)) : spec.kind === 'hit-low' ? Math.min(...inMkt.map((c) => c.l)) : lastUpToSettle;
    const hit = alreadyHit(spec, threshold, plan.started ? inMkt : []);
    if (hit) {
      // A hit market whose line was already reached: distance no longer means anything; don't score it.
      factors.distance = { measured: false, severity: 0, alreadyHit: true, hitAt: hit.t, note: `line already reached at ${new Date(hit.t * 1000).toISOString().slice(0, 16)}Z: distance no longer applies (check that minute for a spike instead)` };
    } else {
      const worst = factors.spikeRevert.worst?.sizeBps ?? null;
      factors.distance = D.thresholdDistance({ price, threshold, comparator: spec.comparator || '>', candles: cs, minutesLeft: Math.max(0, (final.settleT - nowSec) / 60), worstSpikeBps: worst });
      factors.distance.priceSource = priceSrc.name;
      factors.distance.proxy = priceSrc.proxy;
      factors.distance.thresholdNote = thresholdNote;
      if (priceSrc.proxy) factors.distance.severity *= 0.5; // proxy evidence counts half
    }
  } else factors.distance = { measured: false, severity: 0, note: threshold == null ? 'no threshold' : 'no price source' };
  out.factors = factors;

  // On-chain record on Sui, read through Tatum (~2 calls), compared with Pyth itself.
  out.onchain = map.spot ? await onchainRecord(final.contract, nowSec) : { ok: false, error: `no Pyth PriceInfoObject for ${final.contract.symbol} on Sui (feed not posted there)` };

  // Memory loop
  const feedFamily = map.pythPrefix || map.pythSymbol;
  const ctx = { instrument: map.instrument, feed: final.contract.symbol, feedFamily, bucket: bucketAt(final, final.settleT, sched, map.instrument), settleMinuteET: etMinute(final.settleT * 1000), settleT: final.settleT };
  out.series = { channel: target.channel, candles: target.candles.length, prints: target.prints.length };
  out._target = target; out._refs = refs; // raw, for evidence; stripped before saving
  out.context = { ...ctx, liquidityNote: LIQUIDITY[map.instrument]?.note };
  out.bucketAt = (t) => bucketAt(plan.sessions.find((s) => t >= s.open && t < s.close) || null, t, sched, map.instrument); // function: dropped by JSON
  let memories = [];
  let searched = false;
  out.memory = { backend: mem.backendName(), recalled: 0, errors: [] };
  if (o.memory) {
    const ready = await mem.walrusReady();
    if (!ready.ok) out.memory.errors.push(ready.reason);
    else {
      const r = await mem.recallForFeed({ instrument: map.instrument, feed: final.contract.symbol, patterns: Object.keys(D.WEIGHTS) });
      memories = [...r.incidents, ...r.userNotes];
      out.memory.recalled = memories.length;
      out.memory.errors.push(...r.errors);
      searched = !r.errors.some((e) => e.startsWith('alibi-incidents'));
    }
  } else out.memory.errors.push('memory disabled for this run');
  out.learning = applyMemories(factors, memories, ctx, { nowMs: nowSec * 1000, memorySearched: searched });
  out.score = out.learning.after;
  return out;
}

/** Instrument-agnostic thresholds from the feed's own behaviour (median 1m range), with floors. */
export function calibrate(candles) {
  const r = candles.map((c) => D.bps(c.h, c.l)).filter((x) => x > 0);
  const med = D.median(r);
  const m = Number.isFinite(med) ? med : 5;
  return { median1mRangeBps: Math.round(m * 10) / 10, spikeBps: Math.max(15, Math.round(6 * m)), divergenceFloorBps: Math.max(8, Math.round(2.5 * m)), divergenceFullBps: Math.max(60, Math.round(15 * m)) };
}

/** For hit markets: the first in-window candle at/beyond the line, or null. Pure. */
export function alreadyHit(spec, threshold, candles) {
  if (!spec.kind?.startsWith('hit') || !Number.isFinite(threshold)) return null;
  return candles.find((x) => (spec.kind === 'hit-high' ? x.h >= threshold : x.l <= threshold)) || null;
}
