// artifact.mjs — orquestador. buildArtifact() une extract -> run-merge -> render en UNA llamada
// reutilizable e importable que devuelve { html, data } (sin file IO), para que cualquier código — no solo
// el CLI — pueda producir un workflow artifact. json-to-markdown + el script cliente se leen de disco
// (relativos a lib) y se inlinean en el HTML para que "what is tested is what ships".
import { readFileSync } from "node:fs";
import { extractPreviewModel } from "./extract.mjs";
import { resolveRunDir, readRunData, mergeNodes } from "./run-merge.mjs";
import { assembleArtifact } from "./render.mjs";

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

// Renderizador reutilizable de JSON->Markdown, inlineado en el script cliente (se quita export para que quede
// como función común; se interpola vía \${...} para que su contenido nunca rompa el template literal externo).
const jsonToMarkdownSource = (() => {
  try { return readFileSync(new URL("./json-to-markdown.mjs", import.meta.url), "utf8").replace(/\bexport\s+/g, ""); }
  catch { return 'function jsonToMarkdown(v){return typeof v==="string"?v:JSON.stringify(v,null,2);}'; }
})();
const clientJsSource = (() => {
  try { return readFileSync(new URL("./artifact-client.js", import.meta.url), "utf8"); }
  catch { return 'document.body.innerHTML="<p>artifact-client.js missing</p>";'; }
})();
const pandiTokensCss = (() => {
  try { return readFileSync(new URL("./pandi-tokens.css", import.meta.url), "utf8"); }
  catch { return ":root{--bg:#242526;--paper:#292A2B;--info-bg:#2E2A33;--raised:#31353A;--ink:#E6E6E6;--ink2:#BBBBBB;--muted:#757575;--line:#3E4250;--line-strong:#676B79;--accent:#FF75B5;--link:#6FC1FF;--info:#45A9F9;--success:#19F9D8;--warning:#FFCC95;--error:#FF4B82;--code:#19F9D8;--purple:#BCAAFE;--success-bg:#1E2E2B;--error-bg:#2E1E24;--warning-bg:#2E2A33;}"; }
})();
// Código cliente de contract-view, inyectado en el HTML SOLO cuando hay un contrato (mantiene byte-idénticos
// los artifacts sin contrato). Se lee con pereza-eager acá junto al cliente base.
const contractViewSource = (() => {
  try { return readFileSync(new URL("./contract-view.js", import.meta.url), "utf8"); }
  catch { return ''; }
})();

// buildArtifact({ scriptPath, raw?, argsObj?, argsJson?, runDir?, match?, evalPreview? }) -> { html, data, runData,
// nodeCount, composes, runErr, resolvedRunDir }. runDir acepta un path concreto O "latest"/true
// (resuelto con `match`); evalPreview habilita explícitamente el recorrido evaluado con stubs.
export async function buildArtifact({ scriptPath, raw, argsObj, argsJson, runDir, match, evalPreview = false } = {}) {
  if (!scriptPath) throw new Error("buildArtifact: scriptPath is required");
  if (raw == null) raw = readFileSync(scriptPath, "utf8");
  if (argsObj == null) argsObj = argsJson ? JSON.parse(argsJson) : KITCHEN_SINK();
  const model = await extractPreviewModel({ scriptPath, raw, argsObj, evalPreview });
  const resolvedRunDir = runDir ? resolveRunDir(runDir, match) : null;
  const runData = resolvedRunDir ? readRunData(resolvedRunDir) : null;
  const merged = mergeNodes(runData, model.baseNodes, model.declared);
  const { html, data, nodeCount } = assembleArtifact({
    merged, basePhases: model.basePhases, composes: model.composes, meta: model.meta,
    provenance: model.provenance, scaffolds: model.scaffolds, scriptPath, argsJson,
    schemas: model.schemas, skillRefs: model.skillRefs, raw, runData,
    previewMode: evalPreview ? "evaluated" : "parse-only",
    staticFidelity: model.staticFidelity, jsonToMarkdownSource, clientJsSource, contractViewSource, tokensCss: pandiTokensCss,
  });
  return { html, data, runData, nodeCount, composes: model.composes, runErr: model.runErr, resolvedRunDir };
}
