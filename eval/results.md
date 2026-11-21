# Results

Judge: gemini-4-argon. Up to 30 cited claims per system per question, spread evenly through each answer; every cited page re-fetched by the evaluator; unreachable pages excluded from the rates and counted separately in eval.json.

| Question | Kind | Agents | Cited claims (swarm / DR) | Citation supported, any cited page (swarm / DR) | First cited page only (swarm / DR) | Supported or partial (swarm / DR) | Domains per claim (swarm / DR) | Quotes found verbatim (swarm) | Red-team checks / challenges | Edge case handled (swarm / DR) |
|---|---|---|---|---|---|---|---|---|---|---|
| whats teh current us fed funds rate n when did they last change it?? a… | messy input | 16 | 39 / 61 | 35% (7/20) / 59% (10/17) | 21% / 29% | 95% / 100% | 3.46 / 2.2 | 97% (29/30) | 104 / 6 | yes / yes |
| 2026年中国新能源汽车出口了多少辆？主要出口到哪些国家？和2025年比怎么样？ | non-English | 16 | 72 / 11 | 32% (6/19) / 36% (4/11) | 24% / 40% | 100% / 100% | 3.92 / 1.55 | 74% (26/35) | 148 / 28 | yes / no |
| Why did the European Union ban all AI chatbots in 2026, and which comp… | false premise | 16 | 92 / 4 | 60% (12/20) / 50% (2/4) | 38% / 25% | 95% / 100% | 3.35 / 2.5 | 92% (33/36) | 115 / 17 | yes / yes |
| Which team won first place at the Gemini 4 NYC Hackathon on November 2… | probably unanswerable | 16 | 36 / 39 | 50% (10/20) / 72% (13/18) | 50% / 56% | 95% / 100% | 3.11 / 1.51 | 68% (26/38) | 66 / 22 | yes / yes |

**All questions pooled:** citations supported, swarm 44% (35/79) vs Deep Research 58% (29/50); supported or partial 96% vs 100%; first cited page only 33% (24/72) vs 41% (19/46).
