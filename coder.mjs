// ProgramBench with Gemini 4: one agent vs a swarm, same wall-clock time.
//   node coder.mjs --out <arm dir> --agents 32 --minutes 15 [--model gemini-4-neon] [--image pb-ffmpeg-claude:1]
//
// Each agent is a Gemini model with one tool (bash) inside its own container of ProgramBench's clean-room
// image: no network, the reference binary execute-only at /opt/reference/executable. All agents of an arm
// share one project folder (/workspace) and a board (BOARD.md). The product is the folder at the deadline;
// ProgramBench's official evaluator grades it afterwards with the hidden tests.
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const OUT = path.resolve(arg("--out"));
const N = Number(arg("--agents", "1"));
const MINUTES = Number(arg("--minutes", "15"));
const MODEL = arg("--model", "gemini-4-neon");
const PLAN_MODEL = arg("--plan-model", MODEL);
const IMAGE = arg("--image", "pb-ffmpeg-claude:1");
const TAG = arg("--tag", path.basename(OUT)).replace(/[^a-z0-9-]/gi, "-");
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const WORK = path.join(OUT, "work", "ffmpeg");
const TOOLS = path.join(OUT, "tools");
const ai = new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY || fs.readFileSync(path.join(os.homedir(), ".config/gemini/api_key"), "utf8")).trim() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const emit = (ev) => fs.appendFileSync(path.join(OUT, "events.ndjson"), JSON.stringify({ ...ev, at: now() }) + "\n");
const totals = { tokens: 0, steps: 0, commands: 0, errors: 0 };

const GOAL = `This is a reverse-engineering benchmark (ProgramBench, task ffmpeg__ffmpeg.360a402). You are given a compiled binary and its documentation. Write a new, original codebase from scratch that produces an executable with identical behaviour. You must figure out the behaviour solely by running and interacting with the provided binary.

The binary is /opt/reference/executable (it can be run, not read). The project folder /workspace holds its bundled documentation (README.md, assets/). There is no Internet.

What is needed: ./compile.sh at the root of the project that, on a fresh checkout, produces ./executable at the root of the project, with exactly the behaviour of the reference. Hidden tests run your ./executable against the reference's behaviour when the time is up; if compile.sh fails on a fresh checkout, the result is zero.

Rules. Breaking any of them disqualifies the result:
1. No source code from anywhere: do not search for, download or read the original project's source.
2. No wrapping or reusing the reference: the solution must not run /opt/reference/executable or any other build of FFmpeg, and must not copy it.
3. No binary analysis of the reference: do not decompile or disassemble it, and do not use strace, ltrace or similar tools on it. Learn its behaviour only by running it with inputs, flags and arguments, and from the documentation.`;

const STRUCTURE = `HOW THE PROJECT IS BUILT (already in place, do not change main.py or compile.sh):
- compile.sh copies main.py to ./executable. main.py loads every areas/*.py (Python 3.10, standard library only) and calls handle(argv) of each, in order of the module's PRIORITY (lower first, default 50). The first handle that returns an int ends the program with that exit code; returning None means "not mine". A module that fails to import is skipped, so a broken file silently loses all its behaviour.
- handle(argv) gets the arguments after the program name. Decide whether the invocation is yours BEFORE writing anything to stdout or stderr or creating files. Write bytes with sys.stdout.buffer / sys.stderr.buffer when exact output matters.
- Data too large for the .py file goes in areas/<your file name without .py>_data/. Find it relative to os.path.realpath(__file__).
- Save a file by writing areas/.tmp-<name> and then mv-ing it over areas/<name>.py, so nobody ever loads a half-written file.
- Compare with the reference: python3 /opt/tools/cmp.py <arguments...> runs compile.sh, then runs the reference and ./executable with the same arguments in two fresh copies of assets/, and prints whether exit code, stdout, stderr and created files are the same (with the first differences). Tests look at exit code, stdout and output files first; match stderr as far as you can.`;

function agentPrompt(a, areas) {
  const team = N > 1;
  return `${GOAL}

${STRUCTURE}

${team ? `YOU ARE ${a.id}, one of ${N} agents building this at the same time in the same folder. Nobody will tell you what to do next: you work in your own loop until the time is up.
YOUR AREA: ${a.area.title}: ${a.area.scope}
YOUR FILE: areas/${a.area.file}.py (and areas/${a.area.file}_data/). Only you write these. Never edit another agent's file, main.py or compile.sh.
THE BOARD: /workspace/BOARD.md is a message board all agents read and append to (echo "[${a.id}] ..." >> /workspace/BOARD.md). Read it now and then (tail -n 30). Use it to say what your handle() claims (which argument patterns), to hand over something you found that belongs to another area, and to ask. If two areas would claim the same invocation, the more specific one takes a lower PRIORITY: settle it on the board.
ALL AREAS:
${areas.map((x) => `- ${x.owner} areas/${x.file}.py: ${x.title}`).join("\n")}` : `You work alone, in your own loop until the time is up. Put each group of behaviour in its own areas/<name>.py file.`}

You have ${MINUTES} minutes in total. Work in small steps that each leave the project working: learn one behaviour from the reference, write it, check it with cmp.py, move to the next. Prefer breadth of exactly-matching invocations over depth on one. Use the bash tool for everything; there is nobody to talk to, so do not ask questions and do not stop early.`;
}

