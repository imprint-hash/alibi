// HTTP handlers shared by server.js (node:http) and the Vercel functions in api/.
// Responses carry report data only: no env, no keys, no wallet.
import { state, demoReport } from './data.js';
import { runLive, marketKey, normalizeInput, rateCheck, cached, redact, STAGES, LIMIT } from './live.js';
import { samples } from './samples.js';

const json = (res, code, body, extra = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(redact(JSON.stringify(body)));
};

export function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

async function readBody(req) {
  try {
    if (req.body !== undefined) return typeof req.body === 'string' ? safeParse(req.body) : req.body || {}; // Vercel pre-parses
    let s = '';
    for await (const c of req) { s += c; if (s.length > 4096) break; }
    return safeParse(s);
  } catch { return {}; }
}
const safeParse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

export async function handleState(req, res) {
  try { json(res, 200, state(), { 'cache-control': 'public, max-age=30' }); } catch (e) { json(res, 500, { error: 'could not read proof files' }); }
}

export async function handleDemo(req, res) {
  const d = demoReport();
  d ? json(res, 200, d, { 'cache-control': 'public, max-age=60' }) : json(res, 404, { error: 'no saved report found' });
}

export async function handleSamples(req, res) {
  try { json(res, 200, await samples(), { 'cache-control': 'public, max-age=300' }); } catch { json(res, 200, { chips: [] }); }
}

/**
 * POST /api/check {url}. Streams NDJSON: {type:'stages'}, {type:'stage'}..., then {type:'result'} or {type:'error'}.
 * Cached markets (10 min) answer at once and do not count against the per-IP limit.
 */
export async function handleCheck(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST {"url": "<polymarket link>"}' }, { allow: 'POST' });
  const body = await readBody(req);
  const input = normalizeInput(body?.url);
  if (!input) return json(res, 400, { error: 'Paste a Polymarket market link first.' });
  const key = marketKey(input);
  if (!key) return json(res, 400, { error: 'That does not look like a polymarket.com market link or slug.' });

  const hit = cached(key);
  if (hit) return json(res, 200, { type: 'result', result: { ...hit.result, source: 'cache', cachedAt: new Date(hit.at).toISOString() } });

  const rl = rateCheck(clientIp(req));
  if (!rl.ok) return json(res, 429, { error: `Live-check limit reached (${LIMIT.perIp} per ${LIMIT.windowMs / 60000} min). Try again in ${rl.retryInSec}s, or open the saved report.` }, { 'retry-after': String(rl.retryInSec) });

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
  let open = true;
  res.on('close', () => { open = false; });
  const send = (o) => { if (open) res.write(redact(JSON.stringify(o)) + '\n'); };
  send({ type: 'stages', stages: STAGES });
  const beat = setInterval(() => send({ type: 'beat' }), 5000);
  try {
    const p = runLive(input.startsWith('http') ? input : key, key, send);
    rl.take(); // only checks that actually start count against the limit
    const result = await p;
    send({ type: 'result', result });
  } catch (e) {
    send({ type: 'error', status: e.status || 500, error: friendly(e) });
  } finally {
    clearInterval(beat);
    if (open) res.end();
  }
}

function friendly(e) {
  const m = String(e?.message || e);
  if (e?.status === 503) return m;
  if (/unrecognised Polymarket URL|not found|null/i.test(m)) return 'Could not find that market on Polymarket. Check the link.';
  return `The live check stopped: ${m.slice(0, 160)}`;
}
