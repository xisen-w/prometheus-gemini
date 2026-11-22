// Offline backtest: forecast the Nasdaq Composite's next close from frozen data only.
//   node backtest/backtest.mjs [days=20]
// Every model call gets the market data up to the day before the target and has NO tools: it cannot look
// anything up, so nothing from the target day can leak in. System = six analysts with different lenses on
// four Gemini 4 models, a red team that attacks their forecasts, and a synthesiser. Baselines = a random
// walk (tomorrow = today, interval from 20-day volatility) and one single model call on the same data.
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = process.env.BACKTEST_DIR || "/mnt/data0/xisen/workspace/runs/nasdaq-backtest-20261122";
const DAYS = Number(process.argv[2] || 20);
const ai = new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY || fs.readFileSync(path.join(os.homedir(), ".config/gemini/api_key"), "utf8")).trim() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let active = 0; const queue = [];
async function slot(fn) { while (active >= 24) await new Promise((r) => queue.push(r)); active++; try { return await fn(); } finally { active--; queue.shift()?.(); } }
const usage = { calls: 0, tokens: 0, failed: 0 };

function series(sym) {
  const r = JSON.parse(fs.readFileSync(path.join(DIR, `y_${sym}.json`), "utf8")).chart.result[0];
  const q = r.indicators.quote[0];
  const out = new Map();
  r.timestamp.forEach((t, i) => { if (q.close[i] != null) out.set(new Date(t * 1000).toISOString().slice(0, 10), { o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] }); });
  return out;
}
const IXIC = series("%5EIXIC"), GSPC = series("%5EGSPC"), VIX = series("%5EVIX"), TNX = series("%5ETNX");
const dates = [...IXIC.keys()].sort();
const f2 = (x) => (x == null ? "" : x.toFixed(2));

function frozen(upTo) {
  // everything a forecaster may see: the last 60 trading days up to and including `upTo`
  const i = dates.indexOf(upTo);
  const win = dates.slice(Math.max(0, i - 59), i + 1);
  const rows = win.map((d) => { const x = IXIC.get(d); return `${d},${f2(x.o)},${f2(x.h)},${f2(x.l)},${f2(x.c)},${f2(GSPC.get(d)?.c)},${f2(VIX.get(d)?.c)},${f2(TNX.get(d)?.c)}`; });
  const closes = dates.slice(0, i + 1).map((d) => IXIC.get(d).c);
  const ret = (n) => (closes.at(-1) / closes.at(-1 - n) - 1) * 100;
  const r = closes.slice(-21).map((c, k, a) => (k ? Math.log(c / a[k - 1]) : null)).filter((x) => x != null);
  const sd = Math.sqrt(r.reduce((a, x) => a + x * x, 0) / r.length);
  return { last: closes.at(-1), sd, text: `date,nasdaq_open,nasdaq_high,nasdaq_low,nasdaq_close,sp500_close,vix_close,us10y_yield\n${rows.join("\n")}\n\nNasdaq Composite returns to the last close: 1 day ${ret(1).toFixed(2)}%, 5 days ${ret(5).toFixed(2)}%, 20 days ${ret(20).toFixed(2)}%, 60 days ${ret(Math.min(60, closes.length - 1)).toFixed(2)}%. Daily volatility over the last 20 sessions: ${(sd * 100).toFixed(2)}%. 52-week range of closes: ${Math.min(...closes).toFixed(0)} to ${Math.max(...closes).toFixed(0)}.` };
}

const SCHEMA = { type: "OBJECT", properties: { point: { type: "NUMBER" }, low80: { type: "NUMBER" }, high80: { type: "NUMBER" }, p_up: { type: "NUMBER" }, reasoning: { type: "STRING" } }, required: ["point", "low80", "high80", "p_up", "reasoning"] };
async function ask(model, system, text) {
  return slot(async () => {
    for (let i = 0; ; i++) {
      try {
        const res = await ai.models.generateContent({ model, contents: [{ role: "user", parts: [{ text }] }], config: { systemInstruction: system, responseMimeType: "application/json", responseSchema: SCHEMA } });
        usage.calls++; usage.tokens += res.usageMetadata?.totalTokenCount || 0;
        const j = JSON.parse((res.text.match(/\{[\s\S]*\}/) || ["{}"])[0]);
        if ([j.point, j.low80, j.high80, j.p_up].every((x) => typeof x === "number" && isFinite(x))) return j;
        throw new Error("bad forecast");
      } catch (e) {
        if (i >= 4) { usage.failed++; return null; }
        await sleep((/429|rate|quota|exhaust/i.test(String(e.message)) ? 15000 : 3000) * (i + 1));
      }
    }
  });
}

