#!/usr/bin/env node
// build-workflow-artifact.mjs — GENERIC workflow artifact builder (before AND after a run).
// Usage: node build-workflow-artifact.mjs <workflow.js> <out.html> [argsJson]
//                                         [--run <dir|latest>] [--match <s>] [--watch] [--open] [--interval <ms>]
//
// Renders a self-contained, Claude-styled, tabbed HTML preview of ANY dynamic-workflow
// script (Diagram · Agents & prompts · Schemas · Composes · Full script) so you can review
// the orchestration BEFORE launching it. See memory: [[show-workflow-before-launch]].
//
// HOW (static preview): it executes the script body with STUBBED runtime globals that RECORD every
// agent(prompt, opts) call (prompt is the first arg, captured verbatim), run parallel()/
// pipeline() callbacks so nested agents are recorded, and note workflow() composition.
// agent() returns a lenient proxy so downstream result-processing rarely throws; the whole
// run is wrapped in try/catch so a partial extraction still yields an artifact. Runtime-
// injected prompt parts (prior-agent outputs) render as empty/short — the STATIC prompt
// scaffolding, schemas, models/efforts/tools and structure are what you review.
//
// HOW (--run merge): after (or during) a real run, pass --run <runDir> to MERGE the actual
// executed agents (from status.json + events.jsonl + agents/*.md) onto the static structure,
// matched by normalized label. This fills phases that the static preview left empty because they
// were gated on runtime values (e.g. a fan-out over prior-agent output). --watch re-renders on
// each status.json change until the run reaches a terminal state; --open opens the HTML now and
// re-opens it once the run finishes. The run records name/prompt/output/ok/count but NOT
// phase/model/effort (those were input opts) — those are recovered from the script by label.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── CLI: <workflow.js> <out.html> [argsJson] plus optional flags ─────────────────────────
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (key === "watch" || key === "open") flags[key] = true;
    else { const nxt = argv[i + 1]; flags[key] = nxt && !nxt.startsWith("--") ? argv[++i] : true; }
  } else pos.push(a);
}
const scriptPath = pos[0];
const outPath = pos[1];
const argsJson = pos[2];
if (!scriptPath || !outPath) { console.error("usage: build-workflow-artifact.mjs <workflow.js> <out.html> [argsJson] [--run <dir|latest>] [--match <s>] [--watch] [--open] [--interval <ms>]"); process.exit(2); }
const raw = readFileSync(scriptPath, "utf8");

// Reusable JSON->Markdown renderer (auto table/list/kv), inlined into the artifact's client script.
// The `export` is stripped so it becomes a plain function in the classic <script> scope, and it is
// interpolated via ${...} so its content (even backticks or ${...}) can NEVER break the outer
// template literal — the safe pattern the review flagged for all client-side JS.
const jsonToMarkdownSource = (() => {
  try { return readFileSync(new URL("./lib/json-to-markdown.mjs", import.meta.url), "utf8").replace(/\bexport\s+/g, ""); }
  catch { return 'function jsonToMarkdown(v){return typeof v==="string"?v:JSON.stringify(v,null,2);}'; }
})();
const clientJsSource = (() => {
  try { return readFileSync(new URL("./lib/artifact-client.js", import.meta.url), "utf8"); }
  catch { return 'document.body.innerHTML="<p>artifact-client.js missing</p>";'; }
})();

// De-dup / grouping key: strip trailing numeric/escalation indices from a label ("skeptic-3" -> "skeptic").
const norm = (l) => String(l || "agent").replace(/(-e?\d+)+$/i, "").replace(/-\d+$/g, "");
// meta.phases entries may be plain strings ("asignacion") OR objects ({ title: "discover" }).
const phaseTitleOf = (p) => (typeof p === "string" ? p : p && p.title);

// Kitchen-sink args so most workflows' required-input guards pass and the body runs.
const argsObj = argsJson ? JSON.parse(argsJson) : {
  task: "<task>", request: "<request>", text: "<text>", question: "<question>", goal: "<goal>",
  problem: "<problem>", topic: "<topic>", content: "<content>", instruction: "<instruction>",
  files: ["a.js", "b.js"], items: ["x"], claims: ["c1"], findings: [], bugs: [],
  rules: ["r"], inputRules: ["r"], outputRules: ["r"], protect: { name: "fan-out-and-synthesize", args: {} },
  angles: ["a1", "a2"], reviewers: 1, skeptics: 1, samples: 2, finders: 1, maxRounds: 1,
  maxTrials: 1, depth: 1, branching: 2, beam: 1, maxClaims: 1, maxSubtasks: 2, generate: false,
};

