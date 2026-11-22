#!/usr/bin/env node
// A Gemini Managed Agent as a seat of `sharednet goal run`.
//
// goal run drives a Gemini seat by running the Gemini CLI in the seat's container:
//   gemini --approval-mode yolo --output-format stream-json [--model M] [--resume <uuid>] --prompt <text>
// and reads its JSON event stream. This program stands where that CLI stands (same name, same flags, same
// events), so goal run is unchanged. The agent itself is a Managed Agent: its loop, tools and sandbox run on
// Google's side, and this process only carries things across, which is why a seat costs this machine almost
// nothing. One turn:
//   1. the shared workspace (and the Room so far) is copied into the agent's remote sandbox, at /workspace;
//   2. the agent takes its turn there, with the prompt goal run wrote;
//   3. what it changed under /workspace is copied back, and the lines it wants said are said in the Room.
// The agent cannot run `sharednet` itself: it writes its Room lines in a ~~~~room block, and this process
// says them. Files travel both ways by themselves; a ~~~~file or ~~~~append block is a second way to send one.
//
//   GEMINI_API_KEY            the key (goal run passes it to a gemini seat)
//   MANAGED_SEAT_AGENT        the agent id (default antigravity-preview-09-2026)
//   MANAGED_SEAT_TURN_MIN     how long one turn may take, minutes (default 45)
//   MANAGED_SEAT_MOCK=1       no API: a stand-in agent, to rehearse a run's mechanics
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const VERSION = "0.70.0-managed-seat.1";
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) { console.log(VERSION); process.exit(0); }
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const prompt = flag("--prompt") ?? flag("-p");
const model = flag("--model") || "gemini-4-hydrogen";
const resume = flag("--resume");
const MOCK = process.env.MANAGED_SEAT_MOCK === "1";
const AGENT = process.env.MANAGED_SEAT_AGENT || "antigravity-preview-09-2026";
const TURN_MS = Number(process.env.MANAGED_SEAT_TURN_MIN || 45) * 60_000;
const WS = process.cwd();
const STATE_DIR = path.join(os.homedir(), ".managed-seat");
const say = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// What the agent is told once, and the same on every turn (the API wants a seat's system text to stay the same).
const PROTOCOL = `You are one seat of a team that works in a SharedNet Room. You run in your own remote sandbox, and a bridge connects you to the team. How that changes what your instructions say:

THE SHARED WORKSPACE is at /workspace in your sandbox. It is a copy, refreshed at the start of each of your turns with what your teammates changed. Work in it normally: read, run code, create and edit files, append to files. When your turn ends, the files you changed under /workspace are copied back to the team's workspace. Files that end in .jsonl are merged line by line, so appending rows is always safe; for any other file your version replaces the team's, so change only the files that are yours to change, and re-read a shared file before you edit it.

THE ROOM. You cannot run the sharednet command. Where your instructions say to use "sharednet say", write the lines you want said in a block like this, anywhere in your final answer, one Room message per line:
~~~~room
@teammate-3 the price table is in deliverables/prices.md; please cross-check row 4
~~~~
Where they say "sharednet read", read /workspace/.room/transcript.md instead: it holds the Room so far, oldest first, and is refreshed every turn. A message with no @name wakes nobody. A line that says only DONE is a completion claim: write it only when your instructions say you may.

SENDING A FILE EXPLICITLY. If you want to be certain a file reaches the team, you may also put it in your final answer:
~~~~file path=deliverables/report.md
(the whole file)
~~~~
~~~~append path=deliverables/ledger.jsonl
{"type":"claim","id":"C1-1"}
~~~~
Paths are relative to /workspace. Use four tildes exactly as shown.

Your turn ends when you give your final answer. You are woken again when a teammate names you or something is addressed to you; do not wait or poll. Everything else in your instructions applies as written.`;

