import { marked } from '/vendor/marked.esm.js';
import { placeFigures } from '/figures.js';
import { protectMath } from '/mathmd.js';

// a published copy sets window.GP = { base: '/gprometheus', static: true }: finished runs served as files, no server
const BASE = window.GP?.base || '';
const STATIC = !!window.GP?.static;
const fileUrl = (id, name) => (STATIC ? `${BASE}/data/${encodeURIComponent(id)}/${name}` : `/api/runs/${encodeURIComponent(id)}/file/${name}`);

// ---------- helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const drawer = $('#drawer');
const scrim = $('#scrim');

const PHASES = ['plan', 'research', 'crosscheck', 'redteam', 'fix', 'gate', 'write', 'review', 'judge', 'done'];
const PHASE_LABEL = { plan: 'Plan', research: 'Research', crosscheck: 'Cross-check', redteam: 'Red team', fix: 'Fix', gate: 'Gate', write: 'Write', review: 'Team review', judge: 'Judge', done: 'Done' };
const PHASE_VERB = { plan: 'planning', research: 'researching', crosscheck: 'cross-checking', redteam: 'challenging', fix: 'fixing', gate: 'gating', write: 'writing', judge: 'judging' };
const ROLE_LABEL = { planner: 'Planner', researcher: 'Researcher', redteam: 'Red team', judge: 'Judge', writer: 'Writer' };
const R_HUES = [252, 192, 142, 305, 82, 222, 338, 112];
const X_HUES = [32, 52, 14];
const CLAIM_RE = /\b(C\d+-\d+)\b/g;