// Support BOTH harness styles:
//  - Claude-style top-level scripts: `export const meta = …` + top-level agent() calls; the body runs
//    inline and the stubs record nodes as it executes (it usually ends in a top-level `return`).
//  - export-default workflows: Pi ctx-style `export default async function workflow(ctx, input)` OR
//    globals-style `export default async function main()` (and arrow forms). For these the body only
//    DEFINES the entry, so we capture it as globalThis.__default and CALL it after the body runs,
//    passing a recording `ctx` whose methods alias the same stubs (so ctx.agent(...) is recorded too).
const transformed = raw
  .replace(/export\s+const\s+meta\s*=/, "globalThis.__meta =")
  .replace(/export\s+default\s+/, "globalThis.__default = ");
const stubs = `
  globalThis.__nodes = []; globalThis.__composes = []; globalThis.__phases = []; globalThis.__pipeErr = null;
  // Object-target proxy so \`typeof result === 'object'\` checks pass; lenient on every access.
  const lenient = () => new Proxy({}, {
    get(_t, p){
      if (p === 'then') return undefined;
      if (p === Symbol.iterator) return Array.prototype[Symbol.iterator].bind([]);
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return () => '‹runtime value›';
      if (['map','filter','flatMap','forEach','slice','sort','join','reduce','some','every','find','concat','keys','values','entries'].includes(p)) return () => [];
      // String methods a workflow may call on agent TEXT output. Without these, a bare property access
      // falls through to the non-callable lenient() below and throws ("x.match is not a function"),
      // aborting the trace as PARTIAL. Return correctly-typed values so chains like
      // text.match(re) ? m[1].trim() : text.split('\\n') never throw.
      if (p === 'match' || p === 'matchAll') return () => null;
      if (p === 'split') return () => [];
      if (['replace','replaceAll','trim','trimStart','trimEnd','trimLeft','trimRight','toLowerCase','toUpperCase','toLocaleLowerCase','toLocaleUpperCase','padStart','padEnd','repeat','substring','substr','charAt','at','normalize'].includes(p)) return () => '‹runtime value›';
      if (['includes','startsWith','endsWith','test'].includes(p)) return () => false;
      if (['indexOf','lastIndexOf','search'].includes(p)) return () => -1;
      if (['charCodeAt','codePointAt','localeCompare'].includes(p)) return () => 0;
      if (p === 'length') return 0;
      return lenient();
    },
  });
  const phase = (t) => { if (t && !globalThis.__phases.includes(t)) globalThis.__phases.push(String(t)); };
  const log = () => {};
  const agent = async (prompt, opts = {}) => {
    globalThis.__nodes.push({ prompt: String(prompt ?? ''), label: opts.label || opts.name, phase: opts.phase,
      schema: opts.schema, model: opts.model, effort: opts.effort, tools: opts.tools, skills: opts.skills, extensions: opts.extensions });
    return lenient();
  };
  // ctx-style workflows fan out with agents(items, …); record one representative node, return lenient rows.
  const agents = async (items, opts = {}) => {
    const arr = Array.isArray(items) ? items : [];
    // Per-item specs commonly carry phase/label/model/schema (not the top-level opts), so fall back
    // to the first spec object when the top-level opts omit them — otherwise the fan-out node lands
    // with no phase and its declared phase box renders empty.
    const rep = arr.length && arr[0] && typeof arr[0] === 'object' ? arr[0] : {};
    if (arr.length) globalThis.__nodes.push({ prompt: '‹per-item agents() fan-out›', label: opts.label || opts.name || rep.label || rep.name,
      phase: opts.phase ?? rep.phase, schema: opts.schema ?? rep.schema, model: opts.model ?? rep.model,
      effort: opts.effort ?? rep.effort, tools: opts.tools ?? rep.tools, skills: opts.skills ?? rep.skills, extensions: opts.extensions ?? rep.extensions });
    return arr.map(() => lenient());
  };
  const parallel = async (thunks) => Promise.all((thunks || []).map(async (t) => { try { return await t(); } catch { return null; } }));
  const pipeline = async (items, ...stages) => {
    const arr = Array.isArray(items) ? items : [items];
    const probe = arr.length ? arr[0] : '<item>';
    let v = probe;
    for (let i = 0; i < stages.length; i++) { try { v = await stages[i](v, probe, 0); } catch (e) { if (!globalThis.__pipeErr) globalThis.__pipeErr = String((e && e.message) || e); break; } }
    return arr.map(() => v);
  };
  const workflow = async (name, a) => { if (name) globalThis.__composes.push(String(name)); return lenient(); };
  const args = ${JSON.stringify(argsObj)};
  const budget = { total: null, spent: () => 0, remaining: () => Infinity };
  // pi-runtime globals (bare, no ctx.*) so a GLOBALS-style workflow that calls bash()/readFile()/
  // writeArtifact()/sleep()/race()/ask()/… traces without a ReferenceError. Names that scaffolds
  // commonly redeclare locally (compact/fence) are deliberately NOT declared here to avoid a
  // redeclaration SyntaxError; ctx.compact below still serves ctx-style bodies.
  const bash = async () => ({ ok: true, code: 0, stdout: '', stderr: '' });
  const readFile = async () => '';
  const writeFile = async () => {};
  const appendFile = async () => {};
  const listFiles = async () => [];
  const writeArtifact = async (name) => ({ path: '/preview/' + String(name ?? 'artifact') });
  const appendArtifact = async () => {};
  const sleep = async () => {};
  const ask = async (_q, opts = {}) => (opts && Object.prototype.hasOwnProperty.call(opts, 'default') ? opts.default : '');
  const race = async (thunks) => { for (const t of (thunks || [])) { try { const v = await t(() => {}); if (v != null) return { winner: v, index: 0, status: 'won' }; } catch {} } return { winner: null, index: -1, status: 'empty' }; };
  const json = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
  const limits = { concurrency: 3, maxAgents: 60 };
  const runId = 'preview'; const runDir = '/preview'; const cwd = '.';
  globalThis.__default = null; globalThis.__defaultErr = null;
  // CommonJS ctx-style workflows export via module.exports = async function workflow(ctx, input);
  // provide a module stub so the body assigns here instead of throwing 'module is not defined', and
  // pick it up below. (Scaffolds never declare a local const module, so this cannot collide.)
  const module = { exports: null };
  // Recording ctx for export-default ctx-style workflows; methods alias the global stubs / inline no-ops
  // so a body that calls ctx.agent(...)/ctx.parallel(...)/ctx.bash(...) is captured identically. Helpers
  // stay INSIDE this object (not standalone consts) so they never collide with scaffolds that declare
  // their own top-level const compact etc.
  const ctx = {
    runId, runDir, cwd, limits,
    agent, agents, parallel, pipeline, workflow, phase, log, args, budget,
    race, ask, bash, readFile, writeFile, appendFile, listFiles, writeArtifact, appendArtifact, sleep, json,
    compact: (d, n = 60000) => { const s = typeof d === 'string' ? d : JSON.stringify(d); return s.length > n ? s.slice(0, n) + ' …' : s; },
  };
  // Reachable only when the body did NOT already return at top level (i.e. export-default workflows);
  // Claude-style top-level scripts return first, so this is a no-op for them.
  globalThis.__runDefault = async () => {
    const entry = (typeof globalThis.__default === 'function') ? globalThis.__default
      : (typeof module.exports === 'function') ? module.exports : null;
    try { if (entry) await entry(ctx, args); } catch (e) { globalThis.__defaultErr = String((e && e.stack) || e); }
  };
`;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
let runErr = null;
try { await new AsyncFunction(stubs + "\n" + transformed + "\n;await globalThis.__runDefault();")(); } catch (e) { runErr = e; }
if (!runErr && globalThis.__defaultErr) runErr = new Error(globalThis.__defaultErr);

