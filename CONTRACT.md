# Data contract between the orchestrator (swarm.mjs) and the page (public/)

A run lives in `runs/<runId>/` (runId like `r_20261121_2140_ab12`):

- `events.ndjson`: append-only, one JSON object per line, in time order.
- `ledger.jsonl`: append-only evidence ledger (same rows as also carried in `ledger` events).
- `report.md`: final report (Markdown, claims tagged like `[C1-2]`), written near the end.
- `baseline.md`: Google's own Deep Research agent answer to the same question (optional).

## Event kinds (`t` field)

```
{"t":"run","id":"r_…","question":"…","seats":[{"id":"P","role":"planner","model":"gemini-4-argon"},{"id":"R1","role":"researcher","model":"gemini-4-hydrogen"},…,{"id":"X1","role":"redteam",…},{"id":"J","role":"judge",…},{"id":"W","role":"writer",…}],"budget_min":30,"started_at":"…Z"}
{"t":"phase","name":"plan|research|crosscheck|redteam|fix|gate|write|judge|done","round":1,"at":"…Z"}
{"t":"msg","seat":"R1","text":"@R2 please cross-check C1-2 …","at":"…Z"}            // a Room message; seat "system" = orchestrator
{"t":"turn","seat":"R1","phase":"research","status":"started","at":"…Z"}
{"t":"turn","seat":"R1","phase":"research","status":"completed|failed","interaction_id":"…","searches":["query 1",…],"urls":["https://…",…],"tokens":123456,"ms":84000,"error":null,"at":"…Z"}
{"t":"ledger","seat":"R1","rows":[ …ledger rows… ],"rejected":[{"row":{…},"why":"…"}],"at":"…Z"}
{"t":"gate","attempt":1,"pass":false,"problems":["C1-2 has no confirmed check", …],"stats":{"key_claims":9,"confirmed":7,"open_challenges":1,"quotes_checked":6,"quotes_found":5},"at":"…Z"}
{"t":"judge","attempt":1,"pass":true,"notes":"…","at":"…Z"}
{"t":"report","at":"…Z"}
{"t":"baseline","status":"started|completed|failed","agent":"deep-research-…","searches":[…],"urls":[…],"tokens":…,"ms":…,"at":"…Z"}
{"t":"done","status":"passed|ended|failed","totals":{"tokens":…,"searches":…,"urls_opened":…,"turns":…,"minutes":…},"at":"…Z"}
```

## Ledger rows (`type` field; every row has `by` seat and `at`)

```
{"type":"question","id":"Q0-1","text":"…","parent":null,"owner":"R1"}
{"type":"claim","id":"C1-1","text":"…","key":true,"status":"kept|dropped","single_source":false}
{"type":"source","id":"S1-1","claim":"C1-1","url":"https://…","title":"…","publisher":"…","quote":"exact text copied from the page","stance":"agrees|contradicts","published":"2026-11-19","retrieved":"2026-11-21"}
{"type":"answer","question":"Q0-1","status":"answered|abandoned","text":"…","claims":["C1-1"]}
{"type":"not_found","text":"…","searched":"…"}
{"type":"check","source":"S1-1","result":"confirmed|wrong|unreachable","note":"…"}
{"type":"challenge","id":"X1-1","claim":"C1-1","to":"R1","text":"…"}
{"type":"resolution","challenge":"X1-1","text":"…"}
```

A later row with the same `id` replaces the earlier one (latest wins).

## HTTP API (server.mjs)

- `GET /api/runs` → `[{id, question, started_at, status}]` newest first.
- `POST /api/runs` body `{"question":"…","researchers":6,"redteam":2,"minutes":30,"baseline":true}` → `{id}`.
- `GET /api/runs/<id>/stream` → Server-Sent Events: every line of events.ndjson as `data: <json>\n\n` (replays from the start, then tails until `done`).
- `GET /api/runs/<id>/file/<name>` → `report.md`, `baseline.md`, `ledger.jsonl`, `events.ndjson`.
- Static files from `public/` at `/`; `/run/<id>` serves `public/index.html` too (the page reads the id from the path).

## File names in a report on attached files

After the citation check, a run with attached files compares every file path the report names (in backticks) with the attached files. Sentences that name a file that is not there are judged one by one: saying a file is missing is left alone, a shortened path is corrected to the real one, and a sentence that says the team read or used such a file is corrected. The event is `{"t":"files_check","unknown":[paths],"sentences":n,"fixed":n,"unchecked":n}`. `node swarm.mjs --run <id> --from files` runs only this step on a finished report and keeps the earlier text in `report.prefiles.md`.
