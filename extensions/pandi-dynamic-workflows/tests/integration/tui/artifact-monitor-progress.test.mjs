#!/usr/bin/env node
/**
 * workflow-artifact-monitor-progress — pins the monitor semantics for post-run
 * workflow artifacts: run-state severity comes from the run, progress uses known
 * fan-out totals when available, and mixed fan-out groups stay visibly running.
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

function sectionHtml(html, id) {
	const start = html.indexOf(`<section data-s="${id}"`);
	if (start < 0) return "";
	const end = html.indexOf("</section>", start);
	return end < 0 ? html.slice(start) : html.slice(start, end);
}

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

async function renderMonitor(runDir) {
	const artifact = await buildArtifact({ scriptPath: SCAFFOLD, argsJson, runDir });
	return sectionHtml(artifact.html, "monitor");
}

const runningEmptyDir = await writeRunFixture("monitor-running-empty", { agentCount: 0 }, []);
try {
	const monitor = await renderMonitor(runningEmptyDir);
	check(
		"running run with no spawned agents uses running severity",
		monitor.includes('<span class="rpill run">running</span>'),
	);
} finally {
	await fs.rm(runningEmptyDir, { recursive: true, force: true });
}

const mixedDir = await writeRunFixture("monitor-mixed-fanout", {}, [
	{ type: "agent", id: 1, name: "worker", state: "failed", ok: false, phaseId: 1, phaseIndex: 1, phaseTotal: 2 },
	{ type: "agent", id: 2, name: "worker", state: "running", phaseId: 1, phaseIndex: 2, phaseTotal: 2 },
]);
try {
	const monitor = await renderMonitor(mixedDir);
	check("mixed fan-out row stays visibly running", monitor.includes("corriendo 1/2"), monitor);
	check("mixed fan-out row still surfaces the failure", monitor.includes("falló 1"), monitor);
} finally {
	await fs.rm(mixedDir, { recursive: true, force: true });
}

const partialPhaseDir = await writeRunFixture("monitor-partial-phase", {}, [
	{ type: "agent", id: 1, name: "worker", state: "completed", ok: true, phaseId: 1, phaseIndex: 1, phaseTotal: 4 },
	{ type: "agent", id: 2, name: "worker", state: "completed", ok: true, phaseId: 1, phaseIndex: 2, phaseTotal: 4 },
	{ type: "agent", id: 3, name: "worker", state: "completed", ok: true, phaseId: 1, phaseIndex: 3, phaseTotal: 4 },
]);
try {
	const monitor = await renderMonitor(partialPhaseDir);
	check("phaseTotal prevents a 100% flash between fan-out waves", monitor.includes("3/4"), monitor);
	check("phaseTotal monitor does not report 3/3", !monitor.includes("3/3"), monitor);
} finally {
	await fs.rm(partialPhaseDir, { recursive: true, force: true });
}

if (counts.failed > 0) {
	console.error(`\n${counts.failed} checks FAILED:`);
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
