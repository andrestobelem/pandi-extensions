// run-merge.mjs — ingiere un directorio real de run (--run) y superpone sus resultados por rol sobre
// la lista estática de nodos, recuperando roles solo-runtime a los que la extracción stubbed nunca llegó.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { norm } from "./util.mjs";

const tryRead = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const extractPromptFromMd = (md) => { const m = md.match(/\n## Prompt\n\n([\s\S]*?)(?:\n## |\n# |$)/); return m ? m[1].trim().slice(0, 4000) : null; };

export function resolveRunDir(spec, match) {
  if (!spec) return null;
  if (spec !== "latest" && spec !== true) return existsSync(spec) ? spec : null;
  const base = join(process.cwd(), ".pi", "workflows", "runs");
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base).map((d) => join(base, d)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  const filtered = match ? dirs.filter((p) => basename(p).includes(String(match))) : dirs;
  filtered.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return filtered[0] || null;
}

export function readRunData(runDir) {
  const status = (() => { const s = tryRead(join(runDir, "status.json")); try { return s ? JSON.parse(s) : {}; } catch { return {}; } })();
  const events = tryRead(join(runDir, "events.jsonl")) || "";
  const byId = new Map();
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "agent") continue;
    byId.set(e.id, { ...(byId.get(e.id) || {}), ...e }); // los eventos posteriores (completed) pisan a running
  }
  const byRole = new Map();
  let ok = 0, fail = 0, running = 0;
  for (const a of byId.values()) {
    const role = norm(a.name);
    let g = byRole.get(role);
    if (!g) { g = { role, count: 0, ok: 0, fail: 0, running: 0, output: null, artifact: null, prompt: null }; byRole.set(role, g); }
    g.count++;
    // completed → ok/fail según a.ok; still-running → running; cualquier otro estado terminal
    // (error/timeout/killed/cancelled) es una FAILURE, no "running".
    if (a.state === "completed") { if (a.ok) { g.ok++; ok++; } else { g.fail++; fail++; } }
    else if (a.state === "running") { g.running++; running++; }
    else { g.fail++; fail++; }
    if (!g.output && a.output) g.output = String(a.output).slice(0, 700);
    if (!g.artifact && a.artifactPath) g.artifact = a.artifactPath;
  }
  for (const g of byRole.values()) { if (g.artifact) { const md = tryRead(g.artifact); if (md) g.prompt = extractPromptFromMd(md); } }

  // Results: el valor de retorno del workflow (result.json .output) + los artifacts que escribió en el
  // dir RAÍZ del run (sin recursión), excluyendo archivos internos del engine. Se renderiza en la tab Results.
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
  // summary.md primero, después otros .md, luego .txt y después .json — alpha dentro de cada grupo.
  const rank = (x) => (x.name === "summary.md" ? 0 : x.ext === "md" ? 1 : x.ext === "txt" ? 2 : 3);
  artifacts.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const results = returnValue != null || artifacts.length ? { returnValue, artifacts } : null;

  return { runDir, runId: status.runId || basename(runDir), state: status.state || "unknown", active: !!status.active, agentCount: status.agentCount ?? byId.size, elapsedMs: status.elapsedMs || 0, ok, fail, running, byRole, results };
}

export function mergeNodes(runData, baseNodes, declared) {
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
