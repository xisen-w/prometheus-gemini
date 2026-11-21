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

function listRuns() {
  return fs
    .readdirSync(RUNS)
    .filter((d) => safeId(d) && fs.existsSync(path.join(RUNS, d, "request.json")))
    .map((d) => {
      const req = JSON.parse(fs.readFileSync(path.join(RUNS, d, "request.json"), "utf8"));
      const ev = firstEvent(d);
      return { id: d, question: req.question, started_at: ev?.started_at || req.created_at, status: lastStatus(d) };
    })
    .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

function startRun(body) {
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
    ...(Array.isArray(body.models) && body.models.length <= 32 && body.models.every((m) => /^gemini-[a-z0-9.-]{1,40}$/.test(m)) ? { models: body.models } : {}),
    ...(Number(body.max_rounds) >= 1 ? { max_rounds: Math.min(4, Number(body.max_rounds)) } : {}),
    ...(Number(body.concurrency) >= 1 ? { concurrency: Math.min(1024, Number(body.concurrency)) } : {}),
    ...(/^gemini-[a-z0-9.-]{1,40}$/.test(body.seat_model || "") ? { seat_model: body.seat_model } : {}),
    ...(body.mode === "free" ? { mode: "free" } : {}),
    ...(/^[A-Za-z0-9_-]{1,64}$/.test(body.baseline_from || "") ? { baseline_from: body.baseline_from } : {}),
    created_at: d.toISOString(),
  };
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
      if (!l.trim()) continue;
      res.write(`data: ${l}\n\n`);
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

function readBody(req) {
  return new Promise((ok, bad) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 100_000) bad(new Error("too large")); });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  });
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
      if (p === "/api/runs" && req.method === "GET") return send(res, 200, listRuns());
      if (p === "/api/runs" && req.method === "POST") return send(res, 200, { id: startRun(await readBody(req)) });
      let m = p.match(/^\/api\/runs\/([^/]+)\/stream$/);
      if (m && safeId(m[1])) return stream(req, res, m[1]);
      m = p.match(/^\/api\/runs\/([^/]+)\/file\/(report\.md|baseline\.md|ledger\.jsonl|events\.ndjson|request\.json)$/);
      if (m && safeId(m[1])) {
        const f = path.join(RUNS, m[1], m[2]);
        if (!fs.existsSync(f)) return send(res, 404, { error: "not yet" });
        return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] || "text/plain");
      }
      if (p.startsWith("/api/")) return send(res, 404, { error: "not found" });
      let f = p === "/ask" ? path.join(PUB, "ask.html") : p === "/" || p.startsWith("/run/") ? path.join(PUB, "index.html") : path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
      if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, "index.html");
      if (!fs.existsSync(f)) return send(res, 404, "page not built yet", "text/plain");
      return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] || "application/octet-stream");
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`swarm server on http://127.0.0.1:${PORT}`));
