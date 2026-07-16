// run-merge.mjs — ingiere un directorio real de run (--run) y superpone sus resultados por rol sobre
// la lista estática de nodos, recuperando roles solo-runtime a los que la extracción stubbed nunca llegó.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { norm } from "./util.mjs";

const tryRead = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const extractPromptFromMd = (md) => { const m = md.match(/\n## Prompt\n\n([\s\S]*?)(?:\n## |\n# |$)/); return m ? m[1].trim().slice(0, 4000) : null; };

// ── Claude Code run-record adapter ──────────────────────────────────────────────────────
// Claude Code's `Workflow` tool has no pi-style run DIRECTORY (status.json/events.jsonl/result.json).
// Instead it persists one JSON file per run at <sessionDir>/workflows/wf_<runId>.json, sibling to
// subagents/workflows/wf_<runId>/ (the raw per-agent transcripts, which carry no role/label at all —
// only agentId). The record's workflowProgress[] already has exact per-agent `label`/`phaseTitle`/
// `state`/`resultPreview`, so no fuzzy prompt-matching is needed — just group by label like pi groups
// by event.name.
function findClaudeRunRecordPath(spec) {
  try {
    const st = statSync(spec);
    if (st.isFile() && spec.endsWith(".json")) return spec;
    if (st.isDirectory()) {
      // Pointed straight at a workflows/ dir (or anything) containing wf_*.json — use the newest.
      const direct = readdirSync(spec).filter((f) => /^wf_.*\.json$/.test(f)).map((f) => join(spec, f));
      if (direct.length) { direct.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); return direct[0]; }
      // Pointed at subagents/workflows/wf_<id>/ (the per-agent transcript dir this tool's docs suggest
      // using as --run's argument) — the real record is 3 levels up: wf_<id> -> workflows -> subagents -> sessionDir.
      const id = basename(spec);
      if (/^wf_/.test(id)) {
        const candidate = join(dirname(dirname(dirname(spec))), "workflows", `${id}.json`);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch { /* not found / not accessible — fall through to pi-format handling */ }
  return null;
}

// resultPreview in the run-record is truncated (~a few hundred chars) — too short to ever parse
// as JSON for the structured-output markdown upgrade (artifact-client.js's upgradeStructuredOutputs).
// pi reads each agent's FULL output from a saved artifact file instead of a truncated preview; the
// closest equivalent here is the agent's own transcript, which still has the complete arguments of
// its last "StructuredOutput" tool call. Best-effort and capped — a missing/unreadable transcript
// (e.g. an archived or manually-moved run) just falls back to resultPreview, never throws.
const MAX_OUTPUT_CHARS = 20000;
function tryReadFullAgentOutput(transcriptDir, agentId) {
  const raw = tryRead(join(transcriptDir, `agent-${agentId}.jsonl`));
  if (!raw) return null;
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === "tool_use" && block.name === "StructuredOutput" && block.input !== undefined) {
        try { return JSON.stringify(block.input); } catch { return null; }
      }
    }
  }
  return null;
}

function readClaudeRunData(jsonPath, requestedDir) {
  let record;
  try { record = JSON.parse(readFileSync(jsonPath, "utf8")); } catch { return null; }
  const DONE = new Set(["done", "completed", "cached", "ok"]);
  const FAIL = new Set(["failed", "error", "cancelled", "canceled", "timeout", "killed", "interrupted"]);
  const ACTIVE = new Set(["running", "queued", "started", "pending"]);
  const transcriptDir = join(dirname(dirname(jsonPath)), "subagents", "workflows", basename(jsonPath, ".json"));
  const byRole = new Map();
  let ok = 0, fail = 0, running = 0, unknown = 0, retries = 0, timedOut = 0, emptyOutput = 0;
  const agentEvents = (record.workflowProgress || []).filter((e) => e.type === "workflow_agent");
  for (const e of agentEvents) {
    const role = norm(e.label || "agent");
    let g = byRole.get(role);
    if (!g) { g = { role, count: 0, planned: 0, ok: 0, fail: 0, running: 0, unknown: 0, output: null, artifact: null, prompt: null }; byRole.set(role, g); }
    g.count++; g.planned = g.count;
    const state = String(e.state || "");
    if (ACTIVE.has(state)) { g.running++; running++; }
    else if (FAIL.has(state)) { g.fail++; fail++; }
    else if (DONE.has(state)) { g.ok++; ok++; }
    else { g.unknown++; unknown++; }
    const outputText = tryReadFullAgentOutput(transcriptDir, e.agentId) ?? e.resultPreview;
    if (!g.output && outputText) g.output = String(outputText).slice(0, MAX_OUTPUT_CHARS);
    if (!g.prompt && e.promptPreview) g.prompt = String(e.promptPreview).slice(0, 4000);
    if ((e.attempt || 1) > 1) retries++;
    if (state === "timeout") timedOut++;
    // Judge emptiness on the SAME output the report shows (full transcript output with preview
    // fallback), not on resultPreview alone: an agent whose only final action is a StructuredOutput
    // tool call — the finalization pattern our own workflows mandate — can have an empty preview
    // while its real output is complete.
    if (DONE.has(state) && !String(outputText || "").trim()) emptyOutput++;
  }
  // Run-metrics/Result-integrity mirror pi's observe/ report sections, but ONLY from fields the
  // Claude Code run-record actually carries — no cost or tool-error counts are persisted here, so
  // those chips are omitted downstream rather than rendered as fabricated zeros.
  const metrics = {
    measuredAgents: agentEvents.length,
    totalTokens: typeof record.totalTokens === "number" ? record.totalTokens : null,
    totalToolCalls: typeof record.totalToolCalls === "number" ? record.totalToolCalls : null,
    retries,
  };
  const integrity = { measuredAgents: agentEvents.length, failed: fail, timedOut, emptyOutput };
  // Per-agent timing for the real-run Mermaid diagram (mermaid-run.mjs) — mirrors pi's
  // RunReportAgent shape but with numeric epoch-ms timestamps (this record's native format)
  // instead of pi's ISO strings.
  const runAgents = agentEvents.map((e) => {
    const state = String(e.state || "");
    const normalized = DONE.has(state) ? "completed" : FAIL.has(state) ? "failed" : ACTIVE.has(state) ? "running" : "other";
    const endedAt = typeof e.startedAt === "number" && typeof e.durationMs === "number" ? e.startedAt + e.durationMs : (e.lastProgressAt ?? null);
    // output/prompt por agente (no por rol): el reporte estilo pi muestra una tarjeta por agente.
    const output = tryReadFullAgentOutput(transcriptDir, e.agentId) ?? (e.resultPreview ? String(e.resultPreview) : null);
    return {
      id: e.agentId, name: e.label || "agent", state: normalized, phaseLabel: e.phaseTitle || null,
      startedAt: e.startedAt ?? null, endedAt,
      output: output ? output.slice(0, MAX_OUTPUT_CHARS) : null, outputChars: output ? output.length : 0,
      prompt: e.promptPreview ? String(e.promptPreview).slice(0, 4000) : null,
      model: e.model || null, attempt: e.attempt || 1,
      tokens: typeof e.tokens === "number" ? e.tokens : null,
      toolCalls: typeof e.toolCalls === "number" ? e.toolCalls : null,
    };
  });
  const logs = (record.logs || []).map((m) => ({ time: record.timestamp || null, message: String(m) }));
  const state = record.status || "unknown";
  const active = ACTIVE.has(state);
  const agentCount = record.agentCount ?? agentEvents.length;
  const done = ok + fail + unknown;
  const planned = Math.max(agentCount, agentEvents.length);
  const fraction = planned > 0 ? done / planned : 0;
  const runKind = state === "failed" ? "fail" : active ? "run" : (state === "completed" ? "ok" : "warn");
  const progressKind = fail ? "fail" : (active || running) ? "run" : unknown ? "warn" : runKind;
  const progress = { done, total: planned, running, failed: fail, unknown, openEnded: false, fraction, kind: progressKind, value: `${done}/${planned}` };
  const results = record.result !== undefined ? { returnValue: record.result, artifacts: [] } : null;
  return {
    runDir: requestedDir || jsonPath, runId: record.runId || basename(jsonPath, ".json"),
    state, active, agentCount, elapsedMs: record.durationMs || 0,
    ok, fail, unknown, running, bashDone: 0, logs, byRole, results, runKind, progress,
    metrics, integrity, runAgents,
  };
}

// ── Claude Code LIVE journal adapter ─────────────────────────────────────────────────────
// While a Workflow run is still executing, wf_<id>.json does not exist yet — Claude Code only
// persists the run-record at completion. What DOES update live is <transcriptDir>/journal.jsonl
// ("started"/"result" lines per agentId, with each agent's full return value inline in the result
// entry). This adapter builds a partial runData from that journal so --run (and --watch) give a
// pi-style live observe mid-run. Labels/phases are not journaled; the closest stable name is the
// first line of each agent's prompt (from its transcript). Grouping is therefore coarser than the
// post-completion view — the record adapter above takes over automatically on the next render once
// the run finishes, because readRunData prefers the record whenever it exists.
// One pass over an agent transcript, extracting everything the live view can honestly report:
// the prompt (first user message), real start/last-activity timestamps (every transcript line has
// an ISO `timestamp`), output tokens (sum of assistant usage.output_tokens) and tool-call count.
// What is NOT here — and not anywhere on disk mid-run — is the agent's label/phase: the harness
// keeps those in memory until it writes the completion record.
function scanAgentTranscript(transcriptDir, agentId) {
  const raw = tryRead(join(transcriptDir, `agent-${agentId}.jsonl`));
  if (!raw) return null;
  const out = { prompt: null, startedAt: null, endedAt: null, outputTokens: 0, toolCalls: 0 };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (out.startedAt == null) out.startedAt = ts;
      out.endedAt = ts;
    }
    const c = entry?.message?.content;
    if (out.prompt == null && entry?.type === "user") {
      const text = typeof c === "string" ? c : Array.isArray(c) ? (c.find((b) => b?.type === "text")?.text ?? "") : "";
      const t = String(text).trim();
      if (t) out.prompt = t;
    }
    if (entry?.type === "assistant") {
      const u = entry?.message?.usage;
      if (u && typeof u.output_tokens === "number") out.outputTokens += u.output_tokens;
      if (Array.isArray(c)) out.toolCalls += c.filter((b) => b?.type === "tool_use").length;
    }
  }
  return out;
}

