// HTTP server: starts swarm runs as child processes and streams their events.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RUNS = path.join(ROOT, "runs");
const PUB = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 8787);
fs.mkdirSync(RUNS, { recursive: true });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".jsonl": "application/x-ndjson; charset=utf-8", ".ndjson": "application/x-ndjson; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2" };
const safeId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id || "");

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function firstEvent(id) {
  try {
    const fd = fs.openSync(path.join(RUNS, id, "events.ndjson"), "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return JSON.parse(buf.subarray(0, n).toString().split("\n")[0]);
  } catch {
    return null;
  }
}
function lastStatus(id) {
  try {
    const txt = fs.readFileSync(path.join(RUNS, id, "events.ndjson"), "utf8");
    const i = txt.lastIndexOf('"t":"done"');
    if (i < 0) return "running";
    const line = txt.slice(txt.lastIndexOf("\n", i) + 1, txt.indexOf("\n", i));
    return JSON.parse(line).status;
  } catch {
    return "starting";
  }
}

// A run marked private (attached files, or marked by hand) is not shown through the sharednet.ai forward,
// unless it was started there or shared by hand (a file named "forwarded" in its folder).
const hiddenFromForward = (id) => fs.existsSync(path.join(RUNS, id, "private")) && !fs.existsSync(path.join(RUNS, id, "forwarded"));

function listRuns(fwd = false) {
  return fs
    .readdirSync(RUNS)
    .filter((d) => safeId(d) && fs.existsSync(path.join(RUNS, d, "request.json")) && !(fwd && hiddenFromForward(d)))
    .map((d) => {
      const req = JSON.parse(fs.readFileSync(path.join(RUNS, d, "request.json"), "utf8"));
      const ev = firstEvent(d);
      return { id: d, question: req.question, started_at: ev?.started_at || req.created_at, status: lastStatus(d) };
    })
    .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

function startRun(body, fwd = false) {
  if (fwd && Number(body.agents) > FWD_MAX_AGENTS) throw new Error(`a run started here can have ${FWD_MAX_AGENTS} agents at most`);
  const q = String(body.question || "").trim();
  if (q.length < 8) throw new Error("question too short");
  const d = new Date();
  const id = `r_${d.toISOString().slice(0, 16).replace(/[-:T]/g, "")}_${crypto.randomBytes(2).toString("hex")}`;
  const dir = path.join(RUNS, id);
  fs.mkdirSync(dir, { recursive: true });
  const req = {
    question: q.slice(0, 4000),
    ...(body.agents ? { agents: Math.max(4, Math.min(1024, Number(body.agents) || 16)) } : {}),
    researchers: Math.max(2, Math.min(8, Number(body.researchers) || 6)),
    redteam: Math.max(1, Math.min(3, Number(body.redteam) || 2)),
    minutes: Math.max(5, Math.min(120, Number(body.minutes) || 30)),
    baseline: body.baseline !== false,
    ...(body.review_rounds != null ? { review_rounds: Math.max(0, Math.min(4, Number(body.review_rounds) || 0)) } : {}),
    ...(body.multimodal ? { multimodal: true } : {}),
    ...(Array.isArray(body.models) && body.models.length <= 32 && body.models.every((m) => /^gemini-[a-z0-9.-]{1,40}$/.test(m)) ? { models: body.models } : {}),
    ...(Number(body.max_rounds) >= 1 ? { max_rounds: Math.min(4, Number(body.max_rounds)) } : {}),
    ...(Number(body.concurrency) >= 1 ? { concurrency: Math.min(1024, Number(body.concurrency)) } : {}),
    ...(/^gemini-[a-z0-9.-]{1,40}$/.test(body.seat_model || "") ? { seat_model: body.seat_model } : {}),
    ...(body.mode === "free" ? { mode: "free" } : {}),
    ...(/^[A-Za-z0-9_-]{1,64}$/.test(body.baseline_from || "") ? { baseline_from: body.baseline_from } : {}),
    created_at: d.toISOString(),
  };
  // attached files: [{ name: "folder/file.ext", data: "<base64>" }], 25 MB in all
  let bytes = 0;
  for (const a of Array.isArray(body.attachments) ? body.attachments.slice(0, 400) : []) {
    const rel = path.normalize(String(a?.name || "")).replace(/^([/\\]|\.\.[/\\])+/, "");
    if (!rel || rel.includes("..") || typeof a.data !== "string") continue;
    const buf = Buffer.from(a.data, "base64");
    bytes += buf.length;
    if (bytes > 25_000_000) throw new Error("attachments are larger than 25 MB in all; use the command line for more");
    const f = path.join(dir, "attachments", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
  }
  if (bytes) { req.attached_bytes = bytes; fs.writeFileSync(path.join(dir, "private"), "a run with attached files is never exported to the public copy\n"); }
  if (fwd) fs.writeFileSync(path.join(dir, "forwarded"), "started through the sharednet.ai forward, so it is shown there\n");
  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify(req, null, 2));
  const log = fs.openSync(path.join(dir, "swarm.log"), "a");
  const child = spawn(process.execPath, [path.join(ROOT, "swarm.mjs"), "--run", id], { cwd: ROOT, stdio: ["ignore", log, log], detached: true, env: process.env });
  child.unref();
  return id;
}

function stream(req, res, id) {
  const file = path.join(RUNS, id, "events.ndjson");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  let pos = 0, rest = "", closed = false, done = false, sawDone = false, basePending = false;
  // Every event carries the byte offset after it as its id. A browser that reconnects sends the last id it saw,
  // and the stream resumes there instead of replaying the whole run (a proxy in front may cut long streams).
  const last = Number(req.headers["last-event-id"]);
  try { if (Number.isInteger(last) && last > 0 && last <= fs.statSync(file).size) pos = last; } catch {}
  let off = pos;
  const pump = () => {
    if (closed) return;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size <= pos) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = size;
    const lines = (rest + buf.toString("utf8")).split("\n");
    rest = lines.pop();
    for (const l of lines) {
      off += Buffer.byteLength(l) + 1;
      if (!l.trim()) continue;
      res.write(`id: ${off}\ndata: ${l}\n\n`);
      if (l.includes('"t":"baseline"')) basePending = /"status":"(started|submitted)"/.test(l);
      if (l.includes('"t":"done"')) sawDone = true;
      if (sawDone && !basePending) done = true;
    }
  };
  pump();
  const timer = setInterval(() => {
    pump();
    if (done) { clearInterval(timer); clearInterval(ping); res.end(); }
  }, 700);
  const ping = setInterval(() => !closed && res.write(": ping\n\n"), 15000);
  req.on("close", () => { closed = true; clearInterval(timer); clearInterval(ping); });
}

// The same events for a page that cannot hold a stream open (behind a tunnel or the sharednet.ai forward): what
// is new after byte `from`, answered at once when there is something and after 20 s when there is not. The first
// line of the answer says where to ask from next. Whole lines only, about 2 MB at a time.
function events(req, res, id, from) {
  const file = path.join(RUNS, id, "events.ndjson");
  const started = Date.now();
  let closed = false, timer = null;
  req.on("close", () => { closed = true; clearTimeout(timer); });
  const read = () => {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return null; }
    if (from > size) from = 0;
    if (size <= from) return null;
    const fd = fs.openSync(file, "r");
    try {
      for (const want of [2_000_000, 32_000_000]) {
        const buf = Buffer.alloc(Math.min(size - from, want));
        fs.readSync(fd, buf, 0, buf.length, from);
        const cut = buf.lastIndexOf(10);
        if (cut >= 0) return buf.subarray(0, cut + 1);
        if (buf.length < want) return null; // a line still being written
      }
      return null;
    } finally { fs.closeSync(fd); }
  };
  const tick = () => {
    if (closed) return;
    const chunk = read();
    if (chunk || Date.now() - started > 20_000) {
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
      res.write(JSON.stringify({ next: from + (chunk ? chunk.length : 0) }) + "\n");
      return res.end(chunk || "");
    }
    timer = setTimeout(tick, 700);
  };
  tick();
}