function fmtNum(n) {
  n = Math.round(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
const ts = (x) => (x ? Date.parse(x) : NaN);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function seatVars(id) {
  let m, h = 260, c = 0.02;
  if ((m = /^R(\d+)/.exec(id))) { h = R_HUES[(m[1] - 1) % R_HUES.length]; c = 0.09; }
  else if ((m = /^X(\d+)/.exec(id))) { h = X_HUES[(m[1] - 1) % X_HUES.length]; c = 0.15; }
  else if (id === 'J') { h = 285; c = 0.05; }
  else if (id === 'W') { h = 62; c = 0.06; }
  else if (id === 'P') { h = 250; c = 0.025; }
  return `--sh:${h};--sc:${c}`;
}
function roleOf(id) {
  const s = S && S.seats.get(id);
  if (s && ROLE_LABEL[s.role]) return ROLE_LABEL[s.role];
  if (/^R\d/.test(id)) return 'Researcher';
  if (/^X\d/.test(id)) return 'Red team';
  return { P: 'Planner', J: 'Judge', W: 'Writer', system: 'Orchestrator' }[id] || '';
}
const seatTag = (id) => id && id !== 'system' ? `<span class="seat" style="${seatVars(id)}" title="${esc(id + ' ' + roleOf(id))}">${esc(id)}</span>` : `<span class="seat">sys</span>`;

// Inline text: escape, then @mentions and claim ids.
function richText(text) {
  let s = esc(text);
  s = s.replace(/@([A-Z]\d*)\b/g, (m, id) => `<span class="mention" style="${seatVars(id)}">@${id}</span>`);
  s = s.replace(CLAIM_RE, (m, id) => citeChip(id));
  s = s.replace(/\b(S\d+-\d+)\b/g, (m, id) => `<span class="idref" data-source="${id}">${id}</span>`);
  return s;
}
function citeChip(id) {
  const st = S ? claimState(id) : '';
  return `<button class="cite ${st}" data-claim="${esc(id)}" type="button">${esc(id)}</button>`;
}

// ---------- state
let S = null;
function freshState(id) {
  return {
    id, run: null, events: 0, seats: new Map(),
    phase: null, phaseSeen: new Map(), done: null, lastAt: 0,
    claims: new Map(), sources: new Map(), questions: new Map(), challenges: new Map(), figures: new Map(),
    answers: new Map(), checks: new Map(), resolutions: new Map(), notFound: new Map(), rejected: [],
    turns: [], openTurns: new Map(), gates: [], judges: [], baseline: null, baselineStart: null,
    reports: 0, reportHtml: null, baselineMd: null, baselineHtml: null,
    tab: null, tabChosen: false, dirty: new Set(), drawerClaim: null, evFilter: 'all',
  };
}

function ingestRow(r, seat, at) {
  const row = { by: seat, at, ...r };
  switch (row.type) {
    case 'claim': S.claims.set(row.id, row); break;
    case 'figure': S.figures.set(row.id, row); break;
    case 'source': S.sources.set(row.id, row); break;
    case 'question': S.questions.set(row.id, row); break;
    case 'challenge': S.challenges.set(row.id, row); break;
    case 'answer': S.answers.set(row.question, row); break;
    case 'check': S.checks.set(`${row.source}|${row.by}`, row); break;
    case 'resolution': S.resolutions.set(row.challenge, row); break;
    case 'not_found': S.notFound.set(row.text, row); break;
  }
}

// derived indexes, recomputed lazily
let D = null;
function derive() {
  if (D) return D;
  const kept = (r) => r.status !== 'dropped';
  const srcByClaim = new Map(), checksBySrc = new Map(), chalByClaim = new Map();
  for (const s of S.sources.values()) { if (!srcByClaim.has(s.claim)) srcByClaim.set(s.claim, []); srcByClaim.get(s.claim).push(s); }
  for (const c of S.checks.values()) { if (!checksBySrc.has(c.source)) checksBySrc.set(c.source, []); checksBySrc.get(c.source).push(c); }
  for (const c of S.challenges.values()) { if (!chalByClaim.has(c.claim)) chalByClaim.set(c.claim, []); chalByClaim.get(c.claim).push(c); }
  const keptClaims = [...S.claims.values()].filter(kept);
  const keptClaimIds = new Set(keptClaims.map((c) => c.id));
  const keptSources = [...S.sources.values()].filter((s) => kept(s) && (keptClaimIds.has(s.claim) || !S.claims.has(s.claim)));
  const publishers = new Set(keptSources.map((s) => (s.publisher || host(s.url)).trim().toLowerCase()).filter(Boolean));
  const checks = [...S.checks.values()];
  const open = [...S.challenges.values()].filter((c) => !S.resolutions.has(c.id));
  let searches = 0, urls = 0, tokens = 0;
  const uniquePages = new Set();
  for (const t of S.turns) { searches += (t.searches || []).length; urls += (t.urls || []).length; tokens += t.tokens || 0; for (const u of t.urls || []) uniquePages.add(u); }
  const sourcePages = new Set(keptSources.map((s) => s.url));
  const answersByClaim = new Map();
  for (const a of S.answers.values()) for (const c of a.claims || []) { if (!answersByClaim.has(c)) answersByClaim.set(c, []); answersByClaim.get(c).push(a); }
  D = {
    srcByClaim, checksBySrc, chalByClaim, answersByClaim, keptClaims, keptSources, publishers, checks, open,
    keyClaims: keptClaims.filter((c) => c.key),
    confirmed: checks.filter((c) => c.result === 'confirmed').length,
    searches, urls, tokens, uniquePages: uniquePages.size, sourcePages: sourcePages.size,
  };
  return D;
}
const touch = () => { D = null; };
// a source that is an attached file opens the file itself
const srcHref = (url) => (/^attachment:/.test(url || '') ? `${STATIC ? `${BASE}/data/${encodeURIComponent(S.id)}/attachments/` : `/api/runs/${encodeURIComponent(S.id)}/attachment/`}${String(url).replace(/^attachment:\/*/, '').replace(/^attachments\//, '').replace(/#.*$/, '').split('/').map(encodeURIComponent).join('/')}` : url);
const byId = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

function claimInfo(id) {
  const d = derive();
  const c = S.claims.get(id);
  const srcs = d.srcByClaim.get(id) || [];
  const live = srcs.filter((s) => s.status !== 'dropped');
  const checks = live.flatMap((s) => d.checksBySrc.get(s.id) || []);
  const chals = d.chalByClaim.get(id) || [];
  const openChals = chals.filter((x) => !S.resolutions.has(x.id));
  const pubs = new Set(live.map((s) => (s.publisher || host(s.url)).trim().toLowerCase()));
  return {
    c, srcs, live, checks, chals, openChals, pubs,
    contra: live.some((s) => s.stance === 'contradicts'),
    wrong: checks.some((k) => k.result === 'wrong'),
    confirmed: checks.filter((k) => k.result === 'confirmed').length,
    single: !!(c && c.single_source) || pubs.size === 1,
  };
}
function claimState(id) {
  if (!S.claims.has(id)) return '';
  const i = claimInfo(id);
  if (i.c.status === 'dropped') return 'gone';
  if (i.openChals.length || i.wrong) return 'bad';
  if (i.single || i.contra) return 'flag';
  return '';
}


// ---------- Ask screen
async function showAsk() {
  document.title = 'Prometheus on Gemini';
  $('#topnav').innerHTML = '';
  app.innerHTML = `
  <section class="ask">
    <h1>Ask one question.</h1>
    <p class="lede">Gemini researchers split it up and search in parallel. A red team re-opens their sources. Every claim in the answer links to the exact quote behind it.</p>
    <form id="askf" autocomplete="off">
      <textarea name="question" required minlength="8" placeholder="How much grid battery storage did the US add in 2025, and what drove it?"></textarea>
      <div class="ask-row">
        <button class="opts-toggle" type="button" aria-expanded="false" aria-controls="optsgrid">Options</button>
        <div><span class="kbd">⌘↵</span><button class="btn" type="submit">Start</button></div>
      </div>
      <div class="opts" id="optsgrid" hidden>
        <div class="grid">
          <fieldset class="agents"><legend class="lab"><span>Agents</span><span class="v" data-v="split">13 researchers · 3 red team</span></legend>
            <div class="seg">${[8, 16, 32, 64, 128, 1024].map((n) => `<label><input type="radio" name="agents" value="${n}"${n === 16 ? ' checked' : ''}><span>${n}</span></label>`).join('')}</div>
          </fieldset>
          ${range('minutes', 'Minutes', 10, 120, 5, 30)}
          <fieldset class="agents"><legend class="lab"><span>Agent model</span><span class="v">Gemini 4</span></legend>
            <div class="seg">${[['gemini-4-hydrogen', 'Hydrogen'], ['gemini-4-neon', 'Neon'], ['gemini-4-carbon', 'Carbon'], ['mix', 'All']].map(([v, l], i) => `<label><input type="radio" name="seat_model" value="${v}"${i === 0 ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
          </fieldset>
          <fieldset class="agents"><legend class="lab"><span>Coordination</span><span class="v" data-v="modehint">code assigns the work</span></legend>
            <div class="seg"><label><input type="radio" name="mode" value="orchestrated" checked><span>Orchestrated</span></label><label><input type="radio" name="mode" value="free"><span>No orchestrator</span></label></div>
          </fieldset>
          <label class="attach"><span class="lab"><span>Attach files</span><span class="v" data-v="files">none</span></span><input type="file" name="files" multiple></label>
          <label class="check"><input type="checkbox" name="multimodal"> Multi-modal: agents may run code, compute and draw charts</label>
          <label class="check"><input type="checkbox" name="baseline" checked> Compare with Google Deep Research</label>
        </div>
      </div>
      <div class="err" id="err"></div>
    </form>
    <section class="past" id="past" hidden><h2>Past runs</h2><ol></ol></section>
  </section>`;
  const f = $('#askf');
  const ot = $('.opts-toggle', f);
  ot.addEventListener('click', () => { const g = $('#optsgrid'); g.hidden = !g.hidden; ot.setAttribute('aria-expanded', String(!g.hidden)); });
  $$('input[type=range]', f).forEach((r) => r.addEventListener('input', () => { $(`[data-v="${r.name}"]`, f).textContent = r.value; }));
  const split = () => {
    const n = +f.agents.value, x = Math.max(1, Math.round(n / 5)), r = n - x, b = Math.max(1, Math.round(r / 12));
    $('[data-v="split"]', f).textContent = `${r} researchers · ${x} red team${b > 1 ? ` · ${b} branches` : ''}`;
    const m = f.minutes; const want = n >= 128 ? 60 : n >= 64 ? 45 : 30;
    if (!m.dataset.touched) { m.value = want; $('[data-v="minutes"]', f).textContent = want; }
  };
  f.minutes.addEventListener('input', () => { f.minutes.dataset.touched = '1'; });
  f.files.addEventListener('change', () => { const n = f.files.files.length, b = [...f.files.files].reduce((a, x) => a + x.size, 0); $('[data-v="files"]', f).textContent = n ? `${n} file${n > 1 ? 's' : ''}, ${(b / 1e6).toFixed(1)} MB${b > 25e6 ? ' (over the 25 MB limit)' : ''}` : 'none'; });
  $$('input[name=mode]', f).forEach((r) => r.addEventListener('change', () => { $('[data-v="modehint"]', f).textContent = f.mode.value === 'free' ? 'agents loop on a shared board; judges vote to stop' : 'code assigns the work'; }));
  $$('input[name=agents]', f).forEach((r) => r.addEventListener('change', split));
  split();
  f.question.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); f.requestSubmit(); } });
  f.question.focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', f);
    const body = { question: f.question.value.trim(), agents: +f.agents.value, minutes: +f.minutes.value, baseline: f.baseline.checked, multimodal: f.multimodal.checked, mode: f.mode.value, ...(f.seat_model.value === 'mix' ? { models: ['gemini-4-hydrogen', 'gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-hydrogen', 'gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon'] } : { seat_model: f.seat_model.value }), ...(+f.agents.value > 128 ? { max_rounds: 1, concurrency: 256 } : {}) };
    if (body.question.length < 8) { $('#err').textContent = 'A little longer, please.'; return; }
    btn.disabled = true; btn.textContent = 'Starting';
    if (f.files.files.length) {
      const b64 = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(file); });
      body.attachments = await Promise.all([...f.files.files].map(async (x) => ({ name: x.webkitRelativePath || x.name, data: await b64(x) })));
    }
    try {
      const r = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.id) throw new Error(j.error || `Server said ${r.status}`);
      location.assign(`${BASE}/run/${encodeURIComponent(j.id)}`);
    } catch (err) {
      $('#err').textContent = err.message; btn.disabled = false; btn.textContent = 'Start';
    }
  });
  try {
    const runs = await (await fetch(STATIC ? `${BASE}/data/runs.json` : '/api/runs')).json();
    if (STATIC) { const f = $('#askf'); if (f) f.hidden = true; const h = $('.ask h1'); if (h) h.textContent = 'Runs'; const l = $('.ask .lede'); if (l) l.textContent = 'Finished runs of the swarm. Open one to read the report and check every claim.'; }
    if (Array.isArray(runs) && runs.length) {
      const past = $('#past');
      past.hidden = false;
      $('ol', past).innerHTML = runs.slice(0, STATIC ? 60 : 12).map((r) => `
        <li><a href="${BASE}/run/${encodeURIComponent(r.id)}">
          <span class="pq">${esc(r.question || r.id)}</span>
          <span class="pm">${esc(shortDate(r.started_at))} · ${statusWord(r.status)}</span>
        </a></li>`).join('');
    }
  } catch { /* list is optional */ }
}
function range(name, label, min, max, step, v) {
  return `<label><span class="lab"><span>${label}</span><span class="v" data-v="${name}">${v}</span></span><input type="range" name="${name}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
}
function shortDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function statusWord(s) {
  if (s === 'passed') return '<span class="status-passed">passed</span>';
  if (s === 'failed') return '<span class="status-failed">failed</span>';
  return esc(s || '');
}

// ---------- Run screen
const TABS = [
  ['report', 'Report', 'Report'],
  ['room', 'Room', 'Room'],
  ['evidence', 'Evidence', 'Evidence'],
  ['questions', 'Questions', 'Questions'],
  ['compare', 'vs Google Deep Research', 'vs Google'],
];
const TALLY = [
  ['agents', 'Agents'], ['searches', 'Searches'], ['pages', 'Unique pages', 'Pages'], ['sources', 'Sources'], ['publishers', 'Publishers'],
  ['claims', 'Key claims'], ['confirmed', 'Confirmed'], ['challenges', 'Challenges'], ['gate', 'Gate'], ['tokens', 'Tokens'],
];

function openRun(id) {
  S = freshState(id);
  touch();
  $('#topnav').innerHTML = `<a href="${BASE}/">${STATIC ? 'All runs' : 'New question'}</a>`;
  app.innerHTML = `
  <section class="run">
    <header class="run-head">
      <div class="meta" id="meta"><span class="live">Connecting</span></div>
      <h1 class="q" id="q">&nbsp;</h1>
      <ol class="rail" id="rail">${PHASES.map((p) => `<li data-p="${p}">${PHASE_LABEL[p]}</li>`).join('')}</ol>
      <div class="rail-now" id="railnow"></div>
      <dl class="tally" id="tally">${TALLY.map(([k, l, sh]) => `<div><dd data-k="${k}">0</dd><dt>${sh ? `<span class="long">${l}</span><span class="short">${sh}</span>` : l}</dt><span class="sub" data-s="${k}"></span></div>`).join('')}</dl>
    </header>
    <nav class="tabs" role="tablist">${TABS.map(([k, l, s]) => `<button role="tab" data-tab="${k}" aria-selected="false"><span class="long">${l}</span><span class="short">${s}</span><span class="count" data-c="${k}"></span></button>`).join('')}</nav>
    <div class="pane" data-pane="report" hidden></div>
    <div class="pane" data-pane="room" hidden><ol class="room" id="room"></ol><button class="latest btn-quiet" id="latest" type="button" hidden>Latest</button></div>
    <div class="pane" data-pane="evidence" hidden></div>
    <div class="pane" data-pane="questions" hidden></div>
    <div class="pane" data-pane="compare" hidden></div>
  </section>`;
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => { S.tabChosen = true; setTab(b.dataset.tab, true); }));
  const hashTab = location.hash.slice(1).split('/')[0];
  if (TABS.some(([k]) => k === hashTab)) { S.tabChosen = true; setTab(hashTab); } else setTab('room');
  gotDone = false; queue = [];
  connect();
  if (!ticker) ticker = setInterval(updateMeta, 1000);
}

function setTab(k, push) {
  S.tab = k;
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
  $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== k; });
  if (push) history.replaceState(null, '', `#${k}`);
  renderPane(k, true);
}

