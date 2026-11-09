// Live checks for the website: runs the engine's runCheck, caches per market, rate-limits per IP and
// streams real progress (which data source the check is talking to right now). Read-only towards src/.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { ROOT } from './data.js';
import { shapeCheck } from './shape.js';

const require = createRequire(import.meta.url);

// On Vercel the deployment folder is read-only. The engine writes counters and caches under ROOT
// (results/, cache/); send those writes to /tmp so a check never fails on EROFS. Local runs are untouched.
if (process.env.VERCEL) {
  const fs = require('node:fs');
  const TMP = '/tmp/alibi';
  const redirect = (p) => {
    const s = String(p);
    return s.startsWith(ROOT) && !s.startsWith(TMP) ? join(TMP, relative(ROOT, s)) : p;
  };
  const wrap = (name, pathArgs = 1) => {
    const orig = fs[name];
    fs[name] = (...a) => { for (let i = 0; i < pathArgs; i++) a[i] = redirect(a[i]); return orig.apply(fs, a); };
  };
  ['writeFileSync', 'appendFileSync', 'mkdirSync'].forEach((n) => wrap(n));
  // Reads of a file we redirected come from /tmp when it exists there.
  const origRead = fs.readFileSync, origExists = fs.existsSync;
  fs.readFileSync = (p, ...a) => { const r = redirect(p); return origRead.call(fs, r !== p && origExists.call(fs, r) ? r : p, ...a); };
  fs.existsSync = (p) => { const r = redirect(p); return (r !== p && origExists.call(fs, r)) || origExists.call(fs, p); };
  require('node:module').syncBuiltinESMExports();
}

const als = new AsyncLocalStorage();
export const STAGES = [
  { key: 'rules', label: 'Reading the market rules' },
  { key: 'pyth', label: 'Reading the Pyth settlement feed' },
  { key: 'refs', label: 'Cross-checking Hyperliquid' },
  { key: 'sui', label: 'Reading the Sui record via Tatum' },
  { key: 'walrus', label: 'Recalling Walrus Memory' },
];
const idx = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

function stageFor(host, job) {
  if (/polymarket\.com|anthropic\.com|groq\.com/.test(host)) return 'rules';
  if (/hyperliquid\.xyz/.test(host)) return 'refs';
  if (/walrus|memwal/.test(host)) return 'walrus';
  if (/sui\.io|tatum\.io/.test(host)) return 'sui';
  if (/pyth/.test(host)) return job.stage >= idx.refs ? 'sui' : 'pyth'; // Hermes after Hyperliquid = on-chain comparison
  return null;
}
function mark(stageKey) {
  const job = als.getStore();
  if (!job || stageKey == null) return;
  const i = idx[stageKey];
  if (i > job.stage) { job.stage = i; job.emit({ type: 'stage', stage: i, key: stageKey, label: STAGES[i].label, t: Date.now() - job.t0 }); }
}
// Observe which host each check talks to (attributed per request via AsyncLocalStorage).
const origFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const job = als.getStore();
  if (job) { try { mark(stageFor(new URL(typeof input === 'string' ? input : input.url || String(input)).host, job)); } catch {} }
  return origFetch.call(this, input, init);
};
try {
  const http2 = require('node:http2');
  const orig = http2.connect;
  http2.connect = function (authority, ...rest) { const job = als.getStore(); if (job) { try { mark(stageFor(new URL(String(authority)).host, job)); } catch {} } return orig.call(this, authority, ...rest); };
} catch {}

/** Removes any secret value from env that slipped into a string (belt and braces: the engine already redacts). */
const SECRET_NAMES = /KEY|SECRET|TOKEN|PRIVATE|PASSWORD|MNEMONIC|ACCOUNT_ID|ADDRESS/i;
export function redact(json) {
  let s = json;
  for (const [k, v] of Object.entries(process.env)) if (SECRET_NAMES.test(k) && v && v.length >= 8) s = s.split(v).join('***');
  return s;
}

// ---- cache, rate limit, in-flight de-dupe -------------------------------------------------------
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // key → { at, result }
const inflight = new Map(); // key → { promise, listeners:Set }
const hits = new Map(); // ip → [timestamps]
export const LIMIT = { perIp: Number(process.env.ALIBI_RATE_PER_IP || 6), windowMs: 10 * 60 * 1000, maxConcurrent: Number(process.env.ALIBI_MAX_CONCURRENT || 2) };

/** Adds https:// to bare polymarket.com links so "polymarket.com/event/…" works like a full URL. */
export function normalizeInput(input) {
  const s = String(input || '').trim();
  return /^(www\.)?polymarket\.com\//i.test(s) ? `https://${s}` : s;
}

export function marketKey(input) {
  const s = normalizeInput(input);
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if (!/(^|\.)polymarket\.com$/i.test(u.hostname)) return null;
      const parts = u.pathname.split('/').filter(Boolean);
      const i = parts.findIndex((p) => p === 'event' || p === 'market');
      if (i < 0 || !parts[i + 1]) return null;
      return (parts[i + 2] || parts[i + 1]).toLowerCase();
    }
  } catch { return null; }
  return /^[a-z0-9-]{3,160}$/i.test(s) ? s.toLowerCase() : null;
}

export function rateCheck(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < LIMIT.windowMs);
  hits.set(ip, list);
  if (list.length >= LIMIT.perIp) return { ok: false, retryInSec: Math.ceil((LIMIT.windowMs - (list.length ? now - list[0] : 0)) / 1000) };
  return { ok: true, take: () => list.push(now) };
}

export function cached(key) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_MS) return c;
  if (c) cache.delete(key);
  return null;
}

let engine;
async function loadEngine() {
  if (engine) return engine;
  const env = await import('../src/env.js');
  env.loadEnv();
  const [{ runCheck }, { buildReport }] = await Promise.all([import('../src/check.js'), import('../src/report.js')]);
  engine = { runCheck, buildReport };
  return engine;
}

/**
 * Runs (or joins) a live check. emit(event) receives {type:'stage'|'joined'} events.
 * Resolves to the shaped report. AI rule reading is on locally (spend-capped by the engine) and off on Vercel
 * unless ALIBI_WEB_AI=1, because the spend counter file does not persist between serverless instances.
 */
export function runLive(input, key, emit) {
  const running = inflight.get(key);
  if (running) { running.listeners.add(emit); emit({ type: 'joined' }); return running.promise; }
  if (inflight.size >= LIMIT.maxConcurrent) { const e = new Error('Alibi is already running the maximum number of live checks. Try again in a minute, or open the saved report.'); e.status = 503; throw e; }
  const listeners = new Set([emit]);
  const job = { stage: -1, t0: Date.now(), emit: (ev) => { for (const l of listeners) { try { l(ev); } catch {} } } };
  const ai = process.env.ALIBI_WEB_AI ? process.env.ALIBI_WEB_AI === '1' : !process.env.VERCEL;
  const promise = als.run(job, async () => {
    const { runCheck, buildReport } = await loadEngine();
    mark('rules');
    const r = await runCheck(input, { ai });
    const rep = buildReport(r);
    const shaped = shapeCheck(rep, r, { source: 'live', cachedAt: new Date().toISOString(), elapsedMs: Date.now() - job.t0 });
    cache.set(key, { at: Date.now(), result: shaped });
    return shaped;
  }).finally(() => inflight.delete(key));
  inflight.set(key, { promise, listeners });
  return promise;
}
