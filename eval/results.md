# Results

Judge: gemini-4-argon. Up to 20 cited claims per system per question, spread evenly through each answer; every cited page re-fetched by the evaluator; unreachable pages excluded from the rates and counted separately in eval.json.

| Question | Kind | Agents | Cited claims (swarm / DR) | Citation supported, any cited page (swarm / DR) | First cited page only (swarm / DR) | Supported or partial (swarm / DR) | Domains per claim (swarm / DR) | Quotes found verbatim (swarm) | Red-team checks / challenges | Edge case handled (swarm / DR) |
|---|---|---|---|---|---|---|---|---|---|---|
| What are the Gemini 4 models (Argon, Carbon, Neon, Hydrogen) that Goog… | baseline-run | 8 | 102 / 109 | 35% (7/20) / 60% (12/20) | 11% / 39% | 85% / 100% | 5.07 / 1 | 88% (28/32) | 98 / 28 | – / – |

**All questions pooled:** citations supported, swarm 35% (7/20) vs Deep Research 60% (12/20); supported or partial 85% vs 100%; first cited page only 11% (2/18) vs 39% (7/18).
