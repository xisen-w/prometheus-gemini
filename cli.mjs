#!/usr/bin/env node
// Command line for the swarm: ask a question (optionally about files or folders you attach), watch it work,
// read the result. No server needed.
//
//   node cli.mjs ask "<question>" [--attach <file or folder> ...] [--agents 16] [--minutes 30]
//                                 [--model hydrogen|neon|carbon|mix] [--free] [--rounds 2] [--review 2]
//                                 [--baseline] [--detach]
//   node cli.mjs runs                      list runs, newest first
//   node cli.mjs watch <run>               follow a run until it ends
//   node cli.mjs show <run> [report|judgement|room|criteria|files]
//   node cli.mjs grep <run> <text> [--type claim|source|check|challenge|figure]
//
// Attached files are copied into the run and placed in every agent's sandbox at /attachments, so agents
// explore them with code: traces, logs, source code, data files. Folders named .git or node_modules and
// files over 25 MB are skipped; the total is limited to 300 MB.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RUNS = path.join(ROOT, "runs");
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (k) => argv.includes(k);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODELS = { hydrogen: "gemini-4-hydrogen", neon: "gemini-4-neon", carbon: "gemini-4-carbon", argon: "gemini-4-argon" };
const SKIP_DIR = new Set([".git", "node_modules", "__pycache__", ".venv", "dist", "build", ".next"]);

