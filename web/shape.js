// Read-only adapter: turns the engine's report + raw check into the JSON the website renders.
// Never adds numbers of its own: every value comes from the engine output it is given.
import { WEIGHTS } from '../src/detect.js';

const LIVE_FACTORS = [
  ['spikeRevert', 'Spike and snap-back'],
  ['staleness', 'Stale or missing prints'],
  ['repeated', 'Frozen identical prints'],
  ['confidence', 'Confidence blow-out'],
  ['thin', 'Thin trading hours'],
  ['divergence', 'Divergence vs Hyperliquid'],
  ['distance', 'Distance to the line'],
];
const fmt = (n, d = 1) => (Number.isFinite(n) ? +n.toFixed(d) : null);
const iso = (t) => (t == null ? null : new Date(t * 1000).toISOString());

function factorDetail(key, f) {
  if (!f) return null;
  if (!f.measured) return f.note || 'not measured on this run';
  switch (key) {
    case 'divergence': {
      const r = f.perRef?.[0];
      return r ? `widest ${fmt(r.maxAbsBps)} bps vs ${r.name} (95% of minutes within ${fmt(r.p95AbsBps)} bps), basis removed` : 'no reference minutes overlapped';
    }
    case 'spikeRevert':
      return f.worst ? `worst wick ${fmt(f.worst.sizeBps)} bps that came back within 5 min; ${f.events?.length ?? 0} event(s)` : 'no wick past the feed-calibrated threshold that snapped back';
    case 'repeated':
      return f.maxRun ? `longest identical run ${f.maxRun} min while open` : 'no flat identical prints for 5+ min while open';
    case 'staleness':
      return f.maxGapSec ? `longest gap ${f.maxGapSec} s while open` : 'no missing minutes or publish gaps while open';
    case 'confidence':
      return f.ratio ? `widest ${fmt(f.worstConfBps)} bps, ${fmt(f.ratio)}× its median ${fmt(f.medianConfBps)} bps` : 'confidence stayed near its median';
    case 'thin':
      return `settlement minute is ${f.settleState ?? 'n/a'}; ${Math.round((f.thinShare ?? 0) * 100)}% of the open window outside core liquidity`;
    case 'distance':
      return f.alreadyHit ? f.note : `${f.distanceBps > 0 ? '+' : ''}${fmt(f.distanceBps)} bps from the line (${fmt(f.movesAway, 2)} typical moves)${f.proxy ? ', proxy price' : ''}`;
    default:
      return null;
  }
}

function status(f, pts, w) {
  if (!f || !f.measured) return 'na';
  if (!pts) return 'pass';
  return pts / w >= 0.66 ? 'flag' : 'watch';
}