// ------------------------------------------------------------ containers
function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
function startContainer(name) {
  try { docker(["rm", "-f", name]); } catch {}
  docker(["run", "-d", "--name", name, "--network", "none", "--cpus", "1", "--memory", "1500m", "--pids-limit", "256", "-u", "node", "-w", "/workspace",
    "-v", `${WORK}:/workspace`, "-v", `${TOOLS}:/opt/tools:ro`, "--entrypoint", "sleep", IMAGE, "infinity"]);
}
function bash(container, command, timeout = 90) {
  return new Promise((resolve) => {
    const p = spawn("docker", ["exec", "-u", "node", "-w", "/workspace", container, "timeout", "-k", "2", String(timeout), "bash", "-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (d) => { if (out.length < 400_000) out += d; };
    p.stdout.on("data", add); p.stderr.on("data", add);
    const kill = setTimeout(() => p.kill("SIGKILL"), (timeout + 10) * 1000);
    p.on("close", (code) => {
      clearTimeout(kill);
      if (out.length > 7000) out = out.slice(0, 3500) + `\n… [${out.length - 7000} characters left out] …\n` + out.slice(-3500);
      resolve(`${out}${out.endsWith("\n") || !out ? "" : "\n"}[exit ${code === 124 ? `124: timed out after ${timeout}s` : code}]`);
    });
    p.on("error", (e) => { clearTimeout(kill); resolve(`[could not run: ${e.message}]`); });
  });
}

// ------------------------------------------------------------ scaffold
const MAIN_PY = `#!/usr/bin/env python3
import glob, importlib.util, os, sys

HERE = os.path.dirname(os.path.realpath(__file__))


def load():
    mods = []
    for p in sorted(glob.glob(os.path.join(HERE, "areas", "*.py"))):
        try:
            spec = importlib.util.spec_from_file_location("area_" + os.path.basename(p)[:-3], p)
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
            if hasattr(m, "handle"):
                mods.append(m)
        except Exception:
            pass
    return sorted(mods, key=lambda m: getattr(m, "PRIORITY", 50))


def main():
    argv = sys.argv[1:]
    for m in load():
        try:
            rc = m.handle(argv)
        except SystemExit:
            raise
        except Exception:
            rc = None
        if rc is not None:
            sys.stdout.flush()
            sys.exit(rc)
    sys.exit(1)


main()
`;
const COMPILE_SH = `#!/bin/sh
set -e
cd "$(dirname "$0")"
cp main.py executable
chmod +x executable
`;
const CMP_PY = `#!/usr/bin/env python3
"""cmp.py ARGS...: run the reference and ./executable with the same arguments, each in a fresh copy of assets/, and compare."""
import hashlib, os, shutil, subprocess, sys, tempfile

def run(binary, args):
    d = tempfile.mkdtemp(prefix="cmp-")
    for f in os.listdir("/workspace/assets"):
        shutil.copy(os.path.join("/workspace/assets", f), d)
    before = set(os.listdir(d))
    try:
        p = subprocess.run([binary] + args, cwd=d, stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
        rc, out, err = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        rc, out, err = "timeout", b"", b""
    files = {f: hashlib.md5(open(os.path.join(d, f), "rb").read()).hexdigest() + " %d bytes" % os.path.getsize(os.path.join(d, f)) for f in sorted(set(os.listdir(d)) - before)}
    shutil.rmtree(d, ignore_errors=True)
    return rc, out, err, files

def first_diff(a, b):
    la, lb = a.splitlines(), b.splitlines()
    for i in range(max(len(la), len(lb))):
        x = la[i] if i < len(la) else None
        y = lb[i] if i < len(lb) else None
        if x != y:
            return "line %d\\n  reference: %r\\n  yours:     %r" % (i + 1, x, y)
    return "same lines, different bytes (line endings or trailing newline)"

subprocess.run(["sh", "/workspace/compile.sh"], check=True)
args = sys.argv[1:]
r, m = run("/opt/reference/executable", args), run("/workspace/executable", args)
names = ["exit code", "stdout", "stderr", "files"]
same = [r[i] == m[i] for i in range(4)]
print(" ".join("%s:%s" % (n, "SAME" if s else "DIFF") for n, s in zip(names, same)))
if not same[0]: print("exit code: reference %s, yours %s" % (r[0], m[0]))
for i in (1, 2):
    if not same[i]: print("%s (%d vs %d bytes): %s" % (names[i], len(r[i]), len(m[i]), first_diff(r[i], m[i])))
if not same[3]: print("files: reference %s\\n       yours     %s" % (r[3], m[3]))
`;

function scaffold() {
  fs.mkdirSync(path.join(WORK, "areas"), { recursive: true });
  fs.mkdirSync(TOOLS, { recursive: true });
  // the task's bundled documentation, from the image
  const c = `pbg-seed-${TAG}`;
  try { docker(["rm", "-f", c]); } catch {}
  docker(["create", "--name", c, IMAGE]);
  execFileSync("sh", ["-c", `docker cp ${c}:/workspace/. '${WORK}/' && docker rm -f ${c}`], { stdio: "ignore" });
  fs.writeFileSync(path.join(WORK, "main.py"), MAIN_PY);
  fs.writeFileSync(path.join(WORK, "compile.sh"), COMPILE_SH, { mode: 0o755 });
  fs.writeFileSync(path.join(WORK, ".gitignore"), "executable\n__pycache__/\n");
  fs.writeFileSync(path.join(WORK, "BOARD.md"), "");
  fs.writeFileSync(path.join(TOOLS, "cmp.py"), CMP_PY);
  execFileSync("chmod", ["-R", "a+rwX", WORK]);
  execFileSync("chmod", ["-R", "a+rX", TOOLS]);
}

// ------------------------------------------------------------ plan (swarm only)
async function plan(helpText) {
  const sys = `You split a reverse-engineering job among ${N} programmers. The program is a command-line media tool; below is its own help output. Each programmer owns one Python module that handles one group of invocations. Split ALL observable behaviour into exactly ${N} areas that do not overlap: the informational listings and help topics (several areas: there are many, and each prints long exact text), error messages and option parsing, and the media work itself (probing inputs, decoding and encoding the simple audio formats, muxers and output formats, filters, checksums/hash outputs, stream mapping and metadata). Give more areas to what tests would exercise most. Return ONLY JSON {"areas":[{"file":"snake_case_name","title":"short title","scope":"one or two sentences: which invocations belong here"}]}.`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await ai.models.generateContent({ model: PLAN_MODEL, contents: [{ role: "user", parts: [{ text: `HELP OUTPUT OF THE REFERENCE:\n${helpText.slice(0, 30000)}` }] }], config: { systemInstruction: sys } });
      totals.tokens += res.usageMetadata?.totalTokenCount || 0;
      const areas = JSON.parse((res.text.match(/\{[\s\S]*\}/) || ["{}"])[0]).areas || [];
      const seen = new Set();
      const clean = areas.map((x) => ({ ...x, file: String(x.file || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40) })).filter((x) => x.file && !seen.has(x.file) && seen.add(x.file));
      if (clean.length >= Math.min(N, 4)) return clean.slice(0, N);
    } catch (e) { emit({ t: "plan_error", error: String(e.message).slice(0, 200) }); }
  }
  return Array.from({ length: N }, (_, i) => ({ file: `part_${i + 1}`, title: `Part ${i + 1}`, scope: "Pick a group of invocations nobody has claimed on the board and say so there." }));
}

