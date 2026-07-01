// artifact.mjs — orchestrator. buildArtifact() ties extract -> run-merge -> render into ONE
// reusable, importable call that returns { html, data } (no file IO), so any code — not just the
// CLI — can produce a workflow artifact. json-to-markdown + the client script are read from disk
// (lib-relative) and inlined into the HTML so "what is tested is what ships".
import { readFileSync } from "node:fs";
import { extractStaticModel } from "./extract.mjs";
import { resolveRunDir, readRunData, mergeNodes } from "./run-merge.mjs";
import { assembleArtifact } from "./render.mjs";

export { resolveRunDir, readRunData } from "./run-merge.mjs";

// Kitchen-sink args so most workflows' required-input guards pass and the body runs.
const KITCHEN_SINK = () => ({
  task: "<task>", request: "<request>", text: "<text>", question: "<question>", goal: "<goal>",
  problem: "<problem>", topic: "<topic>", content: "<content>", instruction: "<instruction>",
  files: ["a.js", "b.js"], items: ["x"], claims: ["c1"], findings: [], bugs: [],
  rules: ["r"], inputRules: ["r"], outputRules: ["r"], protect: { name: "fan-out-and-synthesize", args: {} },
  angles: ["a1", "a2"], reviewers: 1, skeptics: 1, samples: 2, finders: 1, maxRounds: 1,
  maxTrials: 1, depth: 1, branching: 2, beam: 1, maxClaims: 1, maxSubtasks: 2, generate: false,
});

// Reusable JSON->Markdown renderer, inlined into the client script (export stripped so it becomes a
// plain function; interpolated via \${...} so its content can never break the outer template literal).
const jsonToMarkdownSource = (() => {
  try { return readFileSync(new URL("./json-to-markdown.mjs", import.meta.url), "utf8").replace(/\bexport\s+/g, ""); }
  catch { return 'function jsonToMarkdown(v){return typeof v==="string"?v:JSON.stringify(v,null,2);}'; }
})();
const clientJsSource = (() => {
  try { return readFileSync(new URL("./artifact-client.js", import.meta.url), "utf8"); }
  catch { return 'document.body.innerHTML="<p>artifact-client.js missing</p>";'; }
})();
// Contract-view client code, injected into the HTML ONLY when a contract is present (keeps
// non-contract artifacts byte-identical). Read lazily-eager here alongside the base client.
const contractViewSource = (() => {
  try { return readFileSync(new URL("./contract-view.js", import.meta.url), "utf8"); }
  catch { return ''; }
})();

// buildArtifact({ scriptPath, raw?, argsObj?, argsJson?, runDir?, match? }) -> { html, data, runData,
// nodeCount, composes, runErr, resolvedRunDir }. runDir accepts a concrete path OR "latest"/true
// (resolved with `match`); pass raw/argsObj to skip the file read / arg defaults.
export async function buildArtifact({ scriptPath, raw, argsObj, argsJson, runDir, match } = {}) {
  if (!scriptPath) throw new Error("buildArtifact: scriptPath is required");
  if (raw == null) raw = readFileSync(scriptPath, "utf8");
  if (argsObj == null) argsObj = argsJson ? JSON.parse(argsJson) : KITCHEN_SINK();
  const model = await extractStaticModel({ scriptPath, raw, argsObj });
  const resolvedRunDir = runDir ? resolveRunDir(runDir, match) : null;
  const runData = resolvedRunDir ? readRunData(resolvedRunDir) : null;
  const merged = mergeNodes(runData, model.baseNodes, model.declared);
  const { html, data, nodeCount } = assembleArtifact({
    merged, basePhases: model.basePhases, composes: model.composes, meta: model.meta,
    provenance: model.provenance, scaffolds: model.scaffolds, scriptPath, argsJson,
    schemas: model.schemas, skillRefs: model.skillRefs, raw, runData,
    staticFidelity: model.staticFidelity, jsonToMarkdownSource, clientJsSource, contractViewSource,
  });
  return { html, data, runData, nodeCount, composes: model.composes, runErr: model.runErr, resolvedRunDir };
}