const meta = globalThis.__meta || { name: scriptPath.split("/").pop().replace(/\.js$/, ""), description: "", phases: [] };

// "Based on" tab: a one-line provenance + (optionally) the scaffolds this workflow is based on.
// Two sources, in priority order:
//   1. meta.basedOn (also meta.paper / meta.source): a STRING (provenance line) OR an
//      ARRAY of {name, role?, desc?} scaffold cards. This is the reliable, preferred path.
//   2. Fallback: a leading `Paper:` / `Based on:` / `Source:` comment in the first 1500 chars,
//      as a `//` line comment OR a ` *` block-comment line (both prefixes accepted).
const paperFromComment = (() => {
  const head = raw.slice(0, 1500);
  const m = head.match(/^\s*(?:\/\/|\*)?\s*(?:Paper|Based on|Source)\s*:\s*(.+?)\s*$/im);
  return m ? m[1].replace(/\.*\s*$/, "").trim() : null;
})();
const basedOnRaw = (meta && (meta.basedOn ?? meta.paper ?? meta.source)) ?? null;
const scaffolds = Array.isArray(basedOnRaw)
  ? basedOnRaw.map((t) => (typeof t === "string" ? { name: t } : (t && typeof t === "object" ? t : null))).filter(Boolean)
  : [];
const provenance = (typeof basedOnRaw === "string" ? basedOnRaw : null) || paperFromComment || null;

// ── static-preview nodes (recorded during the stubbed run) ───────────────────────────────
const rawNodes = globalThis.__nodes || [];
const basePhases = (globalThis.__phases && globalThis.__phases.length) ? globalThis.__phases : (meta.phases || []).map(phaseTitleOf).filter(Boolean);
const composes = [...new Set(globalThis.__composes || [])];