// ------------------------------------------------------------------ the workspace, as a set of files
const SKIP_DIRS = new Set([".sharednet", ".git", ".gate", "node_modules", ".room", "__pycache__"]);
const MAX_FILE = 4_000_000, MAX_TOTAL = 60_000_000;
function walk(root) {
  const out = new Map();
  let total = 0;
  const go = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) go(path.join(dir, e.name), r); continue; }
      if (!e.isFile()) continue;
      let buf;
      try { const st = fs.statSync(path.join(dir, e.name)); if (st.size > MAX_FILE || total + st.size > MAX_TOTAL) continue; buf = fs.readFileSync(path.join(dir, e.name)); } catch { continue; }
      total += buf.length;
      out.set(r, buf);
    }
  };
  go(root, "");
  return out;
}
const safeRel = (p) => {
  const rel = path.posix.normalize(String(p || "").replace(/\\/g, "/")).replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/^workspace\//, "");
  if (!rel || rel.startsWith("..") || rel.split("/").some((seg) => SKIP_DIRS.has(seg))) return null;
  return rel;
};

function roomTranscript() {
  try {
    const raw = execFileSync("sharednet", ["read", "--last", "200", "--json"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
    const j = JSON.parse(raw);
    const list = Array.isArray(j) ? j : j.messages || j.items || [];
    const lines = list.map((m) => `#${m.sequence ?? m.seq ?? ""} [${(m.sender && (m.sender.name || m.sender.id)) || m.from || "?"}] ${String(m.content ?? m.text ?? "").replace(/\n/g, "\n    ")}`);
    return lines.length ? lines.join("\n") + "\n" : raw;
  } catch { return null; }
}

// A tar.gz of name -> bytes, written by the system tar so the format is exactly what the API unpacks.
function tarball(files) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "managed-seat-"));
  try {
    for (const [rel, buf] of files) { const f = path.join(stage, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); }
    return execFileSync("tar", ["-czf", "-", "-C", stage, "."], { maxBuffer: 256 * 1024 * 1024 });
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ the remote side: the real API, or a stand-in
const transient = (e) => /\b429\b|\b5\d\d\b|quota|rate|unavailable|overloaded|resource.?exhausted|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(e?.message || e));
const rateLimited = (e) => /\b429\b|rate limit|resource.?exhausted|quota/i.test(String(e?.message || e));
async function patient(what, fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      // every seat is its own process, so each waits out a rate limit by itself, spread apart by chance
      if (rateLimited(e) && i < 90) { const m = String(e?.message || e).match(/retry in (\d+)s/i); await sleep(((m ? Number(m[1]) : 20) + Math.random() * 40) * 1000); continue; }
      if (transient(e) && i < 6) { await sleep(Math.min(60_000, 4000 * 2 ** i) * (0.6 + Math.random() * 0.8)); continue; }
      throw new Error(`${what}: ${String(e?.message || e).slice(0, 300)}`);
    }
  }
}

