#!/usr/bin/env node
// Live recorder: Hyperliquid 1m candles (free, polled) and, when PYTH_API_KEY is set, the Pyth Hermes SSE stream
// (every print with confidence and publish time) for the in-scope commodity feeds. Writes jsonl into data/.
// Usage: node src/record.js [--minutes N]   (Ctrl+C to stop)
import { loadEnv, secret } from './env.js';
import { appendJsonl, path, readJson, writeJson } from './store.js';
import { hyperliquidCandles } from './refs.js';
import * as pyth from './pyth.js';
import { sleep } from './http.js';

loadEnv();
const args = process.argv.slice(2);
const minutes = Number(args[args.indexOf('--minutes') + 1]) || Infinity;
const stopAt = Date.now() + minutes * 60000;
const HL_COINS = ['xyz:CL', 'xyz:BRENTOIL', 'xyz:GOLD', 'xyz:SILVER'];
const STATE = path('data', 'recorder-state.json');
const safe = (s) => s.replace(/[^A-Za-z0-9]+/g, '_');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function pollHyperliquid() {
  const st = readJson(STATE, { hlLast: {} });
  for (;;) {
    if (Date.now() > stopAt) return;
    const now = Math.floor(Date.now() / 1000);
    for (const coin of HL_COINS) {
      try {
        const cs = await hyperliquidCandles(coin, now - 15 * 60, now);
        const done = cs.filter((c) => c.t + 60 <= now && c.t > (st.hlLast[coin] || 0)); // completed minutes only
        for (const c of done) appendJsonl(path('data', `hl-${safe(coin)}.jsonl`), c);
        if (done.length) { st.hlLast[coin] = done.at(-1).t; writeJson(STATE, st); }
      } catch (e) { log('hl error', coin, e.message.slice(0, 120)); }
    }
    await sleep(30000);
  }
}

async function streamPyth() {
  if (!secret('PYTH_API_KEY')) { log('PYTH_API_KEY empty: Pyth stream not started (Hermes requires a key). Recording Hyperliquid only.'); return; }
  const list = await pyth.symbols();
  const wanted = [];
  for (const code of ['CLL', 'BRENT']) {
    const cs = pyth.contractsFromSymbols(list, code).filter((c) => c.state === 'stable');
    wanted.push(...cs.slice(0, 2));
  }
  for (const s of ['Commodities.Index.WTI1M/USD', 'Commodities.Index.LWTI1M/USD', 'Commodities.Index.BRENT1M/USD', 'Metal.XAU/USD', 'Metal.XAG/USD']) {
    const x = list.find((y) => y.symbol === s);
    if (x?.hermes_id) wanted.push({ symbol: x.symbol, hermesId: x.hermes_id });
  }
  const byId = new Map(wanted.map((w) => [w.hermesId.replace(/^0x/, ''), w.symbol]));
  const url = `https://hermes.pyth.network/v2/updates/price/stream?${[...byId.keys()].map((id) => `ids[]=${id}`).join('&')}&parsed=true&encoding=hex`;
  let backoff = 2000;
  while (Date.now() < stopAt) {
    try {
      log(`pyth stream: ${wanted.map((w) => w.symbol).join(', ')}`);
      const res = await fetch(url, { headers: { authorization: `Bearer ${secret('PYTH_API_KEY')}`, accept: 'text/event-stream' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      backoff = 2000;
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = ev.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
          for (const p of j.parsed || []) {
            const sym = byId.get(p.id);
            if (!sym) continue;
            const k = 10 ** p.price.expo;
            appendJsonl(path('data', `pyth-${safe(sym)}.jsonl`), { t: p.price.publish_time, price: Number(p.price.price) * k, conf: Number(p.price.conf) * k, publishTime: p.price.publish_time, slot: p.metadata?.slot ?? null });
          }
        }
        if (Date.now() > stopAt) break;
      }
    } catch (e) {
      log('pyth stream error', String(e.message).slice(0, 120), `retry in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(60000, backoff * 2);
    }
  }
}

log(`recording to ${path('data')} ${Number.isFinite(minutes) ? `for ${minutes} min` : 'until stopped'}`);
await Promise.all([pollHyperliquid(), streamPyth()]);
log('stopped');
process.exit(0);
