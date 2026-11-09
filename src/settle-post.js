#!/usr/bin/env node
// Posts Pyth updates for gold and silver on Sui at the settlement minute (16:59 ET = 21:59Z in winter), through
// Tatum only. Waits until --at (UTC HH:MM:SS), then runs each feed with a gap. Writes the tx log, the proof mirror
// and one Walrus evidence memory per tx (via src/post.js logic). Stops (no fallback) if Tatum keeps refusing.
// Usage: ALIBI_MAX_SUI_TX=6 node src/settle-post.js [--at 21:58:30] [--gap 45] [--feeds XAU,XAG]
import { loadEnv } from './env.js';
import * as pyth from './pyth.js';
import { PYTH_CODES } from './rules.js';
import { postPythUpdate, evidenceRecord, realTxCount } from './evidence.js';
import * as mem from './memory.js';

loadEnv();
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const at = opt('--at', '21:58:30');
const gap = Number(opt('--gap', 45));
const feeds = opt('--feeds', 'XAU,XAG').split(',');
const log = (...a) => console.log(new Date().toISOString(), ...a);

const [hh, mm, ss] = at.split(':').map(Number);
const target = new Date(); target.setUTCHours(hh, mm, ss || 0, 0);
if (target < new Date()) { log(`target ${at}Z already passed today; running now`); }
else { log(`waiting until ${target.toISOString()}`); await new Promise((r) => setTimeout(r, target - Date.now())); }

const list = await pyth.symbols();
for (const [i, inst] of feeds.entries()) {
  if (i) await new Promise((r) => setTimeout(r, gap * 1000));
  const map = Object.values(PYTH_CODES).find((m) => m.instrument === inst && m.spot);
  const feed = pyth.feedBySymbol(list, map.pythSymbol);
  try {
    const r = await postPythUpdate(feed.hermesId, { execute: true });
    log(`${inst}: ${r.action} digest=${r.digest} via=${r.executedVia} ok=${r.executedOk} gas=${r.gasMist} readBack=${r.readBack?.provider} price=${r.readBack?.price?.price}`);
    const w = await mem.remember(mem.NS.evidence, 'evidence', evidenceRecord(map.pythSymbol, { kind: r.action, digest: r.digest, provider: r.executedVia, gasMist: r.gasMist }, r.readBack, `Alibi evidence: ${map.pythSymbol} posted at the 16:59 ET settlement minute via Tatum gRPC`));
    log(`${inst}: evidence memory ${w.blobId}`);
  } catch (e) {
    log(`${inst}: STOPPED — ${e.message} (no public-node fallback for writes)`);
  }
}
log(`done; real Sui tx so far: ${realTxCount()}`);
process.exit(0);
