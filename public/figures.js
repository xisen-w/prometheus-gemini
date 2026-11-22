// Figures in multi-modal mode: an agent computes the numbers in its sandbox and logs them as a `figure` row;
// the page draws the chart, so every mark is backed by data the reader can open (the table under the chart).
// Kinds: line, bar, scatter (drawn here), image (an existing chart on the web, shown with its source).
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const W = 640, H = 330, M = { l: 58, r: 84, t: 14, b: 42 };

function fmt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n ?? '');
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
  if (a >= 100 || Number.isInteger(n)) return String(Math.round(n * 10) / 10);
  if (a >= 1) return n.toFixed(2).replace(/\.?0+$/, '');
  return n.toPrecision(2).replace(/\.?0+$/, '');
}
function niceTicks(lo, hi, n = 5) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const a = Math.floor(lo / step) * step, out = [];
  for (let v = a; v <= hi + step * 0.5; v += step) out.push(+v.toPrecision(12));
  return out;
}

function chart(fig) {
  const series = (fig.series || []).slice(0, 4).map((s) => ({ name: String(s.name ?? ''), points: (s.points || []).filter((p) => Array.isArray(p) && typeof p[1] === 'number' && isFinite(p[1])).slice(0, 400) })).filter((s) => s.points.length);
  if (!series.length) return '';
  const kind = fig.kind === 'bar' || fig.kind === 'scatter' ? fig.kind : 'line';
  const numericX = kind !== 'bar' && series.every((s) => s.points.every((p) => typeof p[0] === 'number'));
  const cats = numericX ? null : [...new Set(series.flatMap((s) => s.points.map((p) => String(p[0]))))];
  const ys = series.flatMap((s) => s.points.map((p) => p[1]));
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (kind === 'bar') { y0 = Math.min(0, y0); y1 = Math.max(0, y1); } else { const pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.05 || 1; y0 -= pad; y1 += pad; }
  const yt = niceTicks(y0, y1);
  y0 = Math.min(y0, yt[0]); y1 = Math.max(y1, yt.at(-1));
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const Y = (v) => M.t + ih - ((v - y0) / (y1 - y0)) * ih;
  let X, xt;
  if (numericX) {
    const xs = series.flatMap((s) => s.points.map((p) => p[0]));
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    X = (v) => M.l + (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0)) * iw;
    xt = niceTicks(x0, x1, 6).filter((v) => v >= x0 && v <= x1).map((v) => [X(v), fmt(v)]);
  } else {
    const band = iw / cats.length;
    X = (v) => M.l + (cats.indexOf(String(v)) + 0.5) * band;
    const every = Math.ceil(cats.length / 8);
    xt = cats.map((c, i) => [X(c), c.length > 12 ? c.slice(0, 11) + '…' : c, i]).filter((t) => t[2] % every === 0);
  }
  const unit = fig.unit ? ` ${fig.unit}` : '';
  const parts = [];
  // recessive grid and axes
  for (const v of yt) parts.push(`<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="tick" x="${M.l - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`);
  for (const [x, label] of xt) parts.push(`<text class="tick" x="${x.toFixed(1)}" y="${H - M.b + 18}" text-anchor="middle">${esc(label)}</text>`);
  if (kind === 'bar' && y0 < 0) parts.push(`<line class="axis" x1="${M.l}" x2="${W - M.r}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>`);
  if (fig.y_label) parts.push(`<text class="lab" transform="translate(14 ${M.t + ih / 2}) rotate(-90)" text-anchor="middle">${esc(fig.y_label)}</text>`);
  if (fig.x_label) parts.push(`<text class="lab" x="${M.l + iw / 2}" y="${H - 6}" text-anchor="middle">${esc(fig.x_label)}</text>`);
  const ends = [];
  series.forEach((s, si) => {
    const tip = (p) => `<title>${esc(series.length > 1 ? s.name + ' · ' : '')}${esc(typeof p[0] === 'number' ? fmt(p[0]) : p[0])}: ${esc(fmt(p[1]))}${esc(unit)}</title>`;
    if (kind === 'bar') {
      const band = iw / cats.length, bw = Math.max(3, Math.min(46, (band - 10) / series.length - 2));
      for (const p of s.points) {
        const cx = X(p[0]) + (si - (series.length - 1) / 2) * (bw + 2), top = Math.min(Y(p[1]), Y(0)), h = Math.max(1, Math.abs(Y(p[1]) - Y(0))), r = Math.min(4, bw / 2, h);
        const up = p[1] >= 0;
        const d = up ? `M${cx - bw / 2},${top + h}V${top + r}q0,-${r} ${r},-${r}h${bw - 2 * r}q${r},0 ${r},${r}V${top + h}Z` : `M${cx - bw / 2},${top}V${top + h - r}q0,${r} ${r},${r}h${bw - 2 * r}q${r},0 ${r},-${r}V${top}Z`;
        parts.push(`<path class="s${si + 1} bar" d="${d}">${tip(p)}</path>`);
        // few bars: the value sits on the bar, in text ink
        if (cats.length * series.length <= 10) parts.push(`<text class="end" x="${cx.toFixed(1)}" y="${(up ? top - 5 : top + h + 13).toFixed(1)}" text-anchor="middle">${esc(fmt(p[1]))}${esc(fig.unit === "%" ? "%" : "")}</text>`);
      }
    } else {
      const pts = s.points.slice().sort((a, b) => (numericX ? a[0] - b[0] : 0));
      if (kind === 'line') parts.push(`<path class="s${si + 1} line" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}"/>`);
      if (kind === 'scatter' || pts.length <= 40) for (const p of pts) parts.push(`<circle class="s${si + 1} dot" cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${kind === 'scatter' ? 4.5 : 3.5}">${tip(p)}</circle>`);
      const last = pts.at(-1);
      if (kind === 'line') ends.push({ y: Y(last[1]), x: X(last[0]), text: `${series.length > 1 ? s.name + ' ' : ''}${fmt(last[1])}` });
    }
  });
  // direct labels at the line ends, nudged apart so they never overlap
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) parts.push(`<text class="end" x="${(e.x + 8).toFixed(1)}" y="${(e.y + 4).toFixed(1)}">${esc(e.text.length > 13 ? e.text.slice(0, 12) + '…' : e.text)}</text>`);
  const legend = series.length > 1 ? `<div class="fig-legend">${series.map((s, i) => `<span><i class="k${i + 1}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(fig.title || fig.caption || 'chart')}">${parts.join('')}</svg>`;
}

function table(fig) {
  const series = (fig.series || []).slice(0, 4);
  if (!series.length) return '';
  const xs = [...new Set(series.flatMap((s) => (s.points || []).map((p) => String(p[0]))))].slice(0, 400);
  const at = (s, x) => { const p = (s.points || []).find((q) => String(q[0]) === x); return p ? fmt(p[1]) : ''; };
  return `<details class="fig-data"><summary>Data</summary><div class="fig-scroll"><table><thead><tr><th>${esc(fig.x_label || '')}</th>${series.map((s) => `<th>${esc(s.name || fig.y_label || 'value')}</th>`).join('')}</tr></thead><tbody>${xs.map((x) => `<tr><td>${esc(x)}</td>${series.map((s) => `<td>${esc(at(s, x))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}

export function figureHtml(fig) {
  if (!fig) return '';
  const who = fig.by ? ` · computed by ${esc(fig.by)}` : '';
  const claims = (fig.claims || []).map((c) => `<button class="cite" data-claim="${esc(c)}" type="button">${esc(c)}</button>`).join('');
  const cap = `<figcaption><b>${esc(fig.title || '')}</b>${fig.caption ? ` ${esc(fig.caption)}` : ''} <span class="fig-meta">${esc(fig.id || '')}${who}</span> ${claims}${fig.method ? `<span class="fig-method">How: ${esc(fig.method)}</span>` : ''}</figcaption>`;
  if (fig.kind === 'image') {
    if (!/^https?:\/\//.test(fig.url || '')) return '';
    return `<figure class="fig"><img src="${esc(fig.url)}" alt="${esc(fig.title || fig.caption || '')}" loading="lazy" referrerpolicy="no-referrer">${cap.replace('</figcaption>', `${fig.page ? ` <a href="${esc(fig.page)}" target="_blank" rel="noopener">source</a>` : ''}</figcaption>`)}</figure>`;
  }
  const svg = chart(fig);
  if (!svg) return '';
  return `<figure class="fig">${svg}${cap}${table(fig)}</figure>`;
}

// replace {{F3-1}} tokens in rendered report HTML with the figures
export function placeFigures(html, figures) {
  return html.replace(/<p>\s*\{\{\s*(F[\w-]+)\s*\}\}\s*<\/p>|\{\{\s*(F[\w-]+)\s*\}\}/g, (m, a, b) => figureHtml(figures.get(a || b)) || '');
}
