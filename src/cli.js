#!/usr/bin/env node
// Usage: node src/cli.js <polymarket-url-or-slug> [--before-after] [--no-ai] [--no-memory] [--json] [--remember]
import { loadEnv } from './env.js';
import { runCheck } from './check.js';
import { buildReport, renderText } from './report.js';
import { incidentsFrom, applyMemories } from './learn.js';
import * as mem from './memory.js';
import { callCounts } from './sui.js';
import { spend } from './ai.js';
import { writeJson, path } from './store.js';

loadEnv();
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('usage: node src/cli.js <polymarket-url-or-slug> [--before-after] [--no-ai] [--no-memory] [--json] [--remember]');
  process.exit(2);
}

const r = await runCheck(input, { ai: !flags.has('--no-ai'), memory: !flags.has('--no-memory') });
const rep = buildReport(r);
writeJson(path('results', 'last-check.json'), { report: rep, raw: { ...r, _target: undefined, _refs: undefined, market: { ...r.market, rules: undefined } } });
// --before-after: same live data, scored without and with the Walrus precedents (one data pull, so no drift).
if (flags.has('--before-after') && r.learning) {
  const strip = (x) => ({ ...x, _target: undefined, _refs: undefined, market: { ...x.market, rules: undefined } });
  const without = { ...r, learning: applyMemories(r.factors, [], r.context, { nowMs: Date.parse(r.at) }), memory: { ...r.memory, recalled: 0, errors: ['before: Walrus precedents withheld (same live data)'] }, dataSources: r.dataSources.map((d) => (d.name.startsWith('Walrus Memory') ? { ...d, ok: false, detail: 'withheld for the before view (same live data)' } : d)) };
  without.score = without.learning.after;
  writeJson(path('results', 'before.json'), { report: buildReport(without), raw: strip(without) });
  writeJson(path('results', 'after.json'), { report: rep, raw: strip(r) });
  console.log(renderText(buildReport(without)));
  console.log('\n' + '#'.repeat(78) + '\n# AFTER: same data + Walrus Memory precedents\n' + '#'.repeat(78));
}
if (flags.has('--json')) console.log(JSON.stringify(rep, null, 2));
else console.log(renderText(rep));

// Optional: remember real detections from this run (only what the detectors actually found).
if (flags.has('--remember') && r.factors) {
  const ready = await mem.walrusReady();
  const incidents = incidentsFrom(r.factors, { ...r.context, bucketAt: r.bucketAt }, { source: `check:${r.market.slug}` });
  if (!ready.ok) console.log(`\n(not remembering ${incidents.length} incident(s): ${ready.reason})`);
  else for (const i of incidents) {
    const w = await mem.remember(mem.NS.incidents, 'incident', i);
    console.log(`remembered ${w.blobId}: ${w.text}`);
  }
}
const s = spend();
console.log(`\n[spend] claude $${s.claude.usd.toFixed(4)} of $${s.capUsd} cap · groq calls ${s.groq.calls} · tatum calls (all runs) ${callCounts().tatumTotal} · Walrus memory writes (all runs) ${mem.writesSoFar()}`);
