# Prometheus on Gemini

A 128-agent swarm architecture for very deep analysis with Gemini models.

Deep research by a swarm of Gemini Managed Agents that argue with each other until the evidence holds.

One question goes in. A planner (Gemini 4 Argon) splits it into sub-questions. Six researcher agents, each a Gemini Managed Agent with its own Google sandbox, Google Search and page reading, research in parallel and write every claim and every source, with the exact sentence copied from the page, into one shared evidence ledger. Researchers cross-check each other's key numbers from different publishers. Red-team agents re-open the sources themselves and challenge what doesn't hold; the owners fix it. A gate in code refuses the answer until every key claim has a confirmed check, no challenge is open, every sub-question is answered, and the quotes it samples are really on the pages. Then a writer produces the report, where every claim carries a tag you can click to see its sources, quotes, checks and challenges, and an independent judge reviews it.

Google's own Deep Research agent answers the same question alongside, so you can compare how much each one actually checked.

## Why Managed Agents

Each seat is one long-lived managed agent: the same agent continues across research, cross-check and fix rounds (`previous_interaction_id` + its own `environment`), so it keeps its context and its sandbox. The orchestrator is only a Room: it relays `@` messages between agents and keeps the ledger. Agents run in the background in parallel; nothing runs on the laptop.

## Run

```
npm install
(umask 077; mkdir -p ~/.config/gemini; read -rs -p "Gemini key: " K; printf %s "$K" > ~/.config/gemini/api_key)
PORT=8899 node server.mjs        # open http://localhost:8899
MOCK=1 node swarm.mjs --run <id> # simulated agents, no key needed
```

Environment: `SWARM_SEAT_MODEL` (default `gemini-4-hydrogen`), `SWARM_LEAD_MODEL` (default `gemini-4-argon`), `SWARM_AGENT` (default `antigravity-preview-09-2026`), `SWARM_BASELINE` (default `deep-research-max-preview-04-2026`).

Files per run in `runs/<id>/`: `events.ndjson` (everything that happened), `ledger.jsonl` (the evidence), `report.md`, `baseline.md`. See `CONTRACT.md`.
