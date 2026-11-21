// Evaluation: the swarm vs Google's Deep Research agent on the same question, scored on what can be verified.
//   node eval.mjs <runId> [<runId> ...]     score runs that have report.md and baseline.md
//   node eval.mjs --table                   rebuild eval/results.md from every runs/*/eval.json
//
// For each system we take the cited claims of its final answer (swarm: sentences with [C…] tags -> the ledger
// sources behind each tag; baseline: claims + URLs extracted from its answer by Gemini 4 Argon), re-open every
// cited page ourselves, and ask the same judge (Gemini 4 Argon) whether the page supports the claim.
// The same procedure, the same judge, the same page fetcher for both systems.
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// claim tags: [C1-2] or [C1-2, C3-4]
const TAG_RE = /\[((?:C\d+-\d+)(?:\s*[,;]\s*C\d+-\d+)*)\]/g;
const tagsIn = (text) => [...new Set([...String(text).matchAll(TAG_RE)].flatMap((m) => m[1].split(/\s*[,;]\s*/)))];
const stripTags = (text) => String(text).replace(/\s*\[(?:C\d+-\d+)(?:\s*[,;]\s*C\d+-\d+)*\]/g, "");
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const JUDGE = process.env.EVAL_JUDGE || "gemini-4-argon";
const PER_SYSTEM = Number(process.env.EVAL_CLAIMS || 20);
const key = process.env.GEMINI_API_KEY || fs.readFileSync(path.join(os.homedir(), ".config/gemini/api_key"), "utf8").trim();
const ai = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1beta" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function ask(input, system) {
  for (let i = 0; ; i++) {
    try {
      const it = await ai.interactions.create({ model: JUDGE, input, system_instruction: system });
      const text = it.output_text || (it.steps || []).flatMap((s) => (s.type === "model_output" ? (s.content || []).map((c) => c.text || "") : [])).join("\n");
      return JSON.parse((text.match(/[\[{][\s\S]*[\]}]/) || ["null"])[0]);
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(3000 * 2 ** i);
    }
  }
}

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const norm = (s) => strip(String(s || "")).replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-").toLowerCase();

const pageCache = new Map();
const finalOf = new Map();
async function page(url) {
  if (pageCache.has(url)) return pageCache.get(url);
  const p = (async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (evaluation; citation re-check)", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } });
      clearTimeout(t);
      if (r.url) finalOf.set(url, r.url);
      if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
      const type = r.headers.get("content-type") || "";
      if (!/html|text|json|xml/.test(type)) return { ok: false, why: `unreadable ${type.split(";")[0]}` };
      const text = strip((await r.text()).slice(0, 3_000_000));
      if (text.length < 200) return { ok: false, why: "empty page (script-rendered or blocked)" };
      return { ok: true, text };
    } catch (e) {
      return { ok: false, why: e.name === "AbortError" ? "timeout" : "fetch failed" };
    }
  })();
  pageCache.set(url, p);
  return p;
}

const host = (u) => { try { return new URL(finalOf.get(u) || u).hostname.replace(/^www\./, ""); } catch { return ""; } };

// pick the part of a long page most related to the claim (word overlap over sliding windows)
function excerpt(text, claim, size = 12000) {
  if (text.length <= size) return text;
  const words = new Set(norm(claim).split(/\W+/).filter((w) => w.length > 3));
  let best = 0, bestAt = 0;
  for (let at = 0; at < text.length; at += 2000) {
    const win = text.slice(at, at + size).toLowerCase();
    let score = 0;
    for (const w of words) if (win.includes(w)) score++;
    if (score > best) { best = score; bestAt = at; }
  }
  return text.slice(bestAt, bestAt + size);
}

const JUDGE_SYS = `You check citations. You get one claim from a research report and the text of a web page the report cites for it. Decide only from the page text: "supported" (the page states it, numbers and dates match), "partial" (the page supports part of it, or a looser version), or "unsupported" (the page does not say it, or says something different). Return ONLY JSON {"verdict":"supported|partial|unsupported","why":"one short sentence"}.`;

