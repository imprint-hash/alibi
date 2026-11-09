// Small JSON file helpers for counters, caches and results.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from './env.js';

export const path = (...p) => join(ROOT, ...p);

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export function appendJsonl(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(value) + '\n');
}
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
/** Increments a counter file: { [key]: n }. */
export function bump(file, key, by = 1, extra) {
  const c = readJson(file, {});
  c[key] = (c[key] || 0) + by;
  c._updated = new Date().toISOString();
  if (extra) Object.assign(c, extra(c));
  writeJson(file, c);
  return c;
}