// Access code for requests that arrive through a public tunnel. A request made on this machine directly
// (no proxy headers) is not asked for it. Starting a run spends the owner's API key, so the code is required
// for every page, file and call, and wrong guesses are rate-limited.
const CODE = (process.env.SWARM_ACCESS_CODE || "").trim();
const TOKEN = CODE ? crypto.createHash("sha256").update("swarm:" + CODE).digest("hex").slice(0, 40) : "";
const tries = new Map();
const viaTunnel = (req) => Boolean(req.headers["cf-connecting-ip"] || req.headers["cf-ray"] || req.headers["x-forwarded-for"]);
const hasAccess = (req) => (req.headers.cookie || "").split(/;\s*/).includes(`swarm_access=${TOKEN}`);
const GATE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Prometheus on Gemini</title>
<style>:root{--bg:#f7f6f2;--fg:#1a1a18;--muted:#6b6a64;--line:#d8d6ce}@media (prefers-color-scheme: dark){:root{--bg:#121212;--fg:#ecebe6;--muted:#9a9993;--line:#2e2e2c;color-scheme:dark}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}form{width:min(360px,calc(100vw - 32px))}h1{font:500 28px/1.2 Georgia,serif;margin:0 0 6px}h1 i{color:var(--muted)}p{color:var(--muted);margin:0 0 22px}label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}.row{display:flex;gap:8px}input{flex:1;min-width:0;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}button{font:inherit;padding:10px 18px;border:0;border-radius:6px;background:var(--fg);color:var(--bg);cursor:pointer}#err{min-height:1.5em;margin-top:10px;font-size:14px;color:#b3402a}</style></head><body>
<form id="f" autocomplete="off"><h1>Prometheus <i>on Gemini</i></h1><p>Ask one question; a swarm of Gemini agents researches it. Enter the access code to use it.</p><label for="code">Access code</label><div class="row"><input id="code" autofocus required spellcheck="false"><button type="submit">Enter</button></div><div id="err" role="alert"></div></form>
<script>document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();const err=document.getElementById('err');err.textContent='';try{const r=await fetch('/unlock?code='+encodeURIComponent(document.getElementById('code').value.trim()),{credentials:'same-origin'});if(r.ok)location.reload();else err.textContent=r.status===429?'Too many tries. Wait a few minutes.':'That code is not right.'}catch{err.textContent='Could not reach the server. Try again.'}});</script></body></html>`;
function gate(req, res, p, url) {
  if (!CODE || !viaTunnel(req)) return false;
  res.setHeader("x-robots-tag", "noindex, nofollow");
  if (p === "/unlock") {
    const ip = String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
    const nowMs = Date.now();
    const mine = (tries.get(ip) || []).filter((t) => nowMs - t < 600_000);
    const all = [...tries.values()].flat().filter((t) => nowMs - t < 600_000).length;
    if (mine.length >= 8 || all >= 80) { send(res, 429, "Too many tries.", "text/plain"); return true; }
    if ((url.searchParams.get("code") || "").trim() !== CODE) { mine.push(nowMs); tries.set(ip, mine); send(res, 401, "Wrong code.", "text/plain"); return true; }
    res.setHeader("set-cookie", `swarm_access=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${14 * 86400}`);
    send(res, 204, "");
    return true;
  }
  if (hasAccess(req)) return false;
  if (!p.startsWith("/api/") && !/\.[a-z0-9]+$/i.test(p)) send(res, 401, GATE_PAGE, "text/html; charset=utf-8");
  else send(res, 401, { error: "access code needed" });
  return true;
}

// The forward: sharednet.ai/gprometheus passes its requests on to /__gp/<key>/… of this server. The key is known
// only to this machine and to sharednet.ai, which has already asked the reader for its own access code. Pages
// served this way live under FWD_BASE, so their addresses are rewritten to it.
const FWD_KEY = (process.env.SWARM_FORWARD_KEY || "").trim();
const FWD_BASE = (process.env.SWARM_FORWARD_BASE || "/gprometheus").replace(/\/+$/, "");
const FWD_MAX_AGENTS = Number(process.env.SWARM_FORWARD_MAX_AGENTS || 128);
const sameSecret = (a, b) => { const x = crypto.createHash("sha256").update(a).digest(), y = crypto.createHash("sha256").update(b).digest(); return crypto.timingSafeEqual(x, y); };
function underBase(buf, ext) {
  let s = buf.toString("utf8");
  if (ext === ".js" || ext === ".mjs" || ext === ".html") s = s.replaceAll("from '/", `from '${FWD_BASE}/`);
  if (ext === ".html") {
    s = s.replaceAll('href="/', `href="${FWD_BASE}/`).replaceAll('src="/', `src="${FWD_BASE}/`)
      .replace("<script", `<script>window.GP = { base: ${JSON.stringify(FWD_BASE)}, static: false, forwarded: true };</script>\n<script`);
    if (!s.includes('name="robots"')) s = s.replace("<head>", '<head>\n<meta name="robots" content="noindex, nofollow">');
  }
  return s;
}
// Starting a run spends the owner's API key. Through the forward it takes the run code as well (the access code
// of this server), because the code that opens the pages on sharednet.ai is short and widely given out.
function runCodeOk(req) {
  if (!CODE) return true;
  const ip = "fwd:" + String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  const nowMs = Date.now();
  const mine = (tries.get(ip) || []).filter((t) => nowMs - t < 600_000);
  if (mine.length >= 8) return false;
  const given = String(req.headers["x-run-code"] || "").trim();
  if (given && sameSecret(given, CODE)) return true;
  if (given) { mine.push(nowMs); tries.set(ip, mine); }
  return false;
}

