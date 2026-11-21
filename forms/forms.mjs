// Messy real-world forms: a swarm of Gemini 4 models with a red team vs a single model call, scored against
// human annotations (FUNSD: noisy scanned forms with labelled field -> value links).
//
//   node forms/forms.mjs prepare                     gold pairs + degraded copies of every image
//   node forms/forms.mjs run <split> <variant>       split: dev | test    variant: clean | messy
//   node forms/forms.mjs score <split> [--tune]      tables; --tune (dev only) picks the vote settings
//
// The test split (FUNSD's 50 test forms) is never looked at during development: settings are chosen on dev
// (20 forms from FUNSD's training set) and frozen in forms/settings.json before the test run.
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FORMS_DIR || "/mnt/data0/xisen/workspace/runs/forms-eval-20261121";
const SRC = path.join(DIR, "data/funsd/dataset");
// v1 = first prompt; v2 = prompt revised after reading dev failures (units, table rows)
const TAG = process.env.FORMS_TAG || "v2";
const OUTDIR = TAG === "v1" ? "out" : `out-${TAG}`;
const MODELS = ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon", "gemini-4-argon"];
const VERIFIERS = ["gemini-4-argon", "gemini-4-carbon"];
const short = (m) => m.replace("gemini-4-", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// ------------------------------------------------------------ text matching
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const sim = (a, b) => (a === b ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length, 1));

// a predicted pair matches a gold pair when the label is close and the value is nearly the same text
const KEY_SIM = 0.7, VALUE_SIM = 0.8;
function scoreDoc(pred, gold) {
  const P = pred.map((p) => ({ k: norm(p.field), v: norm(p.value) })).filter((p) => p.v);
  const G = gold.map((g) => ({ k: norm(g.field), v: norm(g.value) }));
  const cand = [];
  P.forEach((p, i) => G.forEach((g, j) => {
    if (Math.abs(p.v.length - g.v.length) > 0.25 * Math.max(p.v.length, g.v.length) + 1) return;
    const sv = sim(p.v, g.v);
    if (sv < VALUE_SIM) return;
    const sk = sim(p.k, g.k);
    if (sk >= KEY_SIM) cand.push([sk + sv, i, j, sk === 1 && sv === 1]);
  }));
  cand.sort((a, b) => b[0] - a[0]);
  const usedP = new Set(), usedG = new Set();
  let tp = 0, exact = 0;
  for (const [, i, j, ex] of cand) if (!usedP.has(i) && !usedG.has(j)) { usedP.add(i); usedG.add(j); tp++; if (ex) exact++; }
  return { tp, exact, pred: P.length, gold: G.length };
}
const prf = (tp, pred, gold) => { const p = pred ? tp / pred : 0, r = gold ? tp / gold : 0; return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 }; };

// ------------------------------------------------------------ the ledger: weighted vote over every reader's list
function merge(lists, weights, share) {
  const clusters = [];
  lists.forEach((fields, li) => (fields || []).forEach((f) => {
    const k = norm(f.field), v = norm(f.value);
    if (!v) return;
    let best = null, bs = 0;
    for (const c of clusters) { const s = sim(k, c.key); if (s > bs) { bs = s; best = c; } }
    if (best && bs >= 0.75) best.members.push({ li, k, v, field: f.field, value: f.value });
    else clusters.push({ key: k, members: [{ li, k, v, field: f.field, value: f.value }] });
  }));
  const total = weights.reduce((a, b) => a + b, 0);
  const out = [];
  for (const c of clusters) {
    const voters = [...new Set(c.members.map((m) => m.li))];
    const weight = voters.reduce((a, li) => a + weights[li], 0);
    const counts = voters.map((li) => c.members.filter((m) => m.li === li).length).sort((a, b) => a - b);
    const instances = counts[Math.floor((counts.length - 1) / 2)];
    const variants = [];
    for (const m of c.members) {
      let hit = variants.find((x) => sim(x.key, m.v) >= 0.8);
      if (!hit) { hit = { key: m.v, votes: 0, raw: new Map(), by: new Set() }; variants.push(hit); }
      hit.votes += weights[m.li]; hit.by.add(m.li);
      hit.raw.set(m.value, (hit.raw.get(m.value) || 0) + weights[m.li]);
    }
    variants.sort((a, b) => b.votes - a.votes);
    const labels = new Map();
    for (const m of c.members) labels.set(m.field, (labels.get(m.field) || 0) + weights[m.li]);
    const field = [...labels].sort((a, b) => b[1] - a[1])[0][0];
    const top = (v) => [...v.raw].sort((a, b) => b[1] - a[1])[0][0];
    out.push({ field, weight, share: weight / total, readers: voters.length, instances, variants: variants.map((v) => ({ value: top(v), votes: v.votes, readers: v.by.size })) });
  }
  const final = [];
  for (const c of out) if (c.share >= share) for (const v of c.variants.slice(0, c.instances)) final.push({ field: c.field, value: v.value });
  return { final, clusters: out };
}

