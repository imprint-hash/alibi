// /proof: renders /api/state (counts read from proof/ and results/ files) as plain tables.
(() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rows = (list) => `<table class="rows"><tbody>${list.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
  const src = (f, extra = '') => `<p class="src">source: ${esc(f || 'file not found')}${extra ? ' · ' + esc(extra) : ''}</p>`;
  fetch('/api/state').then((r) => r.json()).then((s) => {
    document.getElementById('gen').textContent = `read at ${s.generatedAt}`;
    const t = s.tatum, m = s.memory, sui = s.sui;
    const cards = [
      `<article class="glass pcard"><h2>Tatum Sui gRPC</h2>${src(t.file, t.updated ? `updated ${t.updated}` : '')}
        <p class="total">${esc(t.tatumOk)}</p><p>successful calls through Tatum · ${esc(t.tatumQuotaErrors)} quota errors (HTTP 429) · ${esc(t.tatumErrors)} other errors · ${esc(t.publicFallback)} calls served by the public Sui node instead</p>
        ${rows(t.rows.map((r) => [r.key, r.n]))}</article>`,
      `<article class="glass pcard"><h2>Walrus Memory</h2>${src(m.file)}
        <p class="total">${esc(m.writes)}</p><p>successful writes on ${esc(m.backends.join(', '))}, ${esc(m.incidents.length)} of them incident records</p>
        ${rows(m.namespaces.map((n) => [n.namespace, n.misfiled ? `${n.writes} (${n.misfiled} misfiled early, rewritten)` : n.writes]))}</article>`,
      `<article class="glass pcard"><h2>Sui mainnet transactions</h2>${src(sui.file, `${sui.simulations} simulations logged`)}
        <p class="total">${esc(sui.executed.length)}</p><p>executed; provider as recorded</p>
        ${rows(sui.executed.map((x) => [`${x.kind} ${x.feed || ''} ${x.digest}`, `sim ${x.simulatedBy} · exec ${x.executedBy}`]))}</article>`,
      `<article class="glass pcard"><h2>Tests</h2>${src('tests/*.test.js', s.tests.note)}
        <p class="total">${esc(s.tests.cases)}</p><p>test cases in ${esc(s.tests.files.length)} files</p>
        ${rows(s.tests.files.map((f) => [f.file, f.cases]))}</article>`,
      `<article class="glass pcard"><h2>Pyth calls</h2>${src(s.pyth.file)}
        <p class="total">${esc(s.pyth.total)}</p><p>Pyth API calls counted by the engine</p>${rows(s.pyth.rows.map((r) => [r.key, r.n]))}</article>`,
      s.scan ? `<article class="glass pcard"><h2>History scan</h2>${src(s.scan.file, `run ${s.scan.at}`)}
        <p class="total">${esc(s.scan.incidents)}</p><p>incidents found in ${esc(s.scan.days)} days of Pyth history</p>
        ${rows(s.scan.feeds.map((f) => [f.feed, `${f.incidents} incidents · ${f.candles} candles · ${f.prints} prints`]))}</article>` : '',
      s.beforeAfter ? `<article class="glass pcard span2"><h2>Memory changes the answer</h2>${src(s.beforeAfter.files.join(', '), `same data at ${s.beforeAfter.at}`)}
        ${rows([['without Walrus precedents', `${s.beforeAfter.before.score}/100 · ${s.beforeAfter.before.verdict}`], ['with Walrus precedents', `${s.beforeAfter.after.score}/100 · ${s.beforeAfter.after.verdict}`], ...s.beforeAfter.changes.flatMap((c) => c.memories.map((x) => [`${c.factor} ← ${x.blobId}`, `w=${x.weight}`]))])}</article>` : '',
    ];
    document.getElementById('grid').innerHTML = cards.join('');
  }).catch(() => { document.getElementById('grid').innerHTML = '<div class="glass pcard span2"><p>Could not read the proof files.</p></div>'; });
})();
