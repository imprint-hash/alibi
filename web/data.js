// Read-only adapter over the proof files. proof/ (committed) first, results/ (local, fresher) when present.
// Nothing here is typed in by hand: every count is read from a file at request time.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shapeCheck, parseMemoryText } from './shape.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const readJsonl = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

/** Pick the freshest of results/<name> and proof/<name>. */
function pick(name) {
  const c = ['results', 'proof'].map((dir) => join(ROOT, dir, name)).filter(existsSync);
  if (!c.length) return null;
  c.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return c[0];
}
const rel = (p) => (p ? p.slice(ROOT.length + 1) : null);

const NAMES = { XAU: 'Gold', XAG: 'Silver', EURUSD: 'EUR/USD' };
// Pyth price-feed IDs (public, from Hermes) for transactions whose Walrus evidence record does not name the feed.
const FEED_IDS = {
  '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2': 'Metal.XAU/USD',
  '0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e': 'Metal.XAG/USD',
  '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b': 'FX.EUR/USD',
};

function memories() {
  const file = pick('memories.jsonl');
  if (!file) return null;
  const rows = readJsonl(file).filter((m) => m.ok);
  const byNs = {};
  for (const m of rows) {
    const ns = m.namespace;
    byNs[ns] ||= { namespace: ns, writes: 0, misfiled: 0 };
    byNs[ns].writes++;
    if (m.intended && m.intended !== ns) byNs[ns].misfiled++;
  }
  for (const ns of ['alibi-incidents', 'alibi-sources', 'alibi-evidence', 'alibi-user']) byNs[ns] ||= { namespace: ns, writes: 0, misfiled: 0 };
  const incidents = rows.map((m) => ({ m, f: parseMemoryText(m.text) })).filter(({ f }) => f.kind === 'INCIDENT').map(({ m, f }) => ({
    blobId: m.blobId, at: m.at, feed: f.feed, instrument: f.instrument, name: NAMES[f.instrument] || f.instrument,
    pattern: f.pattern, when: f.when, bucket: f.bucket, simulated: f.simulated === 'yes',
    ratio: f.ratio != null ? +f.ratio : null, confBps: f.conf_bps != null ? +f.conf_bps : null, sizeBps: f.size_bps != null ? +f.size_bps : null,
    evidence: /^https:\/\/pythdata\.app\//.test(f.evidence || '') ? f.evidence : null,
  })).sort((a, b) => String(b.when).localeCompare(String(a.when)));
  const backends = [...new Set(rows.map((m) => m.backend))];
  return { file: rel(file), writes: rows.length, backends, namespaces: Object.values(byNs), incidents };
}

function suiTxs() {
  const file = pick('sui-tx.jsonl');
  if (!file) return null;
  const rows = readJsonl(file);
  // The Walrus evidence record for each digest names the feed (and is itself a blob).
  const ev = new Map();
  for (const m of readJsonl(pick('memories.jsonl'))) {
    if (!m.ok || m.namespace !== 'alibi-evidence') continue;
    const f = parseMemoryText(m.text);
    if (f.digest) ev.set(f.digest, { feed: f.feed, blobId: m.blobId });
  }
  const executed = rows.filter((t) => t.executed && t.ok && t.digest).map((t) => {
    const sim = [...rows].reverse().find((s) => !s.executed && s.feedId === t.feedId && Date.parse(s.at) <= Date.parse(t.at));
    const e = ev.get(t.digest) || {};
    return { at: t.at, kind: t.kind, digest: t.digest, feedId: t.feedId, feed: e.feed || FEED_IDS[t.feedId] || null, evidenceBlob: e.blobId || null, gasMist: t.gasMist, executedBy: t.provider, simulatedBy: sim?.simulated?.provider || sim?.provider || null };
  });
  return { file: rel(file), simulations: rows.filter((t) => !t.executed).length, executed, allSimulatedViaTatum: executed.length > 0 && executed.every((t) => t.simulatedBy === 'tatum') };
}

