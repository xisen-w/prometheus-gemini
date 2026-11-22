// Math in reports: $...$ and $$...$$ are rendered with KaTeX. Dollar amounts ("$94 million", "$7,500") are
// left alone: a span counts as math only when it opens and closes tight against its content, is not followed
// by a digit, and contains something only a formula has.
import katex from '/vendor/katex/katex.mjs';

const SIGNAL = /\\[a-zA-Z]+|[=^_<>≤≥±×]|\\[%$]/;
const render = (tex, display) => {
  try { return katex.renderToString(tex.replace(/(^|[^\\])%/g, '$1\\%'), { displayMode: display, throwOnError: false, strict: false, output: 'html' }); }
  catch { return null; }
};

// Take the math out before Markdown sees it (so _ and * inside a formula are not read as emphasis),
// and give back a function that puts the rendered formulas into the HTML.
export function protectMath(src) {
  const held = [];
  const hold = (tex, display, raw) => {
    const html = render(tex.trim(), display);
    if (html == null) return raw;
    held.push(display ? `<div class="math-block">${html}</div>` : html);
    return `XMATHX${held.length - 1}X`;
  };
  let out = String(src).replace(/\$\$([^$]{1,2000}?)\$\$/g, (raw, tex) => hold(tex, true, raw));
  // inline math, scanned by hand: an opening $ pairs only with the very next $, and a pair that fails the
  // tests gives both dollars back, so "($500K … $250K … $\ge 2$" still finds the formula at the end
  let res = "";
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === "\\" && out[i + 1] === "$") { res += "\\$"; i++; continue; }
    if (ch !== "$") { res += ch; continue; }
    const prev = out[i - 1] || "";
    let j = i + 1;
    while (j < out.length && j - i <= 162 && out[j] !== "\n" && !(out[j] === "$" && out[j - 1] !== "\\")) j++;
    const tex = out[j] === "$" ? out.slice(i + 1, j) : null;
    const ok = tex && !/\w/.test(prev) && !/^\s|\s$/.test(tex) && !/[\d$]/.test(out[j + 1] || "") && SIGNAL.test(tex);
    if (!ok) { res += ch; continue; }
    res += hold(tex, false, "$" + tex + "$");
    i = j;
  }
  out = res;
  return { src: out, restore: (html) => html.replace(/XMATHX(\d+)X/g, (_, i) => held[+i] ?? '') };
}
