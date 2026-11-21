// what do the readers get "wrong" on dev? prints gold pairs missed and predicted pairs unmatched for a few forms
import fs from "node:fs";
const DIR = process.env.FORMS_DIR || "/mnt/data0/xisen/workspace/runs/forms-eval-20261121";
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const idx = JSON.parse(fs.readFileSync(`${DIR}/images/dev/index.json`));
for (const it of idx.slice(0, Number(process.argv[2] || 4))) {
  const gold = JSON.parse(fs.readFileSync(`${DIR}/gold/dev/${it.doc}.json`));
  const rec = JSON.parse(fs.readFileSync(`${DIR}/out/dev/clean/${it.doc}.json`));
  const pred = rec.readers.find((r) => r.model === "gemini-4-argon" && r.view === "orig").fields || [];
  const gv = new Set(gold.map((g) => norm(g.value))), pv = new Set(pred.map((p) => norm(p.value)));
  console.log(`\n== ${it.doc}: gold ${gold.length}, argon predicted ${pred.length}`);
  console.log(" GOLD not predicted (by value):"); for (const g of gold.filter((g) => !pv.has(norm(g.value))).slice(0, 6)) console.log("   ", JSON.stringify(g.field).slice(0, 40), "=>", JSON.stringify(g.value).slice(0, 90));
  console.log(" PREDICTED not in gold (by value):"); for (const p of pred.filter((p) => !gv.has(norm(p.value))).slice(0, 8)) console.log("   ", JSON.stringify(p.field).slice(0, 40), "=>", JSON.stringify(p.value).slice(0, 90));
}
