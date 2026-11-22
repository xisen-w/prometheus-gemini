// The judgement layer: reasoning on top of a run's evidence ledger, not more collection.
//   node reason.mjs <runId>
// Reads runs/<id>/ledger.jsonl and writes runs/<id>/judgement.md (and puts it at the top of report.md).
//
// 1. Frame   : turn the question into forecastable propositions with a date and a way to tell who was right,
//              and name the cruxes the outcome turns on.
// 2. Cruxes  : for each crux, pull the relevant claims out of the ledger and have an analyst say which way the
//              evidence points, how strongly, and what would flip it.
// 3. Outside : reference classes and their base rates (from the models' own knowledge, marked as such).
// 4. Forecast: independent forecasters (four Gemini 4 models, three stances) each give a probability and the
//              reasoning; then they see each other's arguments once and may update.
// 5. Red team: the strongest case for the side the desk bets against.
// 6. Memo    : one page: the call, the chain of reasoning, the scenario tree, where it differs from the
//              market and why, what to watch.
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const id = process.argv[2];
const DIR = path.join(ROOT, "runs", id);
const question = JSON.parse(fs.readFileSync(path.join(DIR, "request.json"), "utf8")).question;
const ai = new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY || fs.readFileSync(path.join(os.homedir(), ".config/gemini/api_key"), "utf8")).trim() });
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let active = 0; const queue = []; const usage = { calls: 0, tokens: 0 };
async function slot(fn) { while (active >= 16) await new Promise((r) => queue.push(r)); active++; try { return await fn(); } finally { active--; queue.shift()?.(); } }
async function ask(model, system, text, json = true) {
  return slot(async () => {
    for (let i = 0; ; i++) {
      try {
        const res = await ai.models.generateContent({ model, contents: [{ role: "user", parts: [{ text }] }], config: { systemInstruction: system, ...(json ? { responseMimeType: "application/json" } : {}) } });
        usage.calls++; usage.tokens += res.usageMetadata?.totalTokenCount || 0;
        if (!json) return res.text;
        return JSON.parse((res.text.match(/[\[{][\s\S]*[\]}]/) || ["null"])[0]);
      } catch (e) {
        if (i >= 4) return null;
        await sleep((/429|rate|quota|exhaust/i.test(String(e.message)) ? 15000 : 3000) * (i + 1));
      }
    }
  });
}
const log = (m) => { console.log(m); fs.appendFileSync(path.join(DIR, "judgement.log"), m + "\n"); };

