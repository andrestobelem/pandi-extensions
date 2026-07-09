#!/usr/bin/env node
/**
 * Regresión visual: los artifacts deben dibujar fan-out como lanes, no comprimir
 * revisores paralelos a una sola caja con un contador. La captura del Contract
 * Gate mostró `revisión · schema · ✓4` como un paso secuencial; este test exige
 * fork → 4 análisis → join también después de mezclar datos del run real.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CONTRACT_GATE = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds", "contract-gate.js");
const ARTIFACT_LIB = path.join(REPO_ROOT, ".claude", "scripts", "lib", "artifact.mjs");
const { buildArtifact } = await import(pathToFileURL(ARTIFACT_LIB).href);
const { check, counts } = createChecker();

const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-contract-gate-fanout-"));
try {
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify({
			runId: "2026-07-09T00-00-00-000Z-contract-gate-fanout",
			state: "completed",
			active: false,
			agentCount: 5,
			elapsedMs: 1000,
		}),
	);
	await fs.writeFile(
		path.join(runDir, "events.jsonl"),
		[
			...Array.from({ length: 4 }, (_value, index) =>
				JSON.stringify({
					type: "agent",
					id: index + 1,
					name: `analyze-${index + 1}`,
					state: "completed",
					ok: true,
				}),
			),
			JSON.stringify({ type: "agent", id: 5, name: "analyze-synthesis", state: "completed", ok: true }),
		].join("\n"),
	);

	const artifact = await buildArtifact({
		scriptPath: CONTRACT_GATE,
		argsJson: JSON.stringify({ request: "revisar un cambio", reviewers: 4 }),
		runDir,
	});
	const diagram = artifact.data.__mm;

	check("diagram keeps a fork for parallel analysis", /fork/i.test(diagram), diagram);
	check(
		"diagram renders four analyzer lanes from the canonical scaffold",
		["analyze 1", "analyze 2", "analyze 3", "analyze 4"].every((label) => diagram.includes(label)),
		diagram,
	);
	check("diagram joins analyzer lanes before synthesis", /join/i.test(diagram), diagram);
	check(
		"diagram does not reduce the parallel analyzers to one sequential node",
		!diagram.includes("analyze · schema · ✓4"),
		diagram,
	);
} finally {
	await fs.rm(runDir, { recursive: true, force: true });
}

if (counts.failed > 0) {
	console.error(`\n${counts.failed} checks FAILED:`);
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
