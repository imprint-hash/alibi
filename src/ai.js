// Structured JSON extraction. Claude Sonnet 5.5 first (hard $5 cap, persistent counter), Groq gpt-oss-120b fallback.
// The model only extracts; callers validate the JSON in code. Raw fetch because no SDK is installed (no new packages).
import { secret } from './env.js';
import { path, readJson, writeJson } from './store.js';
import { fetchJson } from './http.js';

export const CLAUDE_MODEL = 'claude-sonnet-5-5';
export const GROQ_MODEL = 'openai/gpt-oss-120b';
const PRICE = { input: 2.0 / 1e6, output: 10.0 / 1e6, cacheRead: 0.2 / 1e6 }; // USD per token, Sonnet 5.5
export const SPEND_CAP_USD = 5.0;
const SPEND_FILE = path('results', 'spend.json');

export function spend() {
  return readJson(SPEND_FILE, { claude: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 }, groq: { calls: 0, inputTokens: 0, outputTokens: 0 }, capUsd: SPEND_CAP_USD });
}
function record(provider, usage, usd = 0) {
  const s = spend();
  const p = s[provider];
  p.calls += 1;
  p.inputTokens += usage.input || 0;
  p.outputTokens += usage.output || 0;
  if (provider === 'claude') p.usd = +(p.usd + usd).toFixed(6);
  s.capUsd = SPEND_CAP_USD;
  s.updated = new Date().toISOString();
  writeJson(SPEND_FILE, s);
}

// Worst-case cost of a call, used to refuse calls that could cross the cap.
const worstCase = (inChars, maxOut) => (inChars / 3) * PRICE.input + maxOut * PRICE.output;

async function claudeJson({ system, user, schema, maxTokens }) {
  const key = secret('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY empty');
  const s = spend();
  if (s.claude.usd + worstCase(system.length + user.length, maxTokens) > SPEND_CAP_USD) throw new Error('claude spend cap reached');
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    fallbacks: 'default',
  };
  const r = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify(body),
    timeoutMs: 120000,
    retries: 2,
  });
  const u = r.usage || {};
  const usd = (u.input_tokens || 0) * PRICE.input + (u.output_tokens || 0) * PRICE.output + (u.cache_read_input_tokens || 0) * PRICE.cacheRead;
  record('claude', { input: u.input_tokens, output: u.output_tokens }, usd);
  if (r.stop_reason === 'refusal') throw new Error('claude refused');
  if (r.stop_reason === 'max_tokens') throw new Error('claude hit max_tokens');
  const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { json: JSON.parse(text), provider: 'claude', model: r.model || CLAUDE_MODEL, usd };
}

async function groqJson({ system, user, schema, maxTokens }) {
  const key = secret('GROQ_API_KEY');
  if (!key) throw new Error('GROQ_API_KEY empty');
  const r = await fetchJson('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: `${system}\nReply with one JSON object only, matching this JSON schema:\n${JSON.stringify(schema)}` },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
    timeoutMs: 90000,
    retries: 2,
  });
  const u = r.usage || {};
  record('groq', { input: u.prompt_tokens, output: u.completion_tokens });
  return { json: JSON.parse(r.choices[0].message.content), provider: 'groq', model: GROQ_MODEL, usd: 0 };
}

/** Returns { json, provider, model, usd, errors[] }. Never decides anything; callers validate. */
export async function extractJson(opts) {
  const o = { maxTokens: 2000, ...opts };
  const errors = [];
  for (const fn of [claudeJson, groqJson]) {
    try {
      return { ...(await fn(o)), errors };
    } catch (e) {
      errors.push(`${fn.name}: ${String(e.message).slice(0, 160)}`);
    }
  }
  return { json: null, provider: null, errors };
}