const TASK = (target, data) => `Forecast the Nasdaq Composite's CLOSE on ${target}, the next trading day after the last row below. You have only this data; you cannot look anything up.\n\n${data}\n\nReturn JSON: point (your forecast of the close), low80 and high80 (an interval you believe contains the close with 80% probability), p_up (probability the close is above the last close, 0 to 1), reasoning (two or three sentences).`;
const BASE = `You are a market forecaster. Be calibrated: over many days your 80% intervals should contain the close about 80% of the time, and your p_up should match how often the index rises.`;
const LENSES = [
  ["gemini-4-hydrogen", "trend and momentum", "Read the trend: direction and strength over 5, 20 and 60 sessions, and whether the last days extend or break it."],
  ["gemini-4-neon", "mean reversion", "Look for overextension: how far the last moves are from the recent range, and how often such moves partly reverse the next day."],
  ["gemini-4-carbon", "volatility regime", "Read the volatility regime from the VIX level and its change and from the size of recent daily ranges; set the width of the interval from it."],
  ["gemini-4-argon", "cross-asset", "Read what rates (10-year yield), the S&P 500 and the VIX say about risk appetite, and what that implies for the Nasdaq's next session."],
  ["gemini-4-neon", "base rates", "Use statistics only: the unconditional drift and distribution of daily returns in this window, and what follows days like the last one in this window."],
  ["gemini-4-hydrogen", "tail risk", "Think about what could make tomorrow unusual in either direction given the last sessions, and make sure the interval and probability allow for it."],
];

async function forecastDay(target) {
  const prev = dates[dates.indexOf(target) - 1];
  const { last, sd, text } = frozen(prev);
  const task = TASK(target, text);
  const [single, ...analysts] = await Promise.all([
    ask("gemini-4-neon", BASE, task),
    ...LENSES.map(([model, name, how]) => ask(model, `${BASE} Your lens is ${name}. ${how}`, task).then((f) => (f ? { ...f, model, lens: name } : null))),
  ]);
  const got = analysts.filter(Boolean);
  const table = got.map((f) => `- ${f.lens} (${f.model.replace("gemini-4-", "")}): point ${f.point.toFixed(0)}, 80% ${f.low80.toFixed(0)} to ${f.high80.toFixed(0)}, p_up ${f.p_up.toFixed(2)}. ${f.reasoning}`).join("\n");
  const critic = await ask("gemini-4-carbon", `You are the red team for a forecasting desk. You are given the same data and the analysts' forecasts. Attack them: which are overconfident (interval too narrow for the recent volatility), which lean on a pattern the data does not support, where they all share one blind spot. Then give the forecast you would defend after that criticism.`, `${task}\n\nANALYSTS' FORECASTS:\n${table}`);
  const final = await ask("gemini-4-argon", `${BASE} You write the desk's final forecast. You are given the data, the analysts' forecasts and the red team's criticism with its own forecast. Weigh them; do not simply average. Keep the interval honest for the recent volatility.`, `${task}\n\nANALYSTS' FORECASTS:\n${table}\n\nRED TEAM: point ${critic?.point?.toFixed(0)}, 80% ${critic?.low80?.toFixed(0)} to ${critic?.high80?.toFixed(0)}, p_up ${critic?.p_up?.toFixed(2)}. ${critic?.reasoning || ""}`);
  const z = 1.2816;
  return { target, prev, last, actual: IXIC.get(target)?.c ?? null, walk: { point: last, low80: last * Math.exp(-z * sd), high80: last * Math.exp(z * sd), p_up: 0.5 }, single, analysts: got, critic, swarm: final };
}

