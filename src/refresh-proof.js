#!/usr/bin/env node
// Read-only: refreshes proof/ after evidence posts. Waits until --at (UTC HH:MM), then rebuilds
// proof/evidence-tatum.json (Tatum gRPC read-back + Tatum rates) and copies memories/tatum-calls into proof/.
import { copyFileSync } from 'node:fs';
import { loadEnv } from './env.js';
import { listEvidenceTxs } from './tatumdata.js';
import { path } from './store.js';

loadEnv();
const args = process.argv.slice(2);
const at = args.includes('--at') ? args[args.indexOf('--at') + 1] : null;
if (at) {
  const [hh, mm] = at.split(':').map(Number);
  const t = new Date(); t.setUTCHours(hh, mm, 0, 0);
  if (t > new Date()) await new Promise((r) => setTimeout(r, t - Date.now()));
}
const e = await listEvidenceTxs();
for (const f of ['memories.jsonl', 'tatum-calls.json']) copyFileSync(path('results', f), path('proof', f));
console.log(new Date().toISOString(), `proof refreshed: ${e.txs.length} evidence txs, total ${e.totalGasSui} SUI ≈ $${e.totalUsd}`);
console.log(e.txs.map((x) => `${x.digest} ${x.kind} executed=${x.executedVia} read=${x.readVia} ok=${x.success}`).join('\n'));
process.exit(0);
