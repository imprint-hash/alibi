// fetch with timeout, retry and backoff on 429/5xx. Never logs headers.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${redact(url)}: ${String(body).slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}
const redact = (u) => String(u).replace(/(key|token|api_key)=[^&]+/gi, '$1=***');

export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, retries = 3, minGapMs = 0 } = {}) {
  let attempt = 0;
  for (;;) {
    if (minGapMs) await gate(new URL(url).host, minGapMs);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetch(url, { method, headers: { 'user-agent': 'alibi/0.1', ...headers }, body, signal: ctl.signal });
      text = await res.text();
    } catch (e) {
      clearTimeout(t);
      if (attempt++ < retries) { await sleep(1000 * 2 ** attempt); continue; }
      throw e;
    }
    clearTimeout(t);
    if (res.ok) { try { return JSON.parse(text); } catch { return text; } }
    if ((res.status === 429 || res.status >= 500) && attempt++ < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 ? ra * 1000 : 1500 * 2 ** attempt);
      continue;
    }
    throw new HttpError(res.status, url, text);
  }
}

// Per-host minimum spacing between calls (simple rate limiter).
const last = new Map();
async function gate(host, gap) {
  const now = Date.now();
  const next = Math.max(now, (last.get(host) || 0) + gap);
  last.set(host, next);
  if (next > now) await sleep(next - now);
}