const byKey = new Map();
for (const n of rawNodes) {
  const key = (n.phase || "") + "|" + norm(n.label);
  if (!byKey.has(key)) byKey.set(key, { ...n, role: norm(n.label), count: 1 });
  else byKey.get(key).count++;
}
const baseNodes = [...byKey.values()].map((n) => ({
  id: n.role + (n.count > 1 ? ` ×${n.count}` : ""),
  role: n.role,
  phase: n.phase || "—",
  schema: n.schema ? (n.schema.title || "object schema") : "— (free text)",
  schemaObj: n.schema || null,
  model: n.model || "inherited",
  effort: n.effort || "inherited",
  tools: Array.isArray(n.tools) ? n.tools.join(", ") : "inherited",
  skills: Array.isArray(n.skills) ? n.skills : (typeof n.skills === "string" && n.skills ? [n.skills] : []),
  extensions: Array.isArray(n.extensions) ? n.extensions.join(", ") : (typeof n.extensions === "string" ? n.extensions : (n.extensions === false ? "none (opted out)" : "inherited")),
  prompt: n.prompt,
}));

// Resolve each declared skill to its on-disk home + reference files (reference/ or references/),
// so the artifact can show WHICH skills (and their reference docs) each agent loads.
function resolveSkillRefs(names) {
  const bases = [".pi/skills", join(homedir(), ".pi/agent/skills"), join(homedir(), ".agents/skills"), ".claude/skills"];
  const out = {};
  for (const name of names) {
    let found = null;
    for (const base of bases) {
      const dir = join(base, name);
      if (!existsSync(join(dir, "SKILL.md"))) continue;
      const references = [];
      for (const rd of ["reference", "references"]) {
        const rdir = join(dir, rd);
        if (!existsSync(rdir)) continue;
        try {
          for (const e of readdirSync(rdir, { recursive: true, withFileTypes: true })) {
            if (!e.isFile() || !e.name.endsWith(".md")) continue;
            const parent = e.parentPath || e.path || rdir;
            const sub = String(parent).slice(rdir.length).replace(/^[\\/]+/, "");
            references.push(rd + "/" + (sub ? sub + "/" : "") + e.name);
          }
        } catch { /* unreadable reference dir — skip */ }
      }
      found = { base, references: references.sort() };
      break;
    }
    out[name] = found || { missing: true, references: [] };
  }
  return out;
}
const skillRefs = resolveSkillRefs([...new Set(baseNodes.flatMap((n) => n.skills || []))]);

// unique schemas
const schemas = {};
let si = 0;
for (const n of baseNodes) if (n.schemaObj) { const k = (n.role || ("schema" + si++)); if (!schemas[k]) schemas[k] = n.schemaObj; }

// Static fidelity notes (extraction problems) computed once; empty-phase notes are per-render (they
// depend on whether a run filled the phase), so they are added inside build().
const staticFidelity = [];
if (runErr) staticFidelity.push("partial extraction — script threw during stubbed run: " + (runErr.message || runErr));
if (globalThis.__pipeErr) staticFidelity.push("a pipeline() stage threw during extraction (" + globalThis.__pipeErr + ") — agents/phases gated on a prior stage's output may be missing below");