function readBody(req) {
  return new Promise((ok, bad) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 36_000_000) bad(new Error("too large")); });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  });
}

http
  .createServer(async (req, res) => {
    try {
      let fwd = false;
      const fm = req.url.match(/^\/__gp\/([A-Za-z0-9_-]{16,200})(?=[/?]|$)(.*)$/);
      if (fm) {
        if (!FWD_KEY || !sameSecret(fm[1], FWD_KEY)) return send(res, 404, { error: "not found" });
        fwd = true;
        req.url = fm[2].startsWith("/") ? fm[2] : "/" + fm[2];
        res.setHeader("x-robots-tag", "noindex, nofollow");
      }
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
      if (!fwd && gate(req, res, p, url)) return;
      if (fwd && p === "/api/ping") return send(res, 200, { ok: true });
      if (p === "/api/runs" && req.method === "GET") return send(res, 200, listRuns(fwd));
      if (p === "/api/runs" && req.method === "POST") {
        if (fwd && !runCodeOk(req)) return send(res, 403, { error: "The run code is needed to start a run here.", need: "run_code" });
        return send(res, 200, { id: startRun(await readBody(req), fwd) });
      }
      let m = p.match(/^\/api\/runs\/([^/]+)\//);
      if (fwd && m && safeId(m[1]) && hiddenFromForward(m[1])) return send(res, 404, { error: "not found" });
      m = p.match(/^\/api\/runs\/([^/]+)\/stream$/);
      if (m && safeId(m[1])) return stream(req, res, m[1]);
      m = p.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (m && safeId(m[1])) return events(req, res, m[1], Math.max(0, Math.floor(Number(url.searchParams.get("from")) || 0)));
      m = p.match(/^\/api\/runs\/([^/]+)\/file\/(report\.md|baseline\.md|ledger\.jsonl|events\.ndjson|request\.json)$/);
      if (m && safeId(m[1])) {
        const f = path.join(RUNS, m[1], m[2]);
        if (!fs.existsSync(f)) return send(res, 404, { error: "not yet" });
        return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] || "text/plain");
      }
      m = p.match(/^\/api\/runs\/([^/]+)\/attachment\/(.+)$/);
      if (m && safeId(m[1])) {
        const base = path.join(RUNS, m[1], "attachments");
        const f = path.resolve(base, decodeURIComponent(m[2]));
        if (!f.startsWith(base + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { error: "no such attachment" });
        return send(res, 200, fs.readFileSync(f), /\.(png|jpe?g|gif|webp|pdf)$/i.test(f) ? (TYPES[path.extname(f).toLowerCase()] || "application/octet-stream") : "text/plain; charset=utf-8");
      }
      if (p.startsWith("/api/")) return send(res, 404, { error: "not found" });
      let f = p === "/ask" ? path.join(PUB, "ask.html") : p === "/" || p.startsWith("/run/") ? path.join(PUB, "index.html") : path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
      if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, "index.html");
      if (!fs.existsSync(f)) return send(res, 404, "page not built yet", "text/plain");
      const ext = path.extname(f);
      if (fwd && (ext === ".html" || ext === ".js" || ext === ".mjs")) return send(res, 200, underBase(fs.readFileSync(f), ext), TYPES[ext]);
      return send(res, 200, fs.readFileSync(f), TYPES[ext] || "application/octet-stream");
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`swarm server on http://127.0.0.1:${PORT}`));
