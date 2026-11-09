// The visible learning loop. Pure: detector factors + decoded Walrus memories in, before/after out.
// Matching is done in code (feed, time of day, pattern), never by the embedding.
//
// HISTORY FACTOR (20 of the 100 points, see WEIGHTS in detect.js):
//   precedent  = a remembered incident on the SAME Pyth feed whose time of day (ET) falls inside this market's
//                settlement window: from 14 min before to 6 min after the reference candle (e.g. 16:45–17:05 ET
//                around a 16:59 ET candle).
//   weight     = severityScale × recency, severityScale = min(1, severity / 3) (severity is the detector's own
//                multiple of its threshold), recency = 0.5^(age days / 30); simulated memories count half.
//   other      = incidents on the same feed at other times of day count at 0.15 × weight.
//   severity   = 1 − exp(−Σ weights)  (saturates: one strong, 3-day-old precedent ≈ 0.6; several → close to 1).
//   With a 90-day calibration (proof/calibration.json) severity is re-measured against today's p99 threshold
//   (confidence ratio ÷ confRatio, spike size ÷ spikeBps, divergence ÷ divergenceBps), not the value stored at scan time.
//   Memories for other feeds/instruments are ignored and listed with the reason.
// User verdicts ("benign") in alibi-user lower the matching live factor and the history factor.
import { score, clamp01, WEIGHTS } from './detect.js';

export const PATTERN_TO_FACTOR = { 'spike-revert': 'spikeRevert', divergence: 'divergence', repeated: 'repeated', stale: 'staleness', confidence: 'confidence', 'thin-close': 'thin' };
// missingSeverity: a memory without a recorded severity gets the lowest possible weight (0): listed, never scored.
export const HISTORY = { halfLifeDays: 30, before: 14, after: 6, otherTimeWeight: 0.15, severityDivisor: 3, simulatedWeight: 0.5, missingSeverity: 0 };

/** ET minute-of-day of a timestamp (ms). */
export function etMinute(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return +p.hour * 60 + +p.minute;
}
const fmtDay = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const short = (id) => (id ? `${String(id).slice(0, 8)}…` : 'unknown');

/** One plain line for a precedent, e.g. "6 Nov: confidence 23.5× normal, 4 min before this market's reference candle". */
export function describePrecedent(rec, offsetMin) {
  const what = rec.pattern === 'confidence' ? `confidence ${rec.ratio}× normal${rec.conf_bps ? ` (${rec.conf_bps} bps)` : ''}`
    : rec.pattern === 'spike-revert' ? `${rec.size_bps} bps spike-and-revert (${rec.dir || 'n/a'}), back within ${rec.reverted_min ?? '?'} min, reference moved ${rec.ref_move_bps ?? '?'} bps`
    : rec.pattern === 'divergence' ? `${rec.size_bps} bps away from ${rec.ref || 'the reference'} for ${rec.minutes ?? '?'} min`
    : rec.pattern === 'stale' ? `no fresh price for ${rec.gap_min} min`
    : rec.pattern === 'repeated' ? `same price repeated for ${rec.minutes} min` : rec.pattern;
  const when = offsetMin == null ? '' : offsetMin === 0 ? ', on this market\'s reference candle' : offsetMin > 0 ? `, ${offsetMin} min before this market's reference candle` : `, ${-offsetMin} min after this market's reference candle`;
  return `${fmtDay(Date.parse(rec.when))}: ${what}${when}`;
}