const TOGETHER_SYS = `You check citations. You get one claim from a research report and the text of every web page the report cites for it. Decide only from these pages, taken together: "supported" (together they state every part of the claim; numbers and dates match), "partial" (they support part of it, or a looser version), or "unsupported". Return ONLY JSON {"verdict":"supported|partial|unsupported","why":"one short sentence"}.`;

async function judgeUnit(unit) {
  const r = await judgeEach(unit);
  // second reading: all cited pages together (a compound claim may rest on several pages)
  const pages = [];
  for (const url of unit.urls.slice(0, 3)) { const pg = await page(url); if (pg.ok) pages.push({ url, text: pg.text }); }
  let together = "unreachable", togetherWhy = "";
  if (pages.length) {
    try {
      const v = await ask(`CLAIM: ${unit.claim}\n\n${pages.map((p, i) => `PAGE ${i + 1} (${p.url}):\n${excerpt(p.text, unit.claim, Math.floor(24000 / pages.length))}`).join("\n\n")}`, TOGETHER_SYS);
      together = v?.verdict || "error"; togetherWhy = v?.why || "";
    } catch (e) { together = "error"; }
  }
  return { ...r, together, together_why: togetherWhy };
}

async function judgeEach(unit) {
  const tried = [];
  let best = null;
  for (const url of unit.urls.slice(0, 3)) {
    const pg = await page(url);
    if (!pg.ok) { tried.push({ url, verdict: "unreachable", why: pg.why }); continue; }
    let v;
    try {
      v = await ask(`CLAIM: ${unit.claim}\n\nPAGE (${url}):\n${excerpt(pg.text, unit.claim)}`, JUDGE_SYS);
    } catch (e) {
      v = { verdict: "error", why: String(e.message).slice(0, 120) };
    }
    tried.push({ url, verdict: v?.verdict || "error", why: v?.why || "" });
    if (v?.verdict === "supported") { best = "supported"; break; }
    if (v?.verdict === "partial") best = "partial";
    else if (!best && v?.verdict === "unsupported") best = "unsupported";
  }
  return { ...unit, verdict: best || "unreachable", tried };
}

function spread(arr, n) {
  if (arr.length <= n) return arr;
  return Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]);
}

function readLedger(dir) {
  const rows = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const latest = new Map();
  for (const r of rows) if (r.id) latest.set(`${r.type}:${r.id}`, r);
  const of = (t) => [...latest.values()].filter((r) => r.type === t && r.status !== "dropped");
  return { rows, claims: of("claim"), sources: of("source"), checks: rows.filter((r) => r.type === "check"), challenges: of("challenge"), resolutions: rows.filter((r) => r.type === "resolution"), notFound: rows.filter((r) => r.type === "not_found") };
}