function counters(name) {
  const file = pick(name);
  if (!file) return null;
  const c = readJson(file) || {};
  const out = { file: rel(file), updated: c._updated || null, rows: [] };
  for (const [k, v] of Object.entries(c)) if (!k.startsWith('_') && typeof v === 'number') out.rows.push({ key: k, n: v });
  out.rows.sort((a, b) => b.n - a.n);
  return out;
}

function tatum() {
  const c = counters('tatum-calls.json');
  if (!c) return null;
  let ok = 0, quota = 0, errors = 0, pub = 0;
  for (const { key, n } of c.rows) {
    if (key.startsWith('tatum:')) { if (/:quota-error$/.test(key)) quota += n; else if (/:error$/.test(key)) errors += n; else ok += n; }
    else if (key.startsWith('public:')) pub += n;
  }
  return { ...c, tatumOk: ok, tatumQuotaErrors: quota, tatumErrors: errors, publicFallback: pub };
}

function tests() {
  const dir = join(ROOT, 'tests');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.test.js')); } catch {}
  const per = files.map((f) => {
    const src = readFileSync(join(dir, f), 'utf8');
    return { file: `tests/${f}`, cases: (src.match(/^\s*(?:test|it)\(/gm) || []).length };
  });
  if (!per.length) return null;
  return { files: per, cases: per.reduce((s, x) => s + x.cases, 0), note: 'test cases counted from tests/*.test.js (node --test)' };
}

function scan() {
  const file = pick('scan-latest.json');
  const s = readJson(file);
  if (!s) return null;
  return {
    file: rel(file), at: s.at, days: s.days,
    feeds: (s.summary || []).map((x) => ({ feed: x.feed, candles: x.candles, prints: x.prints, incidents: x.incidents, byPattern: x.byPattern })),
    incidents: (s.summary || []).reduce((n, x) => n + (x.incidents || 0), 0),
  };
}

function beforeAfter() {
  const fb = pick('before.json'), fa = pick('after.json');
  const b = readJson(fb), a = readJson(fa);
  if (!b || !a) return null;
  return {
    files: [rel(fb), rel(fa)], at: a.raw?.at, market: a.report?.details?.market?.question,
    before: { score: b.report.score, band: b.report.band, verdict: b.report.verdict, sentence: b.report.sentences?.[1] },
    after: { score: a.report.score, band: a.report.band, verdict: a.report.verdict, sentence: a.report.sentences?.[2] },
    changes: (a.report.details?.memory?.changes || []).map((c) => ({ factor: c.factor, from: c.from, to: c.to, points: c.points, memories: c.memories.map((m) => ({ blobId: m.blobId, weight: m.weight })) })),
  };
}

/** The saved report (proof/after.json), shaped like a live one and labelled with its run time. */
export function demoReport() {
  const f = pick('after.json');
  const a = readJson(f);
  if (!a?.report) return null;
  return shapeCheck(a.report, a.raw, { source: 'prebuilt', sourceFile: rel(f), cachedAt: a.raw?.at || null });
}

/** Paid agent checks (x402 on Sui): one row per verified USDC payment, from proof/agent-payments.jsonl. */
function agentPayments() {
  const file = pick('agent-payments.jsonl');
  if (!file) return null;
  const rows = readJsonl(file).filter((r) => r.digest).map((r) => ({ at: r.at, digest: r.digest, amountUsdc: r.amount_usdc, rate: r.rate, market: r.market, score: r.score, band: r.band, mode: r.mode, executedVia: r.executed_via, verifiedVia: r.verified_via, memoryBlob: r.memory_blob }));
  return { file: rel(file), payments: rows };
}

export function state() {
  const pyth = counters('pyth-calls.json');
  return {
    generatedAt: new Date().toISOString(),
    memory: memories(),
    sui: suiTxs(),
    tatum: tatum(),
    pyth: pyth ? { ...pyth, total: pyth.rows.reduce((s, r) => s + r.n, 0) } : null,
    tests: tests(),
    scan: scan(),
    beforeAfter: beforeAfter(),
    agent: agentPayments(),
  };
}
