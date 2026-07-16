#!/usr/bin/env node
/**
 * workflow-artifact-monitor-progress — pins the monitor semantics for post-run
 * workflow artifacts: run-state severity comes from the run, progress uses known
 * fan-out totals when available, and mixed fan-out groups stay visibly running.
 * (Migrado al reporte unificado: las mismas garantías, medidas sobre el HTML del
 * renderer canónico — summarizeProgress + Workflow monitor cards de pi.)
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const SCAFFOLD = path.join(
	REPO_ROOT,
	"extensions",
	"pandi-dynamic-workflows",
	"scaffolds",
	"fan-out-and-synthesize.js",
);
const ARTIFACT_LIB = path.join(REPO_ROOT, ".claude", "scripts", "lib", "artifact.mjs");

const { buildArtifact } = await import(pathToFileURL(ARTIFACT_LIB).href);
const { check, counts } = createChecker();
const argsJson = JSON.stringify({ task: "revisar progreso", items: ["uno", "dos", "tres", "cuatro"] });

async function writeRunFixture(name, statusPatch, events = []) {
	const runDir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify({
			runId: `2026-01-01T00-00-00-000Z-${name}`,
			state: "running",
			active: true,
			agentCount: events.filter((event) => event.type === "agent").length,
			elapsedMs: 1000,
			...statusPatch,
		}),
	);
	await fs.writeFile(
		path.join(runDir, "events.jsonl"),
		`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
	);
	return runDir;
}

const runningEmptyDir = await writeRunFixture("monitor-running-empty", { agentCount: 0 }, []);
try {
	const artifact = await buildArtifact({ scriptPath: SCAFFOLD, argsJson, runDir: runningEmptyDir });
	check(
		"running run with no spawned agents uses running severity",
		artifact.html.includes('rpill run">running</span>'),
		"",
	);
} finally {
	await fs.rm(runningEmptyDir, { recursive: true, force: true });
}

const mixedDir = await writeRunFixture("monitor-mixed-fanout", {}, [
	{ type: "agent", id: 1, name: "worker", state: "failed", ok: false, phaseId: 1, phaseIndex: 1, phaseTotal: 2 },
	{ type: "agent", id: 2, name: "worker", state: "running", phaseId: 1, phaseIndex: 2, phaseTotal: 2 },
]);
try {
	const artifact = await buildArtifact({ scriptPath: SCAFFOLD, argsJson, runDir: mixedDir });
	check(
		"mixed fan-out progress counts the running lane (1/2)",
		artifact.html.includes(">1/2<"),
		artifact.html.match(/>[\d]+\/[\d]+</g)?.join(","),
	);
	check(
		"mixed fan-out still surfaces the failure in the failed card",
		/metric-label">failed<\/div><div class="metric-value">1</.test(artifact.html),
		artifact.html.match(/metric-label">failed<\/div><div class="metric-value">\d+/)?.[0],
	);
	check("mixed fan-out keeps a running agent card", artifact.html.includes("▶ running"), "");
	check("mixed fan-out keeps the failed agent card visible", artifact.html.includes("✗ failed"), "");
} finally {
	await fs.rm(mixedDir, { recursive: true, force: true });
}

const partialPhaseDir = await writeRunFixture("monitor-partial-phase", {}, [
	{ type: "agent", id: 1, name: "worker", state: "completed", ok: true, phaseId: 1, phaseIndex: 1, phaseTotal: 4 },
	{ type: "agent", id: 2, name: "worker", state: "completed", ok: true, phaseId: 1, phaseIndex: 2, phaseTotal: 4 },
	{ type: "agent", id: 3, name: "worker", state: "completed", ok: true, phaseId: 1, phaseIndex: 3, phaseTotal: 4 },
]);
try {
	const artifact = await buildArtifact({ scriptPath: SCAFFOLD, argsJson, runDir: partialPhaseDir });
	check(
		"phaseTotal prevents a 100% flash between fan-out waves",
		artifact.html.includes(">3/4"),
		artifact.html.match(/>[\d]+\/[\d]+/g)?.join(","),
	);
	check("phaseTotal monitor does not report 3/3", !artifact.html.includes(">3/3"), "");
} finally {
	await fs.rm(partialPhaseDir, { recursive: true, force: true });
}

if (counts.failed > 0) {
	console.error(`\n${counts.failed} checks FAILED:`);
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