function swarmUnits(report, L) {
  const units = [];
  const body = report.replace(/\r/g, "");
  const sentences = body.split(/(?<=[.!?。！？])\s+|\n+/).filter((s) => tagsIn(s).length);
  for (const s of sentences) {
    const tags = tagsIn(s);
    const urls = [...new Set(L.sources.filter((x) => tags.includes(x.claim) && x.stance !== "contradicts").map((x) => x.url))];
    const claim = stripTags(s).replace(/^[-*#>\s|]+/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
    if (claim.length > 20) units.push({ claim, urls, tags });
  }
  return units;
}

function linkTags(report, L) {
  return report.replace(TAG_RE, (_, ids) => {
    const urls = [...new Set(ids.split(/\s*[,;]\s*/).flatMap((id) => L.sources.filter((x) => x.claim === id && x.stance !== "contradicts").map((x) => x.url)))].slice(0, 4);
    return urls.map((u, i) => `[${i + 1}](${u})`).join(" ");
  });
}

async function baselineUnits(md) {
  const sys = `Extract the factual claims from a research report that cite a source. For each, give the claim as one self-contained sentence and the exact URL(s) the report cites for it (resolve numbered references like [3] to their URL from the report's reference list). Skip claims with no resolvable URL. Return ONLY JSON {"claims":[{"claim":"...","urls":["https://..."]}],"uncited_claims":<number of factual claims with no citation>}.`;
  const j = await ask(md.slice(0, 200_000), sys);
  return { units: (j?.claims || []).filter((c) => c.claim && (c.urls || []).length), uncited: j?.uncited_claims ?? null };
}

function summarise(units, judged) {
  const count = (v) => judged.filter((u) => u.verdict === v).length;
  const reached = judged.filter((u) => u.verdict !== "unreachable").length;
  // strict variant: only the first cited page counts (the swarm usually cites several per claim)
  const firstReached = judged.filter((u) => u.tried?.[0] && !["unreachable", "error"].includes(u.tried[0].verdict));
  const firstSupported = firstReached.filter((u) => u.tried[0].verdict === "supported").length;
  const allUrls = new Set(units.flatMap((u) => u.urls));
  return {
    cited_claims: units.length,
    distinct_urls: allUrls.size,
    distinct_domains: new Set([...allUrls].map(host).filter(Boolean)).size,
    mean_domains_per_claim: units.length ? +(units.reduce((a, u) => a + new Set(u.urls.map(host)).size, 0) / units.length).toFixed(2) : 0,
    sampled: judged.length,
    reached,
    supported: count("supported"),
    partial: count("partial"),
    unsupported: count("unsupported"),
    unreachable: count("unreachable"),
    support_rate: reached ? +(count("supported") / reached).toFixed(3) : null,
    support_or_partial_rate: reached ? +((count("supported") + count("partial")) / reached).toFixed(3) : null,
    together_reached: judged.filter((u) => ["supported", "partial", "unsupported"].includes(u.together)).length,
    together_supported: judged.filter((u) => u.together === "supported").length,
    together_unsupported: judged.filter((u) => u.together === "unsupported").length,
    together_rate: (() => { const n = judged.filter((u) => ["supported", "partial", "unsupported"].includes(u.together)).length; return n ? +(judged.filter((u) => u.together === "supported").length / n).toFixed(3) : null; })(),
    first_url_reached: firstReached.length,
    first_url_supported: firstSupported,
    first_url_support_rate: firstReached.length ? +(firstSupported / firstReached.length).toFixed(3) : null,
  };
}

async function quoteRate(L) {
  const keyIds = new Set(L.claims.filter((c) => c.key).map((c) => c.id));
  const srcs = spread(L.sources.filter((s) => keyIds.has(s.claim) && s.quote), 40);
  const res = await pool(srcs, 8, async (s) => {
    const pg = await page(s.url);
    if (!pg.ok) return "unreachable";
    const q = norm(s.quote), body = norm(pg.text);
    if (body.includes(q)) return "found";
    const w = q.split(" ");
    return w.length >= 8 && body.includes(w.slice(1, -1).join(" ")) ? "found" : "missing";
  });
  const reached = res.filter((r) => r !== "unreachable").length;
  return { checked: res.length, reached, found: res.filter((r) => r === "found").length, rate: reached ? +(res.filter((r) => r === "found").length / reached).toFixed(3) : null };
}

async function edgeCheck(question, expect, ours, theirs) {
  if (!expect) return null;
  const sys = `You grade whether an answer handles an edge case correctly. Return ONLY JSON {"a":true|false,"b":true|false,"why":"one sentence"}.`;
  return ask(`QUESTION: ${question}\nWHAT A CORRECT ANSWER MUST DO: ${expect}\n\nANSWER A:\n${ours.slice(0, 30000)}\n\nANSWER B:\n${theirs.slice(0, 30000)}`, sys);
}

async function evalRun(id) {
  const dir = path.join(ROOT, "runs", id);
  const req = JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"));
  const report = fs.readFileSync(path.join(dir, process.env.EVAL_REPORT || "report.md"), "utf8");
  const base = fs.readFileSync(path.join(dir, "baseline.md"), "utf8");
  const evs = fs.readFileSync(path.join(dir, "events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const L = readLedger(dir);
  const testset = fs.existsSync(path.join(ROOT, "eval/testset.json")) ? JSON.parse(fs.readFileSync(path.join(ROOT, "eval/testset.json"), "utf8")) : [];
  const spec = testset.find((t) => t.question === req.question) || {};

  // the same extractor and the same judge for both answers
  const [{ units: ours, uncited: ourUncited }, { units: theirs, uncited }] = await Promise.all([baselineUnits(linkTags(report, L)), baselineUnits(base)]);
  // resolve every cited URL once, so domains are counted where the links really go
  await pool([...new Set([...ours, ...theirs].flatMap((u) => u.urls))], 12, page);
  const [jo, jt] = await Promise.all([pool(spread(ours, PER_SYSTEM), 6, judgeUnit), pool(spread(theirs, PER_SYSTEM), 6, judgeUnit)]);
  const quotes = await quoteRate(L);
  const edge = await edgeCheck(req.question, spec.expect, report, base).catch(() => null);

  const turns = evs.filter((e) => e.t === "turn" && e.status === "completed");
  const done = evs.filter((e) => e.t === "done").pop();
  const bl = evs.filter((e) => e.t === "baseline" && e.status === "completed").pop();
  const first = evs.find((e) => e.t === "run");
  const result = {
    run: id,
    question: req.question,
    kind: spec.kind || "–",
    agents: first.seats.filter((s) => ["researcher", "redteam"].includes(s.role)).length,
    judge: JUDGE,
    mode: first.mode === "free" ? "no orchestrator" : "orchestrated",
    method: "same Argon extraction of cited claims from both answers (swarm tags linked to their ledger sources); every cited page re-fetched; same Argon judge",
    swarm: {
      ...summarise(ours, jo),
      uncited_claims: ourUncited,
      quote_verbatim: quotes,
      key_claims: L.claims.filter((c) => c.key).length,
      redteam_checks: L.checks.length,
      checks_confirmed: L.checks.filter((k) => k.result === "confirmed").length,
      challenges: L.challenges.length,
      challenges_resolved: new Set(L.resolutions.map((r) => r.challenge)).size,
      contradicting_sources: L.sources.filter((s) => s.stance === "contradicts").length,
      not_found: L.notFound.length,
      searches: turns.reduce((a, e) => a + (e.searches || []).length, 0),
      pages_opened: turns.reduce((a, e) => a + (e.urls || []).length, 0),
      tokens: done?.totals?.tokens ?? turns.reduce((a, e) => a + (e.tokens || 0), 0),
      minutes: done?.totals?.minutes ?? null,
      edge_ok: edge ? edge.a : null,
    },
    baseline: {
      agent: bl?.agent,
      ...summarise(theirs, jt),
      uncited_claims: uncited,
      redteam_checks: 0,
      searches: (bl?.searches || []).length,
      pages_opened: (bl?.urls || []).length,
      tokens: bl?.tokens ?? null,
      minutes: bl?.ms ? +(bl.ms / 60000).toFixed(1) : null,
      edge_ok: edge ? edge.b : null,
    },
    edge_why: edge?.why || null,
    details: { swarm: jo, baseline: jt },
  };
  result.report_file = process.env.EVAL_REPORT || "report.md";
  fs.writeFileSync(path.join(dir, process.env.EVAL_OUT || "eval.json"), JSON.stringify(result, null, 2));
  return result;
}

function pct(x) { return x == null ? "–" : `${Math.round(x * 100)}%`; }
function table() {
  const rs = fs.readdirSync(path.join(ROOT, "runs")).map((d) => path.join(ROOT, "runs", d, "eval.json")).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  const lines = [
    "| Question | Kind | Agents | Cited claims (swarm / DR) | Citation supported, any cited page (swarm / DR) | First cited page only (swarm / DR) | Supported or partial (swarm / DR) | Domains per claim (swarm / DR) | Quotes found verbatim (swarm) | Red-team checks / challenges | Edge case handled (swarm / DR) |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const agg = { s: { sup: 0, part: 0, reach: 0, f: 0, fr: 0 }, b: { sup: 0, part: 0, reach: 0, f: 0, fr: 0 } };
  for (const r of rs) {
    const s = r.swarm, b = r.baseline;
    agg.s.sup += s.supported; agg.s.part += s.partial; agg.s.reach += s.reached; agg.s.f += s.first_url_supported || 0; agg.s.fr += s.first_url_reached || 0;
    agg.b.sup += b.supported; agg.b.part += b.partial; agg.b.reach += b.reached; agg.b.f += b.first_url_supported || 0; agg.b.fr += b.first_url_reached || 0;
    lines.push(`| ${r.question.slice(0, 70)}${r.question.length > 70 ? "…" : ""} | ${r.kind} | ${r.agents} | ${s.cited_claims} / ${b.cited_claims} | ${pct(s.support_rate)} (${s.supported}/${s.reached}) / ${pct(b.support_rate)} (${b.supported}/${b.reached}) | ${pct(s.first_url_support_rate)} / ${pct(b.first_url_support_rate)} | ${pct(s.support_or_partial_rate)} / ${pct(b.support_or_partial_rate)} | ${s.mean_domains_per_claim} / ${b.mean_domains_per_claim} | ${pct(s.quote_verbatim?.rate)} (${s.quote_verbatim?.found}/${s.quote_verbatim?.reached}) | ${s.redteam_checks} / ${s.challenges} | ${s.edge_ok == null ? "–" : s.edge_ok ? "yes" : "no"} / ${b.edge_ok == null ? "–" : b.edge_ok ? "yes" : "no"} |`);
  }
  const tot = `\n**All questions pooled:** citations supported, swarm ${pct(agg.s.reach ? agg.s.sup / agg.s.reach : null)} (${agg.s.sup}/${agg.s.reach}) vs Deep Research ${pct(agg.b.reach ? agg.b.sup / agg.b.reach : null)} (${agg.b.sup}/${agg.b.reach}); supported or partial ${pct(agg.s.reach ? (agg.s.sup + agg.s.part) / agg.s.reach : null)} vs ${pct(agg.b.reach ? (agg.b.sup + agg.b.part) / agg.b.reach : null)}; first cited page only ${pct(agg.s.fr ? agg.s.f / agg.s.fr : null)} (${agg.s.f}/${agg.s.fr}) vs ${pct(agg.b.fr ? agg.b.f / agg.b.fr : null)} (${agg.b.f}/${agg.b.fr}).\n`;
  fs.mkdirSync(path.join(ROOT, "eval"), { recursive: true });
  const md = `# Results\n\nJudge: ${rs[0]?.judge || JUDGE}. Up to ${PER_SYSTEM} cited claims per system per question, spread evenly through each answer; every cited page re-fetched by the evaluator; unreachable pages excluded from the rates and counted separately in eval.json.\n\n${lines.join("\n")}\n${tot}`;
  fs.writeFileSync(path.join(ROOT, "eval/results.md"), md);
  fs.writeFileSync(path.join(ROOT, "eval/results.json"), JSON.stringify(rs.map(({ details, ...r }) => r), null, 2));
  return md;
}

// diagnostic: score the ledger's key claims themselves (claim text vs its own sources), before any writing
async function ledgerScore(id) {
  const L = readLedger(path.join(ROOT, "runs", id));
  const units = L.claims.filter((c) => c.key).map((c) => ({ claim: c.text, tags: [c.id], urls: [...new Set(L.sources.filter((x) => x.claim === c.id && x.stance !== "contradicts").map((x) => x.url))] })).filter((u) => u.urls.length);
  const judged = await pool(spread(units, PER_SYSTEM), 6, judgeUnit);
  const r = { run: id, ...summarise(units, judged) };
  fs.writeFileSync(path.join(ROOT, "runs", id, "eval.ledger.json"), JSON.stringify({ ...r, details: judged }, null, 2));
  return r;
}

const args = process.argv.slice(2);
if (args[0] === "--ledger") {
  for (const id of args.slice(1)) {
    const r = await ledgerScore(id);
    console.log(id, "ledger key claims: together", `${r.together_supported}/${r.together_reached}`, r.together_rate, "| single page", `${r.supported}/${r.reached}`, r.support_rate, "| unsupported", r.together_unsupported);
  }
} else if (args[0] === "--table") console.log(table());
else {
  for (const id of args) {
    try {
      const r = await evalRun(id);
      console.log(id, "swarm", JSON.stringify({ ...r.swarm }), "\n   baseline", JSON.stringify(r.baseline));
    } catch (e) {
      console.error(id, "FAILED", e.message);
    }
  }
  console.log(table());
}
