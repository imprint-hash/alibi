// Alibi website: hero form, live check with real stage progress, report rendering, learned/evidence/stats.
// Every number shown comes from /api/* (engine output or proof files). Nothing is typed in here.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const utc = (iso, withYear = false) => {
    if (!iso) return 'n/a';
    const d = new Date(String(iso).includes('T') || String(iso).endsWith('Z') ? String(iso).replace(' ', 'T') : iso);
    if (isNaN(d)) return esc(iso);
    return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}${withYear ? ' ' + d.getUTCFullYear() : ''}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  };
  const short = (s, a = 8, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || '');
  const WALRUS = (id) => `https://walruscan.com/mainnet/blob/${encodeURIComponent(id)}`;
  const AGG = (id) => `https://aggregator.walrus-mainnet.walrus.space/v1/blobs/${encodeURIComponent(id)}`;
  const SUIVISION_TX = (d) => `https://suivision.xyz/txblock/${encodeURIComponent(d)}`;
  const SUISCAN_TX = (d) => `https://suiscan.xyz/mainnet/tx/${encodeURIComponent(d)}`;
  const SUIVISION_OBJ = (o) => `https://suivision.xyz/object/${encodeURIComponent(o)}`;
  const BAND = { low: 'Looks clean so far', elevated: 'Watch this one closely', high: 'High settlement risk' };
  const ST = { pass: 'Pass', watch: 'Watch', flag: 'Flag', na: 'n/a' };
  const FEED = { 'Metal.XAU/USD': 'Gold', 'Metal.XAG/USD': 'Silver', 'FX.EUR/USD': 'EUR/USD' };
  const PATTERN = { confidence: 'Confidence blow-out', 'spike-revert': 'Spike and snap-back', divergence: 'Divergence', staleness: 'Stale prints', repeated: 'Frozen prints' };
  const ext = (href, text, cls = '') => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${cls ? ` class="${cls}"` : ''}>${text}</a>`;
  const copyBtn = (v) => `<button type="button" class="copy" data-copy="${esc(v)}">Copy</button>`;

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; b.classList.add('done'); setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1400); } catch {}
  });

  // ---------- tabs helper (backline-style pill row) ----------
  function tabs(id, items) {
    const row = items.map((t, i) => `<button type="button" role="tab" class="tab" id="${id}-t${i}" aria-controls="${id}-p${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(t.label)}</button>`).join('');
    const panels = items.map((t, i) => `<div role="tabpanel" class="panel" id="${id}-p${i}" aria-labelledby="${id}-t${i}"${i ? ' hidden' : ''}>${t.html}</div>`).join('');
    return `<div class="tabrow" role="tablist">${row}</div>${panels}`;
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[role="tab"]');
    if (t) select(t);
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('[role="tab"]');
    if (!t || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const all = [...t.parentElement.children];
    const n = all[(all.indexOf(t) + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    select(n); n.focus();
  });
  function select(t) {
    for (const o of t.parentElement.children) {
      const on = o === t;
      o.setAttribute('aria-selected', on); o.tabIndex = on ? 0 : -1;
      document.getElementById(o.getAttribute('aria-controls')).hidden = !on;
    }
  }

  // ---------- gauge ----------
  function gauge(score, band) {
    const col = { low: 'var(--ok)', elevated: 'var(--warn)', high: 'var(--bad)' }[band] || 'var(--na)';
    const v = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
    // 270° arc
    const arc = 'M 52.2 197.8 A 110 110 0 1 1 207.8 197.8';
    return `<svg class="gauge" viewBox="0 0 260 230" role="img" aria-label="Settlement Risk Score ${esc(score)} out of 100">
      <defs><linearGradient id="gtrack" x1="0" x2="1"><stop offset="0" stop-color="#4F37FD" stop-opacity=".22"/><stop offset="1" stop-color="#2CCD9A" stop-opacity=".18"/></linearGradient></defs>
      <path d="${arc}" fill="none" stroke="url(#gtrack)" stroke-width="18" stroke-linecap="round" pathLength="100"/>
      <path class="gv" d="${arc}" fill="none" stroke="${col}" stroke-width="18" stroke-linecap="round" pathLength="100" stroke-dasharray="${v} 100" style="transition: stroke-dasharray 1s cubic-bezier(.2,.8,.2,1)"/>
      ${[0, 25, 50, 75, 100].map((k) => { const a = (135 + k * 2.7) * Math.PI / 180; return `<circle cx="${130 + 84 * Math.cos(a)}" cy="${130 + 84 * Math.sin(a)}" r="2" fill="#5D6283"/>`; }).join('')}
      <text x="130" y="140" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-weight="600" font-size="64" fill="#FAF8F5">${esc(score ?? '–')}</text>
      <text x="130" y="170" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="15" fill="#B4B7CC">/ 100</text>
      <text x="130" y="218" text-anchor="middle" font-family="Manrope, sans-serif" font-size="14" fill="#B4B7CC">Settlement Risk Score</text>
    </svg>`;
  }

  // ---------- result rendering ----------
  const wrap = $('#result');
  function sourceTags(r) {
    if (r.source === 'live') return `<span class="tag live">LIVE CHECK</span><span>${utc(r.cachedAt)}${r.elapsedMs ? ` · took ${Math.round(r.elapsedMs / 1000)} s` : ''}</span>`;
    if (r.source === 'cache') return `<span class="tag live">LIVE · CACHED</span><span>checked ${utc(r.cachedAt)}, reused for 10 min to spare the Pyth and Tatum quotas</span>`;
    return `<span class="tag">SAVED REPORT</span><span>run ${utc(r.at, true)} from <code>${esc(r.sourceFile)}</code>; not live</span>`;
  }

  function renderReport(r) {
    if (r.kind === 'out-of-scope') {
      wrap.innerHTML = `<div class="glass top" style="grid-template-columns:1fr"><div><div class="srcline">${sourceTags(r)}</div><span class="verdict b-na">${esc(r.verdict)}</span>
        <ul class="sentences" style="margin-top:16px">${(r.sentences || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div></div>`;
      return;
    }
    const before = r.memory?.before, after = r.memory?.after;
    const effect = before != null && after != null
      ? `<div class="effect"><span>Live data alone</span><span class="n">${esc(before)}</span><span class="arrow" aria-hidden="true">→</span><span>with Walrus Memory</span><span class="n">${esc(after)}</span>
          <span>${histLine(r)}</span></div>` : '';
    const outcomes = (r.market.outcomes || []).filter((o) => o.price != null).map((o) => `${esc(o.name)} <span class="mono">${esc(o.price)}</span>`).join(' · ');
    wrap.innerHTML = `
    <div class="report">
      <article class="glass top">
        <div>${gauge(r.score, r.band)}<div class="gauge-cap"><span class="verdict b-${esc(r.band)}">${esc(BAND[r.band] || r.band)}</span></div></div>
        <div>
          <div class="srcline">${sourceTags(r)}</div>
          <p class="mq">${ext(r.market.url, esc(r.market.question))}${outcomes ? ` · Polymarket now: ${outcomes}` : ''}</p>
          <h2 class="headline">${esc(r.headline)}</h2>
          ${r.complete ? '' : '<p class="mq"><strong>Incomplete check:</strong> some factors could not be measured; see Show why.</p>'}
          <ol class="sentences">${r.sentences.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
          ${effect}
          <button type="button" class="showwhy" aria-expanded="false" aria-controls="why">Show why <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>
        </div>
      </article>
      <article class="glass tabs-card" id="why" hidden>
        ${tabs('rt', [
          { label: 'Seven live checks', html: matrixHtml(r) },
          { label: `Precedents (${r.precedents.length})`, html: precedentsHtml(r) },
          { label: 'On-chain record', html: onchainHtml(r.onchain) },
          { label: 'Settlement rule', html: ruleHtml(r) },
          { label: 'Data sources', html: sourcesHtml(r) },
        ])}
      </article>
    </div>`;
    const sw = $('.showwhy', wrap);
    sw.addEventListener('click', () => { const open = sw.getAttribute('aria-expanded') !== 'true'; sw.setAttribute('aria-expanded', open); $('#why').hidden = !open; });
  }

  function histLine(r) {
    const inW = r.precedents.filter((p) => p.inWindow).length, other = r.precedents.length - inW;
    if (!r.history?.points) return `${esc(r.memory.recalled)} memories recalled; none on this feed and window`;
    const parts = [inW ? `${inW} precedent(s) at this settlement window` : '', other ? `${other} incident(s) on this feed at other times` : ''].filter(Boolean).join(' and ');
    return `history adds <b class="mono">+${esc(r.history.points)}</b> from ${parts}`;
  }

  function matrixHtml(r) {
    const rows = r.matrix.map((m, i) => `
      <div class="mrow"><span class="i">${String(i + 1).padStart(2, '0')}</span>
        <div class="txt"><div class="l">${esc(m.label)}</div><div class="d">${esc(m.text || m.detail || '')}</div></div>
        <span class="st ${m.status}">${ST[m.status]}</span>
        <span class="pts">${m.points == null ? '<small>not scored</small>' : `${m.points ? '+' + esc(m.points) : '0'} <small>/ ${m.weight}</small>`}</span></div>`).join('');
    const h = r.history;
    return `<h3>What the live data shows</h3><p class="sub">Each check has a fixed weight. Points = weight × how bad it looks. Anything Alibi could not measure says n/a and scores nothing; it is never guessed.</p>
      <div class="matrix">${rows}
      <div class="mrow hist"><span class="i">+</span><div class="txt"><div class="l">Walrus history</div><div class="d">${esc(h.text || 'No remembered incident at this feed and settlement window.')}</div></div>
        <span class="st ${h.points ? 'watch' : 'pass'}">${h.points ? 'Memory' : 'None'}</span><span class="pts">+${esc(h.points)} <small>/ ${h.weight}</small></span></div></div>
      <p class="mfoot">Data window: ${esc(r.dataWindow?.mode || '')} ${esc(r.dataWindow?.from || '')} → ${esc(r.dataWindow?.to || '')}.</p>`;
  }

  function precedentsHtml(r) {
    const item = (p) => `<li><div class="pl">${esc(p.line)}</div>
      <div class="pm"><span class="${p.inWindow ? 'in' : ''}">${p.inWindow ? 'Same settlement window' : 'Same feed, other time of day (counts at 0.15×)'}</span><span>weight <span class="mono">${esc(p.weight)}</span></span>${p.ageDays != null ? `<span><span class="mono">${esc(p.ageDays)}</span> days old</span>` : ''}</div>
      <div class="pm"><span class="blobid" title="${esc(p.blobId)}">blob ${esc(short(p.blobId, 10, 6))}</span>${copyBtn(p.blobId)}${ext(WALRUS(p.blobId), 'Walruscan ↗')}${ext(AGG(p.blobId), 'raw blob ↗')}${p.evidence ? ext(p.evidence, 'Pyth chart at that minute ↗') : ''}</div></li>`;
    const inW = r.precedents.filter((p) => p.inWindow), other = r.precedents.filter((p) => !p.inWindow);
    if (!r.precedents.length) return `<h3>No precedents for this feed yet</h3><p class="sub">Walrus Memory returned ${esc(r.memory.recalled)} record(s); none matched this feed. ${r.memory.errors.length ? esc(r.memory.errors[0]) : ''}</p>`;
    return `<h3>From Walrus Memory</h3><p class="sub">Incidents Alibi found earlier on this exact Pyth feed. Ones inside this market's settlement window count fully; older ones fade with a 30-day half-life. Memory blobs are encrypted; the blob ID proves the record exists on Walrus.</p>
      ${inW.length ? `<p class="subhead">At this settlement window</p><ul class="prec">${inW.map(item).join('')}</ul>` : ''}
      ${other.length ? `<p class="subhead">Same feed, other times</p><ul class="prec">${other.map(item).join('')}</ul>` : ''}
      <p class="mfoot">${esc(r.memory.recalled)} memories recalled from ${esc(r.memory.backend)}; ${esc(r.memory.ignored)} ignored (other feeds or record types).</p>`;
  }

  function onchainHtml(o) {
    if (!o) return `<h3>No on-chain read on this run</h3><p class="sub">This report has no Sui record. Newer checks read the Pyth object on Sui through Tatum.</p>`;
    if (!o.ok) return `<h3>On-chain record not read</h3><p class="sub">${esc(o.error || o.line)}</p>`;
    const via = o.provider === 'tatum' ? 'Tatum Sui gRPC' : `${o.provider} (public node after a Tatum quota error)`;
    return `<h3>The same price, on Sui</h3><p class="sub">${esc(FEED[o.feed] || o.feed)}'s Pyth PriceInfoObject on Sui mainnet, read through ${esc(via)} in ${esc(o.tatumCalls ?? '?')} call(s), and compared with Pyth itself.</p>
      <dl class="kv">
        <div><dt>On-chain price</dt><dd class="mono">${esc(o.price)} ± ${esc(o.conf)}</dd></div>
        <div><dt>Published</dt><dd>${utc(o.publishTime)} <span class="mono">(${esc(o.ageMin)} min old)</span></dd></div>
        <div><dt>vs Pyth, same second</dt><dd>${esc(o.status || 'n/a')} <span class="mono">${o.vsSameSecondBps == null ? '' : `(${esc(o.vsSameSecondBps)} bps)`}</span></dd></div>
        <div><dt>vs live Pyth</dt><dd class="mono">${o.vsLiveBps == null ? 'n/a' : `${o.vsLiveBps > 0 ? '+' : ''}${esc(o.vsLiveBps)} bps`}</dd></div>
        <div><dt>Object</dt><dd class="mono">${ext(SUIVISION_OBJ(o.objectId), esc(short(o.objectId, 8, 6)))} ${copyBtn(o.objectId)}</dd></div>
        <div><dt>Version · checkpoint</dt><dd class="mono">${esc(o.version)} · ${esc(o.checkpoint)}</dd></div>
        <div><dt>Read via</dt><dd>${esc(via)}</dd></div>
      </dl>
      ${o.notes?.length ? `<div class="notes">${o.notes.map(esc).join('<br>')}</div>` : ''}`;
  }

  function ruleHtml(r) {
    const u = r.rule;
    const KIND = { 'close-vs-prior-close': 'Close vs prior close', 'close-above': 'Close vs a fixed line', 'hit-high': 'Any 1-min High reaches the line', 'hit-low': 'Any 1-min Low reaches the line' };
    return `<h3>How this market settles</h3><p class="sub">Read from the market's own rules text, then checked by code${u.ruleCheck?.provider ? ` and by AI (${esc(u.ruleCheck.provider)}), which agreed on ${esc(u.ruleCheck.agreements.join(', '))}${u.ruleCheck.disagreements ? `, disagreed on ${u.ruleCheck.disagreements}` : ''}` : ''}.</p>
      <dl class="kv">
        <div><dt>Pyth feed</dt><dd class="mono">${esc(u.feed)}</dd></div>
        <div><dt>Settlement candle</dt><dd class="mono">${esc(u.candle || 'n/a')}</dd></div>
        <div><dt>Field</dt><dd>${esc(u.field)} of the 1-minute candle</dd></div>
        <div><dt>Rule</dt><dd>${esc(KIND[u.kind] || u.kind)} <span class="mono">${esc(u.comparator || '')}</span></dd></div>
        <div><dt>Line</dt><dd class="mono">${u.threshold == null ? 'n/a' : esc(u.threshold)}</dd></div>
        ${u.thresholdNote ? `<div><dt>Line from</dt><dd>${esc(u.thresholdNote)}</dd></div>` : ''}
        <div><dt>Session</dt><dd class="mono">${esc(u.session || 'n/a')}</dd></div>
        <div><dt>Tie</dt><dd>${esc(u.tieRule || 'n/a')}</dd></div>
        ${u.fallbackSource ? `<div><dt>Fallback source</dt><dd>${esc(u.fallbackSource)}</dd></div>` : ''}
      </dl>
      ${u.windowNotes.length ? `<div class="notes">${u.windowNotes.map(esc).join('<br>')}</div>` : ''}
      <p class="subhead">Edge cases in the rules</p><ul class="plainlist">${u.edgeCases.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      ${r.liquidityNote ? `<p class="mfoot">Thin-hours table (Alibi heuristic): ${esc(r.liquidityNote)}</p>` : ''}`;
  }

  function sourcesHtml(r) {
    return `<h3>Where the numbers came from</h3><p class="sub">Independent sources are marked. Compare is like with like: same instrument, same minute, same field.</p>
      <ul class="srcs">${r.sources.map((s) => `<li><span class="st ${s.ok ? 'pass' : 'flag'}">${s.ok ? 'ok' : 'miss'}</span><div><strong>${esc(s.name)}</strong>${s.independent ? ' <span class="tag">independent</span>' : ''}<div class="d">${esc(s.detail)}</div></div></li>`).join('')}</ul>`;
  }

  // ---------- running a check ----------
  let busy = false;
  async function check(url) {
    if (busy) return;
    busy = true;
    const btn = $('.go'); btn.disabled = true;
    wrap.hidden = false;
    let stages = [];
    let cur = -1;
    const t0 = Date.now();
    const draw = () => {
      wrap.innerHTML = `<div class="glass progress" role="status"><h2>Checking the settlement price</h2><p class="q">${esc(url)}</p>
        <ol class="steps">${stages.map((s, i) => `<li class="${i < cur ? 'done' : i === cur ? 'on' : ''}"><span class="dot"></span>${esc(s.label)}</li>`).join('')}</ol>
        <p class="meta"><span class="mono" id="el">0</span> s · a live check reads real feeds and usually takes about a minute. Steps light up as Alibi talks to each source.</p></div>`;
    };
    const timer = setInterval(() => { const el = $('#el'); if (el) el.textContent = Math.round((Date.now() - t0) / 1000); }, 1000);
    stages = [{ label: 'Reading the market rules' }, { label: 'Reading the Pyth settlement feed' }, { label: 'Cross-checking Hyperliquid' }, { label: 'Reading the Sui record via Tatum' }, { label: 'Recalling Walrus Memory' }];
    draw();
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const res = await fetch('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', result = null, error = null;
      const handle = (line) => {
        if (!line.trim()) return;
        let o; try { o = JSON.parse(line); } catch { return; }
        if (o.type === 'stages') { stages = o.stages; draw(); }
        else if (o.type === 'stage') { cur = o.stage; draw(); }
        else if (o.type === 'result') result = o.result;
        else if (o.type === 'error' || o.error) error = o.error;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      handle(buf);
      if (result) { cur = stages.length; renderReport(result); history.replaceState(null, '', `?m=${encodeURIComponent(url)}`); }
      else showError(error || `The check did not finish (HTTP ${res.status}).`);
    } catch (e) {
      showError('The connection dropped before the check finished. On the hosted demo a live check can hit the time limit.');
    } finally {
      clearInterval(timer); busy = false; btn.disabled = false;
    }
  }
  function showError(msg) {
    wrap.innerHTML = `<div class="glass err" role="alert"><p><strong>Could not finish this check.</strong> ${esc(msg)}</p><button type="button" class="btn ghost" id="err-demo">Open the saved gold report instead</button></div>`;
    $('#err-demo').addEventListener('click', openDemo);
  }
  async function openDemo() {
    wrap.hidden = false;
    wrap.innerHTML = '<div class="glass progress"><h2>Opening the saved report…</h2></div>';
    try { const r = await (await fetch('/api/demo')).json(); renderReport(r); } catch { wrap.innerHTML = '<div class="glass err"><p>Saved report not available.</p></div>'; }
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#ask').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#url').value.trim(); if (v) check(v); });
  $('#open-demo').addEventListener('click', openDemo);

  // chips
  fetch('/api/samples').then((r) => r.json()).then(({ chips }) => {
    const box = $('#try');
    for (const c of chips || []) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip';
      b.title = c.question || c.slug;
      b.innerHTML = `${esc(c.label)}${c.live ? '' : ' <small>(may be closed)</small>'}`;
      b.addEventListener('click', () => { $('#url').value = c.url; check(c.url); });
      box.appendChild(b);
    }
  }).catch(() => {});

  // ---------- learned / evidence / stats from proof files ----------
  fetch('/api/state').then((r) => r.json()).then((s) => { learned(s); evidence(s); stats(s); }).catch(() => {});

  function learned(s) {
    const ba = s.beforeAfter;
    if (ba) {
      $('#ba').innerHTML = `
        <article class="glass ba-card"><p class="lbl">Live data only</p><p class="big">${esc(ba.before.score)}<small> /100</small></p><p class="vl"><span class="verdict b-${esc(ba.before.band)}">${esc(ba.before.band)}</span></p><p class="vl">${esc(ba.before.verdict)}</p><p class="sl">${esc(ba.before.sentence)}</p></article>
        <div class="ba-mid" aria-hidden="true"><div><span>→</span>same data</div></div>
        <article class="glass ba-card after"><p class="lbl">Same data + Walrus Memory</p><p class="big">${esc(ba.after.score)}<small> /100</small></p><p class="vl"><span class="verdict b-${esc(ba.after.band)}">${esc(ba.after.band)}</span></p><p class="vl">${esc(ba.after.verdict)}</p><p class="sl">${esc(ba.after.sentence)}</p></article>
        <p class="ba-foot">${esc(ba.market)} · one data pull at ${utc(ba.at, true)}, scored twice. Files: <code>${ba.files.map(esc).join('</code>, <code>')}</code></p>`;
    }
    const m = s.memory;
    const incRows = m.incidents.map((i) => `<tr><td class="mono">${utc(i.when)}</td><td>${esc(i.name)}</td><td>${esc(PATTERN[i.pattern] || i.pattern)}${i.ratio != null ? ` · <span class="mono">${esc(i.ratio)}×</span> normal (<span class="mono">${esc(i.confBps)}</span> bps)` : ''}${i.sizeBps != null ? ` · <span class="mono">${esc(i.sizeBps)}</span> bps` : ''}${i.simulated ? ' · simulated' : ''}</td><td>${esc(i.bucket || '')}</td><td><span class="blobid">${esc(short(i.blobId, 6, 4))}</span> ${copyBtn(i.blobId)} ${ext(WALRUS(i.blobId), 'Walruscan')}${i.evidence ? ` · ${ext(i.evidence, 'Pyth')}` : ''}</td></tr>`).join('');
    const ch = ba?.changes?.map((c) => `<div class="mrow hist"><span class="i">+</span><div class="txt"><div class="l">${esc(c.factor)}: severity ${esc(c.from)} → ${esc(c.to)}</div><div class="d">${c.memories.map((x) => `<span class="blobid">${esc(short(x.blobId, 8, 4))}</span> w=<span class="mono">${esc(x.weight)}</span>`).join(' · ')}</div></div><span class="st watch">Memory</span><span class="pts">+${esc(c.points)}</span></div>`).join('') || '';
    const nsHtml = m.namespaces.map((n) => `<div><div class="n">${esc(n.writes)}</div><div class="k">${esc(n.namespace)}</div><div class="x">${n.misfiled ? `${esc(n.misfiled)} early writes landed here by an SDK namespace quirk and were rewritten to the right namespace` : n.writes ? 'writes on Walrus mainnet' : 'none yet (user verdicts)'}</div></div>`).join('');
    $('#memory-card').innerHTML = tabs('mt', [
      { label: `Incidents (${m.incidents.length})`, html: `<h3>Real incidents in memory</h3><p class="sub">Found by Alibi's own scan of Pyth history against Hyperliquid, then written to Walrus. Times in UTC.</p><div class="tablewrap"><table class="inc"><thead><tr><th>When</th><th>Feed</th><th>What</th><th>Hours</th><th>Walrus blob</th></tr></thead><tbody>${incRows}</tbody></table></div>` },
      { label: 'How memory changed the score', html: `<h3>The memory effect</h3><p class="sub">Only memories on the same Pyth feed count. Ones at this market's settlement window count fully, others at 0.15×, older ones fade.</p><div class="matrix">${ch}</div>` },
      { label: 'Namespaces', html: `<h3>${esc(m.writes)} writes on Walrus mainnet</h3><p class="sub">Read from <code>${esc(m.file)}</code>. Backend: ${m.backends.map(esc).join(', ')}.</p><div class="ns">${nsHtml}</div>` },
    ]);
  }

  function evidence(s) {
    const tx = s.sui.executed;
    const what = (t) => `${t.kind === 'create' ? 'Created' : 'Updated'} the ${esc(FEED[t.feed] || t.feed || short(t.feedId))} Pyth price object on Sui`;
    const prov = (p) => (p === 'tatum' ? '<span class="ptag tatum">TATUM</span>' : `<span class="ptag pub">${esc(p === 'public-fullnode' ? 'PUBLIC SUI NODE' : p)}</span>`);
    $('#txs').innerHTML = tx.map((t) => `<div class="tx">
        <div><div class="what">${what(t)}</div><div class="when">${utc(t.at, true)} · gas <span class="mono">${(Number(t.gasMist) / 1e9).toFixed(6)}</span> SUI</div>
          <div class="prov"><span class="ptag pub">SIMULATED VIA</span>${prov(t.simulatedBy)}<span class="ptag pub">EXECUTED VIA</span>${prov(t.executedBy)}</div></div>
        <div class="dg">${esc(t.digest)} ${copyBtn(t.digest)}${t.evidenceBlob ? `<div class="when">Walrus evidence blob <span class="blobid" style="color:#D4D6DA">${esc(short(t.evidenceBlob, 8, 4))}</span></div>` : ''}</div>
        <div class="lk">${ext(SUIVISION_TX(t.digest), 'Suivision ↗')}${ext(SUISCAN_TX(t.digest), 'Suiscan ↗')}</div></div>`).join('');
    const byPub = tx.filter((t) => t.executedBy !== 'tatum').length, byT = tx.filter((t) => t.executedBy === 'tatum').length;
    $('#txs').insertAdjacentHTML('beforeend', `<p class="txnote">${byPub} of ${tx.length} executed through the public Sui node: Tatum's free plan answered HTTP 429 at that moment (logged as <code>quota-error</code> in <code>${esc(s.tatum.file)}</code>), and the code at the time let writes fall back. ${byT} executed through Tatum. Writes no longer fall back.</p>`);
  }

  function stats(s) {
    const items = [
      [s.scan?.incidents, 'real incidents found', `in a ${esc(s.scan?.days)}-day scan of Pyth history, ${esc(s.scan?.feeds?.length)} feeds`],
      [s.memory.writes, 'Walrus Memory writes', `on mainnet, across ${s.memory.namespaces.filter((n) => n.writes).length} namespaces`],
      [s.sui.executed.length, 'Sui mainnet transactions', `${s.sui.executed.filter((t) => t.executedBy === 'tatum').length} executed via Tatum, all simulated via Tatum`],
      [s.tatum.tatumOk, 'Tatum gRPC calls', `succeeded; ${esc(s.tatum.tatumQuotaErrors)} hit the quota`],
      [s.tests.cases, 'test cases', `${s.tests.files.length} files, node --test`],
    ];
    $('#stats').innerHTML = items.map(([n, k, x]) => `<div class="stat"><div class="n">${esc(n ?? '–')}</div><div class="k">${k}</div><div class="x">${x}</div></div>`).join('');
    $('#stats').insertAdjacentHTML('afterend', `<p class="stats-foot">Counted from the proof files at ${utc(s.generatedAt)} · <a href="/proof">see every count on /proof</a></p>`);
  }

  // hide the centre nav once the page scrolls, so it never sits on top of content
  const onScroll = () => document.body.classList.toggle('scrolled', scrollY > 160);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // deep link: /?m=<polymarket url> runs that check; /?demo shows the saved report
  const q = new URLSearchParams(location.search);
  if (q.has('demo')) openDemo();
  else if (q.get('m')) { $('#url').value = q.get('m'); }
})();
