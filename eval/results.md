# Results: swarm vs Google Deep Research

Same procedure for both answers: Gemini 4 Argon extracts the cited claims of each answer (the swarm's `[C…]` tags are first turned into links to the ledger sources behind them), up to 30 per answer spread evenly; the evaluator re-fetches every cited page; the same Argon judge decides whether the claim is supported. Two readings: all of a claim's cited pages together (up to 3), and any single cited page on its own. Unreachable pages are left out of the rates.

| Question | Kind | Agents | Cited claims (swarm / DR) | Supported by its cited pages together: swarm | swarm after citation check | Deep Research | Supported by a single cited page: swarm | Deep Research | Unsupported (swarm / DR) | Domains per claim (swarm / DR) | Swarm quotes found verbatim | Red-team checks / challenges | Edge case handled (swarm / DR) | Cost (swarm / DR) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| whats teh current us fed funds rate n when did they last change … | messy input | 16 · orchestrated | 55 / 61 | 60% (18/30) | 60% (18/30) | 65% (17/26) | 47% (14/30) | 69% (18/26) | 0 / 0 | 3.53 / 2.2 | 97% (29/30) | 104 / 6 | yes / yes | 14.2M, 13.3 min / 1.0M, 7.4 min |
| 2026年中国新能源汽车出口了多少辆？主要出口到哪些国家？和2025年比怎么样？ | non-English | 16 · orchestrated | 61 / 11 | 20% (6/30) | 34% (10/29) | 40% (4/10) | 20% (6/30) | 30% (3/10) | 4 / 0 | 3.85 / 1.55 | 74% (25/34) | 148 / 28 | yes / no | 30.4M, 19.1 min / 0.9M, 7.2 min |
| Why did the European Union ban all AI chatbots in 2026, and whic… | false premise | 16 · orchestrated | 80 / 4 | 60% (18/30) | 73% (22/30) | 50% (2/4) | 50% (15/30) | 50% (2/4) | 2 / 0 | 3.39 / 2.5 | 92% (33/36) | 115 / 17 | yes / yes | 17.6M, 14.5 min / 0.9M, 7.7 min |
| Is drinking coffee every day good or bad for long-term health? | broad / contested | 16 · orchestrated | 87 / 61 | 11% (1/9) | 8% (2/25) | 45% (13/29) | 22% (2/9) | 38% (11/29) | 1 / 1 | 2 / 2.92 | 100% (4/4) | 145 / 40 | yes / no | 55.1M, 22.4 min / 0.8M, 8 min |
| Which team won first place at the Gemini 4 NYC Hackathon on Nove… | probably unanswerable | 16 · orchestrated | 36 / 39 | 63% (19/30) | 63% (19/30) | 73% (19/26) | 47% (14/30) | 58% (15/26) | 3 / 1 | 3.11 / 1.51 | 67% (26/39) | 66 / 22 | yes / yes | 10.8M, 14 min / 3.3M, 12 min |

**Pooled over all questions** — supported by the cited pages together: swarm 48% (62/129), swarm after the citation check 49% (71/144), Deep Research 58% (55/95). Supported by a single cited page: swarm 40% (51/129), after the check 41% (59/144), Deep Research 52% (49/95).

Noise: scoring the same Deep Research answer twice moved its single-page rate by about 10 points, so differences of that size on one question are not meaningful.
