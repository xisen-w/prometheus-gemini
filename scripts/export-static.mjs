// Export the page and every finished run as static files, to host under a base path without the server.
//   node scripts/export-static.mjs <out dir> [base=/gprometheus]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const OUT = path.resolve(process.argv[2]);
const BASE = process.argv[3] || "/gprometheus";
const PUB = path.join(ROOT, "public");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "data"), { recursive: true });
fs.cpSync(path.join(PUB, "vendor"), path.join(OUT, "vendor"), { recursive: true });
fs.copyFileSync(path.join(PUB, "style.css"), path.join(OUT, "style.css"));
fs.writeFileSync(path.join(OUT, "app.js"), fs.readFileSync(path.join(PUB, "app.js"), "utf8").replace("'/vendor/marked.esm.js'", `'${BASE}/vendor/marked.esm.js'`));
let html = fs.readFileSync(path.join(PUB, "index.html"), "utf8")
  .replaceAll('href="/vendor/', `href="${BASE}/vendor/`)
  .replace('href="/style.css"', `href="${BASE}/style.css"`)
  .replace('<a class="brand" href="/">', `<a class="brand" href="${BASE}/">`)
  .replace('<script type="module" src="/app.js"></script>', `<script>window.GP = { base: ${JSON.stringify(BASE)}, static: true };</script>\n<script type="module" src="${BASE}/app.js"></script>`);
if (!html.includes('name="robots"')) html = html.replace("<head>", '<head>\n<meta name="robots" content="noindex, nofollow">');
if (!html.includes("window.GP")) throw new Error("index.html did not take the static settings");
fs.writeFileSync(path.join(OUT, "index.html"), html);

fs.writeFileSync(path.join(OUT, "gate.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Prometheus on Gemini</title>
<style>
:root { --bg: #f7f6f2; --fg: #1a1a18; --muted: #6b6a64; --line: #d8d6ce; }
@media (prefers-color-scheme: dark) { :root { --bg: #121212; --fg: #ecebe6; --muted: #9a9993; --line: #2e2e2c; color-scheme: dark; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
form { width: min(360px, calc(100vw - 32px)); }
h1 { font: 500 28px/1.2 Georgia, "Times New Roman", serif; margin: 0 0 6px; } h1 i { color: var(--muted); }
p { color: var(--muted); margin: 0 0 22px; }
label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
.row { display: flex; gap: 8px; }
input { flex: 1; min-width: 0; font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; letter-spacing: .1em; text-transform: uppercase; }
button { font: inherit; padding: 10px 18px; border: 0; border-radius: 6px; background: var(--fg); color: var(--bg); cursor: pointer; }
#err { min-height: 1.5em; margin-top: 10px; font-size: 14px; color: #b3402a; }
</style></head><body>
<form id="f" autocomplete="off">
  <h1>Prometheus <i>on Gemini</i></h1>
  <p>A swarm of Gemini agents, and every claim it makes. Enter the access code to read the runs.</p>
  <label for="code">Access code</label>
  <div class="row"><input id="code" name="code" autofocus required autocapitalize="characters" spellcheck="false"><button type="submit">Enter</button></div>
  <div id="err" role="alert"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err'); err.textContent = '';
  try {
    const r = await fetch('${BASE}/unlock?code=' + encodeURIComponent(document.getElementById('code').value.trim()), { credentials: 'same-origin' });
    if (r.ok) location.reload(); else err.textContent = 'That code is not right.';
  } catch { err.textContent = 'Could not reach the server. Try again.'; }
});
</script></body></html>
`);

const runs = [];
for (const id of fs.readdirSync(path.join(ROOT, "runs")).filter((d) => /^r_[A-Za-z0-9_]+$/.test(d)).sort()) {
  const dir = path.join(ROOT, "runs", id);
  const evFile = path.join(dir, "events.ndjson");
  if (!fs.existsSync(evFile) || !fs.existsSync(path.join(dir, "report.md"))) continue;
  const text = fs.readFileSync(evFile, "utf8");
  const done = text.split("\n").filter((l) => l.includes('"t":"done"')).map((l) => JSON.parse(l)).pop();
  if (!done) continue;
  const first = JSON.parse(text.slice(0, text.indexOf("\n")));
  const out = path.join(OUT, "data", id);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "events.ndjson.gz"), zlib.gzipSync(text, { level: 9 }));
  fs.copyFileSync(path.join(dir, "report.md"), path.join(out, "report.md"));
  if (fs.existsSync(path.join(dir, "baseline.md"))) fs.copyFileSync(path.join(dir, "baseline.md"), path.join(out, "baseline.md"));
  runs.push({ id, question: first.question, started_at: first.started_at, status: done.status, agents: (first.seats || []).filter((s) => s.role === "researcher" || s.role === "redteam").length, mode: first.mode === "free" ? "no orchestrator" : "orchestrated" });
}
runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
fs.writeFileSync(path.join(OUT, "data", "runs.json"), JSON.stringify(runs));
const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`${runs.length} runs, ${(size(OUT) / 1e6).toFixed(1)} MB in ${OUT}`);