// ------------------------------------------------------------ prepare
const KINDS = ["rot90", "rot180", "skew", "lowres", "dim"];
async function degrade(src, dst, kind) {
  const img = sharp(src);
  const meta = await img.metadata();
  if (kind === "rot90") await img.rotate(90).png().toFile(dst);
  else if (kind === "rot180") await img.rotate(180).png().toFile(dst);
  else if (kind === "skew") await img.rotate(7, { background: "#ffffff" }).blur(0.7).png().toFile(dst);
  else if (kind === "lowres") await img.resize({ width: Math.round(meta.width * 0.5) }).jpeg({ quality: 20 }).toFile(dst);
  else if (kind === "dim") await img.rotate(-4, { background: "#b0b0b0" }).linear(0.55, 60).blur(0.6).jpeg({ quality: 35 }).toFile(dst);
}
function goldPairs(file) {
  const form = readJson(file).form;
  const by = new Map(form.map((e) => [e.id, e]));
  const out = [];
  for (const e of form) {
    if (e.label !== "question" || !norm(e.text)) continue;
    const ans = e.linking.filter(([a, b]) => a === e.id && by.get(b)?.label === "answer").map(([, b]) => by.get(b)).sort((x, y) => x.box[1] - y.box[1] || x.box[0] - y.box[0]);
    const value = ans.map((a) => a.text).join(" ").trim();
    if (norm(value)) out.push({ field: e.text, value });
  }
  return out;
}
async function prepare() {
  const splits = { dev: ["training_data", 20], test: ["testing_data", 50] };
  for (const [split, [folder, n]] of Object.entries(splits)) {
    const docs = fs.readdirSync(path.join(SRC, folder, "annotations")).filter((f) => f.endsWith(".json")).sort().slice(0, n).map((f) => f.slice(0, -5));
    fs.mkdirSync(path.join(DIR, "gold", split), { recursive: true });
    fs.mkdirSync(path.join(DIR, "images", split, "clean"), { recursive: true });
    fs.mkdirSync(path.join(DIR, "images", split, "messy"), { recursive: true });
    const index = [];
    for (const [i, doc] of docs.entries()) {
      const gold = goldPairs(path.join(SRC, folder, "annotations", doc + ".json"));
      fs.writeFileSync(path.join(DIR, "gold", split, doc + ".json"), JSON.stringify(gold, null, 1));
      const src = path.join(SRC, folder, "images", doc + ".png");
      fs.copyFileSync(src, path.join(DIR, "images", split, "clean", doc + ".png"));
      const kind = KINDS[i % KINDS.length];
      const ext = ["lowres", "dim"].includes(kind) ? "jpg" : "png";
      await degrade(src, path.join(DIR, "images", split, "messy", `${doc}.${ext}`), kind);
      index.push({ doc, pairs: gold.length, clean: `clean/${doc}.png`, messy: `messy/${doc}.${ext}`, kind });
    }
    fs.writeFileSync(path.join(DIR, "images", split, "index.json"), JSON.stringify(index, null, 1));
    console.log(split, docs.length, "forms,", index.reduce((a, x) => a + x.pairs, 0), "gold field-value pairs");
  }
}

// ------------------------------------------------------------ model calls
let ai = null;
const gem = () => (ai ??= new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY || fs.readFileSync(path.join(os.homedir(), ".config/gemini/api_key"), "utf8")).trim() }));
let active = 0; const queue = []; const LIMIT = Number(process.env.FORMS_CONCURRENCY || 24);
async function slot(fn) { while (active >= LIMIT) await new Promise((r) => queue.push(r)); active++; try { return await fn(); } finally { active--; queue.shift()?.(); } }
const usage = { calls: 0, tokens: 0, failed: 0 };

