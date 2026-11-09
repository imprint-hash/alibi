// Alibi website, local: `npm start` (or `node server.js`). node:http only, no extra dependencies.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleCheck, handleState, handleSamples, handleDemo } from './web/handler.js';
import { handleAgentCheck, handleAgentPrice } from './web/agent.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUB = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const API = { '/api/check': handleCheck, '/api/state': handleState, '/api/samples': handleSamples, '/api/demo': handleDemo, '/api/agent/check': handleAgentCheck, '/api/agent/price': handleAgentPrice };

async function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  if (!extname(p)) p += '.html'; // clean URLs: /proof → proof.html
  const file = normalize(join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(await readFile(file));
  } catch {
    let page = 'Not found';
    try { page = await readFile(join(PUB, '404.html')); } catch {}
    res.writeHead(404, { 'content-type': typeof page === 'string' ? 'text/plain; charset=utf-8' : TYPES['.html'], 'cache-control': 'no-cache' });
    res.end(page);
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (API[pathname]) return await API[pathname](req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return await serveStatic(req, res, pathname);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'server error' }));
  }
}).listen(PORT, () => console.log(`Alibi on http://localhost:${PORT}`));
