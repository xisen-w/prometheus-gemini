"""Build eval/results.md from runs/*/eval2.json (original report) and eval2.verified.json (after the citation check)."""
import glob, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def pct(n, d):
    return f"{round(100 * n / d)}% ({n}/{d})" if d else "–"


def load(run, name):
    p = os.path.join(run, name)
    return json.load(open(p)) if os.path.exists(p) else None


rows, pool = [], {k: [0, 0] for k in ["sw_t", "sw2_t", "dr_t", "sw_e", "sw2_e", "dr_e"]}
for run in sorted(glob.glob(os.path.join(ROOT, "runs", "r_*"))):
    a, b = load(run, "eval2.json"), load(run, "eval2.verified.json")
    if not a:
        continue
    s, d = a["swarm"], a["baseline"]
    s2 = b["swarm"] if b else None
    def add(key, n, m):
        pool[key][0] += n; pool[key][1] += m
    add("sw_t", s["together_supported"], s["together_reached"]); add("dr_t", d["together_supported"], d["together_reached"])
    add("sw_e", s["supported"], s["reached"]); add("dr_e", d["supported"], d["reached"])
    if s2:
        add("sw2_t", s2["together_supported"], s2["together_reached"]); add("sw2_e", s2["supported"], s2["reached"])
    edge = lambda v: "–" if v is None else ("yes" if v else "no")
    rows.append(
        f"| {a['question'][:64]}{'…' if len(a['question']) > 64 else ''} | {a.get('kind', '–')} | {a['agents']} · {a.get('mode', 'orchestrated')} "
        f"| {s['cited_claims']} / {d['cited_claims']} "
        f"| {pct(s['together_supported'], s['together_reached'])} | {pct(s2['together_supported'], s2['together_reached']) if s2 else '–'} | {pct(d['together_supported'], d['together_reached'])} "
        f"| {pct(s['supported'], s['reached'])} | {pct(d['supported'], d['reached'])} "
        f"| {s['together_unsupported']} / {d['together_unsupported']} "
        f"| {s['mean_domains_per_claim']} / {d['mean_domains_per_claim']} "
        f"| {pct(s['quote_verbatim']['found'], s['quote_verbatim']['reached'])} "
        f"| {s['redteam_checks']} / {s['challenges']} "
        f"| {edge(s.get('edge_ok'))} / {edge(d.get('edge_ok'))} "
        f"| {s['tokens'] / 1e6:.1f}M, {s['minutes'] or '–'} min / {(d['tokens'] or 0) / 1e6:.1f}M, {d['minutes'] or '–'} min |"
    )

head = (
    "| Question | Kind | Agents | Cited claims (swarm / DR) "
    "| Supported by its cited pages together: swarm | swarm after citation check | Deep Research "
    "| Supported by a single cited page: swarm | Deep Research "
    "| Unsupported (swarm / DR) | Domains per claim (swarm / DR) | Swarm quotes found verbatim "
    "| Red-team checks / challenges | Edge case handled (swarm / DR) | Cost (swarm / DR) |\n"
    "|" + "---|" * 15
)
p = lambda k: pct(*pool[k])
md = f"""# Results: swarm vs Google Deep Research

Same procedure for both answers: Gemini 4 Argon extracts the cited claims of each answer (the swarm's `[C…]` tags are first turned into links to the ledger sources behind them), up to 30 per answer spread evenly; the evaluator re-fetches every cited page; the same Argon judge decides whether the claim is supported. Two readings: all of a claim's cited pages together (up to 3), and any single cited page on its own. Unreachable pages are left out of the rates.

{head}
{chr(10).join(rows)}

**Pooled over all questions** — supported by the cited pages together: swarm {p('sw_t')}, swarm after the citation check {p('sw2_t')}, Deep Research {p('dr_t')}. Supported by a single cited page: swarm {p('sw_e')}, after the check {p('sw2_e')}, Deep Research {p('dr_e')}.

Noise: scoring the same Deep Research answer twice moved its single-page rate by about 10 points, so differences of that size on one question are not meaningful.
"""
open(os.path.join(ROOT, "eval", "results.md"), "w").write(md)
print(md)