// ---------- stream
let es = null, queue = [], scheduled = false, replaying = true, gotDone = false, ticker = null;
async function connectStatic() {
  // the whole event file, gzipped; fed through the same handler as the live stream
  try {
    const r = await fetch(fileUrl(S.id, 'events.ndjson.gz'));
    if (!r.ok) throw new Error(String(r.status));
    const text = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { queue.push(JSON.parse(line)); } catch {} }
    flush();
  } catch { $('#q').textContent = 'This run is not available.'; }
}
function connect() {
  if (STATIC) return connectStatic();
  es = new EventSource(`/api/runs/${encodeURIComponent(S.id)}/stream`);
  es.onopen = () => {
    if (S.events > 0 && !S.done) {
      // The server replays from the start on reconnect: rebuild from scratch.
      const tab = S.tab, chosen = S.tabChosen;
      es.close(); openRunReset(tab, chosen); return;
    }
  };
  let basePending = false;
  es.onmessage = (e) => {
    if (gotDone) return;
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.t === 'baseline') basePending = ev.status === 'started' || ev.status === 'submitted';
    if (ev.t === 'done') S.sawDone = true;
    if (S.sawDone && !basePending && (ev.t === 'done' || ev.t === 'baseline')) { gotDone = true; es.close(); }
    queue.push(ev);
    if (!scheduled) {
      scheduled = true;
      const f = () => { if (scheduled) flush(); };
      requestAnimationFrame(f); setTimeout(f, 250); // rAF pauses in background tabs
    }
  };
  es.onerror = () => { if (S.done) es.close(); else setMeta(); };
}
function openRunReset(tab, chosen) {
  const id = S.id;
  openRun(id);
  if (chosen) { S.tabChosen = true; setTab(tab); }
}

function flush() {
  scheduled = false;
  const batch = queue; queue = [];
  const wasAtBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 120;
  replaying = batch.length > 4; // a replay burst: no motion
  const animate = !replaying;
  for (const ev of batch) handle(ev, animate);
  touch();
  if (wasAtBottom && scrollY > 200) followRoom();
  // a big run sends events all the time; redrawing counters, panes and chips on every batch froze the page
  const wait = S.claims.size > 3000 ? 4000 : S.claims.size > 600 ? 2000 : 900;
  if (performance.now() - lastDraw > wait) draw();
  else if (!drawTimer) drawTimer = setTimeout(draw, wait);
}
let lastDraw = 0, drawTimer = null;
function draw() {
  clearTimeout(drawTimer); drawTimer = null; lastDraw = performance.now();
  if (!S) return;
  updateHeader();
  const todo = [...S.dirty]; S.dirty.clear();
  for (const k of todo) renderPane(k);
  if (S.drawerClaim) renderDrawer(S.drawerClaim);
  if (S.tab === 'report' || S.drawerClaim) refreshChips();
}

