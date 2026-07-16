// artifact.mjs — orquestador. buildArtifact() une extract -> run-merge -> report-model ->
// observe-core en UNA llamada reutilizable e importable que devuelve { html, ... } (sin file IO
// más allá de leer el script), para que cualquier código — no solo el CLI — pueda producir un
// workflow artifact.
//
// Desde la unificación pi/Claude, el HTML lo genera el renderer CANÓNICO de pi
// (observe-core.mjs, bundle generado de observe/html.ts — ver scripts/generate-claude-observe-core.mjs):
// misma feature, mismo código, en ambas plataformas. Acá solo quedan los lectores locales
// (extract.mjs, run-merge.mjs) y el adapter de modelo (report-model.mjs).
import { readFileSync } from "node:fs";
import { extractPreviewModel } from "./extract.mjs";
import { resolveRunDir, readRunData } from "./run-merge.mjs";
import { buildReportModel } from "./report-model.mjs";
import { buildRunReportHtml } from "./observe-core.mjs";

export { resolveRunDir, readRunData } from "./run-merge.mjs";

// Args kitchen-sink para que pasen las guardias de input requerido de la mayoría de los workflows y el body corra.
const KITCHEN_SINK = () => ({
  task: "<task>", request: "<request>", text: "<text>", question: "<question>", goal: "<goal>",
  problem: "<problem>", topic: "<topic>", content: "<content>", instruction: "<instruction>",
  files: ["a.js", "b.js"], items: ["x"], claims: ["c1"], findings: [], bugs: [],
  rules: ["r"], inputRules: ["r"], outputRules: ["r"], protect: { name: "fan-out-and-synthesize", args: {} },
  angles: ["a1", "a2"], reviewers: 1, skeptics: 1, samples: 2, finders: 1, maxRounds: 1,
  maxTrials: 1, depth: 1, branching: 2, beam: 1, maxClaims: 1, maxSubtasks: 2, generate: false,
});

// buildArtifact({ scriptPath, raw?, argsObj?, argsJson?, runDir?, match?, evalPreview?, generatedAt? })
// -> { html, model, runData, nodeCount, composes, runErr, resolvedRunDir }. runDir acepta un path
// concreto O "latest"/true (resuelto con `match`); evalPreview habilita explícitamente el recorrido
// evaluado con stubs. generatedAt (ISO) permite renders byte-estables en tests.
export async function buildArtifact({ scriptPath, raw, argsObj, argsJson, runDir, match, evalPreview = false, generatedAt } = {}) {
  if (!scriptPath) throw new Error("buildArtifact: scriptPath is required");
  if (raw == null) raw = readFileSync(scriptPath, "utf8");
  if (argsObj == null) argsObj = argsJson ? JSON.parse(argsJson) : KITCHEN_SINK();
  const previewModel = await extractPreviewModel({ scriptPath, raw, argsObj, evalPreview });
  const resolvedRunDir = runDir ? resolveRunDir(runDir, match) : null;
  const runData = resolvedRunDir ? readRunData(resolvedRunDir) : null;
  const model = buildReportModel({
    meta: previewModel.meta, baseNodes: previewModel.baseNodes, schemas: previewModel.schemas,
    scriptPath, raw, argsJson, runData,
    generatedAt: generatedAt ?? new Date().toISOString(),
    // Cómo se extrajo la ESTRUCTURA solo importa en el preview pre-launch; en un reporte
    // post-run el chip sería ruido (los agentes mostrados son los reales, no los extraídos).
    previewMode: runData ? undefined : evalPreview ? "evaluado" : "estático (parse-only)",
  });
  const html = buildRunReportHtml(model);
  return {
    html, model, runData,
    nodeCount: previewModel.baseNodes.length, composes: previewModel.composes,
    runErr: previewModel.runErr, resolvedRunDir,
  };
}