function runDir(id) {
  const hit = fs.readdirSync(RUNS).filter((d) => d === id || d.endsWith(id));
  if (hit.length !== 1) { console.error(hit.length ? `"${id}" matches several runs: ${hit.join(", ")}` : `no run "${id}" (see: node cli.mjs runs)`); process.exit(1); }
  return path.join(RUNS, hit[0]);
}
const events = (dir) => (fs.existsSync(path.join(dir, "events.ndjson")) ? fs.readFileSync(path.join(dir, "events.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

function copyAttachments(sources, dest) {
  let total = 0, n = 0; const skipped = [];
  const add = (from, rel) => {
    const st = fs.statSync(from);
    if (st.isDirectory()) { if (SKIP_DIR.has(path.basename(from)) || /\.git$/.test(from)) { skipped.push(`${rel}/ (folder skipped)`); return; } for (const e of fs.readdirSync(from)) add(path.join(from, e), path.join(rel, e)); return; }
    if (!st.isFile()) return;
    if (st.size > 25_000_000) { skipped.push(`${rel} (${(st.size / 1e6).toFixed(0)} MB, over 25 MB)`); return; }
    total += st.size; n++;
    if (total > 300_000_000) { console.error("The attachments are over 300 MB in all. Attach a narrower folder."); process.exit(1); }
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, rel));
  };
  for (const s of sources) { const abs = path.resolve(s); if (!fs.existsSync(abs)) { console.error(`No such file or folder: ${s}`); process.exit(1); } add(abs, path.basename(abs)); }
  return { n, total, skipped };
}

function headline(dir) {
  const f = path.join(dir, "report.md");
  if (!fs.existsSync(f)) return null;
  const r = fs.readFileSync(f, "utf8");
  const lines = r.split("\n");
  // title, then everything up to the first long section: the judgement or bottom line and the lead paragraph
  let end = lines.findIndex((l, i) => i > 3 && /^## /.test(l) && !/^## Judgement/.test(l));
  if (end < 0 || end > 80) end = Math.min(lines.length, 60);
  return lines.slice(0, end).join("\n").trim();
}

async function watch(dir) {
  let seen = 0, lastStatus = 0, done = null;
  const c = { started: 0, completed: 0, failed: 0, searches: 0, pages: new Set(), claims: 0, sources: 0, checks: 0, figures: 0, phase: "" };
  const t0 = Date.now();
  while (!done) {
    const evs = events(dir);
    for (const e of evs.slice(seen)) {
      if (e.t === "run") console.log(`${bold(e.question)}\n${dim(`${path.basename(dir)} · ${(e.seats || []).filter((s) => s.role === "researcher" || s.role === "redteam").length} agents · ${e.mode === "free" ? "no orchestrator" : "orchestrated"} · ${e.budget_min} min budget`)}`);
      else if (e.t === "attachments") console.log(dim(`attached: ${e.files} files, ${(e.bytes / 1e6).toFixed(1)} MB, in every agent's sandbox`));
      else if (e.t === "criteria") console.log(`${dim("judged on:")}\n${e.items.map((x, i) => dim(`  ${i + 1}. ${x}`)).join("\n")}`);
      else if (e.t === "phase") { c.phase = e.name; console.log(`${dim(e.at.slice(11, 19))} ${bold(e.name)}${e.round > 1 ? ` (round ${e.round})` : ""}`); }
      else if (e.t === "turn") { if (e.status === "started") c.started++; else if (e.status === "completed") { c.completed++; c.searches += (e.searches || []).length; for (const u of e.urls || []) c.pages.add(u); } else { c.failed++; console.log(dim(`  ${e.seat} failed: ${(e.error || "").slice(0, 120)}`)); } }
      else if (e.t === "ledger") for (const r of e.rows || []) { if (r.type === "claim") c.claims++; else if (r.type === "source") c.sources++; else if (r.type === "check") c.checks++; else if (r.type === "figure") c.figures++; }
      else if (e.t === "gate") console.log(`  gate ${e.attempt}: ${e.pass ? "passed" : `refused, ${e.problems.length} open items`}`);
      else if (e.t === "review") console.log(`  review ${e.round}: ${e.ok} of ${e.voters} would sign (${Math.round(e.approval * 100)}%) · answers ${e.scores.answers}/5 · insight ${e.scores.insight}/5 · reads ${e.scores.reads}/5 · ${e.issues} issues`);
      else if (e.t === "verify") console.log(`  consistency check: ${e.checked} sentences, ${e.flagged} corrected`);
      else if (e.t === "judge") console.log(`  judge: ${e.pass ? "passed" : "not passed"}${(e.checks || []).filter((k) => !k.met).map((k) => `\n    not met: ${k.criterion.slice(0, 110)}`).join("")}`);
      else if (e.t === "terminate") console.log(`  state = terminate (${e.reason}; ${e.yes} of ${e.of} judges voted to stop)`);
      else if (e.t === "done") done = e;
    }
    seen = evs.length;
    if (!done && Date.now() - lastStatus > 30_000 && c.started) { lastStatus = Date.now(); console.log(dim(`  … ${Math.round((Date.now() - t0) / 60000)} min · ${c.completed}/${c.started} turns · ${c.searches} searches · ${c.pages.size} pages · ${c.claims} claims · ${c.sources} sources · ${c.checks} checks${c.figures ? ` · ${c.figures} figures` : ""}`)); }
    if (!done) await sleep(2000);
  }
  console.log(`\n${bold(`done: ${done.status}`)} ${dim(`${done.totals?.minutes ?? "?"} min · ${((done.totals?.tokens || 0) / 1e6).toFixed(1)}M tokens · ${c.claims} claims · ${c.sources} sources`)}\n`);
  const h = headline(dir);
  if (h) console.log(h + "\n");
  console.log(dim(`full report: ${path.join(dir, "report.md")}\nevidence:    ${path.join(dir, "ledger.jsonl")}\nin a browser: http://localhost:8899/run/${path.basename(dir)}#report`));
}

if (cmd === "ask") {
  const question = argv[1];
  if (!question || question.startsWith("--")) { console.error('usage: node cli.mjs ask "<question>" [--attach <path> ...]'); process.exit(1); }
  const d = new Date();
  const id = `r_${d.toISOString().slice(0, 16).replace(/[-:T]/g, "")}_${crypto.randomBytes(2).toString("hex")}`;
  const dir = path.join(RUNS, id);
  fs.mkdirSync(dir, { recursive: true });
  const attach = all("--attach");
  let att = null;
  if (attach.length) {
    att = copyAttachments(attach, path.join(dir, "attachments"));
    console.log(dim(`attaching ${att.n} files, ${(att.total / 1e6).toFixed(1)} MB${att.skipped.length ? `; skipped: ${att.skipped.slice(0, 6).join(", ")}${att.skipped.length > 6 ? ` and ${att.skipped.length - 6} more` : ""}` : ""}`));
    if (!att.n) { console.error("Nothing to attach after the skips."); process.exit(1); }
  }
  const model = opt("--model", "hydrogen");
  const req = {
    question,
    agents: Math.max(4, Math.min(1024, Number(opt("--agents", 16)))),
    minutes: Math.max(5, Math.min(240, Number(opt("--minutes", 30)))),
    baseline: flag("--baseline"),
    max_rounds: Math.max(1, Math.min(4, Number(opt("--rounds", 2)))),
    review_rounds: Math.max(0, Math.min(4, Number(opt("--review", 2)))),
    ...(flag("--free") ? { mode: "free" } : {}),
    ...(flag("--multimodal") || att ? { multimodal: true } : {}),
    ...(model === "mix" ? { models: ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-hydrogen", "gemini-4-carbon"] } : { seat_model: MODELS[model] || model }),
    created_at: d.toISOString(),
    private: Boolean(att),
  };
  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify(req, null, 2));
  if (att) fs.writeFileSync(path.join(dir, "private"), "a run with attached files is never exported to the public copy\n");
  const log = fs.openSync(path.join(dir, "swarm.log"), "a");
  spawn(process.execPath, [path.join(ROOT, "swarm.mjs"), "--run", id], { cwd: ROOT, stdio: ["ignore", log, log], detached: true, env: process.env }).unref();
  if (flag("--detach")) { console.log(`started ${id}\nfollow it:  node cli.mjs watch ${id}`); process.exit(0); }
  await watch(dir);
} else if (cmd === "runs") {
  const rows = fs.readdirSync(RUNS).filter((d) => /^r_/.test(d) && fs.existsSync(path.join(RUNS, d, "request.json"))).sort().reverse().slice(0, Number(opt("--n", 30)));
  for (const d of rows) {
    const req = JSON.parse(fs.readFileSync(path.join(RUNS, d, "request.json"), "utf8"));
    const evs = events(path.join(RUNS, d));
    const done = evs.filter((e) => e.t === "done").pop();
    console.log(`${d}  ${(done ? done.status : evs.length ? "running" : "starting").padEnd(8)} ${String(req.agents || 8).padStart(4)} agents  ${fs.existsSync(path.join(RUNS, d, "attachments")) ? "+files " : "       "}${req.question.replace(/\s+/g, " ").slice(0, 80)}`);
  }
} else if (cmd === "watch") {
  await watch(runDir(argv[1]));
} else if (cmd === "show") {
  const dir = runDir(argv[1]);
  const what = argv[2] || "report";
  if (what === "report") console.log(fs.readFileSync(path.join(dir, "report.md"), "utf8"));
  else if (what === "judgement") console.log(fs.existsSync(path.join(dir, "judgement.md")) ? fs.readFileSync(path.join(dir, "judgement.md"), "utf8") : headline(dir));
  else if (what === "criteria") console.log(JSON.parse(fs.readFileSync(path.join(dir, "criteria.json"), "utf8")).map((x, i) => `${i + 1}. ${x}`).join("\n"));
  else if (what === "room") for (const e of events(dir)) { if (e.t === "msg") console.log(`${dim(e.at.slice(11, 19))} ${bold(e.seat)} ${e.text}`); }
  else if (what === "files") { const a = path.join(dir, "attachments"); const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(a, path.join(d, e.name))])); console.log(fs.existsSync(a) ? walk(a).join("\n") : "(no attached files)"); }
  else console.error("show: report | judgement | room | criteria | files");
} else if (cmd === "grep") {
  const dir = runDir(argv[1]);
  const needle = String(argv[2] || "").toLowerCase();
  const type = opt("--type", null);
  const rows = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) {
    if (type && r.type !== type) continue;
    const text = JSON.stringify(r);
    if (!text.toLowerCase().includes(needle)) continue;
    if (r.type === "claim") console.log(`${bold(r.id)} ${dim(`claim by ${r.by}${r.key ? ", key" : ""}${r.as_of ? `, as of ${r.as_of}` : ""}`)}\n  ${r.text}`);
    else if (r.type === "source") console.log(`${bold(r.id)} ${dim(`source for ${r.claim} · ${r.publisher || ""} · ${r.url}`)}\n  "${r.quote}"`);
    else console.log(`${bold(r.id || r.type)} ${dim(`${r.type} by ${r.by}`)}\n  ${(r.text || r.note || r.title || "").slice(0, 400)}`);
  }
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
