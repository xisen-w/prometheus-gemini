// Tells a site that forwards to this server where the server can be reached right now.
//
// The server sits behind a quick tunnel, and a quick tunnel gets a new address every time it restarts. A site
// that passes its own pages on to this server (sharednet.ai/gprometheus does) therefore cannot be given the
// address once. This script reads the tunnel's current address from its log, checks that the server answers
// there with the forward key, and reports the address to the site once a minute. When the reports stop, the
// site goes back to serving its saved copy of finished runs.
//
//   SWARM_REPORT_TO     the site's endpoint (default https://www.sharednet.ai/api/gprometheus/upstream)
//   SWARM_REPORT_TOKEN  the secret the site asks for (PROMETHEUS_WORKER_TOKEN is read when this is not set)
//   SWARM_TUNNEL_LOG    the tunnel's log (default runs/.tunnel.log)
// The forward key is derived from the secret, the same way on both sides, and must be the server's
// SWARM_FORWARD_KEY. `node scripts/report-address.mjs --key` prints nothing but writes it to the file named.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const TO = process.env.SWARM_REPORT_TO || "https://www.sharednet.ai/api/gprometheus/upstream";
const TOKEN = (process.env.SWARM_REPORT_TOKEN || process.env.PROMETHEUS_WORKER_TOKEN || "").trim();
const LOG = process.env.SWARM_TUNNEL_LOG || path.join(ROOT, "runs", ".tunnel.log");
const EVERY_MS = 60_000;
if (TOKEN.length < 32) { console.error("no secret to report with (SWARM_REPORT_TOKEN)"); process.exit(2); }
const KEY = crypto.createHmac("sha256", TOKEN).update("gprometheus-forward-v1").digest("hex").slice(0, 48);

const keyFile = process.argv.indexOf("--key");
if (keyFile > 0) {
  fs.writeFileSync(process.argv[keyFile + 1], KEY, { mode: 0o600 });
  process.exit(0);
}

function tunnelAddress() {
  try {
    const all = fs.readFileSync(LOG, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    return all ? all.at(-1) : null;
  } catch { return null; }
}
const within = (ms) => AbortSignal.timeout(ms);

let last = "";
const say = (line) => { if (line !== last) { console.log(new Date().toISOString(), line); last = line; } };

async function once() {
  const url = tunnelAddress();
  if (!url) return say("no tunnel address in the log yet");
  try {
    const ping = await fetch(`${url}/__gp/${KEY}/api/ping`, { signal: within(15_000) });
    if (!ping.ok) return say(`the server does not answer at ${url} with the forward key (${ping.status}); not reported`);
  } catch (e) { return say(`${url} cannot be reached (${e.name}); not reported`); }
  try {
    const r = await fetch(TO, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ url }), signal: within(20_000) });
    say(r.ok ? `reporting ${url}` : `the site refused the report (${r.status})`);
  } catch (e) { say(`the site cannot be reached (${e.name})`); }
}

// Going away on purpose: say so, and the site serves its saved copy from now on.
async function leave() {
  try { await fetch(TO, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` }, signal: within(8_000) }); } catch {}
  process.exit(0);
}
process.on("SIGTERM", leave);
process.on("SIGINT", leave);

await once();
setInterval(once, EVERY_MS);
