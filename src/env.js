// Loads .env into process.env without ever printing values.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let loaded = false;

export function loadEnv(path = join(ROOT, '.env')) {
  if (loaded) return;
  loaded = true;
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

/** Returns the secret or undefined. Never log the return value. */
export function secret(name) {
  loadEnv();
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

/** Safe status for reports: only 'set' or 'empty'. */
export function envStatus(names) {
  loadEnv();
  return Object.fromEntries(names.map((n) => [n, secret(n) ? 'set' : 'empty']));
}
