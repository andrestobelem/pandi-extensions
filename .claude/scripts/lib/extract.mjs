// extract.mjs — extracción del modelo de preview. Por defecto escanea literales y llamadas conocidas
// sin ejecutar source; el modo evaluado conserva el recorrido histórico con globals de runtime stubbeados.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { scanPreviewSource } from "./source-scan.mjs";
import { norm, phaseTitleOf, fallbackMeta } from "./util.mjs";

async function evaluatePreviewSource({ scriptPath, raw, argsObj }) {
  const transformed = raw
  .replace(/export\s+const\s+meta\s*=/, "globalThis.__meta =")
  .replace(/export\s+default\s+/, "globalThis.__default = ");
const stubs = `
  globalThis.__nodes = []; globalThis.__composes = []; globalThis.__phases = []; globalThis.__pipeErr = null; globalThis.__parallelDepth = 0;
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
      schema: opts.schema, model: opts.model, effort: opts.effort, tools: opts.tools, skills: opts.skills, extensions: opts.extensions,
      instances: 1, parallel: globalThis.__parallelDepth > 0 });
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
      effort: opts.effort ?? rep.effort, tools: opts.tools ?? rep.tools, skills: opts.skills ?? rep.skills, extensions: opts.extensions ?? rep.extensions,
      instances: arr.length, parallel: arr.length > 1 });
    return arr.map(() => lenient());
  };
  const parallel = async (thunks) => {
    globalThis.__parallelDepth++;
    try { return await Promise.all((thunks || []).map(async (t) => { try { return await t(); } catch { return null; } })); }
    finally { globalThis.__parallelDepth--; }
  };
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
const globalKeys = ["__meta", "__nodes", "__composes", "__phases", "__pipeErr", "__parallelDepth", "__default", "__defaultErr", "__runDefault"];
const previousGlobals = new Map(globalKeys.map((key) => [key, {
	had: Object.prototype.hasOwnProperty.call(globalThis, key),
	value: globalThis[key],
}]));
try {
	try {
		await new AsyncFunction(`${stubs}\n${transformed}\n;await globalThis.__runDefault();`)();
	} catch (error) {
		runErr = error;
	}
	if (!runErr && globalThis.__defaultErr) runErr = new Error(globalThis.__defaultErr);
	return {
		meta: globalThis.__meta || fallbackMeta(scriptPath),
		nodes: globalThis.__nodes || [],
		phases: globalThis.__phases || [],
		composes: globalThis.__composes || [],
		fidelity: [],
		runErr,
		pipeErr: globalThis.__pipeErr,
	};
} finally {
	for (const [key, previous] of previousGlobals) {
		if (previous.had) globalThis[key] = previous.value;
		else delete globalThis[key];
	}
}
}

// Devuelve el modelo completo que consume render. `evalPreview` es la única entrada al recorrido
// evaluado histórico; sin ese opt-in, el source se trata exclusivamente como texto.
export async function extractPreviewModel({ scriptPath, raw, argsObj, evalPreview = false }) {
	const extracted = evalPreview
		? await evaluatePreviewSource({ scriptPath, raw, argsObj })
		: scanPreviewSource({ scriptPath, raw });
	const meta = extracted.meta || fallbackMeta(scriptPath);

// Tab "Based on": una línea de provenance y, opcionalmente, los scaffolds en los que se basa este workflow.
// Dos fuentes, en orden de prioridad:
//   1. meta.basedOn (también meta.paper / meta.source): un STRING (línea de provenance) O un
//      ARRAY de tarjetas de scaffold {name, role?, desc?}. Esta es la ruta confiable y preferida.
//   2. Fallback: un comentario inicial `Paper:` / `Based on:` / `Source:` dentro de los primeros 1500 chars,
//      como comentario de línea `//` O línea de bloque-comentario ` *` (ambos prefijos se aceptan).
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

  // ── nodos del preview (escaneados o registrados por el recorrido evaluado) ────────────────────
const rawNodes = extracted.nodes || [];
const basePhases = (extracted.phases && extracted.phases.length) ? extracted.phases : (meta.phases || []).map(phaseTitleOf).filter(Boolean);
const composes = [...new Set(extracted.composes || [])];

const byKey = new Map();
for (const n of rawNodes) {
  const key = (n.phase || "") + "|" + norm(n.label);
  const instances = Number.isFinite(n.instances) ? n.instances : 1;
  if (!byKey.has(key)) byKey.set(key, { ...n, role: norm(n.label), count: 1, instances, parallel: !!n.parallel });
  else {
    const grouped = byKey.get(key);
    grouped.count++;
    grouped.instances += instances;
    grouped.parallel ||= !!n.parallel;
  }
}
const baseNodes = [...byKey.values()].map((n) => ({
  id: n.role + (n.instances > 1 ? ` ×${n.instances}` : ""),
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
  instances: n.instances,
  parallel: n.parallel && n.instances > 1,
}));

// Resuelve cada skill declarado a su home en disco y a sus archivos de referencia (reference/ o references/),
// para que el artifact pueda mostrar QUÉ skills (y sus docs de referencia) carga cada agente.
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
        } catch { /* directorio de referencia ilegible — saltear */ }
      }
      found = { base, references: references.sort() };
      break;
    }
    out[name] = found || { missing: true, references: [] };
  }
  return out;
}
const skillRefs = resolveSkillRefs([...new Set(baseNodes.flatMap((n) => n.skills || []))]);

// schemas únicos
const schemas = {};
let si = 0;
for (const n of baseNodes) if (n.schemaObj) { const k = (n.role || ("schema" + si++)); if (!schemas[k]) schemas[k] = n.schemaObj; }

// Notas estáticas de fidelidad (problemas de extracción) calculadas una vez; las notas de fase vacía son por render
// (dependen de si un run llenó la fase), así que se agregan dentro de build().
const staticFidelity = [...(extracted.fidelity || [])];
if (extracted.runErr) staticFidelity.push("partial evaluated preview — script threw during stubbed traversal: " + (extracted.runErr.message || extracted.runErr));
if (extracted.pipeErr) staticFidelity.push("a pipeline() stage threw during evaluated preview (" + extracted.pipeErr + ") — agents/phases gated on a prior stage's output may be missing below");

// Escaneo de declaraciones a nivel fuente: recupera phase/model/effort para labels cuya rama el run stubbed
// nunca ALCANZÓ (por ejemplo, un fan-out gated por la salida de un agente previo). Heurística: para cada literal
// string en label:/name:, buscá en una ventana de ±420 chars los literales phase:/model:/effort: dentro del mismo objeto opts.
function scanDeclaredRoles(src) {
  const map = new Map();
  // Captura la comilla de apertura y exige la MISMA comilla al cerrar (backref) para que una
  // comilla despareja (por ejemplo label:"x`) nunca capture a través de ella en silencio.
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
for (const [role, declaration] of extracted.declared || []) {
	const previous = declared.get(role) || {};
	declared.set(role, {
		phase: previous.phase ?? declaration.phase,
		model: previous.model ?? declaration.model,
		effort: previous.effort ?? declaration.effort,
		schema: previous.schema ?? declaration.schema,
		parallel: previous.parallel || declaration.parallel,
	});
}

  return { meta, baseNodes, basePhases, composes, provenance, scaffolds, skillRefs, schemas, declared, staticFidelity, runErr: extracted.runErr };
}