function handle(ev, animate) {
  S.events++;
  const at = ts(ev.at);
  if (!isNaN(at)) S.lastAt = Math.max(S.lastAt, at);
  switch (ev.t) {
    case 'run':
      S.run = ev;
      for (const s of ev.seats || []) S.seats.set(s.id, s);
      document.title = `${ev.question || 'Run'} · Prometheus`;
      $('#q').textContent = ev.question || ev.id;
      if (ev.mode === 'free') {
        // no fixed steps: agents loop until the judges vote to stop
        $$('#rail li').forEach((li) => { if (['plan', 'crosscheck', 'redteam', 'fix'].includes(li.dataset.p)) li.remove(); else if (li.dataset.p === 'research') li.textContent = 'Agents loop'; else if (li.dataset.p === 'gate') li.textContent = 'Judges stop it'; });
      }
      break;
    case 'criteria':
      S.criteria = ev.items || [];
      roomAdd(simpleLine(ev, `<b>What the answer will be judged on</b><ol>${S.criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>`), animate);
      break;
    case 'review':
      S.reviews = (S.reviews || []).concat(ev);
      roomAdd(simpleLine(ev, `<b>Team review, round ${esc(ev.round)}</b> · <b class="${ev.approval >= 0.9 ? 'pass' : 'fail'}">${esc(ev.ok)} of ${esc(ev.voters)} would sign it (${Math.round(ev.approval * 100)}%)</b>${ev.signed != null ? ` <span class="faint">${esc(ev.signed)} as it stands · ${esc(ev.voters - ev.ok)} would block · ${esc(ev.blocking)} blocking issues</span>` : ''} <span class="faint">answers ${esc(ev.scores?.answers)}/5 · insight ${esc(ev.scores?.insight)}/5 · reads ${esc(ev.scores?.reads)}/5 · ${esc(ev.issues)} issues · ${esc(ev.missing)} findings reported missing</span>${(ev.sample || []).length ? `<ul>${ev.sample.map((i) => `<li><span class="faint">${esc(i.where)} · ${esc(i.kind)}</span> ${esc(i.problem)}</li>`).join('')}</ul>` : ''}`), animate);
      break;
    case 'attachments':
      roomAdd(simpleLine(ev, `<b>${esc(ev.files)} attached file${ev.files > 1 ? 's' : ''}</b> <span class="faint">${(ev.bytes / 1e6).toFixed(1)} MB, placed in every agent's sandbox</span><ul>${(ev.list || []).slice(0, 12).map((x) => `<li class="faint">${esc(x)}</li>`).join('')}${ev.files > 12 ? `<li class="faint">…</li>` : ''}</ul>`), animate);
      break;
    case 'vote':
      S.votes = { yes: ev.yes, of: ev.of };
      roomAdd(simpleLine(ev, `<span class="seat" style="${seatVars(ev.seat)}">${esc(ev.seat)}</span> votes ${ev.terminate ? '<b class="pass">stop</b>' : '<b>keep going</b>'} <span class="faint">${esc(ev.yes)}/${esc(ev.of)} to stop · ${esc(ev.why || '')}</span>`), animate);
      break;
    case 'terminate':
      S.terminate = ev;
      roomAdd(simpleLine(ev, `<b>state = terminate</b> · ${ev.reason === 'judges' ? `${esc(ev.yes)} of ${esc(ev.of)} judges voted to stop` : `time budget ran out (${esc(ev.yes)} of ${esc(ev.of)} judges had voted to stop)`}`), animate);
      break;
    case 'phase':
      S.phase = ev.name;
      S.phaseSeen.set(ev.name, Math.max(S.phaseSeen.get(ev.name) || 0, ev.round || 1));
      roomAdd(phaseLine(ev), animate);
      break;
    case 'msg': roomAdd(msgLine(ev), animate); break;
    case 'turn': turnLine(ev, animate); if (ev.status !== 'started') { S.turns.push(ev); } break;
    case 'ledger':
      for (const r of ev.rows || []) ingestRow(r, ev.seat, ev.at);
      for (const x of ev.rejected || []) S.rejected.push({ ...x, seat: ev.seat, at: ev.at });
      ledgerLines(ev).forEach((li) => roomAdd(li, animate));
      ['evidence', 'questions', 'compare'].forEach((k) => S.dirty.add(k));
      if ((ev.rows || []).some((r) => r.type === 'figure')) S.dirty.add('report');
      break;
    case 'gate': S.gates.push(ev); roomAdd(gateLine(ev), animate); break;
    case 'judge': S.judges.push(ev); roomAdd(judgeLine(ev), animate); break;
    case 'report':
      S.reports++;
      roomAdd(simpleLine(ev, `<span class="seat" style="${seatVars('W')}">W</span> Report written. <button class="btn-quiet open-report" data-go="report" type="button">Read it</button>`), animate);
      loadReport();
      if (!S.tabChosen) setTab('report');
      break;
    case 'baseline':
      if (ev.status === 'submitted') break;
      if (ev.status === 'started') S.baselineStart = ev; else S.baseline = ev;
      roomAdd(baselineLine(ev), animate);
      if (ev.status === 'completed') loadBaseline();
      S.dirty.add('compare');
      break;
    case 'done':
      S.done = ev;
      S.phase = 'done'; if (!S.phaseSeen.has('done')) S.phaseSeen.set('done', 1);
      roomAdd(simpleLine(ev, `<b class="${ev.status === 'passed' ? 'pass' : ev.status === 'failed' ? 'fail' : ''}">Done</b> · ${esc(ev.status || '')}${ev.totals ? ` · ${fmtNum(ev.totals.turns)} turns · ${ev.totals.minutes ?? ''} min` : ''}`), animate);
      for (const li of $$('#room li.running')) li.classList.remove('running');
      if (es) es.close();
      S.dirty.add('compare');
      if (!S.reports) loadReport(true);
      break;
  }
}

// ---------- header
function updateHeader() {
  const d = derive();
  setMeta();
  // rail
  $$('#rail li').forEach((li) => {
    const p = li.dataset.p;
    li.classList.toggle('seen', S.phaseSeen.has(p));
    li.classList.toggle('now', p === S.phase);
    li.classList.toggle('going', p === S.phase && !S.done);
    const lastGate = S.gates[S.gates.length - 1];
    li.classList.toggle('failed', p === 'gate' && lastGate && !lastGate.pass && S.phase === 'gate');
    const rounds = S.phaseSeen.get(p) || 0;
    li.innerHTML = `${PHASE_LABEL[p]}${rounds > 1 ? `<sup>×${rounds}</sup>` : ''}`;
  });
  $('#railnow').innerHTML = S.phase ? `<b>${PHASE_LABEL[S.phase] || esc(S.phase)}</b>${(S.phaseSeen.get(S.phase) || 1) > 1 ? ` · round ${S.phaseSeen.get(S.phase)}` : ''}` : '';
  // tally
  const lastGate = S.gates[S.gates.length - 1];
  const resolved = S.challenges.size - d.open.length;
  const vals = {
    agents: [...S.seats.values()].filter((x) => x.role === 'researcher' || x.role === 'redteam').length || S.seats.size, searches: d.searches, pages: d.uniquePages, sources: d.keptSources.length, publishers: d.publishers.size,
    claims: d.keyClaims.length, confirmed: d.confirmed, challenges: S.challenges.size, gate: S.gates.length, tokens: d.tokens,
  };
  const subs = {
    pages: d.urls > d.uniquePages ? `${fmtNum(d.urls)} opens` : '',
    sources: d.sourcePages && d.sourcePages < d.keptSources.length ? `on ${fmtNum(d.sourcePages)} pages` : '',
    claims: d.keptClaims.length > d.keyClaims.length ? `of ${d.keptClaims.length}` : '',
    confirmed: d.checks.length ? `of ${d.checks.length} checks` : '',
    challenges: S.challenges.size ? (d.open.length ? `<span class="warn">${d.open.length} open</span> · ${resolved} resolved` : `${resolved} resolved`) : '',
    gate: lastGate ? (lastGate.pass ? '<span class="pass">passed</span>' : '<span class="fail">failed</span>') : '',
    agents: S.openTurns.size ? `${S.openTurns.size} working` : '',
  };
  for (const [k] of TALLY) {
    tick($(`#tally [data-k="${k}"]`), vals[k], k === 'tokens' ? fmtNum : (n) => String(Math.round(n)));
    const s = $(`#tally [data-s="${k}"]`);
    const html = subs[k] || '&nbsp;';
    if (s.innerHTML !== html) s.innerHTML = html;
  }
  // tab counts
  const counts = { evidence: d.keyClaims.length || '', questions: S.questions.size || '', room: '' };
  for (const [k, v] of Object.entries(counts)) { const el = $(`.tabs [data-c="${k}"]`); if (el) el.textContent = v; }
}
function setMeta() {
  const m = $('#meta');
  if (!m) return;
  const start = ts(S.run?.started_at);
  let elapsed = 0;
  if (!isNaN(start)) {
    const end = S.done ? ts(S.done.at) : (Date.now() - S.lastAt < 5 * 60e3 ? Date.now() : S.lastAt);
    elapsed = Math.max(0, end - start);
  }
  const budget = S.run?.budget_min ? ` / ${S.run.budget_min}m` : '';
  let status;
  if (S.done) status = `<span class="status-${esc(S.done.status)}">${esc(S.done.status)}</span>`;
  else if (!S.run) status = '<span class="live">Connecting</span>';
  else if (Date.now() - S.lastAt > 5 * 60e3) status = '<span>no events for a while</span>';
  else status = '<span class="live">Live</span>';
  const parts = [status];
  if (S.run) parts.push(`<span>${esc(fmtDur(elapsed))}${budget}</span>`, `<span>${esc(shortDate(S.run.started_at))}</span>`, `<span>${esc(S.id)}</span>`);
  if (S.run?.mode === 'free') parts.push(`<span>no orchestrator${S.votes ? ` · ${S.votes.yes}/${S.votes.of} judges to stop` : ''}${S.terminate ? ' · terminated' : ''}</span>`);
  const html = parts.join('');
  if (m.innerHTML !== html) m.innerHTML = html;
}
function updateMeta() { if (S && !S.done) { setMeta(); $$('#room li.running').forEach(updateRunning); } }

const tweens = new WeakMap();
function tick(el, to, fmt) {
  if (!el) return;
  const from = +(el.dataset.n || 0);
  if (from === to) { if (!el.dataset.n) { el.dataset.n = to; el.textContent = fmt(to); } return; }
  el.dataset.n = to;
  if (replaying || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return; }
  cancelAnimationFrame(tweens.get(el));
  const t0 = performance.now(), dur = 600;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) tweens.set(el, requestAnimationFrame(step));
  };
  tweens.set(el, requestAnimationFrame(step));
  if (to > from) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
}