// Source-level declaration scan: recover phase/model/effort for labels whose branch the stubbed run
// never REACHED (e.g. a fan-out gated on prior-agent output). Heuristic: for each label:/name: string
// literal, look in a ±420-char window for phase:/model:/effort: literals in the same opts object.
function scanDeclaredRoles(src) {
  const map = new Map();
  // Capture the opening quote and require the SAME quote to close (backref) so a mismatched
  // quote (e.g. label:"x`) never silently captures across it.
  const re = /(?:label|name)\s*:\s*(["'`])(.*?)\1/g;
  let m;
  while ((m = re.exec(src))) {
    const win = src.slice(Math.max(0, m.index - 420), Math.min(src.length, m.index + 420));
    const grab = (k) => { const g = win.match(new RegExp(k + "\\s*:\\s*([\"'`])(.*?)\\1")); return g ? g[2] : undefined; };
    const role = norm(m[2]);
    const prev = map.get(role) || {};
    map.set(role, { phase: prev.phase ?? grab("phase"), model: prev.model ?? grab("model"), effort: prev.effort ?? grab("effort") });
  }
  return map;
}
const declared = scanDeclaredRoles(raw);

// ── run-data ingestion (--run) ───────────────────────────────────────────────────────────
const tryRead = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const extractPromptFromMd = (md) => { const m = md.match(/\n## Prompt\n\n([\s\S]*?)(?:\n## |\n# |$)/); return m ? m[1].trim().slice(0, 4000) : null; };

function resolveRunDir(spec, match) {
  if (!spec) return null;
  if (spec !== "latest" && spec !== true) return existsSync(spec) ? spec : null;
  const base = join(process.cwd(), ".pi", "workflows", "runs");
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base).map((d) => join(base, d)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  const filtered = match ? dirs.filter((p) => basename(p).includes(String(match))) : dirs;
  filtered.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return filtered[0] || null;
}

function readRunData(runDir) {
  const status = (() => { const s = tryRead(join(runDir, "status.json")); try { return s ? JSON.parse(s) : {}; } catch { return {}; } })();
  const events = tryRead(join(runDir, "events.jsonl")) || "";
  const byId = new Map();
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "agent") continue;
    byId.set(e.id, { ...(byId.get(e.id) || {}), ...e }); // later (completed) events overwrite running
  }
  const byRole = new Map();
  let ok = 0, fail = 0, running = 0;
  for (const a of byId.values()) {
    const role = norm(a.name);
    let g = byRole.get(role);
    if (!g) { g = { role, count: 0, ok: 0, fail: 0, running: 0, output: null, artifact: null, prompt: null }; byRole.set(role, g); }
    g.count++;
    // completed → ok/fail by a.ok; still-running → running; any other terminal state
    // (error/timeout/killed/cancelled) is a FAILURE, not "running".
    if (a.state === "completed") { if (a.ok) { g.ok++; ok++; } else { g.fail++; fail++; } }
    else if (a.state === "running") { g.running++; running++; }
    else { g.fail++; fail++; }
    if (!g.output && a.output) g.output = String(a.output).slice(0, 700);
    if (!g.artifact && a.artifactPath) g.artifact = a.artifactPath;
  }
  for (const g of byRole.values()) { if (g.artifact) { const md = tryRead(g.artifact); if (md) g.prompt = extractPromptFromMd(md); } }

  // Results: the workflow return value (result.json .output) + the artifacts it wrote to the run
  // dir ROOT (non-recursive), excluding engine-internal files. Rendered in the Results tab.
  let returnValue = null;
  const rj = tryRead(join(runDir, "result.json"));
  if (rj) { try { const o = JSON.parse(rj); returnValue = o.output ?? o.result ?? null; } catch {} }
  const EXCLUDE = new Set(["status.json", "events.jsonl", "journal.jsonl", "input.json", "result.json", "metrics.json"]);
  const artifacts = [];
  try {
    for (const f of readdirSync(runDir)) {
      if (EXCLUDE.has(f)) continue;
      const ext = (f.split(".").pop() || "").toLowerCase();
      if (!["md", "json", "txt"].includes(ext)) continue;
      try { if (!statSync(join(runDir, f)).isFile()) continue; } catch { continue; }
      const c = tryRead(join(runDir, f));
      if (c == null) continue;
      artifacts.push({ name: f, ext, content: c.slice(0, 80000) });
    }
  } catch {}
  // summary.md first, then other .md, then .txt, then .json — alpha within each group.
  const rank = (x) => (x.name === "summary.md" ? 0 : x.ext === "md" ? 1 : x.ext === "txt" ? 2 : 3);
  artifacts.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const results = returnValue != null || artifacts.length ? { returnValue, artifacts } : null;

  return { runDir, runId: status.runId || basename(runDir), state: status.state || "unknown", active: !!status.active, agentCount: status.agentCount ?? byId.size, elapsedMs: status.elapsedMs || 0, ok, fail, running, byRole, results };
}

function mergeNodes(runData) {
  if (!runData) return { nodes: baseNodes, extraPhases: [] };
  const rg = (g) => ({ count: g.count, ok: g.ok, fail: g.fail, running: g.running, output: g.output, artifact: g.artifact });
  const used = new Set();
  const nodes = baseNodes.map((n) => { const g = runData.byRole.get(n.role); if (!g) return n; used.add(n.role); return { ...n, run: rg(g) }; });
  const extraPhases = [];
  for (const [role, g] of runData.byRole) {
    if (used.has(role)) continue;
    const d = declared.get(role) || {};
    const phase = d.phase || "runtime";
    if (phase === "runtime" && !extraPhases.includes("runtime")) extraPhases.push("runtime");
    nodes.push({
      id: role + (g.count > 1 ? ` ×${g.count}` : ""), role, phase,
      schema: "— (free text)", schemaObj: null,
      model: d.model || "inherited", effort: d.effort || "inherited", tools: "inherited", skills: [], extensions: "inherited",
      prompt: g.prompt || "‹ recorded at runtime — see artifact ›",
      runtimeOnly: true, run: rg(g),
    });
  }
  return { nodes, extraPhases };
}

// ── mermaid helpers (shared) ─────────────────────────────────────────────────────────────
const mmId = (s) => "P" + String(s).replace(/[^A-Za-z0-9]/g, "_");
const mmLabel = (s) => String(s).replace(/["\[\]{}|<>`$]/g, " ").replace(/\s+/g, " ").trim();
const shortModel = (m) => (m && m !== "inherited" ? String(m).split("/").pop() : null);
const nodeME = (n) => [shortModel(n.model), n.effort && n.effort !== "inherited" ? n.effort : null].filter(Boolean).join("/");

// ── render + write (called once, or repeatedly under --watch) ────────────────────────────
function build(runData) {
  const merged = mergeNodes(runData);
  const nodes = merged.nodes;
  const phases = [...basePhases, ...merged.extraPhases.filter((p) => !basePhases.includes(p))];

  // auto Mermaid: IN -> phase groups in order -> OUT, plus compose edges
  const nodesByPhase = {};
  for (const n of nodes) (nodesByPhase[n.phase] ||= []).push(n);
  // Diagram must show every phase that has nodes — declared phases first, then any extra node
  // phase (e.g. "—" for agents the workflow never tagged with a phase) so nodes are never dropped.
  const nodePhases = Object.keys(nodesByPhase);
  const orderedPhases = [...phases, ...nodePhases.filter((p) => !phases.includes(p))];
  let mm = "flowchart TB\n  IN([args input]):::io\n";
  orderedPhases.forEach((ph) => {
    const ns = nodesByPhase[ph] || [];
    mm += `  subgraph ${mmId(ph)}["${mmLabel(ph)}"]\n   direction LR\n`;
    ns.forEach((n, i) => {
      const me = nodeME(n);
      const glyph = n.run ? (n.run.fail ? ` · ✗${n.run.fail}/${n.run.count}` : n.run.running ? ` · ⏳${n.run.running}` : ` · ✓${n.run.count}`) : "";
      const cls = n.run ? (n.run.fail ? "agf" : n.run.running ? "agr" : "agok") : "ag";
      mm += `   ${mmId(ph)}_${i}["${mmLabel(n.role)}${n.schemaObj ? " · schema" : ""}${me ? " · " + mmLabel(me) : ""}${glyph}"]:::${cls}\n`;
    });
    if (!ns.length) mm += `   ${mmId(ph)}_x["no agents · bash-only or unreached"]:::empty\n`;
    mm += "  end\n";
  });
  let prev = "IN";
  orderedPhases.forEach((ph) => { mm += `  ${prev} --> ${mmId(ph)}\n`; prev = mmId(ph); });
  mm += `  ${prev} --> OUT[/"return"/]:::io\n`;
  composes.forEach((c, i) => { mm += `  COMP${i}{{"workflow ${mmLabel(c)}"}}:::comp\n  ${prev} -. composes .-> COMP${i}\n`; });
  mm += "  classDef io fill:#f3efe7,stroke:#8a877f,color:#1f1e1d;\n  classDef ag fill:#e7f1ea,stroke:#3f7a52,color:#1f3d2a;\n  classDef agok fill:#dcefe1,stroke:#2f7a4a,color:#123421;\n  classDef agr fill:#dbe7f7,stroke:#2f6f9e,color:#1f3350;\n  classDef agf fill:#fbe3da,stroke:#b54545,color:#5c1f13;\n  classDef comp fill:#efe7f6,stroke:#7a4fb0,color:#3a2356;\n  classDef empty fill:#f6f4ee,stroke:#d9d5cc,color:#8a877f;";

  // Fidelity notes — an empty box is never read as "no agents" when it's really runtime-gated.
  const fidelityNotes = [...staticFidelity];
  const declaredPhaseTitles = (meta.phases || []).map(phaseTitleOf).filter(Boolean);
  const emptyDeclared = declaredPhaseTitles.filter((t) => !nodes.some((n) => n.phase === t));
  if (emptyDeclared.length) fidelityNotes.push("declared phase(s) with no recorded agents: " + emptyDeclared.join(", ") + (runData ? " — still gated on runtime values or bash-only (not reached in this run)" : " — likely gated on runtime values; see the Full script tab"));

  const run = runData ? { runId: runData.runId, state: runData.state, active: runData.active, agentCount: runData.agentCount, ok: runData.ok, fail: runData.fail, running: runData.running, elapsedMs: runData.elapsedMs } : null;
  const data = {
    meta, phases, composes, __mm: mm,
    provenance, scaffolds, source: scriptPath,
    args: argsJson ? "(provided)" : "(kitchen-sink defaults for extraction)",
    schemas, nodes, skillRefs, script: raw, run,
    results: runData ? runData.results : null,
    warn: fidelityNotes.length ? fidelityNotes.join(" · ") : null,
  };
  const jsonBlob = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const autoRefresh = !!(runData && runData.active);

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${autoRefresh ? '<meta http-equiv="refresh" content="2">' : ""}
<title>${(meta.name || "workflow").replace(/[<>&]/g, "")} — workflow</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css">
<style>
  :root{--bg:#faf9f5;--paper:#fff;--ink:#1f1e1d;--ink2:#52504b;--muted:#8a877f;--line:#e7e4db;--coral:#d97757;--coral-d:#bd5d3f;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif;}
  .container{max-width:980px;margin:0 auto;padding:0 24px 80px;}
  header{padding:40px 0 8px;} header .kicker{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--coral-d);font-weight:600;}
  header h1{margin:6px 0 6px;font-size:28px;} header p{margin:0;color:var(--ink2);max-width:74ch;}
  .prov{margin:0 0 16px;padding:12px 16px;background:var(--paper);border:1px solid var(--line);border-radius:12px;font-size:13.5px;color:var(--ink2);} .prov b{color:var(--ink);} .prov a{color:var(--coral-d);} .prov .cite{font-family:ui-monospace,Menlo,monospace;color:var(--muted);} .prov code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);background:#f3efe7;padding:2px 7px;border-radius:6px;word-break:break-all;}
  .trole{font-size:12px;color:var(--muted);margin-top:2px;} .subh{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:18px 0 10px;}
  .chips{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;} .chip{font-size:12px;padding:4px 10px;border-radius:999px;background:#f3efe7;border:1px solid var(--line);color:var(--ink2);}
  .runbanner{margin:14px 0 4px;padding:10px 14px;border-radius:10px;font-size:13px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;} .runbanner b{font-weight:700;}
  .runbanner.ok{background:#eef7f0;border:1px solid #bfe0c8;color:#1f3d2a;} .runbanner.run{background:#eef3fb;border:1px solid #c3d6ef;color:#1f3350;} .runbanner.fail{background:#fdeeea;border:1px solid #f0c1b2;color:#7a2f18;}
  .banner{margin:18px 0 8px;padding:10px 14px;background:#fdf1ec;border:1px solid #f0c9b8;border-radius:10px;color:#8a3f22;font-size:13.5px;}
  .warn{margin:10px 0;padding:8px 12px;background:#fff7e6;border:1px solid #f0d8a8;border-radius:8px;color:#7a5a14;font-size:12.5px;}
  nav.tabs{position:sticky;top:0;background:var(--bg);padding:14px 0;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);z-index:5;}
  nav.tabs button{font:inherit;font-size:13.5px;border:1px solid var(--line);background:var(--paper);color:var(--ink2);padding:7px 14px;border-radius:8px;cursor:pointer;}
  nav.tabs button.active{background:var(--coral);border-color:var(--coral);color:#fff;font-weight:600;}
  section{display:none;padding-top:24px;} section.active{display:block;}
  h2.sec{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 14px;}
  .card{background:var(--paper);border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden;}
  .card>.head{padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;} .card>.head:hover{background:#fbfaf7;}
  .badge{font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;color:#fff;white-space:nowrap;}
  .rpill{font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap;} .rpill.ok{background:#dff0e4;color:#1f6b39;border:1px solid #b7ddc3;} .rpill.fail{background:#f7d9d0;color:#8a2f16;border:1px solid #e6b3a3;} .rpill.run{background:#dbe7f7;color:#274a77;border:1px solid #b4cbea;}
  .nid{font-family:ui-monospace,Menlo,monospace;font-size:13.5px;font-weight:600;} .me{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--ink2);background:#f3efe7;border:1px solid var(--line);padding:2px 8px;border-radius:999px;white-space:nowrap;} .schema{margin-left:auto;font-size:12px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;}
  .card .body{display:none;border-top:1px solid var(--line);} .card.open .body{display:block;}
  .caret{color:var(--muted);transition:transform .15s;} .card.open .caret{transform:rotate(90deg);}
  .meta-row{display:flex;gap:18px;flex-wrap:wrap;padding:12px 16px;background:#fbfaf7;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--ink2);} .meta-row b{color:var(--ink);}
  .skrow{padding:10px 16px;background:#fbfaf7;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--ink2);display:flex;gap:6px;align-items:center;flex-wrap:wrap;} .skrow b{color:var(--ink);margin-right:4px;} .skill{font-size:11.5px;padding:3px 9px;border-radius:6px;background:#e8f0e8;border:1px solid #cfe0cf;color:#2f6b3c;font-family:ui-monospace,Menlo,monospace;}
  .skref{font-size:11px;color:var(--muted);} .skref code{background:#f3efe7;padding:1px 5px;border-radius:4px;font-size:10.5px;} .skmiss{color:#8a2f16;font-size:11px;}
  .card.warn-skills{box-shadow:inset 4px 0 0 #d9822b;} .warnbadge{font-size:10.5px;font-weight:600;padding:3px 8px;border-radius:6px;background:#f7e6cf;color:#8a5314;border:1px solid #e6c48f;white-space:nowrap;}
  .rout{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.55;padding:12px 16px;color:#33312d;background:#f7faf8;border-bottom:1px solid var(--line);} .rout .lbl{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;} .rart{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);padding:8px 16px;border-bottom:1px solid var(--line);word-break:break-all;}
  .prompt{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;padding:16px;color:#33312d;}
  .copy{float:right;font:inherit;font-size:12px;border:1px solid var(--line);background:var(--paper);border-radius:7px;padding:4px 10px;cursor:pointer;color:var(--ink2);}
  pre.block{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto;font-size:12.5px;} .diagram{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto;}
  .tname{font-family:ui-monospace,Menlo,monospace;font-weight:600;color:var(--coral-d);}
  .mdbody{padding:6px 18px 16px;color:#33312d;font-size:14px;line-height:1.7;} .mdbody h1{font-size:20px;margin:16px 0 8px;} .mdbody h2{font-size:16px;margin:14px 0 6px;} .mdbody h3{font-size:14px;margin:12px 0 6px;} .mdbody ol,.mdbody ul{padding-left:22px;margin:6px 0;} .mdbody li{margin:3px 0;} .mdbody p{margin:8px 0;} .mdbody code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:#f3efe7;padding:1px 5px;border-radius:5px;} .mdbody pre{background:#faf9f5;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;} .mdbody pre code{background:none;padding:0;} .mdbody a{color:var(--coral-d);} .mdbody blockquote{border-left:3px solid var(--line);margin:8px 0;padding:2px 12px;color:var(--ink2);} .mdbody table{border-collapse:collapse;margin:8px 0;} .mdbody th,.mdbody td{border:1px solid var(--line);padding:5px 10px;}
</style></head><body><div class="container">
  <header><div class="kicker">Dynamic workflow · review before launch</div><h1 id="wf-name"></h1><p id="wf-desc"></p>
  <div class="runbanner" id="runbanner" style="display:none"></div>
  <div class="chips" id="wf-chips"></div>
  <div class="warn" id="warn" style="display:none"></div></header>
  <nav class="tabs" id="tabs">
    <button data-t="overview" class="active">Diagram</button><button data-t="agents">Agents &amp; prompts</button>
    <button data-t="schemas">Schemas</button><button data-t="based">Based on</button><button data-t="script">Full script</button><button data-t="results" id="tabresults">Results</button>
  </nav>
  <section data-s="overview" class="active"><h2 class="sec">Orchestration</h2><div class="diagram"><pre class="mermaid" id="mm"></pre></div></section>
  <section data-s="results"><h2 class="sec">Results — return value &amp; artifacts</h2><div id="results"></div></section>
  <section data-s="agents"><h2 class="sec">Agents — click for the exact composed prompt</h2><div id="agents"></div></section>
  <section data-s="schemas"><h2 class="sec">Structured-output schemas</h2><div id="schemas"></div></section>
  <section data-s="based"><h2 class="sec">Based on — sources &amp; scaffolds</h2><div id="based"></div></section>
  <section data-s="script"><h2 class="sec">Full script</h2><pre class="block"><code class="language-javascript" id="script"></code></pre></section>
</div>
<script type="application/json" id="data">${jsonBlob}</script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
${jsonToMarkdownSource}
${clientJsSource}
</script></body></html>`;

  writeFileSync(outPath, html);
  return { nodes: nodes.length };
}

// ── main: single render, or --watch loop; --open opens now and re-opens when the run ends ─
const openHtml = () => { if (flags.open) execFile("open", [outPath], () => {}); };
const runDir = resolveRunDir(flags.run, flags.match);
if (flags.run && !runDir) console.error("warn: --run given but no run dir resolved for:", flags.run);

if (flags.watch && runDir) {
  const interval = Math.max(300, parseInt(flags.interval, 10) || 1500);
  let lastMtime = -1;
  let opened = false;
  const tick = () => {
    let m = 0; try { m = statSync(join(runDir, "status.json")).mtimeMs; } catch {}
    if (m !== lastMtime) {
      lastMtime = m;
      const rd = readRunData(runDir);
      const r = build(rd);
      console.log("rendered", outPath, "· run", rd.state, "·", rd.agentCount, "agents", r.nodes, "node types" + (rd.fail ? " · " + rd.fail + " failed" : ""));
      if (!opened) { openHtml(); opened = true; }
      if (!rd.active) { openHtml(); console.log("run terminal (" + rd.state + ") — final render written"); return; }
    }
    setTimeout(tick, interval);
  };
  tick();
} else {
  const rd = runDir ? readRunData(runDir) : null;
  const r = build(rd);
  console.log("wrote", outPath, "(" + r.nodes + " node types, " + composes.length + " composes" + (rd ? ", run " + rd.state + ", " + rd.agentCount + " agents" + (rd.fail ? ", " + rd.fail + " failed" : "") : "") + (runErr ? ", PARTIAL: " + runErr.message : "") + ")");
  openHtml();
}