// ---- the ledger, latest row wins
const rows = fs.readFileSync(path.join(DIR, "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const latest = new Map();
for (const r of rows) if (r.id && (r.type === "claim" || r.type === "source")) latest.set(`${r.type}:${r.id}`, r);
const claims = [...latest.values()].filter((r) => r.type === "claim" && r.status !== "dropped" && r.text);
const sourcesOf = new Map();
for (const r of latest.values()) if (r.type === "source" && r.status !== "dropped") { if (!sourcesOf.has(r.claim)) sourcesOf.set(r.claim, []); sourcesOf.get(r.claim).push(r); }
const words = (t) => String(t).toLowerCase().match(/[a-z0-9][a-z0-9.%$-]{2,}|[㐀-鿿]{2}/g) || [];
const df = new Map();
const cw = claims.map((c) => { const w = new Set(words(c.text)); for (const x of w) df.set(x, (df.get(x) || 0) + 1); return w; });
// claims most related to a set of search phrases (tf-idf overlap; no model call)
function retrieve(phrases, n = 60) {
  const q = new Set(phrases.flatMap(words));
  const scored = claims.map((c, i) => { let s = 0; for (const w of q) if (cw[i].has(w)) s += Math.log(claims.length / (df.get(w) || 1)); return [s + (c.key ? 0.5 : 0), i]; }).filter((x) => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, n);
  return scored.map(([, i]) => claims[i]);
}
const show = (c) => { const s = (sourcesOf.get(c.id) || []); const pubs = [...new Set(s.map((x) => x.publisher).filter(Boolean))].slice(0, 4).join("; "); const contra = s.filter((x) => x.stance === "contradicts").length; return `[${c.id}]${c.as_of ? ` (as of ${c.as_of})` : ""} ${c.text}${pubs ? ` | sources: ${pubs}` : ""}${contra ? ` | ${contra} contradicting` : ""}`; };

// ---- 1. frame
log(`reasoning over ${claims.length} claims for: ${question}`);
const frame = await ask("gemini-4-argon", `You frame a question for forecasting and judgement. Today is ${today}. The person does not want a summary of facts; they want a judgement they can act on.
Return JSON:
{"propositions":[{"id":"P1","statement":"a yes/no statement with a date by which it is settled","resolves":"how one would tell who was right","why_it_matters":"one line"}],   // 1 to 3; the first is the heart of the question
 "cruxes":[{"id":"K1","question":"the thing the outcome turns on, as a question","why":"how it moves the answer","search":["5-8 short phrases to find relevant evidence"]}],   // 5 to 8, about decisions, incentives, constraints and timing of the actors, not about recounting events
 "actors":[{"name":"who has power over the outcome","wants":"...","can":"what they can actually do","constraint":"what limits them"}],
 "reference_classes":["2-4 classes of past cases to take base rates from"]}
Write in the language of the question.`, `QUESTION: ${question}\n\nWHAT THE EVIDENCE COVERS (a sample of key claims):\n${claims.filter((c) => c.key).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 150)) === 0).slice(0, 150).map(show).join("\n")}`);
if (!frame?.propositions?.length) throw new Error("framing failed");
fs.writeFileSync(path.join(DIR, "judgement.frame.json"), JSON.stringify(frame, null, 1));
log(`propositions: ${frame.propositions.map((p) => p.statement).join(" | ")}`);
log(`cruxes: ${frame.cruxes.map((k) => k.question).join(" | ")}`);

// ---- 2. cruxes, each with its own evidence from the ledger
const CRUX_MODELS = ["gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", "gemini-4-neon"];
const cruxes = await Promise.all(frame.cruxes.map(async (k, i) => {
  const ev = retrieve([k.question, ...(k.search || [])], 70);
  const a = await ask(CRUX_MODELS[i % CRUX_MODELS.length], `You are an analyst. You get one crux of a larger question and the evidence a research team collected on it. Do not recount the evidence: reason from it. Today is ${today}. Return JSON:
{"reading":"which way this crux currently points and why, 3-5 sentences of reasoning: what the actors' incentives and constraints imply, not what happened",
 "direction":"toward P1 true | toward P1 false | genuinely open",
 "strength":"strong | moderate | weak",
 "best_evidence":["up to 4 claim ids that carry the reading"],
 "against":"the best evidence or argument against your reading, with claim ids",
 "would_flip":"the specific observable event that would reverse this reading",
 "missing":"what nobody has found that would settle it"}
Write in the language of the question.`, `QUESTION: ${question}\nMAIN PROPOSITION P1: ${frame.propositions[0].statement}\nCRUX ${k.id}: ${k.question}\nWhy it matters: ${k.why}\n\nEVIDENCE FROM THE LEDGER:\n${ev.map(show).join("\n")}`);
  return { ...k, n_evidence: ev.length, ...(a || {}) };
}));
fs.writeFileSync(path.join(DIR, "judgement.cruxes.json"), JSON.stringify(cruxes, null, 1));
for (const k of cruxes) log(`${k.id} ${k.direction} (${k.strength}): ${k.question}`);

// ---- 3. the outside view
const outside = await ask("gemini-4-argon", `You give the outside view. For each reference class, name real past cases you know (from your own knowledge: say so, and do not invent cases; if you are not sure a case happened as you describe, leave it out), count how they ended, and give the base rate. Then say how this case differs from the class in ways that should move the number, and in which direction. Today is ${today}. Return JSON {"classes":[{"class":"...","cases":[{"case":"...","outcome":"..."}],"base_rate":"x of y, about z%","differences":"..."}],"outside_view":"the probability for P1 from base rates alone, and why"}. Write in the language of the question.`, `QUESTION: ${question}\nP1: ${frame.propositions[0].statement}\nREFERENCE CLASSES: ${frame.reference_classes.join("; ")}\nACTORS: ${JSON.stringify(frame.actors)}`);
fs.writeFileSync(path.join(DIR, "judgement.outside.json"), JSON.stringify(outside, null, 1));
log(`outside view: ${outside?.outside_view || "(none)"}`);

// ---- 4. independent forecasts, then one round of seeing each other's arguments
const pack = `QUESTION: ${question}\nToday: ${today}\n\nPROPOSITIONS:\n${frame.propositions.map((p) => `${p.id}: ${p.statement} (settled: ${p.resolves})`).join("\n")}\n\nACTORS:\n${frame.actors.map((a) => `- ${a.name}: wants ${a.wants}; can ${a.can}; limited by ${a.constraint}`).join("\n")}\n\nCRUXES, AS READ BY THE ANALYSTS:\n${cruxes.map((k) => `${k.id} ${k.question}\n  reading (${k.direction}, ${k.strength}): ${k.reading}\n  against: ${k.against}\n  would flip: ${k.would_flip}\n  missing: ${k.missing}`).join("\n")}\n\nOUTSIDE VIEW:\n${(outside?.classes || []).map((c) => `- ${c.class}: ${c.base_rate}. ${c.differences}`).join("\n")}\n${outside?.outside_view || ""}`;
const STANCES = [
  ["outside view first", "Start from the base rates and move away from them only as far as the specifics force you."],
  ["inside view", "Reason through the actors: who decides, what each wants, what each can actually do, in what order and by when. Build the path to each outcome and judge how likely each step is."],
  ["contrarian", "Assume the consensus reading is wrong and find the strongest reason it could be. Give the probability you would defend after that."],
];
const MODELS = ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon", "gemini-4-argon"];
const FSYS = (stance, how) => `You are a forecaster (${stance}). ${how} You are scored on calibration: say 80% only for things that happen 4 times in 5. Give a probability for each proposition, the two or three steps of reasoning that carry it, and the one observation that would move you most. Return JSON {"forecasts":[{"id":"P1","p":0.0}],"reasoning":"4-6 sentences, an argument, not a list of facts","biggest_driver":"...","would_move_me":"..."}. Write in the language of the question.`;
const seats = MODELS.flatMap((m) => STANCES.map(([s, how]) => ({ model: m, stance: s, how })));
await Promise.all(seats.map(async (f) => { f.r1 = await ask(f.model, FSYS(f.stance, f.how), pack); }));
const got = seats.filter((f) => f.r1?.forecasts?.length);
const p1 = (r) => Number(r?.forecasts?.find((x) => x.id === "P1")?.p ?? r?.forecasts?.[0]?.p);
const median = (a) => { const s = a.filter((x) => isFinite(x)).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
log(`round 1: ${got.map((f) => p1(f.r1).toFixed(2)).join(" ")} -> median ${median(got.map((f) => p1(f.r1))).toFixed(2)}`);
const others = (me) => got.filter((f) => f !== me).map((f, i) => `Forecaster ${i + 1} (${f.stance}): P1 = ${p1(f.r1).toFixed(2)}. ${f.r1.reasoning} Driver: ${f.r1.biggest_driver}`).join("\n");
await Promise.all(got.map(async (f) => { f.r2 = await ask(f.model, FSYS(f.stance, f.how) + ` This is the second round: you now see the other forecasters' arguments. Update only for arguments you had not weighed; do not move just because others disagree. Add "changed":"what moved you, or why nothing did".`, `${pack}\n\nYOUR FIRST FORECAST: P1 = ${p1(f.r1).toFixed(2)}. ${f.r1.reasoning}\n\nTHE OTHERS:\n${others(f)}`); }));
const finalPs = got.map((f) => p1(f.r2?.forecasts ? f.r2 : f.r1));
const desk = median(finalPs);
log(`round 2: ${finalPs.map((x) => x.toFixed(2)).join(" ")} -> median ${desk.toFixed(2)}`);
fs.writeFileSync(path.join(DIR, "judgement.forecasts.json"), JSON.stringify(got, null, 1));

// ---- 5. red team: the best case for the other side
const lean = desk < 0.5 ? "P1 is TRUE" : "P1 is FALSE";
const red = await ask("gemini-4-carbon", `You are the red team. The desk's forecast is below. Build the strongest honest case that ${lean}: the most plausible path by which it happens, step by step, with the probability of each step, and what the desk is most likely underweighting. Then say whether the desk's number should move, and to what. Return JSON {"path":["step 1 (p=..)","step 2 (p=..)"],"path_probability":0.0,"underweighted":"...","verdict":"keep | move","to":0.0,"why":"..."}. Write in the language of the question.`, `${pack}\n\nDESK: median P1 = ${desk.toFixed(2)}, range ${Math.min(...finalPs).toFixed(2)} to ${Math.max(...finalPs).toFixed(2)}.\nArguments:\n${got.map((f) => `- (${f.stance}) ${(f.r2?.reasoning || f.r1.reasoning)}`).join("\n")}`);
fs.writeFileSync(path.join(DIR, "judgement.redteam.json"), JSON.stringify(red, null, 1));
log(`red team: ${red?.verdict} ${red?.to ?? ""} ${red?.why || ""}`);

// ---- 6. the memo
const market = retrieve(["prediction market", "Polymarket", "Kalshi", "odds", "probability", "priced", "implied"], 12).map(show).join("\n");
const memo = await ask("gemini-4-argon", `You write a one-page judgement memo for a decision-maker who already knows the facts and is tired of summaries. Today is ${today}. Write in the language of the question. No recounting of events: every sentence is reasoning, a judgement, or a number. At most 650 words. Structure, in Markdown:

**The call:** one sentence: the answer and the probability (the desk's median after the red team; if you move it, say why).
### Why
Three to five numbered steps of reasoning, each a link in a chain ("because X controls Y, and X's incentive is Z, ..."), each citing the claim ids it rests on in square brackets.
### Scenarios
A small table: scenario | what has to happen | probability. Probabilities sum to 100%.
### Where this differs from the market
What the market or the consensus says (cite ids if the evidence has a price), whether the desk is above or below, and the specific reason for the gap; or say plainly that there is no gap.
### Where the desk disagrees with itself
The widest split among the forecasters and what assumption it comes from.
### What to watch
Three to five dated or observable signposts; for each, which way it moves the number and roughly how far.
### What we do not know
The one or two missing facts that matter most.
Use only the material given. Do not add hedging language beyond the probabilities themselves.`, `${pack}\n\nFORECASTS AFTER ROUND 2 (median ${desk.toFixed(2)}):\n${got.map((f) => `- ${f.model.replace("gemini-4-", "")} / ${f.stance}: ${p1(f.r1).toFixed(2)} -> ${p1(f.r2?.forecasts ? f.r2 : f.r1).toFixed(2)}. ${f.r2?.reasoning || f.r1.reasoning}${f.r2?.changed ? ` Changed: ${f.r2.changed}` : ""}`).join("\n")}\n\nRED TEAM (case that ${lean}): path ${JSON.stringify(red?.path || [])}, path probability ${red?.path_probability}; underweighted: ${red?.underweighted}; verdict ${red?.verdict} ${red?.to ?? ""}: ${red?.why}\n\nBEST EVIDENCE PER CRUX (claim ids): ${cruxes.map((k) => `${k.id}: ${(k.best_evidence || []).join(", ")}`).join(" | ")}\n\nMARKET OR CONSENSUS EVIDENCE IN THE LEDGER:\n${market || "(none found)"}`, false);
if (!memo) throw new Error("memo failed");
const head = `## Judgement\n\n${memo.trim()}\n\n<sub>How this was produced: ${got.length} independent forecasts (four Gemini 4 models, three stances), two rounds, median ${desk.toFixed(2)} (range ${Math.min(...finalPs).toFixed(2)}–${Math.max(...finalPs).toFixed(2)}); ${cruxes.length} cruxes read against ${claims.length} ledger claims; base rates come from the models' own knowledge and were not re-checked against sources; ${usage.calls} model calls, ${(usage.tokens / 1e6).toFixed(2)}M tokens.</sub>\n`;
fs.writeFileSync(path.join(DIR, "judgement.md"), head);
// the judgement goes above the long report; the report becomes the evidence behind it
const rp = path.join(DIR, "report.md");
if (fs.existsSync(rp)) {
  let r = fs.readFileSync(rp, "utf8");
  r = r.replace(/\n## Judgement\n[\s\S]*?\n---\n\n## Evidence report\n/, "\n");
  const nl = r.indexOf("\n");
  r = r.startsWith("# ") ? `${r.slice(0, nl)}\n\n${head}\n---\n\n## Evidence report\n${r.slice(nl)}` : `${head}\n---\n\n## Evidence report\n\n${r}`;
  fs.writeFileSync(rp, r);
}
log(`done: ${usage.calls} calls, ${(usage.tokens / 1e6).toFixed(2)}M tokens`);
console.log("\n" + head);