const RULES = `- field = the label exactly as printed on the form (for example "Date:" or "TO:").
- value = the text entered for that field exactly as it appears, typed or handwritten. Join a multi-line value with single spaces. Do not correct spelling, do not reformat dates or numbers, do not summarise.
${TAG === "v1" ? "" : `- Copy everything written in the field's space, including units and symbols printed next to the entry (for example "84 mm", "# 839 / 869", "36 gm/ m2").
- In a table, the row label is the field and the value is all the entries of that row joined left to right with single spaces (for example field "TAR", value "9.1 5.5"). Do not make one field per cell.
`}- Only fields that have a value entered. A label with nothing filled in is left out. The same label can appear more than once on a form: list each occurrence.
- Do not include headings, logos, page furniture or free text that is not the value of a labelled field. Never invent a field.`;
const EXTRACT = `This is a scan of a real paper form. It may be rotated, skewed, faint or low resolution. Extract every filled-in field as a pair.
${RULES}
Return JSON {"fields":[{"field":"...","value":"..."}]}.`;
const SCHEMA = { type: "OBJECT", properties: { fields: { type: "ARRAY", items: { type: "OBJECT", properties: { field: { type: "STRING" }, value: { type: "STRING" } }, required: ["field", "value"] } } }, required: ["fields"] };

async function ask(model, images, text) {
  return slot(async () => {
    for (let i = 0; ; i++) {
      try {
        const res = await gem().models.generateContent({ model, contents: [{ role: "user", parts: [...images.map((im) => ({ inlineData: { mimeType: im.mime, data: im.data } })), { text }] }], config: { responseMimeType: "application/json", responseSchema: SCHEMA } });
        usage.calls++; usage.tokens += res.usageMetadata?.totalTokenCount || 0;
        const j = JSON.parse((res.text.match(/\{[\s\S]*\}/) || ["{}"])[0]);
        return (j.fields || []).filter((f) => f && typeof f.field === "string" && typeof f.value === "string");
      } catch (e) {
        if (i >= 5) { usage.failed++; return null; }
        await sleep((/429|rate|quota|exhaust/i.test(String(e.message)) ? 20000 : 3000) * (i + 1) * (0.7 + Math.random() * 0.6));
      }
    }
  });
}
async function views(file) {
  const buf = fs.readFileSync(file);
  const meta = await sharp(buf).metadata();
  const enhanced = await sharp(buf).normalize().resize({ width: Math.min(2400, meta.width * 2), kernel: "lanczos3" }).sharpen().png().toBuffer();
  return { orig: { mime: file.endsWith(".jpg") ? "image/jpeg" : "image/png", data: buf.toString("base64") }, enhanced: { mime: "image/png", data: enhanced.toString("base64") } };
}

// one form through the swarm: 8 readers (4 models x 2 views), a shared ledger, then 2 red-team verifiers
async function swarmDoc(file) {
  const v = await views(file);
  const readers = MODELS.flatMap((model) => ["orig", "enhanced"].map((view) => ({ model, view })));
  await Promise.all(readers.map(async (r) => { r.fields = await ask(r.model, [v[r.view]], EXTRACT); }));
  const lists = readers.map((r) => r.fields || []);
  const { clusters } = merge(lists, lists.map(() => 1), 0);
  const table = clusters.sort((a, b) => a.share - b.share).map((c) => `- ${JSON.stringify(c.field)} (${c.readers} of ${readers.length} readers): ${c.variants.map((x) => `${JSON.stringify(x.value)} x${x.readers}`).join(" | ")}`).join("\n");
  const verify = `You are the red team of a form-reading team. Two views of the same scanned form are attached: the original, and an enlarged, contrast-enhanced copy. ${readers.length} readers extracted its filled-in fields; their combined candidates are listed below, least agreed first, each with how many readers reported it and the competing readings of its value.
Check every candidate against the image yourself: fix misread characters, set the label to exactly what is printed, remove candidates that are not on the form or have nothing entered, separate fields that readers merged, and add filled-in fields that every reader missed. Spend most of your attention on candidates with few readers or competing readings.
${RULES}
Return the final, complete list as JSON {"fields":[{"field":"...","value":"..."}]}.

CANDIDATES:
${table || "(none)"}`;
  const verifiers = VERIFIERS.map((model) => ({ model }));
  await Promise.all(verifiers.map(async (x) => { x.fields = await ask(x.model, [v.orig, v.enhanced], verify); }));
  return { readers, verifiers };
}

