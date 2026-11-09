// Walrus Memory (mainnet relayer). Memories are short structured lines so code, not the embedding, decides matches.
// Namespaces: alibi-incidents (what went wrong), alibi-sources (facts about feeds/sources),
// alibi-evidence (snapshots), alibi-user (user verdicts such as "benign basis, not a glitch").
import { MemWal } from '@mysten-incubation/memwal';
import { secret } from './env.js';
import { path, appendJsonl, readJsonl } from './store.js';

export const RELAYER = 'https://relayer.memory.walrus.xyz';
export const NS = { incidents: 'alibi-incidents', sources: 'alibi-sources', evidence: 'alibi-evidence', user: 'alibi-user' };
const LOG = path('results', 'memories.jsonl');
const WRITE_CAP = Number(process.env.ALIBI_MEMORY_WRITE_CAP || 60);

let client;
let backend = 'walrus-mainnet';
/** Injects a client (e.g. MemWalMock in tests). Mock memories are labelled backend='mock', never reported as Walrus writes. */
export function setClient(c, name = 'mock') { client = c; backend = name; }
export const backendName = () => backend;
export function memwal() {
  if (client) return client;
  const key = secret('MEMWAL_KEY');
  const accountId = secret('MEMWAL_ACCOUNT_ID');
  if (!key || !accountId) throw new Error('MEMWAL_KEY / MEMWAL_ACCOUNT_ID empty');
  client = MemWal.create({ key, accountId, serverUrl: RELAYER, namespace: NS.incidents, requestTimeoutMs: 45000, preflightTimeoutMs: 20000, recallTimeoutMs: 45000 });
  return client;
}

/** Encodes a record as one line: "ALIBI-<KIND> v1 | k=v | k=v". Values are sanitised (no pipes/newlines). */
export function encode(kind, fields) {
  const parts = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${String(v).replace(/[|\n\r]+/g, ' ').trim()}`);
  return `ALIBI-${kind.toUpperCase()} v1 | ${parts.join(' | ')}`;
}
export function decode(text) {
  const m = String(text).match(/ALIBI-([A-Z]+) v1 \| (.*)$/s);
  if (!m) return null;
  const fields = {};
  for (const part of m[2].split(' | ')) {
    const i = part.indexOf('=');
    if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return { kind: m[1].toLowerCase(), ...fields };
}

export function writesSoFar() { return readJsonl(LOG).filter((r) => r.ok).length; }

/** Writes one memory to mainnet and waits for the blob id. Enforces the dev write cap. */
export async function remember(namespace, kind, fields, { dryRun = false } = {}) {
  const text = encode(kind, fields);
  if (text.length > 600) throw new Error('memory too long; keep it short and structured');
  if (dryRun) return { dryRun: true, namespace, text };
  if (backend === 'walrus-mainnet' && writesSoFar() >= WRITE_CAP) throw new Error(`memory write cap reached (${WRITE_CAP}); raise ALIBI_MEMORY_WRITE_CAP deliberately`);
  try {
    // The namespace must be the 2nd argument as a string; inside an options object the SDK ignores it.
    const r = await memwal().rememberAndWait(text, namespace, { dedupe: true, timeoutMs: 90000 });
    if (backend === 'walrus-mainnet' && r.namespace && r.namespace !== namespace) throw new Error(`relayer stored in namespace ${r.namespace}, expected ${namespace}`);
    if (backend !== 'walrus-mainnet') return { ok: true, backend, namespace, blobId: r.blob_id, text };
    const rec = { ok: true, backend, at: new Date().toISOString(), namespace: r.namespace || namespace, blobId: r.blob_id, id: r.id, text };
    appendJsonl(LOG, rec);
    return rec;
  } catch (e) {
    if (backend !== 'walrus-mainnet') throw e;
    appendJsonl(LOG, { ok: false, at: new Date().toISOString(), namespace, error: String(e.message).slice(0, 200), text });
    throw e;
  }
}

/** Semantic recall in one namespace, then decode. Returns [{blobId, distance, createdAt, text, record}]. */
export async function recall(namespace, query, { limit = 10, maxDistance = 0.95 } = {}) {
  let r;
  for (let attempt = 0; ; attempt++) {
    try { r = await memwal().recall({ query, namespace, topK: limit, maxDistance }); break; }
    catch (e) { if (attempt >= 2 || !/timed out|ECONNRESET|fetch failed|5\d\d/i.test(String(e.message))) throw e; await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1))); }
  }
  return (r.results || []).map((m) => ({ blobId: m.blob_id, distance: m.distance, createdAt: m.created_at || null, text: m.text, record: decode(m.text) }));
}

/** Incidents + user verdicts relevant to an instrument/feed. Matching beyond the semantic query is done by learn.js. */
export async function recallForFeed({ instrument, feed, patterns = [] }) {
  const q = `ALIBI incident ${instrument} ${feed} ${patterns.join(' ')} settlement price glitch`;
  const out = { incidents: [], userNotes: [], sources: [], errors: [] };
  for (const [key, ns, query] of [['incidents', NS.incidents, q], ['userNotes', NS.user, `ALIBI user verdict ${instrument} ${feed}`], ['sources', NS.sources, `ALIBI source fact ${instrument} ${feed}`]]) {
    try { out[key] = await recall(ns, query, { limit: 40 }); } catch (e) { out.errors.push(`${ns}: ${String(e.message).slice(0, 160)}`); }
  }
  return out;
}

export async function health() { return memwal().health(); }

/** Relayer-mode remember/recall build a SEAL session client-side, which needs the @mysten/seal peer package. */
export async function walrusReady() {
  if (backend !== 'walrus-mainnet') return { ok: true, backend };
  if (!secret('MEMWAL_KEY') || !secret('MEMWAL_ACCOUNT_ID')) return { ok: false, reason: 'MEMWAL_KEY / MEMWAL_ACCOUNT_ID empty' };
  try { await import('@mysten/seal'); return { ok: true, backend }; } catch { return { ok: false, reason: '@mysten/seal is not installed; the Walrus Memory SDK needs it for every remember/recall (client-side SEAL session)' }; }
}
