#!/usr/bin/env node
// build-workflow-artifact.mjs — GENERIC "show-before-launch" artifact builder.
// Usage: node build-workflow-artifact.mjs <workflow.js> <out.html> [argsJson]
//
// Renders a self-contained, Claude-styled, tabbed HTML preview of ANY dynamic-workflow
// script (Diagram · Agents & prompts · Schemas · Composes · Full script) so you can review
// the orchestration BEFORE launching it. See memory: [[show-workflow-before-launch]].
//
// HOW: it executes the script body with STUBBED runtime globals that RECORD every
// agent(prompt, opts) call (prompt is the first arg, captured verbatim), run parallel()/
// pipeline() callbacks so nested agents are recorded, and note workflow() composition.
// agent() returns a lenient proxy so downstream result-processing rarely throws; the whole
// run is wrapped in try/catch so a partial extraction still yields an artifact. Runtime-
// injected prompt parts (prior-agent outputs) render as empty/short — the STATIC prompt
// scaffolding, schemas, models/efforts/tools and structure are what you review.

import { readFileSync, writeFileSync } from "node:fs";

const scriptPath = process.argv[2];
const outPath = process.argv[3];
if (!scriptPath || !outPath) { console.error("usage: build-workflow-artifact.mjs <workflow.js> <out.html> [argsJson]"); process.exit(2); }
const raw = readFileSync(scriptPath, "utf8");

// Kitchen-sink args so most workflows' required-input guards pass and the body runs.
const argsObj = process.argv[4] ? JSON.parse(process.argv[4]) : {
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
      schema: opts.schema, model: opts.model, effort: opts.effort, tools: opts.tools, skills: opts.skills });
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
      effort: opts.effort ?? rep.effort, tools: opts.tools ?? rep.tools, skills: opts.skills ?? rep.skills });
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
// meta.basedOn may be a STRING (provenance line) or an ARRAY of {name, role?, desc?} scaffold cards.
const paperFromComment = (() => {
  const head = raw.slice(0, 1500);
  const m = head.match(/^\s*\*?\s*(?:Paper|Based on|Source)\s*:\s*(.+?)\s*$/im);
  return m ? m[1].replace(/\.*\s*$/, "").trim() : null;
})();
const basedOnRaw = (meta && (meta.basedOn ?? meta.paper ?? meta.source)) ?? null;
const scaffolds = Array.isArray(basedOnRaw)
  ? basedOnRaw.map((t) => (typeof t === "string" ? { name: t } : (t && typeof t === "object" ? t : null))).filter(Boolean)
  : [];
const provenance = (typeof basedOnRaw === "string" ? basedOnRaw : null) || paperFromComment || null;

const rawNodes = globalThis.__nodes || [];
const phases = (globalThis.__phases && globalThis.__phases.length) ? globalThis.__phases : (meta.phases || []).map((p) => p.title);
const composes = [...new Set(globalThis.__composes || [])];

// De-dup fan-out nodes by a normalized role key (strip trailing numeric/escalation indices).
const norm = (l) => String(l || "agent").replace(/(-e?\d+)+$/i, "").replace(/-\d+$/g, "");
const byKey = new Map();
for (const n of rawNodes) {
  const key = (n.phase || "") + "|" + norm(n.label);
  if (!byKey.has(key)) byKey.set(key, { ...n, role: norm(n.label), count: 1 });
  else byKey.get(key).count++;
}
const nodes = [...byKey.values()].map((n) => ({
  id: n.role + (n.count > 1 ? ` ×${n.count}` : ""),
  role: n.role,
  phase: n.phase || "—",
  schema: n.schema ? (n.schema.title || "object schema") : "— (free text)",
  schemaObj: n.schema || null,
  model: n.model || "inherited",
  effort: n.effort || "inherited",
  tools: Array.isArray(n.tools) ? n.tools.join(", ") : "inherited",
  prompt: n.prompt,
}));

// unique schemas
const schemas = {};
let si = 0;
for (const n of nodes) if (n.schemaObj) { const k = (n.role || ("schema" + si++)); if (!schemas[k]) schemas[k] = n.schemaObj; }

// phase palette
const PAL = ["#3f7a52", "#7a4fb0", "#b54545", "#9a6a14", "#2f6f9e", "#a3517a"];
const phaseColor = {}; (phases || []).forEach((p, i) => { phaseColor[p] = PAL[i % PAL.length]; });

