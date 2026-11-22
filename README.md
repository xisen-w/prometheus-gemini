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

## Team sizes: 8 to 128 agents

Pick 8, 16, 32, 64 or 128 agents. About 80% are researchers and 20% red team. From 32 agents up the team is split into branches of about 12 researchers: Gemini 4 Argon first splits the question into branches, then plans each branch's sub-questions in parallel; cross-checks stay inside a branch; each branch gets its own section writer, and a lead writer joins the sections. At 128 agents that is 102 researchers and 26 red-team agents in 9 branches. A limiter (`SWARM_CONCURRENCY`, default 64) and backoff keep many agents within API limits.

## Evaluation (5 Sigma)

**Baseline:** Google's own Deep Research agent (`deep-research-max-preview-04-2026`) answers the same question in the same run.

**What we score** (`node eval.mjs <runId>`): only what can be checked, not how the prose reads. For each system we take the cited claims of its final answer (ours: every sentence with a `[C…]` tag and the ledger sources behind it; Deep Research: claims and their URLs, extracted by Gemini 4 Argon), re-open every cited page ourselves, and ask the same judge (Gemini 4 Argon) whether the page supports the claim. Reported: citations supported (any cited page, and first cited page only), supported-or-partial, unreachable pages, independent domains per claim, quotes found verbatim on re-fetch (swarm only: Deep Research gives no quotes), red-team checks and challenges, and whether edge cases are handled.

**Test set** (`eval/testset.json`): questions we did not tune on, chosen to be messy rather than the happy path: a false premise, a typo-ridden question with three asks, a Chinese-language question, a broad contested health question, and a question that cannot be answered yet (an event on the same day). Each edge case has a written expectation, and the judge grades both answers against it.

Results: `eval/results.md` (generated).

## Attach files, and the command line

A question can come with files: data, logs, agent traces, source code. They are placed in every agent's sandbox at `/attachments`, and the agents work on them with code. A finding from a file is cited as `attachment:<path>#L<from>-L<to>` with the exact text, and the gate checks that quote against the file. Runs with attachments are never part of the public export.

```
node cli.mjs ask "Why did this run produce no report? Count, don't guess." --attach ./record --agents 8 --model neon
node cli.mjs runs
node cli.mjs watch <run>
node cli.mjs show <run> report        # or: judgement | room | criteria | files
node cli.mjs grep <run> "timeout" --type claim
```

In the browser the same thing is the "Attach files" field (up to 25 MB; the command line takes folders up to 300 MB and skips `.git`, `node_modules` and files over 25 MB).

## Served from another site

The server listens on this machine only. To put it on a site of yours, the site passes its own pages on to the
server through the tunnel, under a path of the site's choosing:

- The site asks for its own access code, then requests `<tunnel address>/__gp/<forward key>/<rest of the path>`.
  The server answers such a request without asking for its own code, and rewrites the page's addresses to the
  site's path (`SWARM_FORWARD_BASE`, `/gprometheus` by default).
- A quick tunnel gets a new address every time it restarts, so `scripts/report-address.mjs` reports the current
  one to the site once a minute. When the reports stop, the site can fall back to the saved copy that
  `scripts/export-static.mjs` writes.
- A run marked private (it has attached files, or a file named `private` in its folder) is not shown through the
  forward, unless it was started there or has a file named `forwarded` in its folder.
- Starting a run through the forward takes the run code as well (the server's own access code), and at most
  `SWARM_FORWARD_MAX_AGENTS` agents (128 by default): the site's code only opens the pages.
- A page opened through a tunnel follows a run by asking for new events request by request
  (`/api/runs/<id>/events?from=<byte>`), because a tunnel holds a slow event stream back.