/** Fields of an ALIBI-INCIDENT v1 memory text, e.g. "pattern=confidence | ratio=23.5". */
export function parseMemoryText(text = '') {
  const o = {};
  for (const part of String(text).split('|').slice(1)) {
    const i = part.indexOf('=');
    if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  o.kind = (String(text).match(/^ALIBI-(\w+)/) || [])[1] || null;
  return o;
}

export function shapeCheck(rep, raw, meta = {}) {
  const d = rep.details || {};
  if (raw?.outOfScope || !d.rule) {
    return { kind: 'out-of-scope', verdict: rep.verdict, sentences: rep.sentences, market: raw?.market ? { question: raw.market.question, url: raw.market.url } : null, at: raw?.at, ...meta };
  }
  const factors = raw?.factors || {};
  const matrix = LIVE_FACTORS.map(([key, label]) => {
    const f = factors[key];
    const w = WEIGHTS[key];
    const pts = f?.measured ? fmt(w * (f.severity || 0), 1) : null;
    const reason = (d.reasons || []).find((r) => r.factor === key);
    const nm = (d.notMeasured || []).find((n) => n.factor === key);
    return { key, label, weight: w, points: pts, status: status(f, pts, w), text: reason?.text || null, detail: nm?.note || factorDetail(key, f) };
  });
  const hist = (d.reasons || []).find((r) => r.factor === 'history');
  const memTexts = new Map();
  for (const c of d.memory?.changes || []) for (const m of c.memories || []) memTexts.set(m.blobId, m.text);
  const prec = (list, inWindow) => (list || []).map((p) => {
    const f = parseMemoryText(memTexts.get(p.blobId));
    return { line: p.line, blobId: p.blobId, weight: p.weight, ageDays: p.ageDays ?? null, inWindow, when: f.when || null, evidence: /^https:\/\/pythdata\.app\//.test(f.evidence || '') ? f.evidence : null };
  });
  const oc = d.onchain;
  return {
    kind: 'report',
    at: raw?.at || null,
    verdict: rep.verdict,
    headline: rep.verdict.split(' — ')[0],
    band: rep.band,
    score: rep.score,
    complete: rep.complete,
    sentences: rep.sentences,
    market: { question: d.market.question, url: d.market.url, endDate: d.market.endDate, outcomes: d.market.outcomes },
    rule: {
      feed: d.rule.pythCode,
      contract: d.settlement?.contract || null,
      kind: d.rule.kind,
      field: d.rule.field,
      comparator: d.rule.comparator,
      threshold: d.rule.threshold ?? factors.distance?.threshold ?? null,
      thresholdNote: factors.distance?.thresholdNote || null,
      candle: d.settlement?.settlementCandle || null,
      priorClose: d.settlement?.priorClose || null,
      day: d.settlement?.day || null,
      session: d.settlement ? `${d.settlement.sessionOpen} → ${d.settlement.sessionClose}` : null,
      tieRule: d.rule.tieRule,
      fallbackSource: d.rule.fallbackSource || null,
      ruleCheck: d.rule.ruleCheck ? { provider: d.rule.ruleCheck.provider, agreements: d.rule.ruleCheck.agreements, disagreements: d.rule.ruleCheck.disagreements.length } : null,
      edgeCases: d.edgeCases || [],
      windowNotes: d.windowNotes || [],
    },
    matrix,
    history: { weight: WEIGHTS.history, points: hist?.points ?? 0, text: hist?.text || null },
    memory: { backend: d.memory?.backend, recalled: d.memory?.recalled ?? 0, before: d.memory?.before ?? null, after: d.memory?.after ?? null, errors: d.memory?.errors || [], ignored: d.memory?.ignored?.length ?? 0 },
    precedents: [...prec(d.precedents, true), ...prec(d.otherSameFeed, false)],
    onchain: oc ? {
      ok: !!oc.ok, error: oc.ok ? null : oc.error, line: oc.line, notes: oc.notes || [], provider: oc.provider || null,
      providers: oc.providers || [], tatumCalls: oc.tatumCalls ?? null, objectId: oc.objectId || null, version: oc.version || null,
      checkpoint: oc.checkpoint || null, price: oc.price ?? null, conf: oc.conf ?? null, publishTime: iso(oc.publishTime), ageMin: oc.ageMin ?? null,
      vsLiveBps: oc.vsLiveBps ?? null, vsSameSecondBps: oc.vsSameSecondBps ?? null, status: oc.status || null, feed: oc.feed || null,
    } : null,
    sources: [
      ...(d.dataSources || []).map((s) => ({ name: s.name, ok: s.ok, detail: s.detail, independent: !!s.independent })),
      // Display-side rows for the two reads the engine reports elsewhere in the check
      ...(oc && !(d.dataSources || []).some((x) => /sui/i.test(x.name)) ? [{ name: `Sui mainnet via ${oc.provider === 'tatum' ? 'Tatum gRPC' : oc.provider || 'Tatum gRPC'}`, ok: !!oc.ok, detail: oc.ok ? `Pyth PriceInfoObject ${oc.objectId ? oc.objectId.slice(0, 10) + '…' : ''} read in ${oc.tatumCalls ?? '?'} call(s) at checkpoint ${oc.checkpoint ?? 'n/a'}` : oc.error || 'not read', independent: false }] : []),
      ...(d.memory && !(d.dataSources || []).some((x) => /walrus/i.test(x.name)) ? [{ name: `Walrus Memory (${d.memory.backend || 'n/a'})`, ok: !(d.memory.errors || []).length || (d.memory.recalled ?? 0) > 0, detail: `${d.memory.recalled ?? 0} memories recalled, ${(d.precedents || []).length} on this feed at its settlement window${(d.memory.errors || []).length ? `; note: ${d.memory.errors[0]}` : ''}`, independent: false }] : []),
    ],
    dataWindow: d.dataWindow || null,
    liquidityNote: d.liquidityNote || null,
    ...meta,
  };
}