/** Severity of a remembered incident on today's scale: re-measured against the calibration when possible. Pure. */
export function effectiveSeverity(rec, cal) {
  const stored = Number(rec.severity);
  const num = (k) => Number(rec[k]);
  if (cal) {
    if (rec.pattern === 'confidence' && num('ratio') > 0 && cal.confRatio > 0) return { value: num('ratio') / cal.confRatio, basis: `ratio ${rec.ratio}× ÷ 90-day p99 ${cal.confRatio}×` };
    if (rec.pattern === 'spike-revert' && num('size_bps') > 0 && cal.spikeBps > 0) return { value: num('size_bps') / cal.spikeBps, basis: `${rec.size_bps} bps ÷ 90-day p99 ${cal.spikeBps} bps` };
    if (rec.pattern === 'divergence' && num('size_bps') > 0 && cal.divergenceBps > 0) return { value: num('size_bps') / cal.divergenceBps, basis: `${rec.size_bps} bps ÷ 90-day p99 ${cal.divergenceBps} bps` };
  }
  return Number.isFinite(stored) ? { value: stored, basis: 'stored at scan time' } : { value: HISTORY.missingSeverity, basis: 'missing → lowest' };
}

/** Verdict wording that matches what the precedents actually show (strongest precedent's pattern + its timing). */
export const HEADLINES = {
  confidence: "Pyth's confidence has blown out",
  'spike-revert': 'This feed has spiked and snapped back',
  divergence: 'This feed has broken away from other markets',
  stale: 'This feed has gone stale',
  repeated: 'This feed has frozen on one price',
};
/** "at this exact settlement minute" only when the offset is 0; otherwise "near this settlement minute (4 min before)". */
export function timingPhrase(offsetMin) {
  if (offsetMin == null) return 'in this settlement window';
  if (offsetMin === 0) return 'at this exact settlement minute';
  return `near this settlement minute (${Math.abs(offsetMin)} min ${offsetMin > 0 ? 'before' : 'after'} it)`;
}
export function precedentHeadline(precedents) {
  const scored = precedents.filter((p) => p.weight > 0);
  if (!scored.length) return null;
  const lead = scored[0];
  const others = [...new Set(scored.map((p) => p.pattern))].filter((x) => x !== lead.pattern);
  return `${HEADLINES[lead.pattern] || 'This feed has misbehaved'} before, ${timingPhrase(lead.offsetMin)}${others.length ? ` (and shown ${others.join(', ')} there)` : ''}`;
}

/**
 * Sorts recalled memories into precedents (same feed, same settlement window), other same-feed incidents,
 * verdicts, and ignored. ctx: { instrument, feed, settleMinuteET }.
 */