function score(rows, key) {
  const r = rows.filter((x) => x[key] && x.actual != null);
  const n = r.length;
  const mae = r.reduce((a, x) => a + Math.abs(x[key].point - x.actual), 0) / n;
  const mape = r.reduce((a, x) => a + Math.abs(x[key].point / x.actual - 1), 0) / n * 100;
  const cover = r.filter((x) => x.actual >= x[key].low80 && x.actual <= x[key].high80).length;
  const width = r.reduce((a, x) => a + (x[key].high80 - x[key].low80) / x.last, 0) / n * 100;
  const brier = r.reduce((a, x) => a + (x[key].p_up - (x.actual > x.last ? 1 : 0)) ** 2, 0) / n;
  const calls = r.filter((x) => Math.abs(x[key].p_up - 0.5) > 1e-9);
  const dir = calls.filter((x) => (x[key].p_up > 0.5) === (x.actual > x.last)).length;
  return { n, mae, mape, cover, width, brier, dir, dirN: calls.length };
}

const last = dates.length - 1;
const targets = dates.slice(last - DAYS + 1, last + 1);
const out = path.join(DIR, "backtest.json");
const done = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : [];
const have = new Set(done.map((x) => x.target));
const fresh = await Promise.all(targets.filter((t) => !have.has(t)).map(forecastDay));
const rows = [...done, ...fresh].sort((a, b) => a.target.localeCompare(b.target));
fs.writeFileSync(out, JSON.stringify(rows, null, 1));

const names = [["walk", "Random walk (tomorrow = today)"], ["single", "One Gemini 4 Neon call"], ["swarm", "Desk: 6 analysts + red team + synthesiser"]];
const L = ["# Nasdaq Composite, next-day close: offline backtest", "", `${rows.length} trading days, ${rows[0].target} to ${rows.at(-1).target}. Each forecast saw only data up to the previous close and had no tools, so nothing from the target day could leak in. Data: daily Nasdaq Composite, S&P 500, VIX and 10-year yield (Yahoo Finance).`, "", "| Forecaster | Mean abs. error (points) | Mean abs. error (%) | Actual close inside its 80% interval | Mean interval width | Direction right | Brier score of p(up) |", "|---|---|---|---|---|---|---|"];
for (const [k, label] of names) { const s = score(rows, k); L.push(`| ${label} | ${s.mae.toFixed(0)} | ${s.mape.toFixed(2)}% | ${s.cover} of ${s.n} | ${s.width.toFixed(1)}% | ${s.dirN ? `${s.dir} of ${s.dirN}` : "makes no call"} | ${s.brier.toFixed(3)} |`); }
L.push("", "| Day | Previous close | Actual close | Change | Desk forecast (80% interval, p up) | Single call | Desk error |", "|---|---|---|---|---|---|---|");
for (const x of rows) L.push(`| ${x.target} | ${x.last.toFixed(0)} | ${x.actual.toFixed(0)} | ${((x.actual / x.last - 1) * 100).toFixed(2)}% | ${x.swarm ? `${x.swarm.point.toFixed(0)} (${x.swarm.low80.toFixed(0)}–${x.swarm.high80.toFixed(0)}, ${x.swarm.p_up.toFixed(2)})` : "–"} | ${x.single ? x.single.point.toFixed(0) : "–"} | ${x.swarm ? (x.swarm.point - x.actual).toFixed(0) : "–"} |`);
// the next session, from everything up to the last close
const nextFile = path.join(DIR, "next.json");
const lastDate = dates.at(-1);
let next = fs.existsSync(nextFile) ? JSON.parse(fs.readFileSync(nextFile, "utf8")) : null;
if (!next || next.prev !== lastDate) {
  dates.push("the next trading day");
  IXIC.set("the next trading day", null);
  next = await forecastDay("the next trading day");
  fs.writeFileSync(nextFile, JSON.stringify(next, null, 1));
}
if (next.swarm) L.push("", `## Next session after ${next.prev}`, "", `Last close ${next.last.toFixed(2)}. Desk forecast **${next.swarm.point.toFixed(0)}**, 80% interval ${next.swarm.low80.toFixed(0)} to ${next.swarm.high80.toFixed(0)}, probability of a higher close ${(next.swarm.p_up * 100).toFixed(0)}%. ${next.swarm.reasoning}`, "", `Single call: ${next.single?.point?.toFixed(0)} (${next.single?.low80?.toFixed(0)}–${next.single?.high80?.toFixed(0)}). Random walk interval: ${next.walk.low80.toFixed(0)}–${next.walk.high80.toFixed(0)}.`);
L.push("", `Model calls: ${usage.calls}, ${(usage.tokens / 1e6).toFixed(2)}M tokens, ${usage.failed} failed.`);
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "results.md"), L.join("\n") + "\n");
console.log(L.join("\n"));
