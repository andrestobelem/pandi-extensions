#!/usr/bin/env node
/**
 * workflow-preview-didactic — el artifact se explica solo, en castellano, para alguien
 * que lo abre sin contexto. Migrado al reporte unificado (observe-core, el renderer
 * canónico de pi): mismas garantías didácticas, medidas sobre el HTML nuevo —
 * opening que orienta, secciones de plan pre-launch (agentes, schemas, script),
 * post-run que abre por las fallas, y output final renderizado como markdown
 * estructurado (no JSON crudo).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const ARTIFACT_LIB = path.join(REPO_ROOT, ".claude", "scripts", "lib", "artifact.mjs");
const SCAFFOLD = path.join(
	REPO_ROOT,
	"extensions",
	"pandi-dynamic-workflows",
	"scaffolds",
	"fan-out-and-synthesize.js",
);

const { buildArtifact } = await import(pathToFileURL(ARTIFACT_LIB).href);
const { check, counts } = createChecker();
const argsJson = JSON.stringify({ task: "didactic probe", items: ["uno", "dos"] });

// ── pre-launch: la vista planned orienta y muestra el plan completo ─────────────────────
const preview = await buildArtifact({ scriptPath: SCAFFOLD, argsJson });
check("preview has a didactic opening", preview.html.includes("Vista previa pre-launch"), "");
check("preview explains nothing ran yet", preview.html.includes("nada corrió todavía"), "");
check(
	"preview pill reads planned, not failed",
	preview.html.includes('rpill warn">planned<') && !preview.html.includes('rpill fail">planned<'),
	"",
);
check("preview lists the planned agents", preview.html.includes("Agents ("), "");
check("preview renders the schemas section", /Schemas \(\d+\)/.test(preview.html), "");
check("preview renders the full script section", preview.html.includes("<h2>Script</h2>"), "");
check("preview names the workflow", preview.html.includes("fan-out-and-synthesize"), "");
check("preview surfaces the input args", preview.html.includes("didactic probe"), "");

// ── post-run con falla: el reporte abre por lo que falló ────────────────────────────────
async function writeRun(name, status, events, resultJson) {
	const runDir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify(status));
	await fs.writeFile(path.join(runDir, "events.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
	if (resultJson !== undefined) await fs.writeFile(path.join(runDir, "result.json"), JSON.stringify(resultJson));
	return runDir;
}

const failedDir = await writeRun(
	"didactic-failed",
	{ runId: "r-failed", state: "completed", active: false, agentCount: 2, elapsedMs: 1000 },
	[
		{ type: "agent", id: 1, name: "worker-ok", state: "completed", ok: true },
		{ type: "agent", id: 2, name: "worker-bad", state: "failed", ok: false },
	],
);
try {
	const failed = await buildArtifact({ scriptPath: SCAFFOLD, argsJson, runDir: failedDir });
	check("post-run opening mentions the failed agent", failed.html.includes("falló"), "");
	check("post-run opens the failed card first", failed.html.includes('class="fail-card" open'), "");
	check("post-run keeps the run-report kicker", failed.html.includes("Pandi artifact"), "");
} finally {
	await fs.rm(failedDir, { recursive: true, force: true });
}

// ── resultados: el output final renderiza como markdown estructurado, no JSON crudo ─────
const resultDir = await writeRun(
	"didactic-results",
	{ runId: "r-results", state: "completed", active: false, agentCount: 1, elapsedMs: 1000 },
	[{ type: "agent", id: 1, name: "solo", state: "completed", ok: true }],
	{ output: { verdict: "ready", blockers: [], successCriteria: ["compila", "tests verdes"] } },
);
try {
	const withResults = await buildArtifact({ scriptPath: SCAFFOLD, argsJson, runDir: resultDir });
	check("results render a Final output section", withResults.html.includes("Final output"), "");
	check(
		"results render as structured markdown, not raw JSON only",
		withResults.html.includes('class="structured-output"'),
		"",
	);
	check("results keep the raw JSON behind a collapsible", withResults.html.includes("Raw JSON"), "");
	check(
		"results humanize structured keys",
		withResults.html.includes("Success Criteria") || withResults.html.includes("Success criteria"),
		"",
	);
} finally {
	await fs.rm(resultDir, { recursive: true, force: true });
}

// ── run sin resultados: no se inventa una sección de output vacía ───────────────────────
const noResultDir = await writeRun(
	"didactic-no-results",
	{ runId: "r-none", state: "completed", active: false, agentCount: 1, elapsedMs: 1000 },
	[{ type: "agent", id: 1, name: "solo", state: "completed", ok: true }],
);
try {
	const withoutResults = await buildArtifact({ scriptPath: SCAFFOLD, argsJson, runDir: noResultDir });
	check("run without results omits the Final output section", !withoutResults.html.includes("Final output"), "");
	check("run without results still explains itself", withoutResults.html.includes("completaron el run"), "");
} finally {
	await fs.rm(noResultDir, { recursive: true, force: true });
}

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
