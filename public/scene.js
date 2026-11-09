// Hero scene, drawn by us (no brand rasters): Walrus-style glass plates with a diamond cut-out drifting in 3D,
// and three Tatum-coloured blocks that assemble into the T arrangement and drift apart again.
// Pure CSS 3D transforms (compositor-only); paused off-screen and in hidden tabs; a still frame under
// prefers-reduced-motion (handled in CSS).
(() => {
  const scene = document.getElementById('scene');
  if (!scene) return;

  // shared SVG gradients for every plate
  const defs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <linearGradient id="g-face" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#D9D0FF" stop-opacity=".20"/><stop offset=".45" stop-color="#7B5CFF" stop-opacity=".07"/>
      <stop offset=".8" stop-color="#2CCD9A" stop-opacity=".06"/><stop offset="1" stop-color="#FAF8F5" stop-opacity=".14"/></linearGradient>
    <linearGradient id="g-iri" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#E7E0FF"/><stop offset=".3" stop-color="#8E73FF"/><stop offset=".55" stop-color="#7FE9D0"/>
      <stop offset=".8" stop-color="#B9A6FF"/><stop offset="1" stop-color="#FAF8F5"/></linearGradient>
    <linearGradient id="g-cut" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FAF8F5"/><stop offset=".5" stop-color="#9C86FF"/><stop offset="1" stop-color="#5FE0BC"/></linearGradient>
  </defs></svg>`;
  const PLATE = 'M24 0H176A24 24 0 0 1 200 24V236A24 24 0 0 1 176 260H24A24 24 0 0 1 0 236V24A24 24 0 0 1 24 0Z';
  const CUT = 'M100 88 L131 130 L100 172 L69 130Z';
  const layer = (z, face) => `<svg class="pl" viewBox="-2 -2 204 264" style="transform:translateZ(${z}px)" aria-hidden="true">
      <path d="${PLATE} ${CUT}" fill-rule="evenodd" fill="${face ? 'url(#g-face)' : 'none'}" stroke="url(#g-iri)" stroke-width="${face ? 2.4 : 1.6}" stroke-opacity="${face ? 1 : .55}"/>
      ${face ? `<path d="${CUT}" fill="none" stroke="url(#g-cut)" stroke-width="3" stroke-linejoin="round"/>` : ''}</svg>`;

  // plates: position (% of scene), width, depth blur, start/end rotations, duration
  const PLATES = [
    { x: 64, y: 6, w: 150, rx: [58, 66], ry: [-18, 8], rz: [-28, -14], d: 26, k: 'near' },
    { x: 86, y: 63, w: 150, rx: [18, 34], ry: [28, 4], rz: [18, 30], d: 31, k: 'near' },
    { x: 61, y: 76, w: 100, rx: [-30, -12], ry: [-34, -10], rz: [-12, 6], d: 23, k: 'mid' },
    { x: 91, y: 2, w: 120, rx: [10, 24], ry: [20, -6], rz: [8, 18], d: 29, k: 'far' },
    { x: 3, y: 56, w: 120, rx: [8, 22], ry: [-24, 0], rz: [-20, -8], d: 33, k: 'far' },
    { x: 30, y: 4, w: 84, rx: [40, 52], ry: [0, 22], rz: [20, 34], d: 27, k: 'far' },
  ];
  const plates = PLATES.map((p, i) => `<div class="plate ${p.k}" style="left:${p.x}%;top:${p.y}%;--w:${p.w}px;--rx0:${p.rx[0]}deg;--rx1:${p.rx[1]}deg;--ry0:${p.ry[0]}deg;--ry1:${p.ry[1]}deg;--rz0:${p.rz[0]}deg;--rz1:${p.rz[1]}deg;--dur:${p.d}s;--del:-${(i * 3.7).toFixed(1)}s">
      <div class="plate-in">${layer(-9, false)}${layer(-4.5, false)}${layer(0, true)}</div></div>`).join('');

  // Tatum blocks: exact proportions of the T mark (270 × 210 units), scattered start positions per block
  const BLOCKS = [
    { c: 'mint', x: 149.39, y: 0, w: 120.15, h: 60.07, s: ['150px', '-130px', '90px', '40deg', '-60deg', '20deg'] },
    { c: 'violet', x: 0, y: 29.29, w: 120.09, h: 60.08, s: ['-170px', '-60px', '60px', '-30deg', '50deg', '-25deg'] },
    { c: 'violet', x: 120.09, y: 89.37, w: 65.38, h: 120.14, s: ['40px', '170px', '120px', '55deg', '25deg', '35deg'] },
  ];
  const cube = (b) => {
    const D = 26;
    const f = (cls, st) => `<i class="${cls}" style="${st}"></i>`;
    return `<div class="blk ${b.c}" style="left:calc(${b.x} * var(--u));top:calc(${b.y} * var(--u));width:calc(${b.w} * var(--u));height:calc(${b.h} * var(--u));--sx:${b.s[0]};--sy:${b.s[1]};--sz:${b.s[2]};--srx:${b.s[3]};--sry:${b.s[4]};--srz:${b.s[5]};--d:${D}px;--hw:calc(${b.w / 2} * var(--u));--hh:calc(${b.h / 2} * var(--u))">
      ${f('fc front', '')}${f('fc back', '')}${f('fc side l', '')}${f('fc side r', '')}${f('fc cap t', '')}${f('fc cap b', '')}</div>`;
  };
  scene.innerHTML = `${defs}<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>${plates}
    <div class="tee-wrap"><div class="tee-glow"></div><div class="tee">${BLOCKS.map(cube).join('')}</div></div>`;

  // pause when off-screen or the tab is hidden
  let vis = true;
  const upd = () => scene.classList.toggle('paused', !vis || document.hidden);
  new IntersectionObserver(([e]) => { vis = e.isIntersecting; upd(); }).observe(scene);
  document.addEventListener('visibilitychange', upd);
})();
