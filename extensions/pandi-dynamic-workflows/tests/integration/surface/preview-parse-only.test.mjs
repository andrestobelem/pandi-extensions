#!/usr/bin/env node
/**
 * El preview pre-launch es parse-only por defecto. La evaluación del source es
 * una compatibilidad explícita y conserva los stubs del runtime.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const ARTIFACT_LIB = path.join(REPO_ROOT, ".claude", "scripts", "lib", "artifact.mjs");
const BUILDERS = [
	path.join(REPO_ROOT, ".claude", "scripts", "build-workflow-artifact.mjs"),
	path.join(REPO_ROOT, ".pi", "scripts", "build-workflow-artifact.mjs"),
];
const PROCESS_MARKER = "PANDI_PREVIEW_PARSE_ONLY_EFFECT";

const { buildArtifact } = await import(pathToFileURL(ARTIFACT_LIB).href);
const { check, counts } = createChecker();
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "workflow-preview-parse-only-"));
const workflowPath = path.join(tmp, "side-effect-workflow.js");
const markerPath = path.join(tmp, "side-effect.txt");
const outPath = path.join(tmp, "preview.html");
const source = `
export const meta = {
	name: "side-effect-workflow",
	description: "Fixture para asegurar que el preview no ejecuta source por defecto",
	phases: [{ title: "Inspect" }],
};

process.env.${PROCESS_MARKER} = "executed";
if (process.env.PANDI_PREVIEW_SIDE_EFFECT_PATH) {
	process.getBuiltinModule("node:fs").writeFileSync(process.env.PANDI_PREVIEW_SIDE_EFFECT_PATH, "executed");
}

export default async function main() {
	phase("Inspect");
	await agent("Inspeccioná sin ejecutar efectos reales", {
		label: "safe-worker",
		phase: "Inspect",
		model: "haiku",
		effort: "low",
	});
}
`;

try {
	await fsp.writeFile(workflowPath, source);
	delete process.env[PROCESS_MARKER];

	const parsed = await buildArtifact({ scriptPath: workflowPath, raw: source, argsObj: {} });
	check("API parse-only no muta process", process.env[PROCESS_MARKER] === undefined);
	check("API parse-only extrae meta literal", parsed.html.includes("side-effect-workflow"));
	check("API parse-only extrae fases literales", parsed.html.includes("Inspect"));
	check("API parse-only extrae agent calls estáticos", parsed.html.includes("safe-worker"));

	const evaluated = await buildArtifact({
		scriptPath: workflowPath,
		raw: source,
		argsObj: {},
		evalPreview: true,
	});
	check("API evalPreview recorre el workflow con stubs", process.env[PROCESS_MARKER] === "executed");
	check("API evalPreview conserva los agent calls", evaluated.html.includes("safe-worker"));
	check("API evalPreview se etiqueta como evaluado", evaluated.html.includes("preview: evaluado"));
	check("API evalPreview no se presenta como estático", !evaluated.html.includes("preview: estático"));
	check("API parse-only se etiqueta como estático", parsed.html.includes("preview: estático (parse-only)"));
	delete process.env[PROCESS_MARKER];

	for (const builder of BUILDERS) {
		const label = path.relative(REPO_ROOT, builder);
		const help = spawnSync(process.execPath, [builder, "--help"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		check(`${label} --help exits 0`, help.status === 0, help.stderr);
		check(`${label} documenta --eval-preview`, `${help.stdout}\n${help.stderr}`.includes("--eval-preview"));

		await fsp.rm(markerPath, { force: true });
		const defaultRun = spawnSync(process.execPath, [builder, workflowPath, outPath], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: { ...process.env, PANDI_PREVIEW_SIDE_EFFECT_PATH: markerPath },
		});
		check(`${label} default exits 0`, defaultRun.status === 0, defaultRun.stderr);
		check(`${label} default no ejecuta el source`, !fs.existsSync(markerPath));

		const evalRun = spawnSync(process.execPath, [builder, workflowPath, outPath, "--eval-preview"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: { ...process.env, PANDI_PREVIEW_SIDE_EFFECT_PATH: markerPath },
		});
		check(`${label} --eval-preview exits 0`, evalRun.status === 0, evalRun.stderr);
		check(`${label} --eval-preview habilita evaluación controlada`, fs.existsSync(markerPath));
	}
} finally {
	delete process.env[PROCESS_MARKER];
	await fsp.rm(tmp, { recursive: true, force: true });
}

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