// ------------------------------------------------------------ one agent's loop
const TOOL = [{ functionDeclarations: [{ name: "bash", description: "Run a bash command in /workspace inside your container and get its combined stdout and stderr and exit code. Commands are cut off after timeout_s seconds (default 90, at most 300).", parameters: { type: "OBJECT", properties: { command: { type: "STRING" }, timeout_s: { type: "NUMBER" } }, required: ["command"] } }] }];

async function agentLoop(a, areas, deadline) {
  const sys = agentPrompt(a, areas);
  const contents = [{ role: "user", parts: [{ text: `Begin. ${MINUTES} minutes remain.` }] }];
  let quiet = 0;
  while (Date.now() < deadline - 5000) {
    let res;
    try {
      res = await Promise.race([
        ai.models.generateContent({ model: MODEL, contents, config: { systemInstruction: sys, tools: TOOL } }),
        sleep(Math.min(240_000, deadline - Date.now() + 2000)).then(() => { throw new Error("model call timed out"); }),
      ]);
    } catch (e) {
      totals.errors++;
      emit({ t: "error", agent: a.id, error: String(e.message || e).slice(0, 300) });
      if (Date.now() > deadline - 5000) break;
      await sleep(/429|quota|rate|exhaust/i.test(String(e.message)) ? 15000 : 4000);
      continue;
    }
    const tokens = res.usageMetadata?.totalTokenCount || 0;
    a.tokens += tokens; totals.tokens += tokens; a.steps++; totals.steps++;
    const content = res.candidates?.[0]?.content;
    const calls = res.functionCalls || [];
    if (content?.parts?.length) contents.push(content);
    const left = () => Math.max(0, (deadline - Date.now()) / 60000).toFixed(1);
    if (!calls.length) {
      quiet++;
      emit({ t: "say", agent: a.id, text: (res.text || "").slice(0, 300), tokens });
      contents.push({ role: "user", parts: [{ text: `${left()} minutes remain. Nobody reads your messages; keep working with the bash tool: pick the next behaviour of the reference in your area that does not match yet.` }] });
      if (quiet > 3) await sleep(5000);
      continue;
    }
    quiet = 0;
    const parts = [];
    for (const c of calls) {
      const command = String(c.args?.command || "");
      const t0 = Date.now();
      const out = Date.now() < deadline ? await bash(a.container, command, Math.max(5, Math.min(300, Number(c.args?.timeout_s) || 90, (deadline - Date.now()) / 1000))) : "[time is up]";
      a.commands++; totals.commands++;
      emit({ t: "bash", agent: a.id, command: command.slice(0, 400), ms: Date.now() - t0, exit: (out.match(/\[exit ([^\]]+)\]$/) || [])[1], tokens });
      parts.push({ functionResponse: { name: c.name, ...(c.id ? { id: c.id } : {}), response: { output: `${out}\n[${left()} minutes remain]` } } });
    }
    contents.push({ role: "user", parts });
  }
  emit({ t: "agent_done", agent: a.id, steps: a.steps, commands: a.commands, tokens: a.tokens });
}

