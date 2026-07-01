// extract.mjs — static-preview extraction. Run the workflow body with STUBBED runtime globals
// that RECORD every agent()/agents()/workflow()/phase() call, then derive the static model
// (nodes, schemas, skill references, declared roles, provenance) with NO real execution.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { norm, phaseTitleOf } from "./util.mjs";

// Returns the full static model consumed by render. `scriptPath` seeds the fallback meta.name;
// `raw` is the workflow source; `argsObj` is splatted into the stub `args` global.
export async function extractStaticModel({ scriptPath, raw, argsObj }) {
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

  return { meta, baseNodes, basePhases, composes, provenance, scaffolds, skillRefs, schemas, declared, staticFidelity, runErr };
}
