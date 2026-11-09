#!/usr/bin/env node
// Post a Pyth update for a spot feed on Sui (simulate by default), read it back through Tatum, remember the evidence.
// Usage: node src/post.js <XAU|XAG|EURUSD> [--execute] [--context "why"]
//        node src/post.js --remember-logged   (writes evidence memories for already-executed txs in results/sui-tx.jsonl)
import { loadEnv } from './env.js';
import * as pyth from './pyth.js';
import { PYTH_CODES } from './rules.js';
import { postPythUpdate, evidenceRecord, realTxCount } from './evidence.js';
import { readPythPriceInfo, callCounts } from './sui.js';
import * as mem from './memory.js';
import { readJsonl, path } from './store.js';

loadEnv();
const args = process.argv.slice(2);
const list = await pyth.symbols();
const byHermes = new Map(Object.values(PYTH_CODES).filter((m) => m.spot).map((m) => { const f = pyth.feedBySymbol(list, m.pythSymbol); return ['0x' + f.hermesId.replace(/^0x/, ''), m.pythSymbol]; }));
const ctxArg = args.includes('--context') ? args[args.indexOf('--context') + 1] : 'Alibi evidence: settlement feed anchored on Sui';

if (args.includes('--remember-logged')) {
  const done = new Set(readJsonl(path('results', 'memories.jsonl')).filter((m) => m.namespace === mem.NS.evidence && m.ok).map((m) => (m.text.match(/digest=(\w+)/) || [])[1]));
  for (const tx of readJsonl(path('results', 'sui-tx.jsonl')).filter((t) => t.executed && t.ok && !done.has(t.digest))) {
    const sym = byHermes.get(tx.feedId);
    const rb = await readPythPriceInfo(tx.feedId); // current state of the object, read through Tatum
    const rec = evidenceRecord(sym, tx, rb, `${ctxArg}; object read back ${new Date().toISOString().slice(0, 16)}Z`);
    const w = await mem.remember(mem.NS.evidence, 'evidence', rec);
    console.log(`remembered evidence ${w.blobId}: ${w.text.slice(0, 160)}`);
  }
} else {
  const inst = args.find((a) => !a.startsWith('--'));
  const map = Object.values(PYTH_CODES).find((m) => m.instrument === inst && m.spot);
  if (!map) { console.error('usage: node src/post.js <XAU|XAG|EURUSD> [--execute]'); process.exit(2); }
  const feed = pyth.feedBySymbol(list, map.pythSymbol);
  const r = await postPythUpdate(feed.hermesId, { execute: args.includes('--execute') });
  console.log(JSON.stringify(r, null, 2));
  if (r.digest) {
    const w = await mem.remember(mem.NS.evidence, 'evidence', evidenceRecord(map.pythSymbol, { kind: r.action, digest: r.digest, provider: r.executedVia, gasMist: r.gasMist }, r.readBack, ctxArg));
    console.log(`remembered evidence ${w.blobId}`);
  }
}
console.log(`real Sui tx: ${realTxCount()} · tatum calls: ${callCounts().tatumTotal}`);
