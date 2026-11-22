// Who contacted whom in a run. One dot per agent on a ring, grouped by branch; a curve joins two agents when one
// addressed the other. Four ways to address someone are counted, each from the run's own record:
//   message    a Room message that names the other agent (@R12)
//   check      re-opening a source the other agent logged
//   challenge  challenging a claim the other agent made
//   answer     resolving a challenge the other agent raised
// Drawn on a canvas, since a large run has thousands of pairs. The table under it says the same in numbers.
const KINDS = [
  ['message', 'Messages', 'named the other agent in the Room'],
  ['check', 'Checks', "re-opened the other agent's source"],
  ['challenge', 'Challenges', "challenged the other agent's claim"],
  ['answer', 'Answers', "resolved the other agent's challenge"],
];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Math.round(n).toLocaleString('en-US');

// data: { seats: [{id, role, branch}], edges: Map("kind|from|to" -> count), branchTitle: Map(branch -> title) }
export function topologyStats(data) {
  const seats = new Map(data.seats.map((s) => [s.id, s]));
  const pairs = new Map();           // "a|b" directed -> { message, check, challenge, answer }
  const byKind = Object.fromEntries(KINDS.map(([k]) => [k, 0]));
  for (const [key, n] of data.edges) {
    const [kind, a, b] = key.split('|');
    if (a === b || !seats.has(a) || !seats.has(b) || !(kind in byKind)) continue;
    const p = pairs.get(`${a}|${b}`) || { a, b, message: 0, check: 0, challenge: 0, answer: 0 };
    p[kind] += n; byKind[kind] += n; pairs.set(`${a}|${b}`, p);
  }
  const out = new Map(), inn = new Map();
  let within = 0, across = 0, hub = 0;
  for (const p of pairs.values()) {
    if (!out.has(p.a)) out.set(p.a, new Set()); out.get(p.a).add(p.b);
    if (!inn.has(p.b)) inn.set(p.b, new Set()); inn.get(p.b).add(p.a);
    const A = seats.get(p.a), B = seats.get(p.b);
    if (!A.branch || !B.branch) hub++; else if (A.branch === B.branch) within++; else across++;
  }
  const team = data.seats.filter((s) => s.role === 'researcher' || s.role === 'redteam');
  const silent = team.filter((s) => !out.has(s.id) && !(inn.get(s.id) && [...inn.get(s.id)].some((x) => seats.get(x).branch)));
  return { seats, pairs, byKind, out, inn, within, across, hub, team, silent };
}