// ---------- Room
const rel = (at) => { const s = ts(S.run?.started_at), a = ts(at); return isNaN(s) || isNaN(a) ? '' : fmtClock(a - s); };
function li(cls, at, inner) {
  const el = document.createElement('li');
  el.className = cls;
  el.innerHTML = `<div class="t">${rel(at)}</div><div class="body">${inner}</div>`;
  return el;
}
function roomAdd(el, animate) {
  if (!el) return;
  if (animate) el.classList.add('in');
  const room = $('#room');
  room.appendChild(el);
  if (room.childElementCount > 1600) {
    for (let i = 0; i < 400; i++) room.firstElementChild?.remove();
    S.roomCut = (S.roomCut || 0) + 400;
    let note = $('#roomcut');
    if (!note) { note = document.createElement('div'); note.id = 'roomcut'; note.className = 'faint'; note.style.cssText = 'font-size:13px;margin:0 0 12px'; room.before(note); }
    note.textContent = `${S.roomCut.toLocaleString()} earlier lines are not shown here. The whole record is in events.ndjson.`;
  }
}
addEventListener('scroll', () => syncLatest(), { passive: true });
function syncLatest() {
  const b = $('#latest');
  if (!b || !S) return;
  const far = innerHeight + scrollY < document.documentElement.scrollHeight - 400;
  b.hidden = !(S.tab === 'room' && !S.done && far);
}
document.addEventListener('click', (e) => { if (e.target.id === 'latest') scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); });
function followRoom() {
  syncLatest();
  if (S.tab === 'room' && !replaying && !S.done) scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
}
function phaseLine(ev) {
  const el = document.createElement('li');
  el.className = 'phase';
  el.innerHTML = `<div class="t">${rel(ev.at)}</div><div class="ph">${esc(PHASE_LABEL[ev.name] || ev.name)}${(ev.round || 1) > 1 ? ` <span class="r">round ${ev.round}</span>` : ''}</div>`;
  return el;
}
function msgLine(ev) {
  const sys = ev.seat === 'system';
  return li(`msg ${sys ? 'sys' : ''}`, ev.at, `${sys ? '<span class="faint" style="font-size:12px">Orchestrator</span>' : `${seatTag(ev.seat)}<span class="role">${esc(roleOf(ev.seat))}</span>`}<div class="text">${richText(ev.text)}</div>`);
}
const simpleLine = (ev, html) => li('note', ev.at, `<div class="line">${html}</div>`);