export function classify(memories, ctx, nowMs = Date.now()) {
  const out = { sameWindow: [], sameFeedOther: [], verdicts: [], ignored: [] };
  const seenBlob = new Set();
  const seenEvent = new Map(); // feed|pattern|when → blobId: one real event counts once, however many times it was written
  // strongest first, so when the same event was written twice the strongest copy is the one kept (stable for ties)
  const sevOf = (m) => (m.record ? effectiveSeverity(m.record, ctx.calibration).value : HISTORY.missingSeverity);
  const ordered = memories.map((m, i) => ({ m, i })).sort((a, b) => sevOf(b.m) - sevOf(a.m) || a.i - b.i).map((x) => x.m);
  for (const m of ordered) {
    const rec = m.record;
    if (m.blobId && seenBlob.has(m.blobId)) { out.ignored.push({ blobId: m.blobId, reason: 'same blob recalled twice' }); continue; }
    if (m.blobId) seenBlob.add(m.blobId);
    if (!rec) { out.ignored.push({ blobId: m.blobId, reason: 'not an Alibi record' }); continue; }
    if (rec.kind === 'verdict') { if (rec.instrument === ctx.instrument) out.verdicts.push(m); else out.ignored.push({ blobId: m.blobId, reason: `verdict for ${rec.instrument}` }); continue; }
    if (rec.kind !== 'incident') { out.ignored.push({ blobId: m.blobId, reason: `${rec.kind} record, not an incident` }); continue; }
    if (rec.instrument !== ctx.instrument || (rec.feed && ctx.feed && rec.feed !== ctx.feed)) { out.ignored.push({ blobId: m.blobId, reason: `different feed (${rec.feed || rec.instrument})` }); continue; }
    const t = Date.parse(rec.when || '');
    if (!Number.isFinite(t)) { out.ignored.push({ blobId: m.blobId, reason: 'no time' }); continue; }
    const eventKey = `${rec.feed || rec.instrument}|${rec.pattern}|${t}`;
    if (seenEvent.has(eventKey)) { out.ignored.push({ blobId: m.blobId, reason: `duplicate of ${short(seenEvent.get(eventKey))} (same feed, pattern and minute)` }); continue; }
    seenEvent.set(eventKey, m.blobId);
    if (t > nowMs) { out.ignored.push({ blobId: m.blobId, reason: 'in the future' }); continue; }
    const ageDays = (nowMs - t) / 86400000;
    const recency = 0.5 ** (ageDays / HISTORY.halfLifeDays);
    const eff = effectiveSeverity(rec, ctx.calibration);
    const sevScale = Math.min(1, eff.value / HISTORY.severityDivisor);
    let w = sevScale * recency * (rec.simulated === 'yes' ? HISTORY.simulatedWeight : 1);
    let offset = null;
    if (ctx.settleMinuteET != null) {
      offset = ctx.settleMinuteET - etMinute(t); // + = before the reference candle
      if (offset > 720) offset -= 1440; if (offset < -720) offset += 1440;
    }
    const inWindow = offset != null && offset <= HISTORY.before && offset >= -HISTORY.after;
    if (!inWindow) w *= HISTORY.otherTimeWeight;
    const p = { blobId: m.blobId, createdAt: m.createdAt || null, when: rec.when, pattern: rec.pattern, severity: Math.round(eff.value * 100) / 100, severityBasis: eff.basis, ageDays: Math.round(ageDays * 10) / 10, weight: Math.round(w * 1000) / 1000, offsetMin: offset, line: describePrecedent(rec, inWindow ? offset : null) + (inWindow ? '' : ` (at ${new Date(t).toISOString().slice(11, 16)}Z, outside the settlement window)`), text: m.text, record: rec };
    (inWindow ? out.sameWindow : out.sameFeedOther).push(p);
  }
  out.sameWindow.sort((a, b) => b.weight - a.weight);
  out.sameFeedOther.sort((a, b) => b.weight - a.weight);
  return out;
}

/** The history factor from classified memories. */
export function historyFactor(cls, { memorySearched = true } = {}) {
  if (!memorySearched) return { measured: false, severity: 0, note: 'Walrus Memory not searched this run' };
  const sum = [...cls.sameWindow, ...cls.sameFeedOther].reduce((a, p) => a + p.weight, 0);
  let severity = 1 - Math.exp(-sum);
  const benign = cls.verdicts.filter((v) => v.record.verdict === 'benign').length;
  if (benign) severity *= 0.5 ** benign;
  return { measured: true, severity: clamp01(severity), precedents: cls.sameWindow.length, otherSameFeed: cls.sameFeedOther.length, benignVerdicts: benign, weightSum: Math.round(sum * 1000) / 1000 };
}

/**
 * factors: live detector outputs. memories: [{blobId, text, record, createdAt}] from Walrus.
 * ctx: { instrument, feed, settleMinuteET }. Returns before (live only) / after (live + history).
 */
