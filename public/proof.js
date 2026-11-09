// /proof: renders /api/state (counts read from proof/ and results/ files) as plain tables.
// A card whose file is missing is left out, never shown with zeros.
(() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rows = (list) => `<table class="rows"><tbody>${list.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
  const src = (f, extra = '') => `<p class="src">Source: ${esc(f)}${extra ? ' · ' + esc(extra) : ''}</p>`;
  const card = (title, file, extra, total, line, table, wide = false) =>
    `<article class="glass pcard${wide ? ' span2' : ''}"><h2>${title}</h2>${src(file, extra)}${total != null ? `<p class="total">${esc(total)}</p>` : ''}<p>${line}</p>${table}</article>`;
  fetch('/api/state').then((r) => r.json()).then((s) => {
    document.getElementById('gen').textContent = `Read at ${s.generatedAt}`;
    const { tatum: t, memory: m, sui, tests, pyth, scan, beforeAfter: ba, agent } = s;
    const cards = [
      t && card('Tatum calls', t.file, t.updated ? `updated ${t.updated}` : '', t.tatumOk,
        `successful calls through Tatum · ${esc(t.tatumQuotaErrors)} quota errors (HTTP 429) · ${esc(t.tatumErrors)} other errors · ${esc(t.publicFallback)} calls served by the public Sui node instead`,
        rows(t.rows.map((r) => [r.key, r.n]))),
      m && card('Walrus Memory', m.file, '', m.writes, `successful writes on ${esc(m.backends.join(', '))}, ${esc(m.incidents.length)} of them incident records`,
        rows(m.namespaces.map((n) => [n.namespace, n.misfiled ? `${n.writes} (${n.misfiled} misfiled early, rewritten)` : n.writes]))),
      sui && sui.executed.length && card('Sui mainnet transactions', sui.file, `${sui.simulations} simulations logged`, sui.executed.length, 'executed, with the provider as recorded',
        rows(sui.executed.map((x) => [`${x.kind} ${x.feed || ''} ${x.digest}`, `simulated ${x.simulatedBy || 'n/a'} · executed ${x.executedBy}`]))),
      agent && agent.payments.length && card('Paid agent checks', agent.file, 'paid by our demo agent (agent/client.js)', agent.payments.length, 'USDC payments on Sui, verified via Tatum',
        rows(agent.payments.map((p) => [`${p.market} ${p.digest}`, `${p.amountUsdc} USDC · score ${p.score}`]))),
      tests && card('Tests', 'tests/*.test.js', 'run with node --test', tests.cases, `test cases in ${esc(tests.files.length)} files`, rows(tests.files.map((f) => [f.file, f.cases]))),
      pyth && card('Pyth calls', pyth.file, '', pyth.total, 'Pyth API calls counted by the engine', rows(pyth.rows.map((r) => [r.key, r.n]))),
      scan && card('History scan', scan.file, `run ${scan.at}`, scan.incidents, `incidents found in ${esc(scan.days)} days of Pyth history${m ? `, ${esc(m.incidents.length)} of them written to Walrus` : ''}`,
        rows(scan.feeds.map((f) => [f.feed, `${f.incidents} incidents · ${f.candles} candles · ${f.prints} prints`]))),
      ba && card('Memory changes the answer', ba.files.join(', '), `same data at ${ba.at}`, null, 'One data pull, scored without and with the Walrus precedents',
        rows([['without Walrus precedents', `${ba.before.score}/100 · ${ba.before.verdict}`], ['with Walrus precedents', `${ba.after.score}/100 · ${ba.after.verdict}`], ...ba.changes.flatMap((c) => c.memories.map((x) => [`${c.factor} ← ${x.blobId}`, `weight ${x.weight}`]))]), true),
    ].filter(Boolean);
    document.getElementById('grid').innerHTML = cards.length ? cards.join('') : '<div class="glass pcard span2"><p>No proof files are published yet.</p></div>';
  }).catch(() => { document.getElementById('grid').innerHTML = '<div class="glass pcard span2"><p>Could not read the proof files.</p></div>'; });
})();