function turnLine(ev, animate) {
  const key = `${ev.seat}|${ev.phase}`;
  if (ev.status === 'started') {
    const el = li('turn running', ev.at, `<div class="line">${seatTag(ev.seat)}<span class="what">${esc(PHASE_VERB[ev.phase] || ev.phase || 'working')}</span></div>`);
    el.dataset.start = ev.at;
    el.dataset.verb = PHASE_VERB[ev.phase] || ev.phase || 'working';
    S.openTurns.set(key, el);
    roomAdd(el, animate);
    return;
  }
  let el = S.openTurns.get(key);
  S.openTurns.delete(key);
  if (!el) { el = li('turn', ev.at, ''); roomAdd(el, animate); }
  el.classList.remove('running');
  const searches = ev.searches || [], urls = ev.urls || [];
  const bits = [];
  if (searches.length) bits.push(`searched ${plural(searches.length, 'time')}`);
  if (urls.length) bits.push(`opened ${plural(urls.length, 'page')}`);
  let what = bits.length ? bits.join(', ') : `finished ${esc(PHASE_VERB[ev.phase] || ev.phase || 'turn')}`;
  if (ev.status === 'failed') what = `<span class="fail">turn failed</span>${ev.error ? `: ${esc(ev.error)}` : ''}`;
  const tail = `<span class="faint mono" style="font-size:12px"> · ${fmtDur(ev.ms)}${ev.tokens ? ` · ${fmtNum(ev.tokens)} tokens` : ''}</span>`;
  const hasDetail = searches.length || urls.length || ev.interaction_id;
  const detail = hasDetail ? `<div class="detail">
      ${searches.length ? `<div class="h">Searches</div><ol>${searches.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>` : ''}
      ${urls.length ? `<div class="h">Pages</div><ul>${urls.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/(www\.)?/, ''))}</a></li>`).join('')}</ul>` : ''}
      ${ev.interaction_id ? `<div class="faint mono" style="font-size:11px">${esc(ev.interaction_id)}</div>` : ''}
    </div>` : '';
  const line = `${seatTag(ev.seat)}<span class="what">${what}</span>${tail}`;
  el.querySelector('.body').innerHTML = hasDetail
    ? `<details><summary class="line">${line}<span class="more">details</span></summary>${detail}</details>`
    : `<div class="line">${line}</div>`;
}
function updateRunning(el) {
  const a = ts(el.dataset.start);
  const w = el.querySelector('.what');
  if (w && !isNaN(a) && Date.now() - S.lastAt < 5 * 60e3) w.textContent = `${el.dataset.verb} · ${fmtDur(Date.now() - a)}`;
}

function ledgerLines(ev) {
  const out = [];
  const rows = ev.rows || [];
  const by = (t) => rows.filter((r) => r.type === t);
  const claims = by('claim'), sources = by('source'), questions = by('question'), answers = by('answer'), checks = by('check');
  const bits = [];
  const droppedC = claims.filter((c) => c.status === 'dropped'), newC = claims.filter((c) => c.status !== 'dropped');
  const droppedS = sources.filter((c) => c.status === 'dropped'), newS = sources.filter((c) => c.status !== 'dropped');
  if (questions.length) bits.push(`posed ${plural(questions.length, 'question')}`);
  if (newC.length) bits.push(`wrote ${plural(newC.length, 'claim')}`);
  if (newS.length) bits.push(`${bits.length ? '' : 'added '}${plural(newS.length, 'source')}`);
  if (droppedC.length) bits.push(`dropped ${plural(droppedC.length, 'claim')}`);
  if (droppedS.length) bits.push(`dropped ${plural(droppedS.length, 'source')}`);
  if (answers.length) bits.push(`answered ${answers.map((a) => esc(a.question)).join(', ')}`);
  if (checks.length) {
    const n = (r) => checks.filter((c) => c.result === r).length;
    const parts = [['confirmed', 'pass'], ['wrong', 'fail'], ['unreachable', 'warn']].filter(([r]) => n(r)).map(([r, c]) => `<span class="${r === 'confirmed' ? '' : c}">${n(r)} ${r}</span>`);
    bits.push(`checked ${plural(checks.length, 'source')}: ${parts.join(', ')}`);
  }
  if (bits.length) {
    const detail = [
      ...questions.map((q) => `<li><span class="idref">${esc(q.id)}</span> ${esc(q.text)} ${q.owner ? `<span class="faint">→ ${esc(q.owner)}</span>` : ''}</li>`),
      ...claims.map((c) => `<li>${citeChip(c.id)} ${esc(c.text)}${c.status === 'dropped' ? ' <span class="tag">dropped</span>' : ''}</li>`),
      ...sources.map((s) => `<li><span class="idref">${esc(s.id)}</span> → ${esc(s.claim)} · ${esc(s.publisher || host(s.url))}${s.stance === 'contradicts' ? ' <span class="warn">contradicts</span>' : ''}${s.status === 'dropped' ? ' <span class="tag">dropped</span>' : ''}</li>`),
      ...checks.map((c) => `<li><span class="idref">${esc(c.source)}</span> <span class="${c.result === 'confirmed' ? 'pass' : c.result === 'wrong' ? 'fail' : 'warn'}">${esc(c.result)}</span> ${esc(c.note || '')}</li>`),
      ...answers.map((a) => `<li><span class="idref">${esc(a.question)}</span> ${a.status === 'abandoned' ? '<span class="warn">abandoned</span> ' : ''}${esc(a.text)}</li>`),
    ].join('');
    out.push(li('ledger', ev.at, `<details><summary class="line">${seatTag(ev.seat)}${bits.join(', ')}<span class="more">ledger</span></summary><div class="detail"><ul>${detail}</ul></div></details>`));
  }
  for (const c of by('challenge')) {
    out.push(li(`msg chal`, ev.at, `${seatTag(c.by || ev.seat)}<span class="role">challenges ${citeChip(c.claim)}${c.to ? ` → <span class="mention" style="${seatVars(c.to)}">@${esc(c.to)}</span>` : ''} <span class="idref">${esc(c.id)}</span></span><div class="text" style="${seatVars(c.by || ev.seat)}">${richText(c.text)}</div>`));
  }
  for (const r of by('resolution')) {
    out.push(li('msg', ev.at, `${seatTag(r.by || ev.seat)}<span class="role">resolves <span class="idref">${esc(r.challenge)}</span></span><div class="text">${richText(r.text)}</div>`));
  }
  for (const n of by('not_found')) {
    out.push(li('note', ev.at, `<div class="line">${seatTag(n.by || ev.seat)}searched, not found: <span style="color:var(--fg)">${esc(n.text)}</span></div>`));
  }
  if ((ev.rejected || []).length) {
    out.push(li('note', ev.at, `<div class="line rej">${seatTag(ev.seat)}${plural(ev.rejected.length, 'row')} rejected: ${ev.rejected.map((x) => esc(x.why)).join('; ')}</div>`));
  }
  return out;
}
function gateLine(ev) {
  const st = ev.stats || {};
  const stats = [
    st.key_claims != null && `${st.key_claims} key claims`,
    st.confirmed != null && `${st.confirmed} confirmed`,
    st.open_challenges != null && `${st.open_challenges} open challenges`,
    st.quotes_checked != null && `${st.quotes_found ?? '?'}/${st.quotes_checked} quotes found on page`,
  ].filter(Boolean).join(' · ');
  return li('verdict', ev.at, `<div class="line"><b class="${ev.pass ? 'pass' : 'fail'}">Gate ${ev.pass ? 'passed' : 'failed'}</b> <span class="faint">attempt ${esc(ev.attempt)}</span></div>
    ${(ev.problems || []).length ? `<ul>${ev.problems.map((p) => `<li>${richText(p)}</li>`).join('')}</ul>` : ''}
    ${stats ? `<div class="stats">${stats}</div>` : ''}`);
}
function judgeLine(ev) {
  return li('verdict', ev.at, `<div class="line">${seatTag('J')}<b class="${ev.pass ? 'pass' : 'fail'}">Judge ${ev.pass ? 'passed' : 'failed'}</b> <span class="faint">attempt ${esc(ev.attempt)}</span></div>${ev.notes ? `<div class="text" style="margin-top:4px">${richText(ev.notes)}</div>` : ''}`);
}
function baselineLine(ev) {
  const name = 'Google Deep Research';
  if (ev.status === 'started') return simpleLine(ev, `<span class="seat">G</span> ${name} started on the same question.`);
  if (ev.status === 'failed') return simpleLine(ev, `<span class="seat">G</span> ${name} <span class="fail">failed</span>${ev.error ? `: ${esc(ev.error)}` : ''}`);
  const bits = [];
  if ((ev.searches || []).length) bits.push(`searched ${plural(ev.searches.length, 'time')}`);
  if ((ev.urls || []).length) bits.push(`opened ${plural(ev.urls.length, 'page')}`);
  return simpleLine(ev, `<span class="seat">G</span> ${name} finished${bits.length ? ': ' + bits.join(', ') : ''}<span class="faint mono" style="font-size:12px"> · ${fmtDur(ev.ms)}${ev.tokens ? ` · ${fmtNum(ev.tokens)} tokens` : ''}</span>`);
}

// ---------- panes
function renderPane(k, force) {
  if (S.tab !== k && !force) { S.dirty.add(k); return; }
  if (S.tab !== k) return;
  const el = $(`.pane[data-pane="${k}"]`);
  if (k === 'report') renderReport(el);
  else if (k === 'evidence') renderEvidence(el);
  else if (k === 'questions') renderQuestions(el);
  else if (k === 'compare') renderCompare(el);
  refreshChips();
}
const markDirty = (k) => { if (S.tab === k) renderPane(k, true); else S.dirty.add(k); };

// Report
const TAG_RE = /\[((?:C\d+-\d+)(?:\s*[,;]\s*C\d+-\d+)*)\]/g;
function mdToHtml(md, withChips) {
  const math = protectMath(String(md || ''));
  let src = math.src;
  if (withChips) src = src.replace(TAG_RE, (m, ids) => ids.split(/\s*[,;]\s*/).map((id) => `<button class="cite" data-claim="${id}" type="button">${id}</button>`).join(''));
  const html = marked.parse(String(src).replace(/~/g, '\\~'), { gfm: true, breaks: false });
  const t = document.createElement('template');
  t.innerHTML = math.restore(html);
  t.content.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach((n) => n.remove());
  t.content.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
    if (n.tagName === 'A') { n.target = '_blank'; n.rel = 'noopener'; }
  });
  return withChips ? placeFigures(t.innerHTML, S.figures) : t.innerHTML;
}
let reportTry = 0;
async function loadReport(quiet) {
  try {
    const r = await fetch(fileUrl(S.id, 'report.md'), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const md = await r.text();
    S.reportHtml = mdToHtml(md, true);
    if (!S.reports) S.reports = 1;
    if (quiet && !S.tabChosen) setTab('report');
    markDirty('report'); markDirty('compare');
    refreshChips();
  } catch {
    if (!quiet && reportTry++ < 6) setTimeout(() => loadReport(), 1500);
  }
}
async function loadBaseline() {
  try {
    const r = await fetch(fileUrl(S.id, 'baseline.md'), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    S.baselineMd = await r.text();
    S.baselineHtml = mdToHtml(S.baselineMd, false);
    markDirty('compare');
  } catch { /* optional */ }
}
function renderReport(el) {
  if (!S.reportHtml) {
    el.innerHTML = `<p class="empty">${S.done ? 'This run ended without a report.' : 'The report is written once the gate passes. Watch the Room until then.'}</p>`;
    return;
  }
  const d = derive();
  const note = `Each tag is a claim. Open one to see its sources, the exact quotes, and what the red team found. ${d.keyClaims.length} key claims, ${d.keptSources.length} sources, ${d.publishers.size} publishers.`;
  if (el.dataset.v !== String(S.reports) + (S.reportHtml.length)) {
    el.innerHTML = `<p class="report-note">${esc(note)}</p><article class="prose">${S.reportHtml}</article>`;
    el.dataset.v = String(S.reports) + (S.reportHtml.length);
  } else {
    $('.report-note', el).textContent = note;
  }
}
function refreshChips() {
  if (!S) return;
  $$('.cite[data-claim]').forEach((b) => {
    const st = claimState(b.dataset.claim);
    b.className = `cite ${st}${S.drawerClaim === b.dataset.claim ? ' on' : ''}`;
  });
}

// Evidence
function keepOpen(el, fn) {
  const norm = (x) => x.textContent.replace(/\(\d+\)/, '');
  const open = new Set($$('details[open] > summary', el).map(norm));
  fn();
  $$('details > summary', el).forEach((x) => { if (open.has(norm(x))) x.parentElement.open = true; });
}
function renderEvidence(el) { keepOpen(el, () => renderEvidence0(el)); }
function renderEvidence0(el) {
  const d = derive();
  if (!S.claims.size) { el.innerHTML = '<p class="empty">No claims yet. Researchers write them as they find sources.</p>'; return; }
  const infos = [...S.claims.values()].sort((a, b) => byId(a.id, b.id)).map((c) => ({ c, i: claimInfo(c.id) }));
  const flagged = (x) => x.i.single || x.i.contra || x.i.wrong || x.i.openChals.length;
  const key = infos.filter((x) => x.c.key && x.c.status !== 'dropped');
  const other = infos.filter((x) => !x.c.key && x.c.status !== 'dropped');
  const gone = infos.filter((x) => x.c.status === 'dropped');
  const single = key.filter((x) => x.i.single).length, contra = key.filter((x) => x.i.contra).length;
  const show = S.evFilter === 'flagged' ? key.filter(flagged) : key;
  const nf = [...S.notFound.values()];
  el.innerHTML = `
    <div class="ev-sum"><span><span class="num">${key.length}</span> key claims</span><span><span class="num">${d.keptSources.length}</span> sources</span><span><span class="num">${d.publishers.size}</span> publishers</span><span><span class="num">${single}</span> single-source</span><span><span class="num">${contra}</span> with contradicting evidence</span></div>
    <div class="ev-key"><span><b class="pass mono">✓</b> quote confirmed on re-check</span><span><b class="fail mono">✗</b> quote wrong</span><span><b class="faint mono">?</b> unreachable</span><span><b class="warn">outlined</b> contradicts the claim</span></div>
    <div class="seg"><button data-f="all" class="${S.evFilter === 'all' ? 'on' : ''}">All</button><button data-f="flagged" class="${S.evFilter === 'flagged' ? 'on' : ''}">Flagged (${key.filter(flagged).length})</button></div>
    <ul class="ev">${show.map(evRow).join('') || '<li class="empty">Nothing flagged.</li>'}</ul>
    ${other.length ? `<details class="more-claims"><summary>Other claims (${other.length})</summary><ul class="ev">${other.map(evRow).join('')}</ul></details>` : ''}
    ${gone.length ? `<details class="more-claims"><summary>Dropped (${gone.length})</summary><ul class="ev">${gone.map(evRow).join('')}</ul></details>` : ''}
    <h2 class="section-h" style="margin-top:40px">Searched, not found</h2>
    ${nf.length ? `<ul class="nf">${nf.map((n) => `<li>${esc(n.text)} <span class="faint">· ${esc(n.by || '')}</span><div class="s">${esc(n.searched || '')}</div></li>`).join('')}</ul>` : '<p class="muted" style="font-size:14px">Nothing recorded.</p>'}`;
  $$('.seg button', el).forEach((b) => b.addEventListener('click', () => { S.evFilter = b.dataset.f; renderEvidence(el); refreshChips(); }));
  $$('.ev > li[data-claim]', el).forEach((r) => r.addEventListener('click', (e) => { if (!e.target.closest('a')) openDrawer(r.dataset.claim); }));
}
function evRow({ c, i }) {
  const d = derive();
  const groups = new Map();
  for (const s of i.live) {
    const p = (s.publisher || host(s.url) || '?').trim();
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(s);
  }
  const toks = [...groups].map(([p, ss]) => {
    const checks = ss.flatMap((s) => d.checksBySrc.get(s.id) || []);
    let m = '';
    if (checks.some((k) => k.result === 'wrong')) m = '<span class="m bad">✗</span>';
    else if (checks.some((k) => k.result === 'confirmed')) m = '<span class="m ok">✓</span>';
    else if (checks.some((k) => k.result === 'unreachable')) m = '<span class="m unk">?</span>';
    const contra = ss.some((s) => s.stance === 'contradicts');
    return `<span class="ptok ${contra ? 'contra' : ''}" title="${esc(p)}${contra ? ' (contradicts)' : ''}">${esc(p)}${ss.length > 1 ? `<span class="n">×${ss.length}</span>` : ''}${m}</span>`;
  }).join('');
  const flags = [
    i.single && '<span class="tag warn">single source</span>',
    i.contra && '<span class="tag warn">contradicting evidence</span>',
    i.wrong && '<span class="tag fail">quote wrong</span>',
    i.openChals.length && `<span class="tag fail">${plural(i.openChals.length, 'open challenge')}</span>`,
    !i.openChals.length && i.chals.length && `<span class="tag">challenged, resolved</span>`,
  ].filter(Boolean).join('');
  return `<li data-claim="${esc(c.id)}" class="${c.status === 'dropped' ? 'gone' : ''}"><div><div class="ctx">${citeChip(c.id)}${esc(c.text)}</div>${flags ? `<div class="cflags">${flags}</div>` : ''}</div><div class="pubs">${toks || '<span class="faint" style="font-size:13px">no sources</span>'}</div></li>`;
}

// Questions
function renderQuestions(el) {
  if (!S.questions.size) { el.innerHTML = '<p class="empty">The planner has not split the question yet.</p>'; return; }
  const kids = new Map(), roots = [];
  for (const q of S.questions.values()) {
    if (q.parent && S.questions.has(q.parent)) { if (!kids.has(q.parent)) kids.set(q.parent, []); kids.get(q.parent).push(q); }
    else roots.push(q);
  }
  const node = (q) => {
    const a = S.answers.get(q.id);
    let ans;
    if (!a) ans = `<div class="qa none">${S.done ? 'Unanswered' : 'Not answered yet'}</div>`;
    else if (a.status === 'abandoned') ans = `<div class="qa none">Abandoned: <span class="muted">${esc(a.text)}</span></div>`;
    else ans = `<div class="qa">${esc(a.text)} ${(a.claims || []).map(citeChip).join('')}</div>`;
    const ch = kids.get(q.id) || [];
    return `<li><div class="qnode"><div class="qh"><span class="qid">${esc(q.id)}</span><span class="qt">${esc(q.text)}</span>${q.owner ? seatTag(q.owner) : ''}</div>${ans}</div>${ch.length ? `<ul>${ch.map(node).join('')}</ul>` : ''}</li>`;
  };
  const unanswered = [...S.questions.values()].filter((q) => !S.answers.get(q.id) || S.answers.get(q.id).status !== 'answered').length;
  el.innerHTML = `<div class="ev-sum" style="margin-bottom:12px"><span><span class="num">${S.questions.size}</span> questions</span><span><span class="num">${S.questions.size - unanswered}</span> answered</span>${unanswered ? `<span class="warn"><span class="num" style="color:inherit">${unanswered}</span> open or abandoned</span>` : ''}</div><ul class="qtree">${roots.map(node).join('')}</ul>`;
}

// Compare
function renderCompare(el) {
  const d = derive();
  const b = S.baseline;
  if (!b && !S.baselineStart) {
    el.innerHTML = `<p class="empty">${S.done ? 'Google Deep Research was not run for this question.' : 'Google Deep Research has not started yet.'}</p>`;
    return;
  }
  const start = ts(S.run?.started_at);
  const ourMin = S.done?.totals?.minutes ?? (S.done ? (ts(S.done.at) - start) / 60000 : (S.lastAt - start) / 60000);
  const bUrls = new Set(((S.baselineMd || '').match(/https?:\/\/[^\s)\]>"']+/g) || []).map((u) => u.replace(/[.,;]+$/, '')));
  const bPubs = new Set([...bUrls].map(host).filter(Boolean));
  const ours = {
    searches: S.done?.totals?.searches ?? d.searches, pages: S.done?.totals?.urls_opened ?? d.urls,
    tokens: S.done?.totals?.tokens ?? d.tokens, minutes: ourMin, sources: d.keptSources.length,
    pubs: d.publishers.size, checks: d.checks.length, chals: S.challenges.size,
  };
  const theirs = b ? {
    searches: (b.searches || []).length, pages: (b.urls || []).length, tokens: b.tokens || 0, minutes: (b.ms || 0) / 60000,
    sources: S.baselineMd != null ? bUrls.size : null, pubs: S.baselineMd != null ? bPubs.size : null, checks: 0, chals: 0,
  } : null;
  const rows = [
    ['Searches', 'searches', String], ['Pages opened', 'pages', String], ['Tokens', 'tokens', fmtNum], ['Minutes', 'minutes', (n) => n.toFixed(1)],
    ['Sources cited', 'sources', String], ['Publishers', 'pubs', String], ['Red-team checks', 'checks', String], ['Challenges', 'chals', String],
  ];
  const table = `<table class="cmp"><thead><tr><th></th><th>This swarm</th><th>Google Deep Research</th><th></th></tr></thead><tbody>${rows.map(([label, k, f]) => {
    const a = ours[k] || 0, t = theirs ? theirs[k] : null;
    const max = Math.max(a, t || 0, 1e-9);
    const ratio = t && a / t >= 1.05 ? `${(a / t).toFixed(a / t >= 10 ? 0 : 1)}×` : '';
    return `<tr><td class="k">${label}</td><td class="v">${f(a)}<div class="bar" style="transform:scaleX(${(a / max).toFixed(3)})"></div></td><td class="v">${t == null ? '<span class="faint">—</span>' : f(t)}${t == null ? '' : `<div class="bar b" style="transform:scaleX(${(t / max).toFixed(3)})"></div>`}</td><td class="x">${ratio}</td></tr>`;
  }).join('')}</tbody></table>`;
  const pending = !b ? `<p class="cmp-note">Google Deep Research is still running. Its numbers appear when it finishes.</p>` : `<p class="cmp-note">Google's agent reports searches, pages and tokens; sources cited are the links in its answer. It runs no red team.</p>`;
  const answers = `<details class="answers"${el.querySelector('details.answers[open]') ? ' open' : ''}><summary>Read both answers side by side</summary><div class="two">
      <div><h3 class="section-h">This swarm</h3><div class="prose">${S.reportHtml || '<p class="muted">No report yet.</p>'}</div></div>
      <div><h3 class="section-h">Google Deep Research</h3><div class="prose">${S.baselineHtml || `<p class="muted">${b ? 'No answer file.' : 'Still running.'}</p>`}</div></div>
    </div></details>`;
  el.innerHTML = table + pending + answers;
  if (b && S.baselineMd == null && !S.baselineTried) { S.baselineTried = true; loadBaseline(); }
}