function realRemote() {
  const require = createRequire(import.meta.url);
  let sdk;
  for (const from of [process.env.MANAGED_SEAT_SDK, "/opt/managed-seat/node_modules/@google/genai", "@google/genai"].filter(Boolean)) { try { sdk = require(from); break; } catch {} }
  if (!sdk) throw new Error("the @google/genai package is not installed where this seat can load it");
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const ai = new sdk.GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1beta" } });
  const textOf = (it) => {
    if (it.output_text) return it.output_text;
    const parts = [];
    for (const s of it.steps || []) if (s.type === "model_output") for (const c of s.content || []) if (c.type === "text" && c.text) parts.push(c.text);
    if (!parts.length) for (const o of it.outputs || []) if (o.text) parts.push(o.text);
    return parts.join("\n");
  };
  return {
    async create() { return (await patient("could not create the sandbox", () => ai.environments.create({}))).id; },
    async upload(env, bytes) {
      await patient("could not copy the workspace into the sandbox", () => ai.environments.files.upload({ environment: env, path: "workspace", file: new Blob([bytes], { type: "application/gzip" }), mime_type: "application/gzip", extract: true, overwrite: true }));
    },
    async list(env) {
      const out = new Map();
      let page_token;
      for (let n = 0; n < 200; n++) {
        const r = await patient("could not list the sandbox", () => ai.environments.files.list({ environment: env, path: "workspace", recursive: true, page_size: 1000, ...(page_token ? { page_token } : {}) }));
        for (const f of r.files || []) if (f.path && String(f.type || "").toLowerCase() !== "directory") out.set(String(f.path).replace(/^\/?workspace\//, ""), `${f.size_bytes ?? ""}|${f.modified ?? ""}`);
        page_token = r.next_page_token || r.nextPageToken;
        if (!page_token) break;
      }
      return out;
    },
    async download(env, rel) { return Buffer.from(await patient(`could not fetch ${rel}`, () => ai.environments.files.download({ environment: env, path: `workspace/${rel}` }))); },
    async turn(env, previous, input) {
      const req = { input, system_instruction: PROTOCOL, background: true, store: true, agent: AGENT, agent_config: { type: "antigravity", model }, environment: env, ...(previous ? { previous_interaction_id: previous } : {}) };
      let it = await patient("the agent could not be started", () => ai.interactions.create(req));
      const t0 = Date.now();
      let delay = 3000;
      while (["in_progress", "queued"].includes(it.status)) {
        if (Date.now() - t0 > TURN_MS) { try { await ai.interactions.cancel(it.id); } catch {} throw new Error(`the agent's turn passed ${Math.round(TURN_MS / 60000)} minutes`); }
        await sleep(delay); delay = Math.min(delay * 1.3, 10_000);
        try { it = await ai.interactions.get(it.id); } catch (e) { if (!transient(e)) throw e; }
      }
      if (!["completed", "incomplete", "budget_exceeded"].includes(it.status)) throw new Error(`the agent's turn ended as ${it.status}: ${(it.errors || []).map((e) => e.message || JSON.stringify(e)).join("; ").slice(0, 300)}`);
      const u = it.usage || {};
      const tools = (it.steps || []).filter((s) => /_call$/.test(s.type || "")).map((s) => s.type.replace(/_call$/, ""));
      return { id: it.id, env: it.environment_id || env, text: textOf(it), tools, usage: { input: u.total_input_tokens || 0, cached: u.total_cached_tokens || 0, output: u.total_output_tokens || 0, total: u.total_tokens || 0 } };
    },
  };
}

// The stand-in: a folder plays the remote sandbox and a few lines play the agent. It writes a part file, appends
// a ledger row and speaks in the Room, so a whole run (wakes, the red-team gate, the stop) can be rehearsed.
function mockRemote(state) {
  const root = path.join(STATE_DIR, "mock-sandbox");
  const all = () => walk(root);
  return {
    async create() { fs.mkdirSync(root, { recursive: true }); return "mock-env"; },
    async upload(env, bytes) { fs.mkdirSync(root, { recursive: true }); execFileSync("tar", ["-xzf", "-", "-C", root], { input: bytes }); },
    async list() { const out = new Map(); for (const [rel, buf] of all()) out.set(rel, `${buf.length}|${sha(buf).slice(0, 12)}`); return out; },
    async download(env, rel) { return fs.readFileSync(path.join(root, rel)); },
    async turn(env, previous, input) {
      await sleep(1500 + Math.random() * 4000);
      const me = state.name || "seat";
      const red = (process.env.MANAGED_SEAT_MOCK_RED || "").split(",").map((x) => x.trim()).filter(Boolean);
      const n = (state.turns || 0) + 1;
      const ledger = path.join(root, "deliverables", "ledger.jsonl");
      fs.mkdirSync(path.dirname(ledger), { recursive: true });
      let rows = 0;
      try { rows = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length; } catch {}
      let room;
      if (red.includes(me)) {
        const need = Number(process.env.MANAGED_SEAT_MOCK_DONE_AT || 8);
        fs.appendFileSync(ledger, JSON.stringify({ type: "check", source: `S${n}`, result: "confirmed", by: me }) + "\n");
        room = rows >= need ? "DONE" : `${me}: ${rows} ledger rows so far, ${need} wanted before the work can be signed off`;
      } else {
        const id = me.replace(/\D+/g, "") || "0";
        fs.appendFileSync(ledger, JSON.stringify({ type: "claim", id: `C${id}-${n}`, text: `mock finding ${n} of ${me}`, by: me }) + "\n");
        fs.writeFileSync(path.join(root, "deliverables", `part-${me}.md`), `# Part of ${me}\n\nTurn ${n}.\n`);
        room = n === 1 && red.length ? `@${red[Number(id) % red.length]} the part of ${me} is ready in deliverables/part-${me}.md` : `${me}: turn ${n} done`;
      }
      return { id: `mock-${crypto.randomUUID()}`, env, text: `Done.\n~~~~room\n${room}\n~~~~\n`, tools: ["shell"], usage: { input: 1000, cached: 0, output: 200, total: 1200 } };
    },
  };
}

// ------------------------------------------------------------------ one turn
function blocks(text) {
  const out = [];
  const re = /^(~~~~|````)(room|file|append)([^\n]*)\n([\s\S]*?)\n?^\1[ \t]*$/gm;
  for (const m of String(text || "").matchAll(re)) out.push({ kind: m[2], path: (m[3].match(/path=["']?([^\s"']+)/) || [])[1] || null, body: m[4] });
  // a plain ```room fence is accepted too: agents reach for three backticks by habit
  for (const m of String(text || "").matchAll(/^```room[ \t]*\n([\s\S]*?)\n?^```[ \t]*$/gm)) out.push({ kind: "room", path: null, body: m[1] });
  return out;
}
function writeBack(rel, buf, snapshot, notes) {
  const target = path.join(WS, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (rel.endsWith(".jsonl")) {
    // rows are merged, never replaced: other seats append to the same file while this one works
    let have = "";
    try { have = fs.readFileSync(target, "utf8"); } catch {}
    const known = new Set(have.split("\n").map((l) => l.trim()).filter(Boolean));
    const fresh = buf.toString("utf8").split("\n").map((l) => l.trim()).filter((l) => l && !known.has(l));
    if (!fresh.length) return false;
    fs.appendFileSync(target, (have && !have.endsWith("\n") ? "\n" : "") + fresh.join("\n") + "\n");
    notes.push(`${rel} (+${fresh.length} row${fresh.length === 1 ? "" : "s"})`);
    return true;
  }
  let now = null;
  try { now = fs.readFileSync(target); } catch {}
  if (now && now.equals(buf)) return false;
  const given = snapshot.get(rel);
  if (now && given && sha(now) !== given) {
    // a teammate changed this file while the agent worked on its copy: the teammate's version is kept beside it
    const keep = path.join(WS, "notes", ".replaced", `${rel.replace(/\//g, "__")}.${Date.now()}`);
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.writeFileSync(keep, now);
    notes.push(`${rel} (it had changed meanwhile; the version it replaced is in notes/.replaced/)`);
  } else notes.push(rel);
  fs.writeFileSync(target, buf);
  return true;
}

async function main() {
  if (prompt == null) throw new Error("no --prompt was given");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const session = resume || crypto.randomUUID();
  const stateFile = path.join(STATE_DIR, `${session}.json`);
  let state = {};
  if (resume) { try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { throw new Error(`there is no session ${resume} to resume`); } }
  const named = String(prompt).match(/^You are ([A-Za-z0-9_-]+),/m);
  if (named && !state.name) state.name = named[1];
  say({ type: "init", session_id: session, model });

  const remote = MOCK ? mockRemote(state) : realRemote();
  if (!state.env) state.env = await remote.create();

  // 1. the workspace and the Room, into the sandbox (only what changed since this seat's last turn)
  const local = walk(WS);
  const transcript = roomTranscript();
  if (transcript != null) local.set(".room/transcript.md", Buffer.from(transcript));
  const sent = state.sent || {};
  const changed = new Map([...local].filter(([rel, buf]) => sent[rel] !== sha(buf)));
  const snapshot = new Map([...local].map(([rel, buf]) => [rel, sha(buf)]));
  if (changed.size) await remote.upload(state.env, tarball(changed));
  state.sent = Object.fromEntries(snapshot);
  let before = new Map();
  try { before = await remote.list(state.env); } catch {}

  // 2. the agent's turn
  const news = [...changed.keys()].filter((r) => r !== ".room/transcript.md");
  const header = [
    state.turns ? `[bridge] /workspace was refreshed. ${news.length ? `Changed by the team since your last turn: ${news.slice(0, 40).join(", ")}${news.length > 40 ? `, and ${news.length - 40} more` : ""}.` : "No file changed since your last turn."}` : `[bridge] The shared workspace is at /workspace (${local.size} files) and the Room so far is in /workspace/.room/transcript.md.`,
    state.back?.length ? `[bridge] Copied back from your sandbox after your last turn: ${state.back.join(", ")}.` : state.turns ? "[bridge] Nothing was copied back from your sandbox after your last turn." : "",
    state.said != null && state.turns ? `[bridge] Room lines said for you last turn: ${state.said}.` : "",
  ].filter(Boolean).join("\n");
  const res = await remote.turn(state.env, state.interaction || null, `${header}\n\n${prompt}`);
  state.interaction = res.id; state.env = res.env || state.env;

  // 3. back: files the agent changed in its sandbox, then explicit blocks, then its Room lines
  const notes = [];
  try {
    const after = await remote.list(state.env);
    for (const [rel, stamp] of after) {
      if (before.get(rel) === stamp) continue;
      const safe = safeRel(rel);
      if (!safe) continue;
      const buf = await remote.download(state.env, rel);
      if (buf.length > MAX_FILE) { notes.push(`${safe} was not copied: larger than ${MAX_FILE / 1e6} MB`); continue; }
      if (writeBack(safe, buf, snapshot, notes)) state.sent[safe] = sha(fs.readFileSync(path.join(WS, safe)));
    }
  } catch (e) { notes.push(`the sandbox could not be read back (${String(e.message || e).slice(0, 120)}); only files sent in ~~~~file blocks arrived`); }
  let said = 0;
  for (const b of blocks(res.text)) {
    if (b.kind === "room") {
      for (const line of b.body.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12)) {
        try { execFileSync("sharednet", ["say", line.slice(0, 4000), "--json"], { timeout: 60_000, stdio: ["ignore", "ignore", "pipe"] }); said++; }
        catch (e) { notes.push(`a Room line could not be said (${String(e.stderr || e.message || e).slice(0, 100)})`); }
      }
    } else {
      const rel = safeRel(b.path);
      if (!rel) { notes.push(`a ${b.kind} block had no usable path`); continue; }
      if (b.kind === "append") { const target = path.join(WS, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); let have = ""; try { have = fs.readFileSync(target, "utf8"); } catch {} fs.appendFileSync(target, (have && !have.endsWith("\n") ? "\n" : "") + b.body.replace(/\n*$/, "\n")); notes.push(`${rel} (appended)`); }
      else writeBack(rel, Buffer.from(b.body.replace(/\n*$/, "\n")), snapshot, notes);
    }
  }
  state.back = notes; state.said = said; state.turns = (state.turns || 0) + 1;
  fs.writeFileSync(stateFile, JSON.stringify(state));

  // what goal run reads: the tools used, the answer, and the spend
  res.tools.slice(0, 200).forEach((name, i) => { const id = `t${i + 1}`; say({ type: "tool_use", tool_name: name, tool_id: id, parameters: {} }); say({ type: "tool_result", tool_id: id, status: "success" }); });
  say({ type: "message", role: "assistant", content: res.text || "" });
  const promptTokens = Math.max(res.usage.input, 0), cached = Math.min(Math.max(res.usage.cached, 0), promptTokens), output = Math.max(res.usage.output, 0);
  say({ type: "result", status: "success", stats: { input: promptTokens - cached, cached, input_tokens: promptTokens, output_tokens: output, total_tokens: Math.max(res.usage.total, promptTokens + output) } });
}

main().then(() => process.exit(0)).catch((e) => {
  say({ type: "error", severity: "error", message: String(e?.message || e).slice(0, 500) });
  process.stderr.write(String(e?.stack || e) + "\n");
  process.exit(1);
});