// ------------------------------------------------------------ main
fs.mkdirSync(OUT, { recursive: true });
emit({ t: "start", agents: N, minutes: MINUTES, model: MODEL, image: IMAGE });
scaffold();
const agents = Array.from({ length: N }, (_, i) => ({ id: `A${i + 1}`, container: `pbg-${TAG}-${i + 1}`, tokens: 0, steps: 0, commands: 0 }));
for (const a of agents) startContainer(a.container);
let areas = [];
if (N > 1) {
  const help = await bash(agents[0].container, "/opt/reference/executable -h 2>&1 | head -c 30000");
  areas = await plan(help);
  while (areas.length < N) areas.push({ file: `extra_${areas.length + 1}`, title: "Unclaimed behaviour", scope: "Find a group of invocations nobody has claimed on the board and say so there." });
  areas.forEach((x, i) => { x.owner = agents[i].id; agents[i].area = x; });
  fs.writeFileSync(path.join(OUT, "areas.json"), JSON.stringify(areas, null, 2));
  emit({ t: "plan", areas: areas.map(({ owner, file, title }) => ({ owner, file, title })) });
}
// the clock starts when the agents start
const started = Date.now();
const deadline = started + MINUTES * 60_000;
emit({ t: "clock", started: new Date(started).toISOString(), deadline: new Date(deadline).toISOString() });
const tick = setInterval(() => emit({ t: "tick", ...totals, files: fs.readdirSync(path.join(WORK, "areas")).filter((f) => f.endsWith(".py")).length }), 30_000);
await Promise.all(agents.map((a) => agentLoop(a, areas, deadline)));
clearInterval(tick);
for (const a of agents) { try { docker(["rm", "-f", a.container]); } catch {} }
// does it build on a fresh copy? (recorded only; nothing is fixed after the deadline)
let build = "";
try {
  const c = `pbg-${TAG}-check`;
  try { docker(["rm", "-f", c]); } catch {}
  build = docker(["run", "--rm", "--name", c, "--network", "none", "-u", "node", "-v", `${WORK}:/src:ro`, "--entrypoint", "bash", IMAGE, "-lc", "cp -r /src /tmp/p && cd /tmp/p && rm -f executable && ./compile.sh && ./executable -version | head -1; echo exit=$?"]).trim().slice(-300);
} catch (e) { build = `failed: ${String(e.stderr || e.message).slice(-300)}`; }
const py = fs.readdirSync(path.join(WORK, "areas")).filter((f) => f.endsWith(".py"));
const lines = py.reduce((n, f) => n + fs.readFileSync(path.join(WORK, "areas", f), "utf8").split("\n").length, 0);
emit({ kind: "done", t: "done", ...totals, minutes: +((Date.now() - started) / 60000).toFixed(1), area_files: py.length, lines, build });
console.log(JSON.stringify({ ...totals, area_files: py.length, lines, build }));
process.exit(0);
