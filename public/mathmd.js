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
  out = out.replace(/(^|[^\\$\w])\$(?!\s)((?:\\.|[^$\\\n]){1,160}?)\$(?![\d$])/g, (raw, pre, tex) => {
    if (/\s$/.test(tex) || !SIGNAL.test(tex)) return raw;
    return pre + hold(tex, false, '$' + tex + '$');
  });
  return { src: out, restore: (html) => html.replace(/XMATHX(\d+)X/g, (_, i) => held[+i] ?? '') };
}
