// The report as a document, for paper and PDF: title, the question, the run's numbers, the report, and the
// evidence behind every claim it cites. Reads the run's files directly; nothing is replayed.
import { marked } from '/vendor/marked.esm.js';
import { placeFigures } from '/figures.js';
import { protectMath } from '/mathmd.js';

const BASE = window.GP?.base || '';
const id = window.GP?.share?.id || decodeURIComponent((location.pathname.match(/\/run\/([^/]+)\/print/) || [])[1] || '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const file = (name) => `${BASE}/api/runs/${encodeURIComponent(id)}/${name}`;
const TAG_RE = /\[((?:C\d+-\d+)(?:\s*[,;]\s*C\d+-\d+)*)\]/g;
const num = (n) => Number(n).toLocaleString('en-US');

async function main() {
  const [sum, md, ledgerText] = await Promise.all([
    fetch(file('summary'), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})),
    fetch(file('file/report.md'), { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('This run has no report.'); return r.text(); }),
    fetch(file('file/ledger.jsonl'), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')),
  ]);
  const claims = new Map(), sources = new Map(), figures = new Map(), open = new Set(), resolved = new Set();
  for (const line of ledgerText.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'claim') claims.set(r.id, r);
    else if (r.type === 'figure') figures.set(r.id, r);
    else if (r.type === 'source') { if (!sources.has(r.claim)) sources.set(r.claim, new Map()); sources.get(r.claim).set(r.id, r); }
    else if (r.type === 'challenge') open.add(r.id + '|' + r.claim);
    else if (r.type === 'resolution') resolved.add(r.challenge);
  }
  const challenged = new Set([...open].filter((k) => !resolved.has(k.split('|')[0])).map((k) => k.split('|')[1]));

  // the report's own first heading is the document's title
  let body = md.replace(/^﻿/, '');
  let title = '';
  const h1 = body.match(/^\s*#\s+(.+?)\s*\n/);
  if (h1) { title = h1[1].replace(/[*_`]/g, ''); body = body.slice(h1[0].length); }
  // A claim tag is a link. With the evidence list it points to the claim's line there; without it, straight to
  // the first source kept for the claim, so the document stays short and every tag still opens something.
  const withEvidence = new URLSearchParams(location.search).has('evidence');
  const firstSource = (c) => [...(sources.get(c) || new Map()).values()].find((s) => s.status !== 'dropped' && /^https?:\/\//.test(s.url || ''))?.url;
  const cited = [];
  const math = protectMath(body);
  const src = math.src.replace(TAG_RE, (m, ids) => ids.split(/\s*[,;]\s*/).map((c) => {
    if (!cited.includes(c)) cited.push(c);
    const to = withEvidence ? `#c-${c}` : firstSource(c);
    return to ? `<a class="cite" href="${esc(to)}">${c}</a>` : `<span class="cite">${c}</span>`;
  }).join(''));
  const t = document.createElement('template');
  t.innerHTML = math.restore(marked.parse(src.replace(/~/g, '\\~'), { gfm: true, breaks: false }));
  t.content.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach((n) => n.remove());
  t.content.querySelectorAll('*').forEach((n) => { for (const a of [...n.attributes]) if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name); });
  const html = placeFigures(t.innerHTML, figures);

  const date = sum.started_at ? new Date(sum.started_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const facts = [
    date && `<span>${esc(date)}</span>`,
    sum.agents && `<span><b>${num(sum.agents)}</b> agents${sum.mode === 'free' ? ', no orchestrator' : ''}</span>`,
    sum.minutes != null && `<span><b>${Math.round(sum.minutes)}</b> min</span>`,
    sum.claims && `<span><b>${num(sum.claims)}</b> claims</span>`,
    sum.sources && `<span><b>${num(sum.sources)}</b> sources from <b>${num(sum.publishers || 0)}</b> publishers</span>`,
  ].filter(Boolean).join('');
  const q = String(sum.question || '').trim();
  const evidence = !withEvidence ? '' : cited.filter((c) => claims.has(c)).map((c) => {
    const row = claims.get(c);
    const live = [...(sources.get(c) || new Map()).values()].filter((s) => s.status !== 'dropped');
    const seen = new Set();
    const links = live.filter((s) => { const k = s.url; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4).map((s) => (/^attachment:/.test(s.url || '')
      ? esc(String(s.url).replace(/^attachment:\/*/, ''))
      : `<a href="${esc(s.url)}">${esc(s.publisher || host(s.url))}</a> <span>${esc(host(s.url))}</span>`));
    const flags = [row.status === 'dropped' && 'dropped by the team', challenged.has(c) && 'open challenge', row.single_source && 'single source'].filter(Boolean);
    return `<li id="c-${esc(c)}"><span class="cid">${esc(c)}</span><span><span class="ct">${esc(row.text || '')}</span>${flags.length ? ` <span class="flag">(${flags.join('; ')})</span>` : ''}<span class="cs">${links.join(' · ') || 'no source kept'}${live.length > 4 ? ` · and ${live.length - 4} more` : ''}</span></span></li>`;
  }).join('');

  document.title = `${title || q.slice(0, 80) || 'Report'} · Prometheus on Gemini`;
  document.getElementById('doc').innerHTML = `
    <p class="d-kicker"><span>Prometheus on Gemini</span><span>Research report</span></p>
    <h1 class="d-title">${esc(title || q)}</h1>
    ${title && q ? `<p class="d-ask"><b>The question</b>${esc(q)}</p>` : ''}
    <p class="d-facts">${facts}</p>
    <article class="prose">${html}</article>
    ${evidence ? `<section class="d-ev"><h2>Evidence</h2><p class="lede">Every claim the report cites, in the order it first appears, with where it comes from. The small tags in the text point here.</p><ol>${evidence}</ol></section>`
      : `<p class="d-end">The small tags in the text are claims. Each one links to the first source the team kept for it; ${num(cited.length)} claims are cited here. The run itself holds every source, the exact quotes, and what the red team found.</p>`}`;
  // fonts and formulas settle before the page is printed
  try { await document.fonts.ready; } catch {}
  await new Promise((ok) => requestAnimationFrame(() => setTimeout(ok, 150)));
  window.__printReady = true;
  if (new URLSearchParams(location.search).has('auto')) window.print();
}

main().catch((e) => {
  document.getElementById('doc').innerHTML = `<p class="wait">${esc(e.message || e)}</p>`;
  window.__printReady = true;
});
