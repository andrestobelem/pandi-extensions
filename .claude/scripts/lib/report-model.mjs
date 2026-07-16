// report-model.mjs — adapter Claude→RunReportModel. Mapea lo que producen los lectores locales
// (extract.mjs para el plan estático, run-merge.mjs para el run real) al modelo normalizado que
// consume el renderer canónico compartido con pi (observe-core.mjs, bundle de observe/html.ts).
// Acá NO se genera HTML: ese es todo del renderer de pi — misma feature, mismo código, en ambas
// plataformas. Puro: sin file IO ni Date.now(); `generatedAt` viene del caller.
import { norm } from "./util.mjs";

const MAX_SCRIPT_CHARS = 80000;

const toText = (value, cap = Infinity) => {
  if (value == null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { text: text.slice(0, cap), truncated: text.length > cap };
};

const toIso = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

// Estados del adaptador de run-merge → vocabulario de RunReportAgent (completed/failed/running
// más el "planned" que agregamos al canónico). "other" (estado desconocido del engine) se pasa
// tal cual: pillClass lo trata como warn-por-fallback y agentStateText como "? unknown".
const agentState = (state) => (state === "other" ? "unknown" : state);

function plannedAgents(baseNodes) {
  return baseNodes.map((node, index) => ({
    id: index + 1,
    name: node.role,
    state: "planned",
    phaseLabel: node.phase || undefined,
    // instances>1 declara fan-out: phaseTotal hace que el progreso 0/N cuente el plan real.
    phaseTotal: Math.max(1, node.instances ?? 1),
    model: node.model && node.model !== "inherited" ? node.model : undefined,
    thinking: node.effort && node.effort !== "inherited" ? node.effort : undefined,
    prompt: toText(node.prompt),
    tools: node.tools && node.tools !== "inherited" ? node.tools : undefined,
    skills: Array.isArray(node.skills) && node.skills.length ? node.skills.join(", ") : undefined,
  }));
}

function realAgents(runData, baseNodes) {
  const byRole = new Map(baseNodes.map((node) => [norm(node.role), node]));
  // phaseTotal por fase = eventos observados en esa fase; con el run completo eso ES el plan,
  // y evita el flash de 100% entre oleadas de fan-out (mismo criterio que pi).
  const phaseCounts = new Map();
  for (const agent of runData.runAgents) {
    const key = agent.phaseLabel || "";
    phaseCounts.set(key, (phaseCounts.get(key) || 0) + 1);
  }
  const phaseIds = new Map([...phaseCounts.keys()].map((key, index) => [key, index + 1]));
  return runData.runAgents.map((agent, index) => {
    const staticNode = byRole.get(norm(agent.name));
    const startedAt = toIso(agent.startedAt);
    const endedAt = toIso(agent.endedAt);
    const elapsedMs =
      typeof agent.startedAt === "number" && typeof agent.endedAt === "number" && agent.endedAt >= agent.startedAt
        ? agent.endedAt - agent.startedAt
        : undefined;
    const output = agent.output != null ? toText(agent.output) : undefined;
    if (output && agent.outputChars > output.text.length) output.truncated = true;
    const metrics = {};
    if (typeof agent.tokens === "number") metrics.outputTokensTotal = agent.tokens;
    if (typeof agent.toolCalls === "number") metrics.toolCalls = agent.toolCalls;
    if (agent.attempt > 1) metrics.autoRetries = agent.attempt - 1;
    return {
      id: index + 1,
      name: agent.name,
      state: agentState(agent.state),
      startedAt,
      endedAt,
      elapsedMs,
      phaseLabel: agent.phaseLabel || undefined,
      // phaseId/phaseTotal explícitos (eventos pi) ganan: son el PLAN declarado. El conteo
      // observado por fase es el fallback para el record de Claude, que no declara totales.
      phaseId: agent.phaseId ?? phaseIds.get(agent.phaseLabel || ""),
      phaseIndex: agent.phaseIndex ?? undefined,
      phaseTotal: agent.phaseTotal ?? phaseCounts.get(agent.phaseLabel || ""),
      model: agent.model || staticNode?.model || undefined,
      thinking: staticNode?.effort && staticNode.effort !== "inherited" ? staticNode.effort : undefined,
      prompt: toText(agent.prompt ?? staticNode?.prompt),
      output,
      outputChars: agent.outputChars || undefined,
      outputEmpty: agent.state === "completed" && !String(agent.output ?? "").trim() ? true : undefined,
      metrics: Object.keys(metrics).length ? metrics : undefined,
    };
  });
}

/**
 * buildReportModel({ meta, baseNodes, schemas, scriptPath, raw, argsJson, runData, generatedAt })
 * → RunReportModel para observe-core.buildRunReportHtml().
 */
export function buildReportModel({ meta = {}, baseNodes = [], schemas = {}, scriptPath, raw = "", argsJson, runData = null, generatedAt, previewMode }) {
  const state = runData?.state ?? "planned";
  const basedOn = (Array.isArray(meta.basedOn) ? meta.basedOn : []).map((entry) =>
    typeof entry === "string" ? { name: entry } : { name: String(entry?.name ?? "unknown"), role: entry?.role, desc: entry?.desc ?? entry?.description },
  );
  const schemaEntries = Object.entries(schemas).map(([name, schema]) => ({ name, json: JSON.stringify(schema, null, 2) }));
  const clampNotes = [];
  if (runData?.liveJournal) {
    clampNotes.push(
      "vista live desde journal.jsonl: nombres de agente derivados de la primera línea del prompt; los labels y fases exactos aparecen cuando el run completa y existe el record.",
    );
  }
  const returnValue = runData?.results?.returnValue;
  return {
    workflow: meta.name || scriptPath || "workflow",
    runId: runData?.runId ?? "preview",
    scriptPath,
    state,
    liveness: "unverified",
    generatedAt,
    previewMode,
    elapsedMs: runData?.elapsedMs || undefined,
    input: argsJson ? toText(argsJson) : undefined,
    output: returnValue !== undefined && returnValue !== null ? toText(returnValue) : undefined,
    basedOn: basedOn.length ? basedOn : undefined,
    schemas: schemaEntries.length ? schemaEntries : undefined,
    script: raw ? toText(raw, MAX_SCRIPT_CHARS) : undefined,
    logs: (runData?.logs ?? []).map((log) => ({ time: String(log.time ?? ""), message: String(log.message ?? "") })),
    phases: [],
    agents: runData?.runAgents?.length ? realAgents(runData, baseNodes) : plannedAgents(baseNodes),
    integrity: runData?.integrity
      ? {
          agentResults: runData.integrity.measuredAgents,
          failedAgents: runData.integrity.failed,
          timedOutAgents: runData.integrity.timedOut,
          emptyOutputAgents: runData.integrity.emptyOutput,
        }
      : undefined,
    metricsTotals: runData?.metrics
      ? {
          measuredAgents: runData.metrics.measuredAgents,
          okAgents: runData.ok,
          failedAgents: runData.fail,
          outputTokensTotal: runData.metrics.totalTokens ?? undefined,
          toolCalls: runData.metrics.totalToolCalls ?? undefined,
          autoRetries: runData.metrics.retries,
        }
      : undefined,
    artifacts: [],
    missingFiles: [],
    clampNotes,
  };
}
