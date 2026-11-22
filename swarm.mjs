// Prometheus on Gemini: a deep-research swarm of Gemini Managed Agents.
// Usage: node swarm.mjs --run <runId>   (reads runs/<runId>/request.json)
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const AGENT_ID = process.env.SWARM_AGENT || "antigravity-preview-09-2026";
const AGENT_FALLBACK = "antigravity-preview-05-2026";
let SEAT_MODEL = process.env.SWARM_SEAT_MODEL || "gemini-4-hydrogen";
const LEAD_MODEL = process.env.SWARM_LEAD_MODEL || "gemini-4-argon";
const BASELINE_AGENT = process.env.SWARM_BASELINE || "deep-research-max-preview-04-2026";
const MOCK = process.env.MOCK === "1";
const TURN_TIMEOUT_MS = Number(process.env.SWARM_TURN_TIMEOUT_MS || 12 * 60_000);

// claim tags: [C1-2] or [C1-2, C3-4]
const TAG_RE = /\[((?:C\d+-\d+)(?:\s*[,;]\s*C\d+-\d+)*)\]/g;
const tagsIn = (text) => [...new Set([...String(text).matchAll(TAG_RE)].flatMap((m) => m[1].split(/\s*[,;]\s*/)))];
const stripTags = (text) => String(text).replace(/\s*\[(?:C\d+-\d+)(?:\s*[,;]\s*C\d+-\d+)*\]/g, "");
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const f = path.join(os.homedir(), ".config/gemini/api_key");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  return null;
}

// ---------------------------------------------------------------- run state
class Run {
  constructor(id) {
    this.id = id;
    this.dir = path.join(ROOT, "runs", id);
    this.req = JSON.parse(fs.readFileSync(path.join(this.dir, "request.json"), "utf8"));
    this.rows = []; // ledger rows in order
    this.room = []; // {seat,text,at}
    this.totals = { tokens: 0, searches: 0, urls_opened: 0, turns: 0 };
    this.started = Date.now();
    this.deadline = this.started + (this.req.minutes || 30) * 60_000;
  }
  emit(ev) {
    ev.at ??= now();
    fs.appendFileSync(path.join(this.dir, "events.ndjson"), JSON.stringify(ev) + "\n");
  }
  say(seat, text) {
    const m = { seat, text, at: now() };
    this.room.push(m);
    this.emit({ t: "msg", ...m });
  }
  addRows(seat, rows, rejected = []) {
    if (!rows.length && !rejected.length) return;
    for (const r of rows) {
      this.rows.push(r);
      fs.appendFileSync(path.join(this.dir, "ledger.jsonl"), JSON.stringify(r) + "\n");
    }
    this.emit({ t: "ledger", seat, rows, rejected });
  }
  minutesLeft() {
    return (this.deadline - Date.now()) / 60_000;
  }
  // latest-wins views
  view() {
    const byId = (type) => {
      const m = new Map();
      for (const r of this.rows) if (r.type === type && r.id) m.set(r.id, r);
      return m;
    };
    const claims = byId("claim");
    const sources = byId("source");
    const questions = byId("question");
    const challenges = byId("challenge");
    const answers = new Map();
    for (const r of this.rows) if (r.type === "answer" && r.question) answers.set(r.question, r);
    const checks = this.rows.filter((r) => r.type === "check");
    const resolutions = new Map();
    for (const r of this.rows) if (r.type === "resolution" && r.challenge) resolutions.set(r.challenge, r);
    const notFound = this.rows.filter((r) => r.type === "not_found");
    const kept = (r) => r && r.status !== "dropped";
    const keyClaims = [...claims.values()].filter((c) => kept(c) && c.key);
    const sourcesOf = (cid) => [...sources.values()].filter((s) => s.claim === cid && kept(s));
    const checksOf = (sid) => checks.filter((k) => k.source === sid);
    const openChallenges = [...challenges.values()].filter((x) => !resolutions.has(x.id));
    return { claims, sources, questions, challenges, answers, checks, resolutions, notFound, keyClaims, sourcesOf, checksOf, openChallenges, kept };
  }
}

// ---------------------------------------------------------------- Gemini calls
let client = null;
function gem() {
  if (!client) {
    const key = apiKey();
    if (!key) throw new Error("No Gemini API key: set GEMINI_API_KEY or write ~/.config/gemini/api_key");
    client = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1beta" } });
  }
  return client;
}

function digestSteps(it) {
  const searches = [];
  const urls = [];
  for (const s of it.steps || []) {
    if (s.type === "google_search_call") searches.push(...(s.arguments?.queries || []));
    if (s.type === "url_context_call") urls.push(...(s.arguments?.urls || []));
  }
  const u = it.usage || {};
  const tokens =
    u.total_tokens ??
    (u.total_input_tokens || 0) + (u.total_output_tokens || 0) + (u.total_thought_tokens || 0) + (u.total_tool_use_tokens || 0);
  return { searches, urls, tokens: tokens || 0 };
}

function outputText(it) {
  if (it.output_text) return it.output_text;
  const parts = [];
  for (const s of it.steps || []) {
    if (s.type === "model_output") for (const c of s.content || []) if (c.type === "text" && c.text) parts.push(c.text);
  }
  if (parts.length) return parts.join("\n");
  for (const o of it.outputs || []) if (o.text) parts.push(o.text);
  return parts.join("\n");
}

async function waitFor(it, timeoutMs) {
  const t0 = Date.now();
  let delay = 3000;
  while (["in_progress", "queued"].includes(it.status)) {
    if (Date.now() - t0 > timeoutMs) {
      try { await gem().interactions.cancel(it.id); } catch {}
      throw new Error(`timed out after ${Math.round(timeoutMs / 60000)} min`);
    }
    await sleep(delay);
    delay = Math.min(delay * 1.3, 10000);
    try { it = await gem().interactions.get(it.id); } catch (e) { if (!transient(e)) throw e; }
  }
  if (!["completed", "incomplete", "budget_exceeded"].includes(it.status)) {
    const err = (it.errors || []).map((e) => e.message || JSON.stringify(e)).join("; ");
    throw new Error(`interaction ${it.status}${err ? ": " + err : ""}`);
  }
  return it;
}

// at most SWARM_CONCURRENCY interactions run at once; the rest queue
let LIMIT = Number(process.env.SWARM_CONCURRENCY || 64);
let active = 0;
const waiting = [];
async function slot(fn) {
  while (active >= LIMIT) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}
const transient = (e) => /\b429\b|\b5\d\d\b|quota|rate|unavailable|overloaded|resource.?exhausted|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(e?.message || e));
const backoff = (i) => sleep(Math.min(60_000, 4000 * 2 ** i) * (0.6 + Math.random() * 0.8));
const rateLimited = (e) => /\b429\b|rate limit|resource.?exhausted|quota/i.test(String(e?.message || e));
let rateWaits = 0;
async function rateWait(e) {
  rateWaits++;
  const m = String(e?.message || e).match(/retry in (\d+)s/i);
  await sleep(((m ? Number(m[1]) : 20) + Math.random() * 30) * 1000);
}

let agentId = AGENT_ID;
let useAgentConfig = true;
async function createWithFallbacks(req) {
  const tries = [];
  const attempt = async () => { const { fell_back, ...body } = req; return gem().interactions.create({ ...body, agent: agentId, ...(useAgentConfig ? {} : { agent_config: undefined }) }); };
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt();
    } catch (e) {
      const msg = String(e?.message || e);
      tries.push(msg.slice(0, 200));
      if (!/\b4\d\d\b|invalid|not found|unsupported/i.test(msg) || /\b429\b|quota|rate/i.test(msg)) throw e;
      if (req.agent_config?.model && req.agent_config.model !== "gemini-4-hydrogen" && /model|agent_config|config/i.test(msg)) { req.agent_config = { ...req.agent_config, model: "gemini-4-hydrogen" }; req.fell_back = true; continue; }
      if (useAgentConfig && /model|agent_config|config/i.test(msg)) { useAgentConfig = false; continue; }
      if (agentId !== AGENT_FALLBACK) { agentId = AGENT_FALLBACK; continue; }
      if (useAgentConfig) { useAgentConfig = false; continue; }
      throw e;
    }
  }
  throw new Error("create failed: " + tries.join(" / "));
}

async function agentTurn(seat, input, system, timeoutMs = TURN_TIMEOUT_MS) {
  return slot(() => agentTurnNow(seat, input, system, timeoutMs));
}
async function agentTurnNow(seat, input, system, timeoutMs) {
  if (MOCK) return mockTurn(seat, input);
  const req = {
    input,
    system_instruction: system,
    background: true,
    store: true,
    agent_config: { type: "antigravity", model: seat.model },
    environment: seat.env || "remote",
  };
  if (seat.prev) req.previous_interaction_id = seat.prev;
  let it;
  for (let i = 0; ; i++) {
    try { it = await createWithFallbacks(req); break; }
    catch (e) {
      if (rateLimited(e) && i < 60) { await rateWait(e); continue; }
      if (i < 6 && transient(e)) { await backoff(i); continue; }
      throw e;
    }
  }
  it = await waitFor(it, timeoutMs);
  seat.prev = it.id;
  if (it.environment_id) seat.env = it.environment_id;
  return { text: outputText(it), id: it.id, ...digestSteps(it) };
}

async function modelCall(input, system, model = LEAD_MODEL, timeoutMs = 8 * 60_000) {
  return slot(() => modelCallNow(input, system, model, timeoutMs));
}
async function modelCallNow(input, system, model, timeoutMs) {
  if (MOCK) return mockModel(input, system);
  let it;
  for (let i = 0; ; i++) {
    try {
      it = await gem().interactions.create({ model, input, system_instruction: system, background: true, store: true });
      break;
    } catch (e) {
      const msg = String(e?.message || e);
      if (i === 0 && /background/i.test(msg)) {
        it = await gem().interactions.create({ model, input, system_instruction: system });
        break;
      }
      if (rateLimited(e) && i < 60) { await rateWait(e); continue; }
      if (i < 6 && transient(e)) { await backoff(i); continue; }
      throw e;
    }
  }
  it = await waitFor(it, timeoutMs);
  return { text: outputText(it), id: it.id, ...digestSteps(it) };
}

// ---------------------------------------------------------------- parsing
function blocks(text, lang) {
  const out = [];
  const re = new RegExp("```" + lang + "[^\\n]*\\n([\\s\\S]*?)```", "g");
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out.join("\n");
}

