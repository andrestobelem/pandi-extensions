#!/usr/bin/env node
/**
 * workflow-plan-unphased-agents — regression for #64, migrada al reporte unificado.
 *
 * El preview pre-launch no debe esconder agentes declarados sin fase explícita.
 * `extract.mjs` los estampa con el centinela "—"; el modelo del reporte (report-model.mjs →
 * observe-core) debe listarlos como agentes planned con ese phaseLabel, no filtrarlos.
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const ARTIFACT_LIB = path.join(REPO_ROOT, ".claude", "scripts", "lib", "artifact.mjs");

const { buildArtifact } = await import(pathToFileURL(ARTIFACT_LIB).href);
const { check, counts } = createChecker();

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "plan-unphased-"));
const workflowPath = path.join(tmp, "mixed-probe.js");
await fsp.writeFile(
	workflowPath,
	`
export const meta = { name: "mixed-probe", description: "Probe unphased agents", phases: [{ title: "Scout" }] };
export default async function main() {
	await agent("judge the findings", { label: "judge" });
	phase("Scout");
	await agent("scout the repo", { label: "scout", phase: "Scout" });
}
`,
);

try {
	const artifact = await buildArtifact({ scriptPath: workflowPath, argsObj: {} });
	const judge = artifact.model.agents.find((agent) => agent.name === "judge");
	const scout = artifact.model.agents.find((agent) => agent.name === "scout");
	check("el agente con fase declarada conserva su phaseLabel", scout?.phaseLabel === "Scout", JSON.stringify(scout));
	check(
		"el agente sin fase queda en el modelo (no se filtra)",
		!!judge,
		artifact.model.agents.map((a) => a.name).join(","),
	);
	check(
		"el agente sin fase conserva el bucket centinela del extractor",
		judge?.phaseLabel === "—",
		JSON.stringify(judge),
	);
	check(
		"ambos agentes aparecen en el HTML renderizado",
		artifact.html.includes("scout") && artifact.html.includes("judge"),
		"",
	);
	check("el conteo de agentes del header incluye al unphased", artifact.html.includes("Agents (2)"), "");
} finally {
	await fsp.rm(tmp, { recursive: true, force: true });
}

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