function readClaudeJournalRunData(runDir) {
  const raw = tryRead(join(runDir, "journal.jsonl"));
  if (!raw) return null;
  const agents = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e.agentId) continue;
    if (e.type === "started" && !agents.has(e.agentId)) agents.set(e.agentId, { done: false, result: undefined });
    if (e.type === "result") { const a = agents.get(e.agentId) || { done: false, result: undefined }; a.done = true; a.result = e.result; agents.set(e.agentId, a); }
  }
  if (!agents.size) return null;
  const byRole = new Map();
  const runAgents = [];
  let ok = 0, running = 0, totalTokens = 0, totalToolCalls = 0, sawUsage = false;
  let firstStart = null, lastActivity = null;
  for (const [agentId, a] of agents) {
    const scan = scanAgentTranscript(runDir, agentId);
    const prompt = scan?.prompt ?? null;
    const role = norm((prompt || "").split("\n")[0].trim().slice(0, 60)) || `agent ${agentId.slice(0, 7)}`;
    let g = byRole.get(role);
    if (!g) { g = { role, count: 0, planned: 0, ok: 0, fail: 0, running: 0, unknown: 0, output: null, artifact: null, prompt: null }; byRole.set(role, g); }
    g.count++; g.planned = g.count;
    if (a.done) { g.ok++; ok++; } else { g.running++; running++; }
    if (!g.output && a.result !== undefined) { try { g.output = JSON.stringify(a.result).slice(0, MAX_OUTPUT_CHARS); } catch { /* unserializable — leave null */ } }
    if (!g.prompt && prompt) g.prompt = prompt.slice(0, 4000);
    if (scan) {
      totalTokens += scan.outputTokens; totalToolCalls += scan.toolCalls;
      if (scan.outputTokens || scan.toolCalls) sawUsage = true;
      if (scan.startedAt != null && (firstStart == null || scan.startedAt < firstStart)) firstStart = scan.startedAt;
      if (scan.endedAt != null && (lastActivity == null || scan.endedAt > lastActivity)) lastActivity = scan.endedAt;
    }
    // Real timestamps from the transcript: startedAt = first line, endedAt = last activity — for a
    // still-running agent that is "progress so far", which is exactly what a live wave should show.
    // Agents with no transcript yet fall back to null; buildRunMermaidBody's single-wave fallback
    // then keeps the whole group as one concurrent wave instead of inventing seriality.
    let liveOutput = null;
    if (a.result !== undefined) { try { liveOutput = JSON.stringify(a.result); } catch { /* unserializable */ } }
    runAgents.push({
      id: agentId, name: role, state: a.done ? "completed" : "running", phaseLabel: null,
      startedAt: scan?.startedAt ?? null, endedAt: scan?.endedAt ?? null,
      output: liveOutput ? liveOutput.slice(0, MAX_OUTPUT_CHARS) : null, outputChars: liveOutput ? liveOutput.length : 0,
      prompt: prompt ? prompt.slice(0, 4000) : null, model: null, attempt: 1,
      tokens: scan?.outputTokens ?? null, toolCalls: scan?.toolCalls ?? null,
    });
  }
  const total = agents.size;
  // openEnded: the journal only lists agents that already STARTED — later pipeline stages may add
  // more, so `total` is a floor, not the plan. Integrity chips are omitted entirely: partial live
  // data would render misleading zeros for failed/timed-out.
  const progress = { done: ok, total, running, failed: 0, unknown: 0, openEnded: true, fraction: total ? ok / total : 0, kind: "run", value: `${ok}/${total}` };
  return {
    runDir, runId: basename(runDir),
    state: "running", active: true, agentCount: total,
    elapsedMs: firstStart != null && lastActivity != null ? lastActivity - firstStart : 0,
    ok, fail: 0, unknown: 0, running, bashDone: 0,
    logs: [], byRole, results: null, runKind: "run", progress,
    metrics: {
      measuredAgents: total,
      totalTokens: sawUsage ? totalTokens : null,
      totalToolCalls: sawUsage ? totalToolCalls : null,
      retries: 0,
    },
    integrity: null,
    runAgents,
    // Marca para que el reporte declare el clamp: nombres derivados del prompt, labels exactos
    // recién cuando el record de completion exista (regla pandi 5: los clamps nunca son silenciosos).
    liveJournal: true,
  };
}

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
  // pi format is status.json + events.jsonl in runDir; only look for a Claude Code run-record when
  // that's absent, so existing pi runs are completely unaffected by this branch.
  if (!existsSync(join(runDir, "status.json"))) {
    const claudeRecordPath = findClaudeRunRecordPath(runDir);
    if (claudeRecordPath) {
      const claudeData = readClaudeRunData(claudeRecordPath, runDir);
      if (claudeData) return claudeData;
    }
    // Record absent (run still executing) — fall back to the live journal for a partial view.
    const liveData = readClaudeJournalRunData(runDir);
    if (liveData) return liveData;
  }
  const status = (() => { const s = tryRead(join(runDir, "status.json")); try { return s ? JSON.parse(s) : {}; } catch { return {}; } })();
  const events = tryRead(join(runDir, "events.jsonl")) || "";
  const byId = new Map();
  const logs = [];
  let bashDone = 0;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "log" && e.time && e.message) {
      logs.push({ time: e.time, message: String(e.message), ...(e.details === undefined ? {} : { details: e.details }) });
      if (String(e.message).startsWith("bash end:")) bashDone++;
      continue;
    }
    if (e.type !== "agent") continue;
    byId.set(e.id, { ...(byId.get(e.id) || {}), ...e }); // los eventos posteriores (completed) pisan a running
  }
  const byRole = new Map();
  const phaseTotals = new Map();
  let ok = 0, fail = 0, running = 0, unknown = 0, standalonePlanned = 0;
  const failedAgent = (a) => a.ok === false || ["failed", "interrupted", "cancelled", "error", "timeout", "killed"].includes(String(a.state || ""));
  const successfulAgent = (a) => (a.state === "completed" || a.state === "cached") && a.ok !== false;
  const phaseKey = (a) => a.phaseId !== undefined && a.phaseId !== null ? `phase:${a.phaseId}` : `role:${norm(a.name)}`;
  for (const a of byId.values()) {
    const role = norm(a.name);
    let g = byRole.get(role);
    if (!g) { g = { role, count: 0, planned: 0, ok: 0, fail: 0, running: 0, unknown: 0, output: null, artifact: null, prompt: null }; byRole.set(role, g); }
    g.count++;
    if (typeof a.phaseTotal === "number" && a.phaseTotal > 0) {
      const key = phaseKey(a);
      phaseTotals.set(key, Math.max(phaseTotals.get(key) || 0, a.phaseTotal));
      g.planned = Math.max(g.planned || 0, a.phaseTotal);
    } else {
      standalonePlanned++;
      g.planned = Math.max(g.planned || 0, g.count);
    }
    if (a.state === "running") { g.running++; running++; }
    else if (failedAgent(a)) { g.fail++; fail++; }
    else if (successfulAgent(a)) { g.ok++; ok++; }
    else { g.unknown++; unknown++; }
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

  let planned = standalonePlanned;
  for (const total of phaseTotals.values()) planned += total;
  planned = Math.max(status.agentCount ?? 0, byId.size, planned);
  const state = status.state || "unknown";
  const active = !!status.active || state === "running";
  const done = ok + fail + unknown;
  const openEnded = active && running === 0 && done >= planned && planned > 0;
  const fraction = planned > 0 ? (openEnded ? Math.min(done / planned, 0.95) : done / planned) : 0;
  const runKind = state === "failed" ? "fail" : active ? "run" : state === "completed" ? "ok" : "warn";
  const progressKind = fail || state === "failed" ? "fail" : active || running ? "run" : unknown ? "warn" : runKind;
  const progress = { done, total: planned, running, failed: fail, unknown, openEnded, fraction, kind: progressKind, value: `${done}/${planned}${openEnded ? "+" : ""}` };

  // runAgents en formato pi también, así report-model.mjs construye las tarjetas por agente desde
  // los eventos reales (con phaseId/phaseTotal explícitos — el plan declarado, no el conteo
  // observado, para no flashear 100% entre oleadas de fan-out).
  const runAgents = [...byId.values()].map((a) => ({
    id: a.id ?? a.name, name: a.name || "agent",
    state: a.state === "running" ? "running" : failedAgent(a) ? "failed" : successfulAgent(a) ? "completed" : "other",
    phaseLabel: a.phaseLabel ?? null, phaseId: a.phaseId ?? null, phaseIndex: a.phaseIndex ?? null, phaseTotal: a.phaseTotal ?? null,
    startedAt: typeof a.startedAt === "number" ? a.startedAt : (a.startedAt ? Date.parse(a.startedAt) || null : null),
    endedAt: typeof a.endedAt === "number" ? a.endedAt : (a.endedAt ? Date.parse(a.endedAt) || null : null),
    output: a.output ? String(a.output).slice(0, MAX_OUTPUT_CHARS) : null, outputChars: a.output ? String(a.output).length : 0,
    prompt: null, model: a.model ?? null, attempt: 1, tokens: null, toolCalls: null,
  }));

  return { runDir, runId: status.runId || basename(runDir), state, active, agentCount: status.agentCount ?? byId.size, elapsedMs: status.elapsedMs || 0, ok, fail, unknown, running, bashDone, logs, byRole, results, runKind, progress, runAgents };
}

export function mergeNodes(runData, baseNodes, declared) {
  if (!runData) return { nodes: baseNodes, extraPhases: [] };
  const rg = (g) => ({ count: g.count, planned: Math.max(g.planned || 0, g.count), ok: g.ok, fail: g.fail, unknown: g.unknown || 0, running: g.running, output: g.output, artifact: g.artifact });
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
      schema: d.schema ? (d.schema.title || "object schema") : "— (free text)", schemaObj: d.schema || null,
      model: d.model || "inherited", effort: d.effort || "inherited", tools: "inherited", skills: [], extensions: "inherited",
      prompt: g.prompt || "‹ recorded at runtime — see artifact ›", parallel: !!d.parallel,
      runtimeOnly: true, run: rg(g),
    });
  }
  return { nodes, extraPhases };
}