// ---------- Drawer (receipts)
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.cite[data-claim]');
  if (chip) { e.preventDefault(); e.stopPropagation(); openDrawer(chip.dataset.claim); return; }
  const sref = e.target.closest('.idref[data-source]');
  if (sref && S) { const s = S.sources.get(sref.dataset.source); if (s) { openDrawer(s.claim); return; } }
  if (S && S.drawerClaim && !e.target.closest('#drawer')) { closeDrawer(); }
  const go = e.target.closest('[data-go]');
  if (go) { S.tabChosen = true; setTab(go.dataset.go, true); scrollTo({ top: 0, behavior: 'smooth' }); }
}, true);
scrim.addEventListener('click', closeDrawer);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

function openDrawer(id) {
  if (!S) return;
  S.drawerClaim = id;
  renderDrawer(id);
  drawer.classList.add('on'); scrim.classList.add('on');
  drawer.setAttribute('aria-hidden', 'false');
  drawer.scrollTop = 0;
  refreshChips();
  $('.x', drawer)?.focus({ preventScroll: true });
}
function closeDrawer() {
  if (!S || !S.drawerClaim) return;
  S.drawerClaim = null;
  drawer.classList.remove('on'); scrim.classList.remove('on');
  drawer.setAttribute('aria-hidden', 'true');
  refreshChips();
}
function renderDrawer(id) {
  const d = derive();
  const i = claimInfo(id);
  const c = i.c;
  const keepScroll = drawer.scrollTop;
  if (!c) {
    drawer.innerHTML = `<div class="dhead"><div class="did">${esc(id)}</div><button class="x" aria-label="Close" type="button">×</button></div><p class="muted">This claim is not in the ledger${S.done ? '' : ' yet'}.</p>`;
    $('.x', drawer).onclick = closeDrawer;
    return;
  }
  const flags = [
    c.key && '<span class="tag">key</span>',
    c.status === 'dropped' && '<span class="tag fail">dropped</span>',
    i.single && '<span class="tag warn">single source</span>',
    i.contra && '<span class="tag warn">contradicting evidence</span>',
    i.wrong && '<span class="tag fail">a quote failed re-check</span>',
    i.openChals.length && `<span class="tag fail">${plural(i.openChals.length, 'open challenge')}</span>`,
    !i.single && !i.contra && !i.wrong && !i.openChals.length && i.live.length && i.live.every((x) => (d.checksBySrc.get(x.id) || []).some((k) => k.result === 'confirmed')) && c.status !== 'dropped' && '<span class="tag pass">every quote confirmed</span>',
  ].filter(Boolean).join('');
  const srcHtml = (s) => {
    const checks = d.checksBySrc.get(s.id) || [];
    const contra = s.stance === 'contradicts';
    const date = s.published ? esc(s.published) : '';
    return `<div class="src ${contra ? 'contra' : ''} ${s.status === 'dropped' ? 'gone' : ''}">
      <div class="pubrow"><span class="pub">${esc(s.publisher || host(s.url))}</span><span class="date">${date}</span></div>
      <a class="title" href="${esc(srcHref(s.url))}" target="_blank" rel="noopener">${esc(s.title || s.url)}<span class="host">${esc(/^attachment:/.test(s.url || '') ? String(s.url).replace(/^attachment:\/*/, '') : host(s.url))} ↗</span></a>
      ${s.quote ? `<blockquote>${esc(s.quote)}</blockquote>` : '<p class="warn" style="font-size:13px">No quote recorded.</p>'}
      <div style="margin-top:8px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span class="stance ${contra ? 'contra' : ''}">${contra ? 'Contradicts the claim' : 'Agrees'}</span>
        <span class="faint mono" style="font-size:11px">${esc(s.id)} · by ${esc(s.by || '?')}${s.retrieved ? ` · retrieved ${esc(s.retrieved)}` : ''}</span>
      </div>
      <ul class="checks">${checks.length ? checks.map((k) => `<li><span class="res ${k.result === 'confirmed' ? 'pass' : k.result === 'wrong' ? 'fail' : 'warn'}">${esc(k.result[0].toUpperCase() + k.result.slice(1))}</span><span><span class="who">${seatTag(k.by)}</span> ${esc(k.note || '')}</span></li>`).join('') : '<li><span class="res faint">Not re-checked</span><span></span></li>'}</ul>
    </div>`;
  };
  const chals = i.chals.map((x) => {
    const r = S.resolutions.get(x.id);
    return `<div class="chal-item"><div class="who">${seatTag(x.by)} → ${x.to ? seatTag(x.to) : ''} <span class="idref">${esc(x.id)}</span></div><div>${richText(x.text)}</div>
      ${r ? `<div class="res"><span>${seatTag(r.by)}</span> ${richText(r.text)}</div>` : '<div class="res open">Open</div>'}</div>`;
  }).join('');
  const answers = (d.answersByClaim.get(id) || []).map((a) => {
    const q = S.questions.get(a.question);
    return `<div class="ans"><span class="idref">${esc(a.question)}</span> ${esc(q ? q.text : '')}</div>`;
  }).join('');
  const dropped = i.srcs.filter((s) => s.status === 'dropped');
  drawer.innerHTML = `
    <div class="dhead"><div class="did">${esc(c.id)} <span>· by ${seatTag(c.by)}</span> <span class="faint">${rel(c.at)}</span></div><button class="x" aria-label="Close" type="button">×</button></div>
    <p class="ctext ${c.status === 'dropped' ? 'gone' : ''}">${esc(c.text)}</p>
    <div class="flags">${flags}</div>
    <div class="sum"><span class="num">${i.live.length}</span> ${i.live.length === 1 ? 'source' : 'sources'} from <span class="num">${i.pubs.size}</span> ${i.pubs.size === 1 ? 'publisher' : 'publishers'} · <span class="num">${i.confirmed}</span> ${i.confirmed === 1 ? 'quote' : 'quotes'} confirmed on re-check${i.chals.length ? ` · <span class="num">${i.chals.length}</span> ${i.chals.length === 1 ? 'challenge' : 'challenges'}` : ''}</div>
    <h3>Sources</h3>
    ${i.live.map(srcHtml).join('') || '<p class="muted">No sources.</p>'}
    ${dropped.length ? `<details class="gone-list"><summary>Dropped sources (${dropped.length})</summary>${dropped.map(srcHtml).join('')}</details>` : ''}
    ${chals ? `<h3>Challenges</h3>${chals}` : ''}
    ${answers ? `<h3>Answers that rest on it</h3>${answers}` : ''}`;
  $('.x', drawer).onclick = closeDrawer;
  drawer.scrollTop = keepScroll;
}

// ---------- routing
const route = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname;
const runMatch = route.match(/^\/run\/([^/]+)/);
if (runMatch) openRun(decodeURIComponent(runMatch[1]));
else showAsk();