async function run(split, variant) {
  const index = readJson(path.join(DIR, "images", split, "index.json"));
  const outDir = path.join(DIR, OUTDIR, split, variant);
  fs.mkdirSync(outDir, { recursive: true });
  let done = 0;
  await Promise.all(index.map(async (it) => {
    const out = path.join(outDir, it.doc + ".json");
    if (!fs.existsSync(out)) fs.writeFileSync(out, JSON.stringify(await swarmDoc(path.join(DIR, "images", split, it[variant])), null, 1));
    if (++done % 10 === 0) console.log(`${split}/${variant}: ${done}/${index.length} forms, ${usage.calls} calls, ${(usage.tokens / 1e6).toFixed(2)}M tokens, ${usage.failed} failed`);
  }));
  console.log(`${split}/${variant} done: ${usage.calls} calls, ${(usage.tokens / 1e6).toFixed(2)}M tokens, ${usage.failed} failed`);
}

// ------------------------------------------------------------ score
function systems(rec, settings) {
  const use = settings.readers || MODELS.map(short);
  const all = rec.readers, V = rec.verifiers;
  const R = all.filter((r) => use.includes(short(r.model)));
  const sys = {};
  for (const m of MODELS) sys[`single ${short(m)}`] = all.find((r) => r.model === m && r.view === "orig").fields || [];
  const lists = [...R.map((r) => r.fields || []), ...V.map((x) => x.fields || [])];
  sys["swarm, vote only"] = merge(R.map((r) => r.fields || []), R.map(() => 1), settings.share).final;
  sys["swarm (readers + red team)"] = merge(lists, [...R.map(() => 1), ...V.map(() => settings.verifier_weight)], settings.share).final;
  return sys;
}
function evaluate(split, variant, settings, only = null) {
  const index = readJson(path.join(DIR, "images", split, "index.json"));
  const res = {};
  for (const it of index) {
    const f = path.join(DIR, OUTDIR, split, variant, it.doc + ".json");
    if (!fs.existsSync(f)) continue;
    const gold = readJson(path.join(DIR, "gold", split, it.doc + ".json"));
    for (const [name, pred] of Object.entries(systems(readJson(f), settings))) {
      if (only && !only.includes(name)) continue;
      (res[name] ??= []).push({ doc: it.doc, kind: it.kind, ...scoreDoc(pred, gold) });
    }
  }
  return res;
}
const micro = (rows) => { const s = rows.reduce((a, r) => ({ tp: a.tp + r.tp, exact: a.exact + r.exact, pred: a.pred + r.pred, gold: a.gold + r.gold }), { tp: 0, exact: 0, pred: 0, gold: 0 }); return { ...s, ...prf(s.tp, s.pred, s.gold), exact_f1: prf(s.exact, s.pred, s.gold).f1 }; };
function bootstrap(a, b, n = 5000) {
  // paired over forms: difference in micro F1 (a - b)
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const diffs = [];
  for (let i = 0; i < n; i++) {
    const pick = Array.from({ length: a.length }, () => Math.floor(rnd() * a.length));
    diffs.push(micro(pick.map((k) => a[k])).f1 - micro(pick.map((k) => b[k])).f1);
  }
  diffs.sort((x, y) => x - y);
  const mean = diffs.reduce((x, y) => x + y, 0) / n, sd = Math.sqrt(diffs.reduce((x, y) => x + (y - mean) ** 2, 0) / n);
  return { lo: diffs[Math.floor(n * 0.025)], hi: diffs[Math.floor(n * 0.975)], sd, share_positive: diffs.filter((d) => d > 0).length / n };
}
const pc = (x) => (100 * x).toFixed(1);

function tune() {
  let best = null;
  const sets = [MODELS.map(short), ["hydrogen", "neon"], ["hydrogen", "neon", "argon"]];
  for (const readers of sets) for (const share of [0.3, 0.4, 0.5]) for (const verifier_weight of [0, 1, 2]) {
    const s = { share, verifier_weight, readers };
    const name = "swarm (readers + red team)";
    const f1 = ["clean", "messy"].map((v) => micro(evaluate("dev", v, s, [name])[name] || []).f1);
    const mean = (f1[0] + f1[1]) / 2;
    console.log(`readers ${readers.join("+")} share ${share} verifier_weight ${verifier_weight}: dev F1 clean ${pc(f1[0])} messy ${pc(f1[1])}`);
    if (!best || mean > best.mean + 1e-9) best = { ...s, mean };
  }
  const settings = { prompt: TAG, readers: best.readers, share: best.share, verifier_weight: best.verifier_weight, chosen_on: "dev (20 forms from FUNSD training set), mean F1 of clean and messy", frozen_at: new Date().toISOString() };
  fs.writeFileSync(path.join(HERE, "settings.json"), JSON.stringify(settings, null, 2));
  console.log("frozen:", JSON.stringify(settings));
}