let renameN = 0;
const TYPES = new Set(["question", "claim", "source", "answer", "not_found", "check", "challenge", "resolution"]);
function parseLedger(seat, text) {
  const raw = blocks(text, "ledger") || blocks(text, "jsonl");
  const rows = [];
  const rejected = [];
  const n = seat.id.replace(/^[A-Z]+/, "");
  const own = seat.role === "redteam" ? [`X${n}-`, `S${seat.id}-`] : [`C${n}-`, `S${n}-`, `Q${n}-`];
  for (const line of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let r;
    try { r = JSON.parse(line); } catch { rejected.push({ row: line.slice(0, 200), why: "not valid JSON" }); continue; }
    if (!r || !TYPES.has(r.type)) { rejected.push({ row: r, why: "unknown type" }); continue; }
    // a cross-checker that reuses someone else's source id gets a fresh id of its own instead of a rejection
    if (r.type === "source" && r.id && !own.some((p) => r.id.startsWith(p)) && r.status !== "dropped") {
      r.renamed_from = r.id;
      r.id = `${own[1]}x${++renameN}`;
    }
    if (r.id && ["claim", "source", "question", "challenge"].includes(r.type) && !own.some((p) => r.id.startsWith(p))) {
      rejected.push({ row: r, why: `id must start with ${own.join(" or ")}` });
      continue;
    }
    const dropping = r.status === "dropped";
    if (r.type === "source" && !dropping && !/^https?:\/\//.test(r.url || "")) { rejected.push({ row: r, why: "source needs an http(s) url" }); continue; }
    if (r.type === "source" && !dropping && !(r.quote || "").trim()) { rejected.push({ row: r, why: "source needs an exact quote" }); continue; }
    r.by = seat.id;
    r.at = now();
    rows.push(r);
  }
  return { rows, rejected };
}

function parseRoom(text) {
  return blocks(text, "room").split("\n").map((l) => l.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- prompts
const SWEEP = ` If the question is about a specific organisation, product or person, the FIRST branch or the first sub-questions are a full sweep of its own footprint, one surface per sub-question: every page of its own site (sitemap.xml, robots.txt, likely paths such as /privacy /terms /careers /jobs /about /blog /docs /pricing /security), every subdomain (certificate-transparency listings such as crt.sh, the app or login host, the trust centre, the status page, the docs host) with the same paths tried on each, the page source and scripts of its app and login pages, its legal and trust documents (privacy policy, terms, subprocessor list), its job postings on its own site and on hiring platforms, its code and model repositories, company and visa filings, and archived copies of all of these.`;
const STALE_DAYS = Number(process.env.SWARM_STALE_DAYS || 60);
const today = () => new Date().toISOString().slice(0, 10);

function protocol(run, seat) {
  const n = seat.id.replace(/^[A-Z]+/, "");
  const R = run.seats.filter((s) => s.role === "researcher");
  const X = run.seats.filter((s) => s.role === "redteam");
  let team = `${R.length} researchers (R1-R${R.length}) and ${X.length} red-team agents (X1-X${X.length})`;
  if (seat.branch && run.branches?.length > 1) {
    const b = run.branches.find((b) => b.id === seat.branch);
    const mates = R.filter((r) => r.branch === seat.branch).map((r) => r.id);
    team += `, split into ${run.branches.length} branches. Your branch is ${b.id} "${b.title}" with ${mates.join(", ")}`;
  }
  const ids =
    seat.role === "redteam"
      ? `Your challenge ids start with X${n}- (X${n}-1, X${n}-2, ...). check rows have no id. If you add a source, its id starts with S${seat.id}-.`
      : `Your ids start with your number: claims C${n}-1, C${n}-2...; sources S${n}-1...; extra questions Q${n}-1.... You may add sources to another seat's claim (set "claim" to their id) but the source id stays yours.`;
  if (run.free) team += `. Nobody assigns work and nobody tells you what to do next: you decide. Everyone shares one message board and one evidence ledger. You work in a loop: each turn you see what is new on the board and in the ledger, do one piece of work, post, and come back. You keep going until the red-team judges vote to stop`;
  return `You are ${seat.id}, a ${seat.role === "redteam" && run.free ? "red-team judge" : seat.role} in a deep-research team of Gemini agents working on ONE question together. Team: ${team}. Today is ${today()} (UTC).
You have your own sandbox with Google Search and page reading (url_context). Search widely, open pages and read them in full, prefer primary sources (official pages, filings, statistics, papers, original reporting) over write-ups of them. Never answer from memory.

Every finding goes into the shared evidence ledger. End EVERY reply with exactly two fenced blocks:

\`\`\`room
${run.free ? "one message per line; EVERYONE reads the board. Say what you are taking (start the line with TAKING:), what you found that others should know, ask for help, answer others. Use @R7 to address someone" : "@R2 one message per line to a teammate (they only see messages that @ them; @all reaches everyone)"}
\`\`\`
\`\`\`ledger
{"type":"claim","id":"C${n}-1","text":"...","key":true,"status":"kept","kind":"state","as_of":"YYYY-MM-DD"}
{"type":"source","id":"S${n}-1","claim":"C${n}-1","url":"https://...","title":"...","publisher":"original publisher (for a reprint, the original outlet)","quote":"10-40 words copied EXACTLY from the page","stance":"agrees","published":"YYYY-MM-DD","retrieved":"${today()}"}
\`\`\`
One JSON object per line. Row types: question {id,text,parent}, claim {id,text,key,status,single_source,kind,as_of,rechecked}, source {id,claim,url,title,publisher,quote,stance,published,retrieved}, answer {question,status:"answered"|"abandoned",text,claims:[ids]}, not_found {text,searched}, check {source,result:"confirmed"|"wrong"|"unreachable",note}, challenge {id,claim,to,text}, resolution {challenge,text}.
${ids}
Rules:
- quote is copied character-for-character from the page you opened. The system re-opens pages and searches for the quote; a quote it cannot find fails the whole submission.
- The subject's own pages come first. When the question is about a specific organisation, product or person, what its own site, app, legal documents, job postings and filings say outranks any press report. Read them exhaustively rather than sampling: fetch sitemap.xml and robots.txt, try likely paths on every host you find, and when page reading returns little (a login page, a script-rendered page) use your sandbox shell: curl the page, read its HTML source, its title and meta tags, and the script files it loads, and look for product names, feature names, API routes and copy. The wording of a login page, a document in a trust centre, a job title, or a subprocessor list is evidence about what is being built: log it as a key claim and say in the room what it implies.
- Check that a page is about the right subject: other organisations can share the name. Drop sources about a namesake.
${criteriaText(run) ? `- What the final answer will be judged on, one criterion at a time, by an independent judge:\n${criteriaText(run).split("\n").map((l) => "    " + l).join("\n")}\n  Work so that the ledger can carry every one of these. If the ledger cannot yet support one (nobody has evidence for one side, a number has one source), say so in the room and go and get it.\n` : ""}- The ledger is the only thing the writer reads. A finding you only mention in the room is lost. Whatever you learn that bears on THE QUESTION goes into the ledger as a claim with its source and quote, even when it is outside your own sub-questions; say in the room whose sub-question it helps.
- A page that needs a login, or that you cannot re-open, is still evidence: its address, its title, and the words on its sign-in screen say what exists. Log exactly what is visible (and how you saw it: the page itself, a search-engine snippet, or curl in your sandbox).
- Time. Every claim says WHEN it was true. "kind" is "event" (something that happened on a date: a funding round, a release, a vote; it stays true forever), "state" (a condition that can change: who leads, what exists, what a price or score is, whether a problem is solved) or "forecast". "as_of" is the date the source shows it was true (the article's date, or the date named in the text), never today's date unless you saw it today on a live page. Put the date in the claim's text too ("As of March 2026, ...").
- An old state is not the current state. For a key state claim whose as_of is more than ${STALE_DAYS} days before today, run ONE targeted search for what changed since (the subject plus the newest months, newest results first). If you find something newer, write the newer claim with its own as_of and keep the old one as history. If you find nothing, keep the claim and add "rechecked":{"on":"${today()}","found":"nothing newer"}. Either way you are then free to state it plainly with its date; do not hedge, and never write "may have changed" without having looked.
- An old source and a new source that disagree are usually a change over time, not a contradiction: log both with their dates rather than marking one "contradicts".
- One fact per claim. A claim states only what its quoted sentence itself says: one number, one date, one event. Do not pack several facts, a list, or your own summary into one claim; split them into separate claims, each with its own quote. An independent checker re-opens the page and fails any claim that says more than the page.
- A key claim (one the answer rests on) needs two independent publishers. If you can only find one, set "single_source": true.
- stance is about the claim on that row: "contradicts" if the source disagrees with that claim. Actively look for the strongest contradicting evidence.
- Searched and found nothing? Write a not_found row with what you searched.
- To change a row, append it again with the same id (latest wins). To drop a claim or source, append it with "status":"dropped" and "why".`;
}

function roomFor(run, seat, since = 0) {
  const tag = new RegExp(`@${seat.id}(?![0-9])`);
  const mine = run.room.slice(since).filter((m) => m.seat !== seat.id && (tag.test(m.text) || m.text.includes("@all") || (seat.branch && m.text.includes(`@${seat.branch}`)))).slice(-40);
  return mine.length ? "Room messages for you:\n" + mine.map((m) => `[${m.seat}] ${m.text}`).join("\n") : "";
}

function claimDigest(run, cids) {
  const v = run.view();
  return cids
    .map((cid) => {
      const c = v.claims.get(cid);
      if (!c) return "";
      const src = v.sourcesOf(cid)
        .map((s) => {
          const ch = v.checksOf(s.id).map((k) => `${k.result} by ${k.by}`).join(", ");
          return `   - ${s.id} [${s.stance}] ${s.publisher} ${s.published || ""} ${s.url}\n     quote: "${s.quote}"${ch ? `\n     checks: ${ch}` : ""}`;
        })
        .join("\n");
      const when = `${c.kind ? `, ${c.kind}` : ""}${c.as_of ? ` as of ${c.as_of}` : ""}${c.rechecked ? `, rechecked ${c.rechecked.on || ""}: ${c.rechecked.found || ""}` : ""}`;
      return `- ${c.id} (by ${c.by}${c.key ? ", key" : ""}${c.single_source ? ", single source" : ""}${when}): ${c.text}\n${src || "   (no sources)"}`;
    })
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- phases
const GRACE_MS = Number(process.env.SWARM_GRACE_MS || 3 * 60_000);

// emit each phase name once per round, however many branches enter it
function phaseOnce(run, name, round = 1) {
  run.phaseSeen ??= new Set();
  const k = `${name}:${round}`;
  if (run.phaseSeen.has(k)) return;
  run.phaseSeen.add(k);
  run.emit({ t: "phase", name, round });
}

// wait for a set of seat turns, but once 90% are back give the rest at most GRACE_MS:
// stragglers keep running and their rows land when they finish; busy seats skip the next step
async function settle(tasks, frac = 0.9) {
  const list = tasks.filter(Boolean);
  if (!list.length) return;
  let done = 0, timer = null;
  await new Promise((resolve) => {
    for (const p of list)
      p.finally(() => {
        done++;
        if (done === list.length) resolve();
        else if (!timer && done >= Math.ceil(list.length * frac)) timer = setTimeout(resolve, GRACE_MS);
      });
  });
  if (timer) clearTimeout(timer);
}

async function seatTurn(run, seat, phase, input) {
  if (seat.busy) return null;
  seat.busy = true;
  run.emit({ t: "turn", seat: seat.id, phase, status: "started" });
  const t0 = Date.now();
  try {
    const sinceRoom = run.room.length;
    const res = await agentTurn(seat, input, protocol(run, seat));
    const { rows, rejected } = parseLedger(seat, res.text);
    run.totals.tokens += res.tokens;
    run.totals.searches += res.searches.length;
    run.totals.urls_opened += res.urls.length;
    run.totals.turns += 1;
    run.emit({ t: "turn", seat: seat.id, phase, status: "completed", interaction_id: res.id, searches: res.searches, urls: res.urls, tokens: res.tokens, ms: Date.now() - t0, error: null });
    run.addRows(seat.id, rows, rejected);
    for (const line of parseRoom(res.text)) run.say(seat.id, line);
    seat.rejected = rejected;
    seat.lastText = res.text;
    return res;
  } catch (e) {
    run.emit({ t: "turn", seat: seat.id, phase, status: "failed", ms: Date.now() - t0, error: String(e.message || e).slice(0, 400) });
    return null;
  } finally {
    seat.busy = false;
  }
}

async function planCall(prompt, sys) {
  const res = await modelCall(prompt, sys);
  return { res, json: JSON.parse((res.text.match(/\{[\s\S]*\}/) || ["{}"])[0]) };
}

async function plan(run) {
  run.emit({ t: "phase", name: "plan", round: 1 });
  const researchers = run.seats.filter((s) => s.role === "researcher");
  const B = run.branches.length;
  const lang = "Write in the language of the user's question.";
  let rows = [];
  if (B === 1) {
    const k = researchers.length;
    const sys = `You plan deep research. Split the user's question into the sub-questions a careful analyst must answer to give a trustworthy answer: definitions and scope, the key facts and numbers, how they are measured, the strongest counter-evidence, and what could change the answer. Return ONLY JSON: {"questions":[{"id":"Q0-1","text":"...","parent":null}, ...]} with ${Math.max(k + 2, 6)}-${Math.max(2 * k, 10)} questions; children use "parent".${SWEEP} ${lang}`;
    try {
      const { res, json } = await planCall(`User question (today is ${today()}):\n${run.req.question}`, sys);
      run.totals.tokens += res.tokens;
      rows = (json.questions || []).map((q, i) => ({ type: "question", id: q.id || `Q0-${i + 1}`, text: q.text, parent: q.parent || null, branch: "B1" }));
    } catch (e) {
      run.say("system", `Planner failed (${String(e.message).slice(0, 120)}); researchers will split the question themselves.`);
    }
    if (!rows.length) rows = [{ type: "question", id: "Q0-1", text: run.req.question, parent: null, branch: "B1" }];
    rows.forEach((q, i) => (q.owner = researchers[i % k].id));
  } else {
    const sys1 = `You are the lead planner of a ${run.seats.length}-agent deep-research team. Split the user's question into exactly ${B} branches that together cover everything a careful analyst must establish (scope and definitions, the key facts and numbers, how they are measured, causes, comparisons, the strongest counter-evidence, what could change the answer). Branches must not overlap. Return ONLY JSON: {"branches":[{"title":"short title","scope":"one or two sentences: what this branch must establish"}]}.${SWEEP} ${lang}`;
    let branches = [];
    try {
      const { res, json } = await planCall(`User question (today is ${today()}):\n${run.req.question}`, sys1);
      run.totals.tokens += res.tokens;
      branches = (json.branches || []).slice(0, B);
    } catch (e) {
      run.say("system", `Lead planner failed (${String(e.message).slice(0, 120)}).`);
    }
    while (branches.length < B) branches.push({ title: `Part ${branches.length + 1}`, scope: run.req.question });
    run.branches.forEach((b, i) => Object.assign(b, { title: branches[i].title, scope: branches[i].scope }));
    const top = run.branches.map((b) => ({ type: "question", id: b.id, text: `${b.title}: ${b.scope}`, parent: null, branch: b.id, owner: "P", by: "P", at: now() }));
    run.addRows("P", top);
    run.say("P", `${B} branches: ${run.branches.map((b) => `${b.id} ${b.title}`).join(" · ")}`);
    const subs = await Promise.all(
      run.branches.map(async (b) => {
        const team = researchers.filter((r) => r.branch === b.id);
        const n = team.length;
        const sys2 = `You plan one branch of a deep-research project. Split the branch into ${n + 2}-${2 * n} concrete, researchable sub-questions (facts, numbers, how they are measured, counter-evidence, what could change). Return ONLY JSON: {"questions":[{"text":"..."}]}. If this branch is the sweep of the subject's own footprint, give each sub-question one concrete surface to read exhaustively (one host or one kind of document). ${lang}`;
        let qs = [];
        try {
          const { res, json } = await planCall(`User question: ${run.req.question}\nToday: ${today()}\nAll branches:\n${run.branches.map((x) => `- ${x.id} ${x.title}: ${x.scope}`).join("\n")}\n\nYOUR BRANCH: ${b.id} ${b.title}: ${b.scope}`, sys2);
          run.totals.tokens += res.tokens;
          qs = json.questions || [];
        } catch {}
        if (!qs.length) qs = [{ text: `${b.title}: ${b.scope}` }];
        return qs.map((q, i) => ({ type: "question", id: `Q0-${b.id.slice(1)}-${i + 1}`, text: q.text, parent: b.id, branch: b.id, owner: team[i % n].id }));
      }),
    );
    rows = subs.flat();
  }
  run.addRows("P", rows.map((r) => ({ ...r, by: "P", at: now() })));
  for (const r of researchers) {
    const mine = rows.filter((q) => q.owner === r.id).map((q) => q.id);
    if (mine.length) run.say("P", `@${r.id} yours: ${mine.join(", ")}`);
  }
}

async function research(run, branch = null) {
  phaseOnce(run, "research", 1);
  const v = run.view();
  const all = [...v.questions.values()];
  const tasks = run.seats
    .filter((s) => s.role === "researcher" && (!branch || s.branch === branch))
    .map((seat) => {
      const mine = all.filter((q) => q.owner === seat.id);
      const ctx = run.branches?.length > 1 ? all.filter((q) => q.branch === seat.branch || q.parent === null) : all;
      const input = `THE QUESTION: ${run.req.question}

Sub-questions (for context):
${ctx.map((q) => `- ${q.id}${q.parent ? ` (under ${q.parent})` : ""}: ${q.text} [owner ${q.owner}]`).join("\n")}

YOUR sub-questions: ${mine.map((q) => q.id).join(", ")}.
Research them in depth now: many searches, open the pages, read them. For each of your sub-questions write the claims it rests on with sources and exact quotes, then an answer row (or "abandoned" with the reason). Look for contradicting evidence for every key claim and log it. Add new sub-questions if you discover them. If another seat's sub-question overlaps yours, tell them in the room.`;
      return seatTurn(run, seat, "research", input);
    });
  await settle(tasks);
}

async function crosscheck(run, branch = null) {
  phaseOnce(run, "crosscheck", 1);
  const researchers = run.seats.filter((s) => s.role === "researcher");
  const v = run.view();
  const tasks = researchers.filter((s) => !branch || s.branch === branch).map((seat) => {
    const mates = researchers.filter((r) => r.branch === seat.branch);
    const pool = mates.length > 1 ? mates : researchers;
    const other = pool[(pool.indexOf(seat) + 1) % pool.length];
    if (other === seat) return null;
    const theirs = v.keyClaims.filter((c) => c.by === other.id).map((c) => c.id);
    if (!theirs.length) return null;
    const input = `${roomFor(run, seat)}

Cross-check ${other.id}'s key claims from DIFFERENT, independent sources (a different publisher than the ones already listed). For each claim: add an agreeing source from a new publisher, or a contradicting one, or a not_found row saying what you searched. If a claim is wrong, say so to @${other.id} in the room.

${claimDigest(run, theirs)}`;
    return seatTurn(run, seat, "crosscheck", input);
  });
  await settle(tasks);
}

async function redteam(run, round, gateProblems = [], branch = null) {
  phaseOnce(run, "redteam", round);
  const seatBranch = new Map(run.seats.map((s) => [s.id, s.branch]));
  const reds = run.seats.filter((s) => s.role === "redteam" && (!branch || s.branch === branch) && !s.busy);
  if (!reds.length) return;
  const v = run.view();
  const order = new Map(run.seats.map((s, i) => [s.id, i]));
  const keys = v.keyClaims.filter((c) => !branch || seatBranch.get(c.by) === branch).sort((a, b) => (order.get(a.by) ?? 0) - (order.get(b.by) ?? 0)).map((c) => c.id);
  const unchecked = keys.filter((cid) => !v.sourcesOf(cid).some((s) => v.checksOf(s.id).some((k) => k.result === "confirmed")));
  const targets = round === 1 ? keys : unchecked.length ? unchecked : keys;
  const tasks = reds.map((seat, i) => {
    const per = Math.ceil(targets.length / reds.length);
    const mine = targets.slice(i * per, (i + 1) * per);
    const unanswered = [...v.questions.values()].filter((q) => q.owner !== "P" && !v.answers.has(q.id) && (!branch || q.branch === branch)).map((q) => `${q.id}: ${q.text}`);
    const input = `${roomFor(run, seat)}

You are the red team. You do not write the answer; you try to break it before anyone declares it done.
For EACH key claim below: re-open at least one of its sources yourself (open the URL) and write a check row: confirmed (the quote is on the page and supports the claim), wrong (quote missing, or page says otherwise), or unreachable. If page reading fails (a login page, a script-rendered page), try the search-engine snippet for that address and curl in your sandbox before writing unreachable; when either shows the quoted words, the check is confirmed. When a claim says more than its quote, ask the owner to narrow it, never to drop it: a true but over-stated finding must stay in the ledger. Then look for what the team skipped: claims resting on one publisher without "single_source", numbers that do not match, outdated dates, contradicting evidence nobody logged. Check time on every key claim: a missing as_of, an as_of that is not what the source shows, or an old state written as if it were true today is a challenge ("stale: what changed since <date>?"); the fix is one search and a dated claim, not a hedge. For each problem write a challenge row {"type":"challenge","id":"X${seat.id.slice(1)}-k","claim":"C…","to":"<seat that owns the claim>","text":"…"} and tell that seat with @ in the room.
${unanswered.length ? `\nUnanswered sub-questions:\n${unanswered.join("\n")}\n` : ""}${gateProblems.length ? `\nThe automatic gate refused the last attempt for these reasons:\n${gateProblems.map((p) => "- " + p).join("\n")}\n` : ""}
Key claims to attack:
${claimDigest(run, mine)}`;
    return seatTurn(run, seat, "redteam", input);
  });
  await settle(tasks);
}

async function fix(run, round, problems = [], branch = null) {
  phaseOnce(run, "fix", round);
  const v = run.view();
  const tasks = run.seats
    .filter((s) => s.role === "researcher" && (!branch || s.branch === branch))
    .map((seat) => {
      const ch = v.openChallenges.filter((x) => x.to === seat.id || v.claims.get(x.claim)?.by === seat.id);
      const wrong = v.checks.filter((k) => k.result !== "confirmed" && v.sources.get(k.source)?.by === seat.id);
      const mineProblems = problems.filter((p) => p.includes(`(${seat.id})`) || p.includes(`C${seat.id.slice(1)}-`));
      const room = roomFor(run, seat, seat.roomSeen || 0);
      seat.roomSeen = run.room.length;
      const rejected = (seat.rejected || []).map((r) => `- ${JSON.stringify(r.row).slice(0, 160)} -> ${r.why}`);
      if (!ch.length && !wrong.length && !mineProblems.length && !room && !rejected.length) return null;
      const input = `${room}

Fix what was raised against your work. For each challenge: fix the claim/source (append with the same id) or add sources, then write a resolution row. When the challenge says the claim goes beyond its quote, NARROW the claim to exactly what the quote shows and keep it; do not drop it. Drop a claim only when its quote is not real or is about a different subject. A source being login-gated or unreachable for the checker is not a reason to drop: say how you saw it. Then write the resolution row {"type":"resolution","challenge":"X…","text":"what you did"}. Answer any unanswered sub-question you own.
${ch.length ? `\nOpen challenges:\n${ch.map((x) => `- ${x.id} on ${x.claim} by ${x.by}: ${x.text}`).join("\n")}` : ""}
${wrong.length ? `\nChecks that did not confirm your sources:\n${wrong.map((k) => `- ${k.source}: ${k.result} by ${k.by}: ${k.note || ""}`).join("\n")}` : ""}
${mineProblems.length ? `\nGate problems:\n${mineProblems.map((p) => "- " + p).join("\n")}` : ""}
${rejected.length ? `\nLedger rows the system rejected last time:\n${rejected.join("\n")}` : ""}

Your claims now:
${claimDigest(run, [...v.claims.values()].filter((c) => c.by === seat.id).map((c) => c.id))}`;
      return seatTurn(run, seat, "fix", input);
    });
  await settle(tasks);
}

// one branch moves through research -> cross-check -> red team -> fix without waiting for the other branches
async function branchPipeline(run, b) {
  await research(run, b.id);
  if (run.minutesLeft() > 4) await crosscheck(run, b.id);
  await redteam(run, 1, [], b.id);
  await fix(run, 1, [], b.id);
}

// ---------------------------------------------------------------- gate
const norm = (s) =>
  String(s || "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

async function quoteOnPage(url, quote) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (research-checker)" } });
    clearTimeout(t);
    if (!r.ok) return "unreachable";
    const body = norm((await r.text()).slice(0, 4_000_000));
    const q = norm(quote);
    if (!q) return "missing";
    if (body.includes(q)) return "found";
    // allow a long middle chunk (punctuation drift at the edges)
    const words = q.split(" ");
    if (words.length >= 8) {
      const mid = words.slice(1, -1).join(" ");
      if (body.includes(mid)) return "found";
      const half = words.slice(0, Math.ceil(words.length * 0.6)).join(" ");
      if (body.includes(half)) return "found";
    }
    return "missing";
  } catch {
    return "unreachable";
  }
}

async function gate(run, attempt) {
  phaseOnce(run, "gate", attempt);
  const v = run.view();
  const problems = [];
  for (const q of v.questions.values()) if (q.owner !== "P" && !v.answers.has(q.id)) problems.push(`${q.id} has no answer (${q.owner || q.by})`);
  if (!v.keyClaims.length) problems.push("no key claims in the ledger");
  let confirmed = 0;
  for (const c of v.keyClaims) {
    const src = v.sourcesOf(c.id);
    const agree = src.filter((s) => s.stance !== "contradicts");
    const pubs = new Set(agree.map((s) => (s.publisher || "").toLowerCase().trim()).filter(Boolean));
    if (!agree.length) problems.push(`${c.id} (${c.by}) has no supporting source`);
    else if (pubs.size < 2 && !c.single_source) problems.push(`${c.id} (${c.by}) rests on one publisher but is not marked single_source`);
    if (src.some((s) => v.checksOf(s.id).some((k) => k.result === "confirmed"))) confirmed++;
    else problems.push(`${c.id} (${c.by}) has no confirmed red-team check`);
  }
  // an old state presented as current: key state claims older than the window with no recheck
  const cutoff = Date.now() - STALE_DAYS * 86_400_000;
  const stale = v.keyClaims.filter((c) => c.kind === "state" && c.as_of && Date.parse(c.as_of) < cutoff && !c.rechecked);
  for (const c of stale.slice(0, 40)) problems.push(`${c.id} (${c.by}) is a state as of ${c.as_of} and nobody looked for what changed since: search once, then update it or mark it rechecked`);
  const undated = v.keyClaims.filter((c) => !c.as_of).length;
  // leads lost between the room and the ledger: an address several seats mentioned that no kept source cites
  const kept = new Set([...v.sources.values()].filter(v.kept).map((x) => { try { const u = new URL(x.url); return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, ""); } catch { return ""; } }));
  const mentions = new Map();
  for (const m of run.room) {
    if (!/^[RX]\d+$/.test(m.seat)) continue;
    for (const raw of m.text.match(/https?:\/\/[^\s)"'<>\]]+/g) || []) {
      let k; try { const u = new URL(raw.replace(/[.,;:]+$/, "")); k = u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, ""); } catch { continue; }
      if (!mentions.has(k)) mentions.set(k, { url: raw.replace(/[.,;:]+$/, ""), seats: new Set(), first: m.seat });
      mentions.get(k).seats.add(m.seat);
    }
  }
  const orphans = [...mentions].filter(([k, x]) => x.seats.size >= 3 && !kept.has(k)).sort((a, b) => b[1].seats.size - a[1].seats.size).slice(0, 12);
  for (const [, x] of orphans) problems.push(`lead ${x.url} was mentioned in the room by ${x.seats.size} seats but no kept source in the ledger cites it: log what it shows as a claim, or say why it is not about the subject (${x.first})`);
  for (const x of v.openChallenges) problems.push(`challenge ${x.id} on ${x.claim} is unresolved (${x.to || v.claims.get(x.claim)?.by || "?"})`);
  // quote spot-check on a sample of key-claim sources
  const pool = v.keyClaims.flatMap((c) => v.sourcesOf(c.id).filter((s) => s.stance !== "contradicts"));
  const sample = pool.sort(() => Math.random() - 0.5).slice(0, Math.min(8 + Math.floor(run.seats.length / 8), pool.length));
  const results = await Promise.all(sample.map(async (s) => [s, MOCK ? "found" : await quoteOnPage(s.url, s.quote)]));
  let found = 0, reached = 0;
  for (const [s, r] of results) {
    if (r !== "unreachable") reached++;
    if (r === "found") found++;
    if (r === "missing") problems.push(`quote of ${s.id} (${s.by}) was not found on ${s.url}`);
  }
  const stats = { stale_states: stale.length, undated_key_claims: undated, orphan_leads: orphans.length, key_claims: v.keyClaims.length, confirmed, open_challenges: v.openChallenges.length, quotes_checked: results.length, quotes_reached: reached, quotes_found: found };
  const pass = problems.length === 0;
  run.emit({ t: "gate", attempt, pass, problems, stats });
  run.phaseSeen?.add(`gate:${attempt}`);
  return { pass, problems };
}

// ---------------------------------------------------------------- writer + judge
function ledgerDigest(run, { branch = null, compact = false } = {}) {
  const v = run.view();
  const seatBranch = new Map(run.seats.map((s) => [s.id, s.branch]));
  const inBranch = (by) => !branch || seatBranch.get(by) === branch;
  const qs = [...v.questions.values()].filter((q) => !branch || q.branch === branch || q.id === branch).map((q) => {
    const a = v.answers.get(q.id);
    return `- ${q.id}${q.parent ? ` (under ${q.parent})` : ""}: ${q.text}\n  answer: ${a ? `[${a.status}] ${a.text} (claims ${(a.claims || []).join(", ")})` : "NONE"}`;
  });
  const claims = [...v.claims.values()].filter((c) => v.kept(c) && inBranch(c.by)).map((c) => c.id);
  const nf = v.notFound.filter((r) => inBranch(r.by)).map((r) => `- ${r.text} (searched: ${r.searched || "?"})`);
  const ch = [...v.challenges.values()].filter((x) => inBranch(v.claims.get(x.claim)?.by)).map((x) => `- ${x.id} on ${x.claim}: ${x.text} -> ${v.resolutions.get(x.id)?.text || "UNRESOLVED"}`);
  const cd = compact
    ? claims.map((cid) => {
        const c = v.claims.get(cid);
        const src = v.sourcesOf(cid);
        const pubs = [...new Set(src.filter((x) => x.stance !== "contradicts").map((x) => x.publisher))].join("; ");
        const contra = src.filter((x) => x.stance === "contradicts").length;
        const conf = src.some((x) => v.checksOf(x.id).some((k) => k.result === "confirmed"));
        return `- ${cid}${c.key ? " key" : ""}${c.single_source ? " single-source" : ""}${c.kind ? ` ${c.kind}` : ""}${c.as_of ? ` as of ${c.as_of}` : ""}${c.rechecked ? ` (rechecked ${c.rechecked.on || ""}: ${c.rechecked.found || ""})` : ""}: ${c.text} | publishers: ${pubs || "none"}${contra ? ` | ${contra} contradicting` : ""} | ${conf ? "confirmed" : "unconfirmed"}`;
      }).join("\n")
    : claimDigest(run, claims);
  return `QUESTIONS AND ANSWERS\n${qs.join("\n")}\n\nCLAIMS WITH SOURCES AND CHECKS\n${cd}\n\nSEARCHED, NOT FOUND\n${nf.join("\n") || "(none)"}\n\nRED-TEAM CHALLENGES\n${ch.join("\n") || "(none)"}`;
}

// cut a text to a character budget (about 4 characters per token) so huge runs stay inside the model's input window
const fit = (text, max) => (text.length <= max ? text : text.slice(0, max) + `\n… [cut: ${text.length - max} more characters not shown]`);

async function writeSections(run, judgeNotes) {
  const dir = path.join(run.dir, "sections");
  fs.mkdirSync(dir, { recursive: true });
  const sys = `You write ONE section of a deep-research report from the evidence ledger of one research branch. Write in the language of the user's question. Start with a "## " heading (the branch title). Every sentence that states a ledger claim ends with its id in square brackets, like [C12-3]; cite only ids in this ledger, invent nothing. Link only URLs from the ledger. Name contradicting evidence and how it was weighed; say plainly when a key number rests on one publisher. Write each time-sensitive statement with its date and lead with the latest known state; a change over time is a short timeline, newest last; never put an old state in the present tense, and do not add hedges beyond the date. Dense and concrete; no preamble.`;
  const parts = await Promise.all(
    run.branches.map(async (b) => {
      const saved = path.join(dir, `${b.id}.md`);
      // a section already written (an earlier attempt that failed later) is reused
      if (!judgeNotes && fs.existsSync(saved)) return fs.readFileSync(saved, "utf8");
      try {
        const res = await modelCall(`USER QUESTION: ${run.req.question}\nToday: ${today()}\nBRANCH ${b.id}: ${b.title}: ${b.scope}\n\n${fit(ledgerDigest(run, { branch: b.id }), 2_400_000)}${judgeNotes ? `\n\nJUDGE NOTES ON THE LAST REPORT:\n${judgeNotes}` : ""}`, sys);
        run.totals.tokens += res.tokens;
        const md = res.text.trim();
        const first = md.split("\n").filter((l) => l.trim() && !l.startsWith("#"))[0] || "";
        const claims = tagsIn(md);
        run.addRows("W", [{ type: "answer", question: b.id, status: "answered", text: stripTags(first).slice(0, 600), claims, by: "W", at: now() }]);
        fs.writeFileSync(saved, md);
        return md;
      } catch (e) {
        return `## ${b.title}\n\n(section writer failed: ${String(e.message).slice(0, 120)})`;
      }
    }),
  );
  return parts;
}

async function write(run, judgeNotes = "") {
  run.emit({ t: "phase", name: "write", round: 1 });
  if (run.branches.length > 1) return writeBig(run, judgeNotes);
  run.emit({ t: "turn", seat: "W", phase: "write", status: "started" });
  const t0 = Date.now();
  const sys = `You write the final deep-research report from an evidence ledger. Rules:
- Write in the language of the user's question. Lead with the direct answer in 2-4 sentences, then sections organised by the sub-questions.
- Every sentence that states a ledger claim ends with its id in square brackets, like [C1-2]. Only cite ids that exist in the ledger; never invent facts that are not in the ledger.
- Link only URLs that appear in the ledger (Markdown links).
- Include a section on the strongest contradicting evidence and how it was weighed, a "Searched, not found" section, and a final "Confidence" section (high / medium / low, with reasons and what could change).
- Say plainly when a key number rests on a single publisher.
- Time: write each time-sensitive statement with its date ("as of March 2026", "in September 2026") and lead with the latest known state. When the ledger shows a change over time, tell it as a short timeline, newest last. Never put an old state in the present tense. A state that was rechecked with nothing newer is stated plainly with its date; do not add hedges such as "may have changed" beyond that. Then give your best current reading in one sentence, with what it rests on.
- When the question is about a specific organisation, product or person, give what its own pages, app, documents, job postings and filings show its own section near the top, including small clues (the wording of a login page, a trust-centre document, a job title) and what each implies; press reports come after.
- Be concise: short is fine, shallow is not.${criteriaText(run) ? `\nAn independent judge checks the report against these criteria, one at a time; meet each of them:\n${criteriaText(run)}` : ""}`;
  try {
    const res = await modelCall(`USER QUESTION: ${run.req.question}\nToday: ${today()}\n\n${ledgerDigest(run)}${judgeNotes ? `\n\nTHE JUDGE REFUSED THE LAST REPORT:\n${judgeNotes}` : ""}`, sys);
    run.totals.tokens += res.tokens;
    fs.writeFileSync(path.join(run.dir, "report.md"), res.text.trim() + "\n");
    run.emit({ t: "turn", seat: "W", phase: "write", status: "completed", interaction_id: res.id, searches: [], urls: [], tokens: res.tokens, ms: Date.now() - t0, error: null });
    run.emit({ t: "report" });
    return res.text;
  } catch (e) {
    run.emit({ t: "turn", seat: "W", phase: "write", status: "failed", ms: Date.now() - t0, error: String(e.message).slice(0, 400) });
    return null;
  }
}

async function writeBig(run, judgeNotes) {
  run.emit({ t: "turn", seat: "W", phase: "write", status: "started" });
  const t0 = Date.now();
  try {
    const sections = await writeSections(run, judgeNotes);
    const sys = `You are the lead writer of a deep-research report written by a ${run.seats.length}-agent team. The branch sections are already written. Write in the language of the user's question, and output exactly two parts separated by a line containing only =====SECTIONS=====:
PART 1: a "# " title, then the direct answer in 3-6 sentences, citing claim ids like [C3-1] from the sections. When the question is about a specific organisation, product or person, the answer must use what its own pages, app, documents, job postings and filings show (including small clues such as the wording of a login page), not only press reports.
PART 2: "## Strongest contradicting evidence" (how it was weighed), "## Searched, not found", and "## Confidence" (high / medium / low with reasons, what could change, which key numbers rest on one publisher).
Cite only ids present in the sections or the compact ledger. Never invent facts.${criteriaText(run) ? `\nAn independent judge checks the report against these criteria, one at a time; meet each of them:\n${criteriaText(run)}` : ""}`;
    // the lead reads every section (each cut to a share of the budget) and as much of the compact ledger as fits
    const per = Math.max(3000, Math.floor(1_400_000 / sections.length));
    const res = await modelCall(`USER QUESTION: ${run.req.question}\nToday: ${today()}\n\nSECTIONS:\n${sections.map((x) => fit(x, per)).join("\n\n")}\n\nCOMPACT LEDGER:\n${fit(ledgerDigest(run, { compact: true }), 1_000_000)}${judgeNotes ? `\n\nTHE JUDGE REFUSED THE LAST REPORT:\n${judgeNotes}` : ""}`, sys);
    run.totals.tokens += res.tokens;
    const [head, tail = ""] = res.text.split(/^=====SECTIONS=====\s*$/m);
    const report = `${head.trim()}\n\n${sections.join("\n\n")}\n\n${tail.trim()}\n`;
    fs.writeFileSync(path.join(run.dir, "report.md"), report);
    run.emit({ t: "turn", seat: "W", phase: "write", status: "completed", interaction_id: res.id, searches: [], urls: [], tokens: res.tokens, ms: Date.now() - t0, error: null });
    run.emit({ t: "report" });
    return report;
  } catch (e) {
    run.emit({ t: "turn", seat: "W", phase: "write", status: "failed", ms: Date.now() - t0, error: String(e.message).slice(0, 400) });
    return null;
  }
}

// What done means for THIS question: written once from the question itself, shown to every agent, and judged
// one criterion at a time. Nothing about the form of the answer is hard-coded: if the person asked whether
// something will happen, a clear answer to that is a criterion because they asked it.
async function criteria(run) {
  const file = path.join(run.dir, "criteria.json");
  if (fs.existsSync(file)) { run.criteria = JSON.parse(fs.readFileSync(file, "utf8")); return; }
  const fallback = ["The report answers each thing the question asks, clearly and near the top.", "Every key number or fact is backed by two independent sources or plainly marked single-source.", "It presents the strongest evidence against its answer and says how it was weighed.", "It says what was searched for and not found.", "It states its confidence with the specific evidence and limits behind it."];
  const sys = `You write the criteria a research report will be judged on, for one question. Three to six concrete criteria a judge can check against the report itself, in the language of the question.
- First: what the person asked for, in their words. Name each thing the question asks (each "what", "how many", "will", "which", "when") and require a clear answer to each, in the form the question asks for, where the reader finds it first. When the question asks for a judgement or a forecast, the criterion is a clear answer to it that separates what is known from what is forecast and says how sure, with the evidence and limits behind that.
- The rest are bars of depth with numbers fitted to this question, which a judge can count: at least how many independent sources and which kinds count for this question (copies of one story count once); every key date, number or fact backed by two independent sources or plainly marked single-source; the strongest evidence on each side with at least how many sources; what was searched for and not found; anything else this particular question needs (a timeline that separates confirmed events from disputed ones, a table, a range).
One bar per criterion. Never write a criterion about process or tools. Return ONLY JSON {"criteria":["..."]}.`;
  try {
    const res = await modelCall(`QUESTION (today is ${today()}):\n${run.req.question}`, sys);
    run.totals.tokens += res.tokens;
    const c = (JSON.parse((res.text.match(/\{[\s\S]*\}/) || ["{}"])[0]).criteria || []).filter((x) => typeof x === "string" && x.trim()).slice(0, 6);
    run.criteria = c.length >= 3 ? c : fallback;
  } catch { run.criteria = fallback; }
  fs.writeFileSync(file, JSON.stringify(run.criteria, null, 1));
  run.emit({ t: "criteria", items: run.criteria });
}
const criteriaText = (run) => (run.criteria?.length ? run.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n") : "");

function evidenceCounts(run) {
  const v = run.view();
  const pubs = (c) => new Set(v.sourcesOf(c.id).filter((x) => x.stance !== "contradicts").map((x) => (x.publisher || "").toLowerCase().trim()).filter(Boolean)).size;
  const sources = [...v.sources.values()].filter(v.kept);
  return {
    sources: sources.length,
    independent_publishers: new Set(sources.map((x) => (x.publisher || "").toLowerCase().trim()).filter(Boolean)).size,
    key_claims: v.keyClaims.length,
    key_claims_with_two_publishers: v.keyClaims.filter((c) => pubs(c) >= 2).length,
    key_claims_marked_single_source: v.keyClaims.filter((c) => c.single_source).length,
    contradicting_sources: sources.filter((x) => x.stance === "contradicts").length,
    not_found_notes: v.notFound.length,
    key_claims_with_confirmed_check: v.keyClaims.filter((c) => v.sourcesOf(c.id).some((x) => v.checksOf(x.id).some((k) => k.result === "confirmed"))).length,
    open_challenges: v.openChallenges.length,
  };
}

// What would a person who reads only the opening take away? A separate reader gets the question and the first
// lines of the report, nothing else, and must say the report's answer to each thing the question asks. An ask
// the reader cannot answer from the opening was not answered where people look, whatever the rest says.
function opening(report) {
  const body = report.replace(/^#[^\n]*\n+/, "");
  const cjk = (body.slice(0, 400).match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length > 80;
  return body.slice(0, cjk ? 350 : 700);
}
async function readerTest(run, report) {
  const sys = `You are a reader with one minute. You get a question someone asked and only the opening lines of the report written to answer it. List each separate thing the question asks, and sort each into kind "answer" (it has an answer one can state in a line: what happened, what is the status, will it, how many, which, when) or kind "material" (a request for material that needs space: lay out a timeline, list the evidence, give a table). For each ask of kind "answer", say what the opening tells you the answer is, in a few words; if the opening does not let you state it, stated is false: do not guess, and do not count background that leads up to an answer. For kind "material" leave answer empty and stated true. Return ONLY JSON {"asks":[{"ask":"...","kind":"answer","answer":"...","stated":true}]}.`;
  try {
    const res = await modelCall(`QUESTION: ${run.req.question}\n\nOPENING OF THE REPORT (this is all you have read):\n${opening(report)}`, sys);
    run.totals.tokens += res.tokens;
    return (JSON.parse((res.text.match(/\{[\s\S]*\}/) || ["{}"])[0]).asks || []).filter((a) => a && a.ask);
  } catch { return null; }
}

async function judge(run, attempt, report) {
  run.emit({ t: "phase", name: "judge", round: attempt });
  const reader = await readerTest(run, report);
  const unstated = (reader || []).filter((a) => a.kind !== "material" && a.stated !== true);
  const v = run.view();
  const tags = tagsIn(report);
  const bad = tags.filter((t) => !v.claims.has(t) || !v.kept(v.claims.get(t)));
  const list = run.criteria?.length ? run.criteria : ["The report answers each thing the question asks, clearly and near the top."];
  const sys = `You are the judge of a research report written by a team of agents. You are not on the team. You decide, criterion by criterion, whether the report meets what the person asked for.
For every criterion, in order:
- met: true only when the report itself clearly satisfies the criterion as written. A promise, a placeholder, or an answer the reader has to dig out of a long passage does not satisfy a criterion that asks for a clear answer: the answer must be stated where the reader finds it first.
- For a criterion that sets a number (sources, publishers, evidence on each side), count from the EVIDENCE COUNTS and the ledger, not from what the report says about itself.
- A criterion that asks for a clear or direct answer is met only when the READER TEST shows every ask stated: an ask the reader could not answer from the opening was not answered where people look, however well the rest of the report covers it.
- A key fact the report states must follow from the quoted passage of a source attached to the claim it cites; when the quotes do not say it, the criterion it serves is not met.
- evidence: one or two sentences on where the report meets it, or what you found instead. missing: what exactly is missing, empty when met.
Judge only against the question and its criteria; do not add requirements of your own. When you cannot tell whether a criterion is met, it is not met. Return ONLY JSON {"checks":[{"criterion":1,"met":true,"evidence":"...","missing":""}]}.`;
  let pass = false, notes = "", checks = [];
  try {
    const res = await modelCall(`QUESTION: ${run.req.question}\nToday: ${today()}\n\nCRITERIA:\n${list.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nEVIDENCE COUNTS: ${JSON.stringify(evidenceCounts(run))}\nREADER TEST (a separate reader saw only the question and the report's opening lines; for each thing the question asks, what the opening told them): ${reader ? JSON.stringify(reader) : "not run"}\nClaim ids cited in the report that are not in the ledger: ${bad.join(", ") || "none"}.\n\nREPORT:\n${fit(report, 1_600_000)}\n\nLEDGER:\n${fit(ledgerDigest(run, { compact: run.seats.length > 24 }), 1_200_000)}`, sys);
    run.totals.tokens += res.tokens;
    const j = JSON.parse((res.text.match(/\{[\s\S]*\}/) || ["{}"])[0]);
    checks = list.map((c, i) => { const k = (j.checks || []).find((x) => Number(x.criterion) === i + 1) || {}; return { criterion: c, met: k.met === true, evidence: String(k.evidence || ""), missing: String(k.missing || (k.met === true ? "" : "the judge gave no answer for this criterion")) }; });
    // the reader test is not left to the judge's goodwill: an unstated ask fails the first criterion
    if (unstated.length && checks[0]) { checks[0].met = false; checks[0].missing = `A reader of the opening alone could not say the report's answer to: ${unstated.map((a) => a.ask).join("; ")}. State those answers in the first lines.`; }
    pass = checks.every((k) => k.met) && bad.length === 0;
    notes = [...(bad.length ? [`report cites ids not in the ledger: ${bad.join(", ")}`] : []), ...checks.filter((k) => !k.met).map((k) => `NOT MET: ${k.criterion}\n  missing: ${k.missing}`)].join("\n");
  } catch (e) {
    notes = `judge error: ${String(e.message).slice(0, 200)}`;
  }
  run.emit({ t: "judge", attempt, pass, notes, checks, reader });
  run.say("J", pass ? `Passed: all ${checks.length} criteria met.` : `Not yet:\n${notes}`);
  return { pass, notes };
}

// ---------------------------------------------------------------- baseline
async function baseline(run) {
  if (!run.req.baseline) return;
  run.emit({ t: "baseline", status: "started", agent: BASELINE_AGENT });
  const t0 = Date.now();
  try {
    if (MOCK) {
      await sleep(3000);
      fs.writeFileSync(path.join(run.dir, "baseline.md"), "# Baseline (mock)\n\nA single-agent answer.\n");
      run.emit({ t: "baseline", status: "completed", agent: BASELINE_AGENT, searches: ["q1", "q2"], urls: ["https://example.com"], tokens: 1000, ms: Date.now() - t0 });
      return;
    }
    let it = await gem().interactions.create({ agent: BASELINE_AGENT, input: run.req.question, background: true, store: true });
    run.emit({ t: "baseline", status: "submitted", agent: BASELINE_AGENT, interaction_id: it.id });
    it = await waitFor(it, 60 * 60_000);
    const d = digestSteps(it);
    fs.writeFileSync(path.join(run.dir, "baseline.md"), outputText(it).trim() + "\n");
    run.emit({ t: "baseline", status: "completed", agent: BASELINE_AGENT, interaction_id: it.id, ...d, ms: Date.now() - t0 });
  } catch (e) {
    run.emit({ t: "baseline", status: "failed", agent: BASELINE_AGENT, error: String(e.message).slice(0, 400), ms: Date.now() - t0 });
  }
}

// ---------------------------------------------------------------- mock (no key needed)
let mockN = 0;
async function mockTurn(seat, input) {
  await sleep(800 + Math.random() * 1500);
  const n = seat.id.replace(/^[A-Z]+/, "");
  const k = ++mockN;
  let ledger = "";
  if (seat.role === "researcher") {
    const qs = [...input.matchAll(/YOUR sub-questions: ([^\n.]+)/g)].flatMap((m) => m[1].split(", "));
    ledger = [
      { type: "claim", id: `C${n}-${k}`, text: `Mock claim ${k} from ${seat.id}`, key: true, status: "kept" },
      { type: "source", id: `S${n}-${k}a`, claim: `C${n}-${k}`, url: "https://example.com/a", title: "A", publisher: "Pub A", quote: "example domain", stance: "agrees", published: "2026-11-01", retrieved: today() },
      { type: "source", id: `S${n}-${k}b`, claim: `C${n}-${k}`, url: "https://example.org/b", title: "B", publisher: "Pub B", quote: "example domain", stance: "agrees", published: "2026-11-02", retrieved: today() },
      ...qs.map((q) => ({ type: "answer", question: q.trim(), status: "answered", text: "mock answer", claims: [`C${n}-${k}`] })),
    ].map((r) => JSON.stringify(r)).join("\n");
    for (const m of input.matchAll(/(X\d+-\d+) on/g)) ledger += "\n" + JSON.stringify({ type: "resolution", challenge: m[1], text: "fixed (mock)" });
  } else {
    const srcs = [...input.matchAll(/- (S\d+-\w+) \[/g)].map((m) => m[1]);
    ledger = srcs.map((s) => JSON.stringify({ type: "check", source: s, result: "confirmed", note: "mock" })).join("\n");
    if (k % 3 === 0) {
      const cl = (input.match(/- (C\d+-\d+) \(by (R\d+)/) || []);
      if (cl[1]) ledger += "\n" + JSON.stringify({ type: "challenge", id: `X${n}-${k}`, claim: cl[1], to: cl[2], text: "mock challenge" });
    }
  }
  if (seat.role === "researcher" && !ledger && /TAKING/.test(input)) ledger = [
    { type: "claim", id: `C${n}-${k}`, text: `Mock claim ${k} from ${seat.id}`, key: true, status: "kept" },
    { type: "source", id: `S${n}-${k}a`, claim: `C${n}-${k}`, url: "https://example.com/a", title: "A", publisher: "Pub A", quote: "example domain", stance: "agrees" },
    { type: "source", id: `S${n}-${k}b`, claim: `C${n}-${k}`, url: "https://example.org/b", title: "B", publisher: "Pub B", quote: "example domain", stance: "agrees" },
  ].map((r) => JSON.stringify(r)).join("\n");
  const vote = seat.role === "redteam" ? `\n\`\`\`vote\n{"terminate": ${/turn [3-9] of your loop/.test(input)}, "why": "mock"}\n\`\`\`` : "";
  const text = `Done.\n\`\`\`room\n${/TAKING/.test(input) ? `TAKING: mock part ${k}` : `@all mock message from ${seat.id}`}\n\`\`\`\n\`\`\`ledger\n${ledger}\n\`\`\`${vote}`;
  return { text, id: `mock_${k}`, searches: ["mock query a", "mock query b"], urls: ["https://example.com/a"], tokens: 5000 };
}
async function mockModel(input, system) {
  await sleep(500);
  if (system.includes("plan deep research")) return { text: JSON.stringify({ questions: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `Q0-${i}`, text: `Mock sub-question ${i}`, parent: null })) }), id: "mock_p", searches: [], urls: [], tokens: 100 };
  if (system.includes("criteria a research report will be judged on")) return { text: '{"criteria":["Mock: a clear answer to the question, first.","Mock: two sources per key fact.","Mock: evidence against."]}', id: "mock_c", searches: [], urls: [], tokens: 100 };
  if (system.includes("You are a reader with one minute")) return { text: '{"asks":[{"ask":"mock","answer":"mock","stated":true}]}', id: "mock_r", searches: [], urls: [], tokens: 50 };
  if (system.includes("You are the judge")) return { text: '{"checks":[{"criterion":1,"met":true,"evidence":"mock"},{"criterion":2,"met":true,"evidence":"mock"},{"criterion":3,"met":true,"evidence":"mock"}]}', id: "mock_j", searches: [], urls: [], tokens: 100 };
  const ids = [...new Set(input.match(/C\d+-\d+/g) || [])];
  return { text: `# Mock report\n\nAnswer. ${ids.map((i) => `[${i}]`).join(" ")}\n\n## Confidence\nMedium.`, id: "mock_w", searches: [], urls: [], tokens: 100 };
}

// ---------------------------------------------------------------- free mode: no orchestrator
// Every agent runs its own loop until state = terminate. Nothing assigns work: agents coordinate on a shared
// board. The terminate state comes from the red-team judges' votes (or the time budget running out).
const QUORUM = Number(process.env.SWARM_TERMINATE_QUORUM || 2 / 3);
const MAX_TURNS = Number(process.env.SWARM_MAX_TURNS || 12);

function boardFor(run, seat) {
  const since = seat.boardSeen || 0;
  const tag = new RegExp(`@${seat.id}(?![0-9])`);
  const fresh = run.room.slice(since).filter((m) => m.seat !== seat.id);
  seat.boardSeen = run.room.length;
  const toMe = fresh.filter((m) => tag.test(m.text));
  const rest = fresh.filter((m) => !tag.test(m.text) && !/^TAKING:/i.test(m.text));
  const shown = rest.slice(-50);
  // who is on what: everyone's latest TAKING line stays visible however long the board gets
  const taking = new Map();
  for (const m of run.room) if (/^TAKING:/i.test(m.text) && m.seat !== seat.id) taking.set(m.seat, m.text.replace(/^TAKING:\s*/i, "").slice(0, 140));
  const mine = [...run.room].reverse().find((m) => m.seat === seat.id && /^TAKING:/i.test(m.text));
  return [
    taking.size ? `WHO IS ON WHAT (latest TAKING line of each agent):\n${[...taking].map(([k, v]) => `${k}: ${v}`).join("\n")}` : "The board is empty: you are among the first.",
    mine ? `YOU SAID: ${mine.text}` : "",
    toMe.length ? `ADDRESSED TO YOU:\n${toMe.map((m) => `[${m.seat}] ${m.text}`).join("\n")}` : "",
    shown.length ? `NEW ON THE BOARD${rest.length > shown.length ? ` (${rest.length - shown.length} older messages not shown)` : ""}:\n${shown.map((m) => `[${m.seat}] ${m.text}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

function freeStats(run) {
  const v = run.view();
  const confirmed = v.keyClaims.filter((c) => v.sourcesOf(c.id).some((s) => v.checksOf(s.id).some((k) => k.result === "confirmed"))).length;
  const votes = [...(run.votes || new Map()).values()];
  return { v, confirmed, line: `LEDGER NOW: ${v.claims.size} claims (${v.keyClaims.length} key, ${confirmed} of them with a confirmed judge check), ${v.sources.size} sources, ${v.openChallenges.length} open challenges, ${v.notFound.length} not-found notes. Judges voting to stop: ${votes.filter((x) => x.terminate).length} of ${run.seats.filter((s) => s.role === "redteam").length}.` };
}

function workerInput(run, seat, n) {
  const { v, line } = freeStats(run);
  const ch = v.openChallenges.filter((x) => x.to === seat.id || v.claims.get(x.claim)?.by === seat.id);
  const wrong = v.checks.filter((k) => k.result !== "confirmed" && v.sources.get(k.source)?.by === seat.id).slice(-10);
  const rejected = (seat.rejected || []).map((r) => `- ${JSON.stringify(r.row).slice(0, 160)} -> ${r.why}`);
  const mine = [...v.claims.values()].filter((c) => c.by === seat.id && v.kept(c));
  const others = [...v.claims.values()].filter((c) => c.by !== seat.id && v.kept(c)).slice(-70);
  const brief = (c) => {
    const src = v.sourcesOf(c.id);
    const pubs = new Set(src.filter((x) => x.stance !== "contradicts").map((x) => (x.publisher || "").toLowerCase())).size;
    return `- ${c.id} (${c.by}${c.key ? ", key" : ""}): ${c.text.slice(0, 170)} | ${pubs} publisher${pubs === 1 ? "" : "s"}${src.some((x) => v.checksOf(x.id).some((k) => k.result === "confirmed")) ? ", confirmed" : ""}`;
  };
  return `THE QUESTION: ${run.req.question}

${boardFor(run, seat)}

${line}
${ch.length ? `\nOPEN CHALLENGES ON YOUR CLAIMS (fix the claim, add sources or drop it, then write a resolution row):\n${ch.map((x) => `- ${x.id} on ${x.claim} by ${x.by}: ${x.text}`).join("\n")}\n` : ""}${wrong.length ? `\nJUDGE CHECKS THAT DID NOT CONFIRM YOUR SOURCES:\n${wrong.map((k) => `- ${k.source}: ${k.result} by ${k.by}: ${k.note || ""}`).join("\n")}\n` : ""}${rejected.length ? `\nLEDGER ROWS THE SYSTEM REJECTED LAST TURN:\n${rejected.join("\n")}\n` : ""}${mine.length ? `\nYOUR CLAIMS SO FAR:\n${mine.slice(-30).map(brief).join("\n")}\n` : ""}${others.length ? `\nRECENT CLAIMS BY OTHERS (do not redo these; cross-check a key one from a different publisher if it matters and has one publisher):\n${others.map(brief).join("\n")}\n` : ""}
This is turn ${n} of your loop. ${n === 1 ? "First decide what part of the question you take that nobody else has taken, and post it on the board as a line starting with TAKING:. Then research it." : "Decide what is most useful now: answer challenges on your claims first; then go deeper on what you took, take a part nobody covers (post a new TAKING: line), cross-check someone's single-publisher key claim, or hunt for evidence against the emerging answer."} One solid piece of work per turn (several searches, pages opened and read), then stop so you can read the board again. If there is truly nothing useful left for you, say so on the board and write an empty ledger block.`;
}

function judgeInput(run, seat, n) {
  const { v, line } = freeStats(run);
  const unchecked = v.keyClaims.filter((c) => !v.sourcesOf(c.id).some((s) => v.checksOf(s.id).some((k) => k.result === "confirmed")));
  const slice = unchecked.sort(() => Math.random() - 0.5).slice(0, 10).map((c) => c.id);
  const mineCh = [...v.challenges.values()].filter((x) => x.by === seat.id).slice(-12);
  return `THE QUESTION: ${run.req.question}

${boardFor(run, seat)}

${line}

You are one of the red-team judges. You do not write the answer; you try to break it, and you decide when the team may stop. This is turn ${n} of your loop.
1. Re-open sources yourself (open the URL) for key claims that have no confirmed check and write a check row for each: confirmed (the quote is on the page and supports the claim), wrong, or unreachable. If page reading fails (a login page, a script-rendered page), try the search-engine snippet for that address and curl in your sandbox before writing unreachable; when either shows the quoted words, the check is confirmed. When a claim says more than its quote, ask the owner to narrow it, never to drop it: a true but over-stated finding must stay in the ledger.
2. Look for what the team skipped: parts of the question nobody took, claims on one publisher without "single_source", numbers that disagree, stale dates, contradicting evidence nobody logged. Check time on every key claim: a missing as_of, an as_of that is not what the source shows, or an old state written as if it were true today is a challenge ("stale: what changed since <date>?"); the fix is one search and a dated claim, not a hedge. For each problem write a challenge row {"type":"challenge","id":"X${seat.id.slice(1)}-k","claim":"C…","to":"<seat that owns the claim>","text":"…"}; for a gap nobody covers, say it on the board.
3. Check how your earlier challenges were resolved.
${mineCh.length ? `\nYOUR CHALLENGES:\n${mineCh.map((x) => `- ${x.id} on ${x.claim}: ${x.text.slice(0, 140)} -> ${v.resolutions.get(x.id)?.text?.slice(0, 160) || "NOT RESOLVED YET"}`).join("\n")}\n` : ""}
KEY CLAIMS WITH NO CONFIRMED CHECK (${unchecked.length} in total; this is your slice, other judges see other slices):
${slice.length ? claimDigest(run, slice) : "(none right now)"}

After the room and ledger blocks, end with a third block: your vote on whether the whole team should stop now.
\`\`\`vote
{"terminate": false, "why": "one sentence"}
\`\`\`
Vote true only when the question is answered in depth, the key claims you examined hold, you know of no open challenge or uncovered part that matters, and more work would not change the answer. The team stops when ${Math.round(QUORUM * 100)}% of the judges vote true.`;
}

function recordVote(run, seat, text) {
  let vote = null;
  try { vote = JSON.parse((blocks(text, "vote").match(/\{[\s\S]*\}/) || ["null"])[0]); } catch {}
  if (!vote || typeof vote.terminate !== "boolean") return;
  run.votes ??= new Map();
  run.votes.set(seat.id, { terminate: vote.terminate, why: String(vote.why || "").slice(0, 300) });
  const judges = run.seats.filter((s) => s.role === "redteam").length;
  const yes = [...run.votes.values()].filter((x) => x.terminate).length;
  run.emit({ t: "vote", seat: seat.id, terminate: vote.terminate, why: String(vote.why || "").slice(0, 300), yes, of: judges });
  if (!run.terminate && yes >= Math.ceil(QUORUM * judges)) {
    run.terminate = { reason: "judges", yes, of: judges };
    run.emit({ t: "terminate", reason: "judges", yes, of: judges });
    run.say("system", `state = terminate: ${yes} of ${judges} judges voted to stop. Agents finish what they are doing and stop.`);
  }
}

async function seatLoop(run, seat) {
  const judge = seat.role === "redteam";
  // agents arrive a few at a time, so later arrivals can see what earlier ones took
  await sleep(seat.arrive || 0);
  let idle = 0;
  for (let n = 1; n <= MAX_TURNS && !run.terminate; n++) {
    if (run.minutesLeft() < 5) break;
    if (judge && !run.view().claims.size) { n--; await sleep(20_000); continue; }
    const rowsBefore = run.rows.length, roomBefore = run.room.length;
    const res = await seatTurn(run, seat, judge ? "redteam" : "research", judge ? judgeInput(run, seat, n) : workerInput(run, seat, n));
    if (!res) { await sleep(15_000); continue; }
    if (judge) recordVote(run, seat, res.text);
    const produced = run.rows.slice(rowsBefore).some((r) => r.by === seat.id) || run.room.slice(roomBefore).some((m) => m.seat === seat.id);
    if (produced) idle = 0;
    else { idle++; await sleep(Math.min(90_000, 30_000 * idle)); }
  }
}

// a single writer cannot hold a 100-agent ledger: Argon outlines it, section writers write, a lead joins
async function writeOutlined(run) {
  run.emit({ t: "turn", seat: "W", phase: "write", status: "started" });
  const t0 = Date.now();
  try {
    const v = run.view();
    const kept = [...v.claims.values()].filter(v.kept);
    const o = await modelCall(`USER QUESTION: ${run.req.question}\n\nCLAIMS:\n${kept.map((c) => `${c.id}${c.key ? " key" : ""}: ${c.text.slice(0, 200)}`).join("\n")}`, `You outline a deep-research report. Group the claims into 5-10 sections that together answer the user's question; every key claim goes in exactly one section. Return ONLY JSON {"sections":[{"title":"...","claims":["C1-2", ...]}]}. Titles in the language of the user's question.`);
    run.totals.tokens += o.tokens;
    const sections = (JSON.parse((o.text.match(/\{[\s\S]*\}/) || ["{}"])[0]).sections || []).filter((x) => (x.claims || []).length);
    const sys = `You write ONE section of a deep-research report from the evidence given. Write in the language of the user's question. Start with a "## " heading. Every sentence that states a ledger claim ends with its id in square brackets, like [C12-3]; cite only the ids given, invent nothing, and state only what that claim's text and quotes say. Link only URLs from the evidence. Name contradicting evidence and how it was weighed; say plainly when a key number rests on one publisher. Write each time-sensitive statement with its date and lead with the latest known state; a change over time is a short timeline, newest last; never put an old state in the present tense, and do not add hedges beyond the date. Dense and concrete; no preamble.`;
    const parts = await Promise.all(sections.map(async (sec) => {
      try {
        const ids = sec.claims.filter((id) => v.claims.has(id));
        const ch = [...v.challenges.values()].filter((x) => ids.includes(x.claim)).map((x) => `- ${x.id} on ${x.claim}: ${x.text} -> ${v.resolutions.get(x.id)?.text || "UNRESOLVED"}`);
        const res = await modelCall(`USER QUESTION: ${run.req.question}\nToday: ${today()}\nSECTION: ${sec.title}\n\nCLAIMS WITH SOURCES AND CHECKS\n${claimDigest(run, ids)}\n\nCHALLENGES\n${ch.join("\n") || "(none)"}`, sys);
        run.totals.tokens += res.tokens;
        return res.text.trim();
      } catch (e) { return `## ${sec.title}\n\n(section writer failed: ${String(e.message).slice(0, 120)})`; }
    }));
    const lead = await modelCall(`USER QUESTION: ${run.req.question}\nToday: ${today()}\n\nSECTIONS:\n${parts.join("\n\n")}\n\nCOMPACT LEDGER:\n${ledgerDigest(run, { compact: true })}`, `You are the lead writer of a deep-research report written by a ${run.seats.length}-agent team. The sections are already written. Write in the language of the user's question, and output exactly two parts separated by a line containing only =====SECTIONS=====:
PART 1: a "# " title, then the direct answer in 3-6 sentences, citing claim ids like [C3-1] from the sections. When the question is about a specific organisation, product or person, the answer must use what its own pages, app, documents, job postings and filings show (including small clues such as the wording of a login page), not only press reports.
PART 2: "## Strongest contradicting evidence" (how it was weighed), "## Searched, not found", and "## Confidence" (high / medium / low with reasons, what could change, which key numbers rest on one publisher).
Cite only ids present in the sections or the compact ledger. Never invent facts.${criteriaText(run) ? `\nAn independent judge checks the report against these criteria, one at a time; meet each of them:\n${criteriaText(run)}` : ""}`);
    run.totals.tokens += lead.tokens;
    const [head, tail = ""] = lead.text.split(/^=====SECTIONS=====\s*$/m);
    const report = `${head.trim()}\n\n${parts.join("\n\n")}\n\n${tail.trim()}\n`;
    fs.writeFileSync(path.join(run.dir, "report.md"), report);
    run.emit({ t: "turn", seat: "W", phase: "write", status: "completed", interaction_id: lead.id, searches: [], urls: [], tokens: lead.tokens, ms: Date.now() - t0, error: null });
    run.emit({ t: "report" });
    return report;
  } catch (e) {
    run.emit({ t: "turn", seat: "W", phase: "write", status: "failed", ms: Date.now() - t0, error: String(e.message).slice(0, 400) });
    return null;
  }
}

// reuse the Deep Research answer of another run on the same question (same baseline for both modes)
async function baselineFrom(run, other) {
  run.emit({ t: "baseline", status: "started", agent: BASELINE_AGENT, from: other });
  const dir = path.join(ROOT, "runs", other);
  for (let i = 0; i < 400; i++) {
    try {
      const ev = fs.readFileSync(path.join(dir, "events.ndjson"), "utf8").trim().split("\n").filter((l) => l.includes('"t":"baseline"')).map((l) => JSON.parse(l)).pop();
      if (ev && ev.status === "completed" && fs.existsSync(path.join(dir, "baseline.md"))) {
        fs.copyFileSync(path.join(dir, "baseline.md"), path.join(run.dir, "baseline.md"));
        run.emit({ ...ev, at: undefined, from: other });
        return;
      }
      if (ev && ev.status === "failed") break;
    } catch {}
    await sleep(15_000);
  }
  run.emit({ t: "baseline", status: "failed", agent: BASELINE_AGENT, error: `no baseline from ${other}` });
}

async function freeRun(run, R, X) {
  run.free = true;
  run.branches = [{ id: "B1", title: "", scope: "" }];
  const N = R + X;
  run.seats = [
    ...Array.from({ length: R }, (_, k) => ({ id: `R${k + 1}`, role: "researcher", model: seatModel(run, k), arrive: Math.floor(k / 8) * (N > 20 ? 25_000 : 8_000) })),
    ...Array.from({ length: X }, (_, k) => ({ id: `X${k + 1}`, role: "redteam", model: seatModel(run, R + k), arrive: 60_000 + k * 2_000 })),
    { id: "W", role: "writer", model: LEAD_MODEL },
    { id: "J", role: "judge", model: LEAD_MODEL },
  ];
  run.emit({ t: "run", id: run.id, mode: "free", question: run.req.question, seats: run.seats.map(({ id, role, model }) => ({ id, role, model })), branches: 1, budget_min: run.req.minutes || 30, agent: MOCK ? "mock" : AGENT_ID, quorum: QUORUM, started_at: new Date(run.started).toISOString() });
  const base = run.req.baseline_from ? baselineFrom(run, run.req.baseline_from) : baseline(run);
  let status = "ended";
  try {
    await criteria(run);
    phaseOnce(run, "research", 1);
    run.say("system", `No orchestrator. ${R} researchers and ${X} red-team judges each run their own loop and coordinate on this board. The run stops when ${Math.round(QUORUM * 100)}% of the judges vote to stop, or when the time budget runs out.`);
    const loops = run.seats.filter((s) => ["researcher", "redteam"].includes(s.role)).map((s) => seatLoop(run, s));
    // the budget is the only other way to reach terminate
    const budget = (async () => {
      while (!run.terminate && run.minutesLeft() > 8) await sleep(5000);
      if (!run.terminate) {
        const judges = X, yes = [...(run.votes || new Map()).values()].filter((x) => x.terminate).length;
        run.terminate = { reason: "budget", yes, of: judges };
        run.emit({ t: "terminate", reason: "budget", yes, of: judges });
        run.say("system", `state = terminate: the time budget ran out (${yes} of ${judges} judges had voted to stop).`);
      }
    })();
    await budget;
    // agents finish the turn they are in, within a grace period
    await Promise.race([Promise.allSettled(loops), sleep(GRACE_MS)]);
    const g = await gate(run, 1); // not a blocker here: recorded to compare with the orchestrated mode
    let report = N > 24 ? (run.emit({ t: "phase", name: "write", round: 1 }), await writeOutlined(run)) : await write(run);
    if (report) report = await bottomLine(run, report);
    if (report) report = await verifyReport(run, report);
    if (report) {
      const j = await judge(run, 1, report);
      if (j.pass) status = "passed";
    }
  } catch (e) {
    run.say("system", `Run error: ${String(e.message || e).slice(0, 300)}`);
    status = "failed";
  }
  await Promise.race([base, sleep(Math.max(0, run.deadline + 10 * 60_000 - Date.now()))]);
  run.emit({ t: "phase", name: "done", round: 1 });
  run.emit({ t: "done", status, totals: { ...run.totals, minutes: Math.round((Date.now() - run.started) / 6000) / 10 } });
}

const seatModel = (run, k) => (run.req.models?.length ? run.req.models[k % run.req.models.length] : SEAT_MODEL);

// ---------------------------------------------------------------- main
async function main() {
  const i = process.argv.indexOf("--run");
  if (i < 0) throw new Error("usage: node swarm.mjs --run <runId>");
  const run = new Run(process.argv[i + 1]);
  if (run.req.concurrency) LIMIT = Number(run.req.concurrency);
  if (run.req.seat_model) SEAT_MODEL = run.req.seat_model; // per-run choice: hydrogen, neon, carbon
  const from = process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from") + 1] : null;
  if (from === "write") return resumeAtWrite(run);
  if (from === "baseline") { run.req.baseline = true; return baseline(run); }
  if (from === "verify") return verifyOnly(run);
  if (from === "judge") { loadState(run); await criteria(run); return void (await judge(run, 9, fs.readFileSync(path.join(run.dir, process.env.JUDGE_REPORT || "report.md"), "utf8"))); }
  if (from === "bottomline") { loadState(run); const f = path.join(run.dir, "report.md"); return void (await bottomLine(run, fs.readFileSync(f, "utf8"))); }
  // team size: `agents` = researchers + red team (8..128); older requests give the two counts
  let R, X;
  if (run.req.agents) {
    const N = Math.max(4, Math.min(1024, run.req.agents));
    X = Math.max(1, Math.round(N / 5));
    R = N - X;
  } else {
    R = Math.max(2, Math.min(8, run.req.researchers || 6));
    X = Math.max(1, Math.min(3, run.req.redteam || 2));
  }
  if (run.req.mode === "free") return freeRun(run, R, X);
  const B = Math.max(1, Math.round(R / 12));
  run.branches = Array.from({ length: B }, (_, i) => ({ id: `B${i + 1}`, title: "", scope: "" }));
  run.seats = [
    { id: "P", role: "planner", model: LEAD_MODEL },
    ...Array.from({ length: R }, (_, k) => ({ id: `R${k + 1}`, role: "researcher", model: seatModel(run, k), branch: `B${Math.min(B, Math.floor((k * B) / R) + 1)}` })),
    ...Array.from({ length: X }, (_, k) => ({ id: `X${k + 1}`, role: "redteam", model: seatModel(run, R + k), branch: `B${(k % B) + 1}` })),
    { id: "W", role: "writer", model: LEAD_MODEL },
    { id: "J", role: "judge", model: LEAD_MODEL },
  ];
  run.emit({ t: "run", id: run.id, question: run.req.question, seats: run.seats.map(({ id, role, model, branch }) => ({ id, role, model, ...(branch && B > 1 ? { branch } : {}) })), branches: B, budget_min: run.req.minutes || 30, agent: MOCK ? "mock" : AGENT_ID, started_at: new Date(run.started).toISOString() });
  const base = baseline(run);
  let status = "ended";
  try {
    await criteria(run);
    await plan(run);
    await Promise.all(run.branches.map((b) => branchPipeline(run, b)));
    let g = { pass: false, problems: [] };
    for (let round = 1; round <= (run.req.max_rounds || 4); round++) {
      if (round > 1) {
        await redteam(run, round, g.problems);
        await fix(run, round, g.problems);
      }
      g = await gate(run, round);
      if (g.pass || run.minutesLeft() < 6) break;
    }
    let report = await write(run);
    if (report) report = await bottomLine(run, report);
    if (report) report = await verifyReport(run, report);
    for (let attempt = 1; report && attempt <= 2; attempt++) {
      const j = await judge(run, attempt, report);
      if (j.pass) { status = g.pass ? "passed" : "ended"; break; }
      if (run.minutesLeft() < 3) break;
      await fix(run, 10 + attempt, j.notes.split("\n"));
      report = await write(run, j.notes);
      if (report) report = await bottomLine(run, report);
      if (report) report = await verifyReport(run, report);
    }
  } catch (e) {
    run.say("system", `Run error: ${String(e.message || e).slice(0, 300)}`);
    status = "failed";
  }
  await Promise.race([base, sleep(Math.max(0, run.deadline + 10 * 60_000 - Date.now()))]);
  run.emit({ t: "phase", name: "done", round: 1 });
  run.emit({ t: "done", status, totals: { ...run.totals, minutes: Math.round((Date.now() - run.started) / 6000) / 10 } });
}

// ---------------------------------------------------------------- the answer first
// A reader who asked "will he be back or not?" must find Yes or No in the first line, not in the fifth
// sentence of a long paragraph. After the report is written, Argon states the verdict from the report itself
// and it is placed directly under the title.
async function bottomLine(run, report) {
  if (/^\*\*Bottom line/m.test(report.slice(0, 4000))) return report;
  const head = report.slice(0, 9000);
  const tailAt = Math.max(report.lastIndexOf("## Strongest contradicting"), report.lastIndexOf("## Confidence"), report.length - 14000);
  const sys = `You write the bottom line of a research report: the direct answer to the user's question, placed above everything else. Use only what the report says. Write in the language of the user's question. Output exactly this Markdown and nothing else:
**Bottom line: <the verdict in one short sentence>**
- <reason 1, one line, with its claim ids in square brackets as in the report>
- <reason 2>
- <reason 3>
- What would change it: <one line>
The verdict answers what the person asked, in the form they asked it: read the question and the criteria below and answer each thing it asks, starting with the judgement or forecast if it asks for one (a question that asks whether something will happen gets a plain yes or no and how sure the report is, in the report's own terms; a question that asks how many gets the number and its range). Keep it short enough to read at a glance; facts the question also asks for go in the bullets. Say what the report concludes; do not soften it beyond what the report says, and do not sharpen it either.${criteriaText(run) ? `\nCRITERIA THE REPORT IS JUDGED ON:\n${criteriaText(run)}` : ""}`;
  try {
    const res = await modelCall(`USER QUESTION: ${run.req.question}\nToday: ${today()}\n\nREPORT, OPENING:\n${head}\n\nREPORT, CLOSING SECTIONS:\n${fit(report.slice(tailAt), 60000)}`, sys);
    run.totals.tokens += res.tokens;
    const block = res.text.trim().replace(/^```\w*\n?|```$/g, "").trim();
    if (!/^\*\*Bottom line/.test(block)) return report;
    const nl = report.indexOf("\n");
    const out = report.startsWith("# ") && nl > 0 ? `${report.slice(0, nl)}\n\n${block}\n${report.slice(nl)}` : `${block}\n\n${report}`;
    fs.writeFileSync(path.join(run.dir, "report.md"), out);
    run.say("W", block.split("\n")[0].replace(/\*\*/g, ""));
    run.emit({ t: "report" });
    return out;
  } catch (e) {
    return report;
  }
}

// ---------------------------------------------------------------- citation check after writing
// The first evaluation showed the research was sound (88% of quotes found verbatim) but the writer
// attached details to the wrong claim ids. Every sentence (or table row) that carries claim tags is now
// checked against the ledger text and quotes behind exactly those tags; anything the tagged evidence does
// not state is rewritten from that evidence only, or removed.
function citedUnits(report) {
  const units = [];
  for (const line of report.split("\n")) {
    if (!tagsIn(line).length) continue;
    if (line.trim().startsWith("|")) { units.push(line); continue; }
    for (const s of line.split(/(?<=[.!?。！？])\s+/)) if (tagsIn(s).length) units.push(s);
  }
  return [...new Set(units)];
}

function evidenceFor(run, ids) {
  const v = run.view();
  return ids
    .map((id) => {
      const c = v.claims.get(id);
      if (!c) return `${id}: (not in the ledger)`;
      const q = v.sourcesOf(id).filter((x) => x.stance !== "contradicts").slice(0, 3).map((x) => `"${x.quote}" (${x.publisher})`).join(" ");
      return `${id}: ${c.text}${q ? ` | quotes: ${q}` : ""}`;
    })
    .join("\n");
}

async function verifyReport(run, report) {
  const units = citedUnits(report);
  if (!units.length) return report;
  run.emit({ t: "turn", seat: "W", phase: "verify", status: "started" });
  const t0 = Date.now();
  const sys = `You check citations in a research report. Each unit is a sentence or a Markdown table row, followed by the evidence behind the claim ids it cites (the ledger claim text and exact quotes from the sources). A unit is OK only if every specific fact in it (numbers, dates, names, rankings, comparisons) is stated by the evidence of the ids it cites. If not, rewrite the unit so it says only what that evidence supports, keeping its claim tags, language, Markdown and (for a table row) the same number of cells (write "—" in a cell the evidence does not support); if nothing useful remains, return an empty string. Return ONLY JSON {"units":[{"i":0,"ok":true},{"i":1,"ok":false,"why":"…","fixed":"…"}]}.`;
  const batches = [];
  for (let i = 0; i < units.length; i += 15) batches.push(units.slice(i, i + 15).map((u, k) => ({ i: i + k, u })));
  let flagged = 0, rewritten = 0, removed = 0;
  const fixes = new Map();
  await Promise.all(
    batches.map(async (batch) => {
      const input = batch.map(({ i, u }) => `UNIT ${i}:\n${u}\nEVIDENCE:\n${evidenceFor(run, tagsIn(u))}`).join("\n\n");
      try {
        const res = await modelCall(input, sys);
        run.totals.tokens += res.tokens;
        const j = JSON.parse((res.text.match(/\{[\s\S]*\}/) || ["{}"])[0]);
        for (const r of j.units || []) if (r && r.ok === false && typeof r.fixed === "string" && units[r.i] != null) fixes.set(r.i, r.fixed.trim());
      } catch {}
    }),
  );
  let out = report;
  for (const [i, fixed] of fixes) {
    flagged++;
    if (fixed) rewritten++; else removed++;
    out = out.split(units[i]).join(fixed);
  }
  out = out.replace(/\n{3,}/g, "\n\n");
  run.emit({ t: "turn", seat: "W", phase: "verify", status: "completed", searches: [], urls: [], tokens: 0, ms: Date.now() - t0, error: null });
  run.emit({ t: "verify", checked: units.length, flagged, rewritten, removed });
  run.say("W", `Checked ${units.length} cited sentences against the quotes behind their tags: ${flagged} said more than their evidence (${rewritten} rewritten, ${removed} removed).`);
  fs.writeFileSync(path.join(run.dir, "report.md"), out);
  run.emit({ t: "report" });
  return out;
}

// load a finished or interrupted run's state from its files
function loadState(run) {
  const evs = fs.readFileSync(path.join(run.dir, "events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const first = evs.find((e) => e.t === "run");
  run.started = Date.parse(first.started_at);
  run.deadline = Date.now() + 15 * 60_000;
  run.seats = first.seats;
  const B = first.branches || 1;
  run.branches = Array.from({ length: B }, (_, i) => ({ id: `B${i + 1}`, title: "", scope: "" }));
  run.rows = fs.readFileSync(path.join(run.dir, "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const r of run.rows) if (r.type === "question" && /^B\d+$/.test(r.id)) { const b = run.branches.find((x) => x.id === r.id); if (b) { const [t, ...rest] = r.text.split(": "); b.title = t; b.scope = rest.join(": "); } }
  for (const e of evs) {
    if (e.t === "msg") run.room.push({ seat: e.seat, text: e.text, at: e.at });
    if (e.t === "turn" && e.status === "completed") { run.totals.tokens += e.tokens || 0; run.totals.searches += (e.searches || []).length; run.totals.urls_opened += (e.urls || []).length; run.totals.turns += 1; }
  }
  const cf = path.join(run.dir, "criteria.json");
  if (fs.existsSync(cf)) run.criteria = JSON.parse(fs.readFileSync(cf, "utf8"));
  return evs;
}

// re-check an existing report's citations (keeps the original as report.v1.md)
async function verifyOnly(run) {
  loadState(run);
  const f = path.join(run.dir, "report.md");
  const v1 = path.join(run.dir, "report.v1.md");
  if (!fs.existsSync(v1)) fs.copyFileSync(f, v1);
  await verifyReport(run, fs.readFileSync(v1, "utf8"));
}

// finish a run whose research already passed the gate (e.g. the process was killed while writing)
async function resumeAtWrite(run) {
  const evs = fs.readFileSync(path.join(run.dir, "events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const first = evs.find((e) => e.t === "run");
  run.started = Date.parse(first.started_at);
  run.deadline = Date.now() + 15 * 60_000;
  run.seats = first.seats;
  const B = first.branches || 1;
  run.branches = Array.from({ length: B }, (_, i) => ({ id: `B${i + 1}`, title: "", scope: "" }));
  run.rows = fs.readFileSync(path.join(run.dir, "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const r of run.rows) if (r.type === "question" && /^B\d+$/.test(r.id)) { const b = run.branches.find((x) => x.id === r.id); if (b) { const [t, ...rest] = r.text.split(": "); b.title = t; b.scope = rest.join(": "); } }
  for (const e of evs) {
    if (e.t === "msg") run.room.push({ seat: e.seat, text: e.text, at: e.at });
    if (e.t === "turn" && e.status === "completed") { run.totals.tokens += e.tokens || 0; run.totals.searches += (e.searches || []).length; run.totals.urls_opened += (e.urls || []).length; run.totals.turns += 1; }
  }
  const gates = evs.filter((e) => e.t === "gate");
  const gatePassed = gates.length && gates[gates.length - 1].pass;
  run.say("system", "Resumed at the writing step (the earlier process stopped while writing).");
  let status = "ended";
  let report = await write(run);
  for (let attempt = 1; report && attempt <= 2; attempt++) {
    const j = await judge(run, attempt, report);
    if (j.pass) { status = gatePassed ? "passed" : "ended"; break; }
    if (attempt === 2) break;
    report = await write(run, j.notes);
  }
  run.emit({ t: "phase", name: "done", round: 1 });
  run.emit({ t: "done", status, totals: { ...run.totals, minutes: Math.round((Date.now() - run.started) / 6000) / 10 } });
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
