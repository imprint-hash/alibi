import { precedentHeadline } from './learn.js';
import { onchainLine } from './onchain.js';
// User-facing report: verdict, three plain sentences, then details. Early warning only; never promises an outcome.
const iso = (t) => (t == null ? 'n/a' : new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z');
const VERDICT = { low: 'Settlement price looks clean so far', elevated: 'Watch this settlement closely', high: 'High settlement risk' };

export function buildReport(r) {
  if (r.outOfScope) {
    return { verdict: 'Out of scope', sentences: [r.outOfScope, `Market: ${r.market.question}`, 'Alibi only checks markets that settle on a Pyth price feed.'], details: { market: r.market.url } };
  }
  const s = r.score || { score: null, band: 'low', reasons: [], notMeasured: [] };
  const final = r.plan?.sessions?.at(-1);
  const rule = describeRule(r.spec, final, r);
  const top = s.reasons.slice(0, 2).map((x) => x.text).join(' ');
  const gaps = r.gaps.length ? `Not yet checked: ${s.notMeasured.map((n) => n.factor).join(', ') || 'none'} (${r.gaps[0]}).` : '';
  const P = r.learning?.precedents || [];
  const memSentence = P.length
    ? `Walrus Memory holds ${P.length} precedent${P.length === 1 ? '' : 's'} for this feed in this settlement window, e.g. "${P[0].line}" (blob ${P[0].blobId.slice(0, 8)}…); that history adds ${r.learning.changes.find((c) => c.factor === 'history')?.points ?? 0} points.`
    : r.memory.errors.length && !r.learning?.used?.length ? `Memory not used this run: ${r.memory.errors[0]}.` : r.learning.explanation;
  const sentences = [rule, top || 'No live warning signs in the data Alibi could read.', [memSentence, gaps].filter(Boolean).join(' ')];
  return {
    // The precedent headline leads only when the score agrees (band elevated or high); otherwise it is a secondary line.
    verdict: precedentHeadline(P) && s.band !== 'low' && !s.notMeasured.some((n) => n.factor === 'divergence')
      ? `${precedentHeadline(P)} — Settlement Risk Score ${s.score}/100 (${P.length} precedent${P.length === 1 ? '' : 's'} in Walrus Memory)`
      : s.notMeasured.some((n) => n.factor === 'divergence' || n.factor === 'spikeRevert')
      ? `Incomplete check (settlement feed not read) — partial Settlement Risk Score ${s.score}/100`
      : `${VERDICT[s.band]} — Settlement Risk Score ${s.score}/100`,
    complete: !s.notMeasured.length,
    secondary: precedentHeadline(P) && s.band === 'low' ? `Precedent: ${precedentHeadline(P)} (${P.length} in Walrus Memory; ${P[0].line}).` : null,
    score: s.score,
    band: s.band,
    sentences,
    details: {
      market: { question: r.market.question, url: r.market.url, endDate: r.market.endDate, outcomes: r.market.outcomes },
      rule: { source: r.spec.source, pythCode: r.spec.pythCode, instrument: r.spec.instrument, kind: r.spec.kind, field: r.spec.field, comparator: r.spec.comparator, threshold: r.spec.threshold, tieRule: r.spec.tieRule, monthRule: r.spec.monthRule, rollSessions: r.spec.rollSessions, fallbackSource: r.spec.fallbackSource, ruleCheck: r.spec.ruleCheck },
      settlement: final ? { contract: final.contract, day: final.day, sessionOpen: iso(final.open), sessionClose: iso(final.close), settlementCandle: iso(final.settleT), priorClose: r.priorSession ? iso(r.priorSession.settleT) : undefined } : null,
      windowNotes: r.plan?.notes || [],
      edgeCases: r.spec.edgeCases,
      dataWindow: r.dataWindow ? { ...r.dataWindow, from: iso(r.dataWindow.from), to: iso(r.dataWindow.to) } : null,
      dataSources: r.dataSources,
      reasons: s.reasons,
      notMeasured: s.notMeasured,
      onchain: r.onchain ? { line: onchainLine(r.onchain), notes: r.onchain.notes || [], ...r.onchain } : null,
      precedents: P.map((p) => ({ line: p.line, blobId: p.blobId, weight: p.weight, ageDays: p.ageDays, severity: p.severity, severityBasis: p.severityBasis })),
      otherSameFeed: (r.learning?.otherSameFeed || []).map((p) => ({ line: p.line, blobId: p.blobId, weight: p.weight })),
      memory: { backend: r.memory.backend, recalled: r.memory.recalled, errors: r.memory.errors, before: r.learning.before.score, after: r.learning.after.score, changes: r.learning.changes, used: r.learning.used, ignored: r.learning.ignored },
      liquidityNote: r.context?.liquidityNote,
    },
  };
}

function describeRule(spec, final, r) {
  if (!final) return `Settles on Pyth ${spec.pythCode}, but Alibi found no trading session for the window.`;
  const what = spec.kind === 'close-vs-prior-close' ? 'the Close of one 1-minute candle vs the same candle on the prior trading day'
    : spec.kind === 'close-above' ? `the Close of the final 1-minute candle vs $${spec.threshold}`
    : spec.kind === 'hit-high' ? `any 1-minute High at or above $${spec.threshold}`
    : spec.kind === 'hit-low' ? `any 1-minute Low at or below $${spec.threshold}` : 'a Pyth price';
  const when = spec.kind?.startsWith('hit') ? `during ${r.plan.sessions.length} session(s) ending ${iso(final.close)}` : spec.closeCandleET ? `at ${iso(final.settleT)} (the candle timestamped ${spec.closeCandleET} ET on ${final.day})` : `at ${iso(final.settleT)} (last minute of the ${final.day} session)`;
  return `This market settles on ${what}, read from Pyth ${final.contract} ${when}.`;
}

export function renderText(rep) {
  const L = [];
  L.push('='.repeat(78));
  L.push(`ALIBI  ${rep.verdict}`);
  if (rep.secondary) L.push(`       ${rep.secondary}`);
  L.push('='.repeat(78));
  rep.sentences.forEach((x, i) => L.push(`${i + 1}. ${x}`));
  const d = rep.details;
  if (!d.rule) { L.push(''); L.push(`Market: ${d.market}`); return L.join('\n'); }
  L.push('');
  L.push(`Market   ${d.market.question}`);
  L.push(`         ${d.market.url}`);
  L.push(`         ${d.market.outcomes.map((o) => `${o.name} ${o.price}`).join(' / ')}  · ends ${d.market.endDate}`);
  L.push(`Rule     source=${d.rule.source} code=${d.rule.pythCode} kind=${d.rule.kind} field=${d.rule.field} ${d.rule.comparator ?? ''} ${d.rule.threshold ?? ''} tie=${d.rule.tieRule ?? 'n/a'} month=${d.rule.monthRule} roll=${d.rule.rollSessions ?? 'n/a'}`);
  if (d.rule.fallbackSource) L.push(`         fallback if Pyth has no price that day: ${d.rule.fallbackSource}`);
  const rc = d.rule.ruleCheck;
  L.push(`         rule check: AI=${rc.provider ?? 'none'}${rc.cached ? ' (cached)' : ''} agrees on [${rc.agreements.join(', ')}]${rc.disagreements.length ? ` DISAGREES on ${rc.disagreements.map((x) => `${x.field} (parser ${x.parser} vs AI ${x.ai})`).join(', ')}` : ''}${rc.filledByAi.length ? ` filled by AI: ${rc.filledByAi.join(', ')}` : ''}${rc.rejected.length ? ` rejected: ${rc.rejected.join('; ')}` : ''}`);
  if (d.settlement) L.push(`Settles  ${d.settlement.contract} · session ${d.settlement.sessionOpen} → ${d.settlement.sessionClose} · candle ${d.settlement.settlementCandle}${d.settlement.priorClose ? ` · prior close candle ${d.settlement.priorClose}` : ''}`);
  for (const n of d.windowNotes) L.push(`Window   ${n}`);
  if (d.dataWindow) L.push(`Data     ${d.dataWindow.mode}: ${d.dataWindow.from} → ${d.dataWindow.to}`);
  L.push('');
  L.push('Sources');
  for (const s of d.dataSources) L.push(`  ${s.ok ? 'ok  ' : 'MISS'} ${s.name}${s.independent ? ' [independent]' : ''}: ${s.detail}`);
  L.push('');
  L.push('Why this score');
  if (!d.reasons.length) L.push('  (no factor scored above zero)');
  for (const x of d.reasons) L.push(`  +${String(x.points).padStart(4)}  ${x.factor.padEnd(11)} ${x.text}`);
  for (const n of d.notMeasured) L.push(`   n/a  ${n.factor.padEnd(11)} ${n.note}`);
  L.push('');
  L.push('Evidence');
  if (d.onchain) { L.push(`  ${d.onchain.line}`); for (const n of d.onchain.notes) L.push(`  note: ${n}`); }
  L.push('');
  L.push('Precedents (from Walrus Memory: same feed, same settlement window)');
  if (!d.precedents?.length) L.push('  none');
  for (const p of d.precedents || []) L.push(`  - ${p.line}  [blob ${p.blobId}]${p.severityBasis ? `  (severity ${p.severity}: ${p.severityBasis})` : ''}`);
  if (d.otherSameFeed?.length) { L.push('  Other incidents on this feed (count at 0.15 weight):'); for (const p of d.otherSameFeed) L.push(`  - ${p.line}  [blob ${p.blobId}]`); }
  L.push('');
  L.push(`Memory   backend=${d.memory.backend} recalled=${d.memory.recalled} score live-only=${d.memory.before} with history=${d.memory.after}`);
  for (const e of d.memory.errors) L.push(`         note: ${e}`);
  for (const c of d.memory.changes) {
    L.push(`         ${c.factor}: severity ${c.from} → ${c.to} (${c.points >= 0 ? '+' : ''}${c.points} pts)`);
    for (const m of c.memories.slice(0, 6)) L.push(`           ← ${m.blobId}${m.weight != null ? ` (w=${m.weight})` : ''}`);
  }
  for (const m of d.memory.ignored.slice(0, 5)) L.push(`         ignored ${m.blobId}: ${m.reason}`);
  if (d.memory.ignored.length > 5) L.push(`         … and ${d.memory.ignored.length - 5} more ignored (full list in the --json report)`);
  L.push('');
  L.push('Edge cases from the rules');
  for (const e of d.edgeCases) L.push(`  - ${e}`);
  if (d.liquidityNote) L.push(`Thin-hours table (Alibi heuristic): ${d.liquidityNote}`);
  L.push('');
  L.push('Alibi is an early-warning and evidence tool. It does not predict or guarantee how a market or dispute resolves.');
  return L.join('\n');
}