function report(split) {
  const settings = readJson(path.join(HERE, "settings.json"));
  const lines = [`## ${split === "test" ? "Test: FUNSD's 50 test forms (never seen during development)" : "Dev: 20 forms from FUNSD's training set"}`, ""];
  const all = {};
  for (const variant of ["clean", "messy"]) {
    const res = (all[variant] = evaluate(split, variant, settings));
    const names = Object.keys(res);
    if (!names.length) continue;
    lines.push(`### ${variant === "clean" ? "Original scans" : "Degraded copies (rotated 90°/180°, skewed + blurred, half resolution + heavy JPEG, dim + tilted)"}`, "", "| System | Precision | Recall | F1 | Exact-match F1 | Fields found / predicted / in the annotations |", "|---|---|---|---|---|---|");
    for (const n of names) { const m = micro(res[n]); lines.push(`| ${n} | ${pc(m.p)} | ${pc(m.r)} | **${pc(m.f1)}** | ${pc(m.exact_f1)} | ${m.tp} / ${m.pred} / ${m.gold} |`); }
    const singles = names.filter((n) => n.startsWith("single")).map((n) => [n, micro(res[n]).f1]).sort((a, b) => b[1] - a[1]);
    const sw = "swarm (readers + red team)";
    if (res[sw] && singles.length) {
      const [bn] = singles[0];
      const b = bootstrap(res[sw], res[bn]);
      const d = micro(res[sw]).f1 - micro(res[bn]).f1;
      const better = res[sw].filter((r, i) => prf(r.tp, r.pred, r.gold).f1 > prf(res[bn][i].tp, res[bn][i].pred, res[bn][i].gold).f1 + 1e-9).length;
      const worse = res[sw].filter((r, i) => prf(r.tp, r.pred, r.gold).f1 < prf(res[bn][i].tp, res[bn][i].pred, res[bn][i].gold).f1 - 1e-9).length;
      lines.push("", `Swarm vs the best single call (${bn}): ${d >= 0 ? "+" : ""}${pc(d)} F1 points, 95% interval ${pc(b.lo)} to ${pc(b.hi)} (paired bootstrap over forms; ${(d / b.sd).toFixed(1)} standard errors). Better on ${better} forms, worse on ${worse}, of ${res[sw].length}.`, "");
      const f1s = (rows) => rows.map((r) => prf(r.tp, r.pred, r.gold).f1).sort((x, y) => x - y);
      const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
      lines.push("| Per-form F1 | Worst form | 10th percentile | Median | Forms under 30 |", "|---|---|---|---|---|");
      for (const n of [bn, sw]) { const a = f1s(res[n]); lines.push(`| ${n} | ${pc(a[0])} | ${pc(q(a, 0.1))} | ${pc(q(a, 0.5))} | ${a.filter((x) => x < 0.3).length} |`); }
      lines.push("");
      if (variant === "messy") {
        lines.push("| Degradation | Forms | Best single F1 | Swarm F1 |", "|---|---|---|---|");
        for (const k of KINDS) { const a = res[bn].filter((r) => r.kind === k), s = res[sw].filter((r) => r.kind === k); if (a.length) lines.push(`| ${k} | ${a.length} | ${pc(micro(a).f1)} | ${pc(micro(s).f1)} |`); }
        lines.push("");
      }
    }
  }
  const md = lines.join("\n");
  fs.writeFileSync(path.join(HERE, `results-${split}.md`), `Settings: a field is kept when readers holding at least ${settings.share * 100}% of the vote report it; readers: ${(settings.readers || []).join(", ")} (each on the original and an enhanced view); a red-team verifier's vote counts ${settings.verifier_weight}x (0 = not used); prompt ${settings.prompt}. A predicted pair counts when its label is at least ${KEY_SIM * 100}% similar and its value at least ${VALUE_SIM * 100}% similar to an annotated pair (normalised edit distance, case and punctuation ignored).\n\n${md}\n`);
  console.log(md);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "prepare") await prepare();
else if (cmd === "run") await run(a, b);
else if (cmd === "score") { if (process.argv.includes("--tune")) tune(); report(a); }
else console.log("usage: forms.mjs prepare | run <dev|test> <clean|messy> | score <dev|test> [--tune]");