export function applyMemories(factors, memories, ctx, { nowMs = Date.now(), weights = WEIGHTS, memorySearched = true } = {}) {
  const live = { ...factors, history: memorySearched ? { measured: true, severity: 0, precedents: 0, otherSameFeed: 0 } : { measured: false, severity: 0, note: 'Walrus Memory not searched this run' } };
  const before = score(live, weights);
  const cls = classify(memories, ctx, nowMs);
  const adjusted = Object.fromEntries(Object.entries(factors).map(([k, f]) => [k, f ? { ...f } : f]));
  const changes = [];
  // user verdicts: "benign" lowers the matching live factor (bounded), and is named in the change list
  for (const v of cls.verdicts) {
    const k = PATTERN_TO_FACTOR[v.record.pattern];
    const f = adjusted[k];
    if (!f?.measured || v.record.verdict !== 'benign') continue;
    const from = f.severity;
    f.severity = clamp01(from - 0.3);
    changes.push({ factor: k, from: round2(from), to: round2(f.severity), points: round1((f.severity - from) * (weights[k] || 0)), memories: [{ blobId: v.blobId, text: v.text }] });
  }
  adjusted.history = historyFactor(cls, { memorySearched });
  adjusted.history.lines = cls.sameWindow.map((p) => p.line);
  const after = score(adjusted, weights);
  const hp = round1(adjusted.history.severity * (weights.history || 0));
  if (hp > 0) changes.push({ factor: 'history', from: 0, to: round2(adjusted.history.severity), points: hp, memories: [...cls.sameWindow, ...cls.sameFeedOther].map((p) => ({ blobId: p.blobId, weight: p.weight, text: p.text })) });
  const used = [...cls.sameWindow, ...cls.sameFeedOther].map((p) => ({ blobId: p.blobId, factor: 'history', weight: p.weight, ageDays: p.ageDays, text: p.text, createdAt: p.createdAt }));
  return { before, after, delta: after.score - before.score, changes, used, ignored: cls.ignored, precedents: cls.sameWindow, otherSameFeed: cls.sameFeedOther, history: adjusted.history, explanation: explain(cls, before, after, hp) };
}

function explain(cls, before, after, hp) {
  if (!cls.sameWindow.length && !cls.sameFeedOther.length) return 'No past incident in Walrus Memory matches this feed, so the score is from live data only.';
  const n = cls.sameWindow.length;
  const lead = n ? `${n} precedent${n === 1 ? '' : 's'} in this settlement window (${cls.sameWindow.map((p) => short(p.blobId)).join(', ')})` : 'no precedent at this settlement window';
  const other = cls.sameFeedOther.length ? ` and ${cls.sameFeedOther.length} other incident${cls.sameFeedOther.length === 1 ? '' : 's'} on this feed` : '';
  return `Walrus Memory found ${lead}${other}: the history factor adds ${hp} points (score ${before.score} → ${after.score}).`;
}
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

/** Builds incident records (for memory.remember) from detector output. Only real detections; never invented. */
export function incidentsFrom(factors, ctx, { source = 'live-check', simulated = false } = {}) {
  const out = [];
  const base = { instrument: ctx.instrument, feed: ctx.feed, bucket: ctx.bucket, source, simulated: simulated ? 'yes' : 'no' };
  for (const e of factors.spikeRevert?.events || []) if (e.isolated) out.push({ ...base, pattern: 'spike-revert', when: new Date(e.t * 1000).toISOString(), size_bps: e.sizeBps, dir: e.dir, ref: e.ref, ref_move_bps: e.refMoveBps, reverted_min: e.revertedAfterMin, bucket: ctx.bucketAt ? ctx.bucketAt(e.t) : base.bucket });
  const d = factors.divergence;
  if (d?.measured && d.severity >= 0.3) {
    const best = d.perRef.find((r) => r.name === d.best);
    out.push({ ...base, pattern: 'divergence', when: best?.at ? new Date(best.at * 1000).toISOString() : undefined, size_bps: Math.abs(d.headlineBps), ref: d.best });
  }
  for (const r of factors.repeated?.runs || []) if (r.minutes >= 10) out.push({ ...base, pattern: 'repeated', when: new Date(r.start * 1000).toISOString(), minutes: r.minutes });
  const s = factors.staleness;
  if (s?.maxGapSec >= 600) { const g = s.gaps.sort((a, b) => b.seconds - a.seconds)[0]; out.push({ ...base, pattern: 'stale', when: new Date(g.from * 1000).toISOString(), gap_min: Math.round(g.seconds / 60) }); }
  const c = factors.confidence;
  if (c?.measured && c.ratio >= 6) out.push({ ...base, pattern: 'confidence', when: new Date(c.worstAt * 1000).toISOString(), ratio: c.ratio });
  return out;
}