export function renderTopology(el, data) {
  const st = topologyStats(data);
  const branches = [...new Set(data.seats.map((s) => s.branch).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const total = st.pairs.size;
  if (!total) { el.innerHTML = '<p class="empty">No agent has addressed another yet.</p>'; return; }
  const state = el._topo || (el._topo = { kind: 'all', hover: null, pin: null });
  const peers = st.within + st.across;
  const lede = branches.length > 1 && peers
    ? `${num(total)} pairs of agents were in contact. Between researchers and red team, ${Math.round((100 * st.within) / peers)}% of pairs sit inside one branch and ${Math.round((100 * st.across) / peers)}% cross branches.`
    : `${num(total)} pairs of agents were in contact.`;
  const top = st.team.map((s) => ({ s, o: st.out.get(s.id)?.size || 0, i: st.inn.get(s.id)?.size || 0 })).sort((x, y) => y.o + y.i - (x.o + x.i)).slice(0, 10);
  el.innerHTML = `
    <p class="topo-lede">${esc(lede)}${st.silent.length ? ` ${num(st.silent.length)} of ${num(st.team.length)} agents never addressed a teammate and were never addressed by one.` : ''}</p>
    <div class="topo-filter" role="group" aria-label="What counts as contact">
      <button type="button" data-k="all" aria-pressed="${state.kind === 'all'}">All contact</button>
      ${KINDS.map(([k, label], i) => `<button type="button" data-k="${k}" aria-pressed="${state.kind === k}" title="${esc(KINDS[i][2])}"><i class="k${i + 1}"></i>${label} <span>${num(st.byKind[k])}</span></button>`).join('')}
    </div>
    <div class="topo-stage"><canvas></canvas><div class="topo-tip" hidden></div></div>
    <p class="topo-key"><span><i class="dot"></i>researcher</span><span><i class="ring"></i>red team</span><span><i class="sq"></i>planner, writer, judge</span><span>Agents sit on the ring by branch. Hover an agent to see only its contacts; click to keep it.</span></p>
    <details class="topo-table"><summary>Most connected agents</summary>
      <table><thead><tr><th>Agent</th><th>Role</th><th>Branch</th><th>Addressed</th><th>Addressed by</th></tr></thead>
      <tbody>${top.map(({ s, o, i }) => `<tr><td>${esc(s.id)}</td><td>${s.role === 'redteam' ? 'red team' : esc(s.role)}</td><td>${esc(s.branch || '')}</td><td>${o}</td><td>${i}</td></tr>`).join('')}</tbody></table>
    </details>`;

  const stage = el.querySelector('.topo-stage'), cv = el.querySelector('canvas'), tip = el.querySelector('.topo-tip');
  const css = getComputedStyle(el);
  const ink = css.getPropertyValue('--fg').trim() || '#1c1c1a', muted = css.getPropertyValue('--muted').trim() || '#66655f', faint = css.getPropertyValue('--faint').trim() || '#9b9992', bg = css.getPropertyValue('--bg').trim() || '#f8f7f3';
  const hue = KINDS.map((_, i) => css.getPropertyValue(`--series-${i + 1}`).trim() || ink);

  // layout: ring seats by branch, the three single seats in the middle
  const ring = data.seats.filter((s) => s.role === 'researcher' || s.role === 'redteam').sort((a, b) => (a.branch || '').localeCompare(b.branch || '', undefined, { numeric: true }) || (a.role === b.role ? a.id.localeCompare(b.id, undefined, { numeric: true }) : a.role === 'researcher' ? -1 : 1));
  const mid = data.seats.filter((s) => !(s.role === 'researcher' || s.role === 'redteam') && (st.out.has(s.id) || st.inn.has(s.id)));
  const groups = branches.length || 1, gap = groups > 1 ? Math.min(0.045, (Math.PI * 2 * 0.18) / groups) : 0;
  const step = (Math.PI * 2 - gap * groups) / Math.max(1, ring.length);
  const pos = new Map(), arcs = [];
  let W = 0, R = 0, cx = 0, cy = 0;
  function place() {
    W = Math.max(320, Math.min(stage.clientWidth, 760));
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = W * dpr; cv.style.width = cv.style.height = `${W}px`;
    cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = cy = W / 2; R = W / 2 - (groups > 1 && groups <= 40 ? 34 : 14);
    pos.clear(); arcs.length = 0;
    let a = -Math.PI / 2, last = null, from = a;
    ring.forEach((s, i) => {
      if (i && s.branch !== last) { arcs.push([last, from, a - step]); a += gap; from = a; }
      last = s.branch;
      pos.set(s.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a, s });
      a += step;
    });
    if (ring.length) arcs.push([last, from, a - step]);
    mid.forEach((s, i) => pos.set(s.id, { x: cx + (i - (mid.length - 1) / 2) * Math.min(64, R * 0.3), y: cy, a: null, s }));
  }
  const shown = (p) => (state.kind === 'all' ? true : p[state.kind] > 0);
  const mainKind = (p) => (state.kind !== 'all' ? KINDS.findIndex(([k]) => k === state.kind) : KINDS.reduce((best, [k], i) => (p[k] > p[KINDS[best][0]] ? i : best), 0));
  function draw() {
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, W);
    const focus = state.pin || state.hover;
    const list = [...st.pairs.values()].filter(shown);
    const base = Math.max(0.05, Math.min(0.5, 110 / Math.sqrt(list.length + 1) / 10));
    const curve = (p, alpha, width) => {
      const A = pos.get(p.a), B = pos.get(p.b);
      if (!A || !B) return;
      g.beginPath(); g.moveTo(A.x, A.y);
      if (A.a == null || B.a == null) g.lineTo(B.x, B.y);
      else { const pull = 0.25 + 0.55 * (1 - Math.min(1, Math.abs(Math.atan2(Math.sin(A.a - B.a), Math.cos(A.a - B.a))) / Math.PI)); g.quadraticCurveTo(cx + (((A.x + B.x) / 2 - cx) * pull), cy + (((A.y + B.y) / 2 - cy) * pull), B.x, B.y); }
      g.strokeStyle = hue[mainKind(p)]; g.globalAlpha = alpha; g.lineWidth = width; g.stroke();
    };
    for (const p of list) if (!focus) curve(p, base, 1); else if (p.a !== focus && p.b !== focus) curve(p, Math.min(0.04, base), 1);
    if (focus) for (const p of list) if (p.a === focus || p.b === focus) curve(p, 0.85, p.a === focus ? 1.6 : 1);
    g.globalAlpha = 1;
    // branch arcs and names
    if (groups > 1) {
      g.strokeStyle = faint; g.lineWidth = 1; g.fillStyle = muted; g.font = '11px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const [name, a0, a1] of arcs) {
        g.globalAlpha = 0.7; g.beginPath(); g.arc(cx, cy, R + 9, a0 - step * 0.3, a1 + step * 0.3); g.stroke(); g.globalAlpha = 1;
        if (groups <= 40) { const m = (a0 + a1) / 2; g.fillText(name || '', cx + (R + 23) * Math.cos(m), cy + (R + 23) * Math.sin(m)); }
      }
    }
    // agents: filled dot = researcher, ring = red team, square = the single seats
    const near = focus ? new Set([focus, ...(st.out.get(focus) || []), ...(st.inn.get(focus) || [])]) : null;
    const r0 = ring.length > 400 ? 1.6 : ring.length > 140 ? 2.4 : 3.6;
    for (const [id, p] of pos) {
      const deg = (st.out.get(id)?.size || 0) + (st.inn.get(id)?.size || 0);
      const r = p.a == null ? 6 : r0 + Math.min(3, Math.sqrt(deg) * 0.28);
      g.globalAlpha = near && !near.has(id) ? 0.25 : 1;
      g.beginPath();
      if (p.a == null) g.rect(p.x - r, p.y - r, r * 2, r * 2); else g.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (p.s.role === 'redteam') { g.fillStyle = bg; g.fill(); g.strokeStyle = ink; g.lineWidth = 1.4; g.stroke(); } else { g.fillStyle = ink; g.fill(); g.strokeStyle = bg; g.lineWidth = 1.5; g.stroke(); }
      if (p.a == null || id === focus) { g.fillStyle = ink; g.font = '500 11px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(id, p.x, p.y + (p.a == null ? 17 : p.y > cy ? 14 : -14)); }
    }
    g.globalAlpha = 1;
  }
  function nearest(ev) {
    const b = cv.getBoundingClientRect(), x = ev.clientX - b.left, y = ev.clientY - b.top;
    let best = null, d = 14 * 14;
    for (const [id, p] of pos) { const q = (p.x - x) ** 2 + (p.y - y) ** 2; if (q < d) { d = q; best = id; } }
    return [best, x, y];
  }
  function tell(id, x, y) {
    if (!id) { tip.hidden = true; return; }
    const s = st.seats.get(id), o = st.out.get(id) || new Set(), i = st.inn.get(id) || new Set();
    const kinds = KINDS.map(([k, label]) => { let n = 0; for (const p of st.pairs.values()) if (p.a === id) n += p[k]; return n ? `${label.toLowerCase()} ${n}` : ''; }).filter(Boolean).join(' · ');
    const title = s.branch && data.branchTitle?.get(s.branch);
    tip.innerHTML = `<b>${esc(id)}</b> <span>${s.role === 'redteam' ? 'red team' : esc(s.role)}${s.branch ? ` · ${esc(s.branch)}` : ''}</span>${title ? `<em>${esc(title)}</em>` : ''}<div>addressed ${o.size} agent${o.size === 1 ? '' : 's'} · addressed by ${i.size}</div>${kinds ? `<div class="k">${esc(kinds)}</div>` : ''}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(W - 230, Math.max(0, x + 14))}px`; tip.style.top = `${Math.max(0, y + 14)}px`;
  }
  cv.onmousemove = (ev) => { const [id, x, y] = nearest(ev); if (id !== state.hover) { state.hover = id; draw(); } tell(id || state.pin, x, y); cv.style.cursor = id ? 'pointer' : 'default'; };
  cv.onmouseleave = () => { state.hover = null; tip.hidden = true; draw(); };
  cv.onclick = (ev) => { const [id] = nearest(ev); state.pin = id && id !== state.pin ? id : null; draw(); };
  el.querySelector('.topo-filter').onclick = (ev) => { const b = ev.target.closest('button[data-k]'); if (!b) return; state.kind = b.dataset.k; el.querySelectorAll('.topo-filter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(); };
  place(); draw();
  el._topoRedraw = () => { place(); draw(); };
  if (!el._topoResize) { el._topoResize = true; window.addEventListener('resize', () => { if (el.isConnected && !el.hidden && el.querySelector('canvas')) el._topoRedraw(); }); }
}