// auto Mermaid: IN -> phase groups in order -> OUT, plus compose edges
const mmId = (s) => "P" + String(s).replace(/[^A-Za-z0-9]/g, "_");
// Mermaid labels are interpolated raw — strip chars that break mermaid syntax or smuggle markup.
const mmLabel = (s) => String(s).replace(/["\[\]{}|<>]/g, " ").replace(/\s+/g, " ").trim();
let mm = "flowchart TB\n  IN([args input]):::io\n";
const nodesByPhase = {};
for (const n of nodes) (nodesByPhase[n.phase] ||= []).push(n);
const orderedPhases = phases.length ? phases : Object.keys(nodesByPhase);
orderedPhases.forEach((ph) => {
  const ns = nodesByPhase[ph] || [];
  mm += `  subgraph ${mmId(ph)}["${mmLabel(ph)}"]\n   direction LR\n`;
  ns.forEach((n, i) => { mm += `   ${mmId(ph)}_${i}["${mmLabel(n.role)}${n.schemaObj ? " · schema" : ""}"]:::ag\n`; });
  if (!ns.length) mm += `   ${mmId(ph)}_x[" "]\n`;
  mm += "  end\n";
});
let prev = "IN";
orderedPhases.forEach((ph) => { mm += `  ${prev} --> ${mmId(ph)}\n`; prev = mmId(ph); });
mm += `  ${prev} --> OUT[/"return"/]:::io\n`;
composes.forEach((c, i) => { mm += `  COMP${i}{{"workflow ${mmLabel(c)}"}}:::comp\n  ${prev} -. composes .-> COMP${i}\n`; });
mm += "  classDef io fill:#f3efe7,stroke:#8a877f,color:#1f1e1d;\n  classDef ag fill:#e7f1ea,stroke:#3f7a52,color:#1f3d2a;\n  classDef comp fill:#efe7f6,stroke:#7a4fb0,color:#3a2356;";

// Fidelity notes — surface anything that makes this preview an INCOMPLETE picture of the workflow,
// so an empty diagram box is never read as "this phase has no agents" when it's really gated on runtime values.
const fidelityNotes = [];
if (runErr) fidelityNotes.push("partial extraction — script threw during stubbed run: " + (runErr.message || runErr));
if (globalThis.__pipeErr) fidelityNotes.push("a pipeline() stage threw during extraction (" + globalThis.__pipeErr + ") — agents/phases gated on a prior stage's output may be missing below");
const declaredPhases = (meta.phases || []).map((p) => p && p.title).filter(Boolean);
const emptyDeclared = declaredPhases.filter((t) => !nodes.some((n) => n.phase === t));
if (emptyDeclared.length) fidelityNotes.push("declared phase(s) with no recorded agents: " + emptyDeclared.join(", ") + " — likely gated on runtime values; see the Full script tab");

const data = {
  meta, phases, composes, __mm: mm,
  provenance, scaffolds, source: scriptPath,
  args: process.argv[4] ? "(provided)" : "(kitchen-sink defaults for extraction)",
  schemas, nodes, script: raw,
  warn: fidelityNotes.length ? fidelityNotes.join(" · ") : null,
};
const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
  .nid{font-family:ui-monospace,Menlo,monospace;font-size:13.5px;font-weight:600;} .schema{margin-left:auto;font-size:12px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;}
  .card .body{display:none;border-top:1px solid var(--line);} .card.open .body{display:block;}
  .caret{color:var(--muted);transition:transform .15s;} .card.open .caret{transform:rotate(90deg);}
  .meta-row{display:flex;gap:18px;flex-wrap:wrap;padding:12px 16px;background:#fbfaf7;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--ink2);} .meta-row b{color:var(--ink);}
  .prompt{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;padding:16px;color:#33312d;}
  .copy{float:right;font:inherit;font-size:12px;border:1px solid var(--line);background:var(--paper);border-radius:7px;padding:4px 10px;cursor:pointer;color:var(--ink2);}
  pre.block{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto;font-size:12.5px;} .diagram{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto;}
  .tname{font-family:ui-monospace,Menlo,monospace;font-weight:600;color:var(--coral-d);}
</style></head><body><div class="container">
  <header><div class="kicker">Dynamic workflow · review before launch</div><h1 id="wf-name"></h1><p id="wf-desc"></p>
  <div class="chips" id="wf-chips"></div>
  <div class="warn" id="warn" style="display:none"></div></header>
  <nav class="tabs" id="tabs">
    <button data-t="overview" class="active">Diagram</button><button data-t="agents">Agents &amp; prompts</button>
    <button data-t="schemas">Schemas</button><button data-t="based">Based on</button><button data-t="script">Full script</button>
  </nav>
  <section data-s="overview" class="active"><h2 class="sec">Orchestration</h2><div class="diagram"><pre class="mermaid" id="mm"></pre></div></section>
  <section data-s="agents"><h2 class="sec">Agents — click for the exact composed prompt</h2><div id="agents"></div></section>
  <section data-s="schemas"><h2 class="sec">Structured-output schemas</h2><div id="schemas"></div></section>
  <section data-s="based"><h2 class="sec">Based on — sources &amp; scaffolds</h2><div id="based"></div></section>
  <section data-s="script"><h2 class="sec">Full script</h2><pre class="block"><code class="language-javascript" id="script"></code></pre></section>
</div>
<script type="application/json" id="data">${json}</script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
const D=JSON.parse(document.getElementById("data").textContent);
const esc=(s)=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const PAL=["#3f7a52","#7a4fb0","#b54545","#9a6a14","#2f6f9e","#a3517a"];
const pc={}; (D.phases||[]).forEach((p,i)=>pc[p]=PAL[i%PAL.length]);
// Render the diagram FIRST and in isolation: set #mm content, then run mermaid explicitly.
// (startOnLoad races other DOM code — if anything below throws, #mm stays empty and mermaid renders "Syntax error".)
(function(){try{
  var mmEl=document.getElementById("mm");
  mmEl.textContent=D.__mm||"";
  mermaid.initialize({startOnLoad:false,theme:"neutral",flowchart:{useMaxWidth:false}});
  mermaid.run({nodes:[mmEl]}).catch(function(){});
}catch(e){}})();
document.getElementById("wf-name").textContent=D.meta.name||"workflow";
document.getElementById("wf-desc").textContent=D.meta.description||"";
document.getElementById("wf-chips").innerHTML=(D.phases||[]).map(p=>'<span class="chip">'+esc(p)+'</span>').join("")+'<span class="chip">'+D.nodes.length+' node types</span><span class="chip">args: '+esc(D.args)+'</span>';
if(D.warn){const w=document.getElementById("warn");w.style.display="block";w.textContent="⚠ "+D.warn;}
document.getElementById("agents").innerHTML=D.nodes.map((n,i)=>'<div class="card"><div class="head"><span class="caret">▸</span><span class="badge" style="background:'+(pc[n.phase]||"#8a877f")+'">'+esc(n.phase)+'</span><span class="nid">'+esc(n.id)+'</span><span class="schema">schema: '+esc(n.schema)+'</span></div><div class="body"><div class="meta-row"><span><b>phase</b> '+esc(n.phase)+'</span><span><b>model</b> '+esc(n.model)+'</span><span><b>effort</b> '+esc(n.effort)+'</span><span><b>tools</b> '+esc(n.tools)+'</span></div><div class="prompt"><button class="copy" data-c="'+i+'">copy</button>'+esc(n.prompt.trim())+'</div></div></div>').join("");
document.querySelectorAll(".card .head").forEach(h=>h.onclick=()=>h.parentElement.classList.toggle("open"));
document.querySelectorAll(".copy").forEach(b=>b.onclick=(e)=>{e.stopPropagation();navigator.clipboard.writeText(D.nodes[b.dataset.c].prompt);b.textContent="copied!";setTimeout(()=>b.textContent="copy",1200);});
document.getElementById("schemas").innerHTML=Object.keys(D.schemas).length?Object.entries(D.schemas).map(([k,v])=>'<div class="card open"><div class="head"><span class="nid">'+esc(k)+'</span></div><div class="body"><pre class="block" style="border:0;margin:0">'+esc(JSON.stringify(v,null,2))+'</pre></div></div>').join(""):'<p style="color:var(--muted)">No structured-output schemas.</p>';
(function(){
  var linkify=function(t){return esc(t).replace(/\\((https?:\\/\\/[^\\s)]+)\\)/g,'(<a href="$1" target="_blank" rel="noopener">$1</a>)').replace(/(arXiv:[\\d.]+)/gi,'<span class="cite">$1</span>');};
  var card=function(name,role,desc){return '<div class="card open"><div class="body" style="display:block;padding:14px 16px"><div class="tname">'+esc(name)+'</div>'+(role?'<div class="trole">'+esc(role)+'</div>':'')+(desc?'<div style="margin-top:6px;color:var(--ink2);font-size:13.5px">'+esc(desc)+'</div>':'')+'</div></div>';};
  var h="";
  if(D.provenance){h+='<div class="prov"><b>Based on</b> '+linkify(D.provenance)+'</div>';}
  if((D.scaffolds||[]).length){h+='<div class="subh">Scaffolds this workflow is based on</div>'+D.scaffolds.map(function(t){return card(t.name||"",t.role||"",t.desc||"");}).join("");}
  if((D.composes||[]).length){h+='<div class="subh">Composes at runtime (workflow())</div>'+D.composes.map(function(c){return card(c,"","");}).join("");}
  if(D.source){h+='<div class="subh">Generated from</div><div class="prov"><code>'+esc(D.source)+'</code></div>';}
  document.getElementById("based").innerHTML=h||'<p style="color:var(--muted)">No provenance recorded.</p>';
})();
document.getElementById("script").textContent=D.script;
document.querySelectorAll("#tabs button").forEach(b=>b.onclick=()=>{document.querySelectorAll("#tabs button").forEach(x=>x.classList.remove("active"));document.querySelectorAll("section").forEach(s=>s.classList.remove("active"));b.classList.add("active");document.querySelector('section[data-s="'+b.dataset.t+'"]').classList.add("active");});
try{document.querySelectorAll("#script,#schemas code").forEach(el=>hljs.highlightElement(el));}catch(e){}
</script></body></html>`;

writeFileSync(outPath, html);
console.log("wrote", outPath, "(" + html.length + " bytes, " + nodes.length + " node types, " + composes.length + " composes" + (runErr ? ", PARTIAL: " + runErr.message : "") + ")");
