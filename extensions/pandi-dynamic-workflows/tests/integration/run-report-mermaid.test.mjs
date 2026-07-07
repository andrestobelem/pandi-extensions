#!/usr/bin/env node
/**
 * buildRunMermaidSource (run-report-html.ts): el reporte de un run textual no traía ningún
 * diagrama del run concreto (fases → agentes con su estado). El viewer estático ya tiene un
 * generador Mermaid para el GRAFO ESTÁTICO del código del workflow (workflow-graph.ts); esto
 * cubre el caso distinto — un flowchart de LA CORRIDA real, agrupado por fase, coloreado por
 * estado (completed/failed/running/...). Sigue el contrato de seguridad pineado en
 * run-report-security.test.mjs: la fuente Mermaid se emite como TEXTO en un bloque
 * colapsable, nunca renderizada client-side (cero <script> en la página).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function baseModel(overrides = {}) {
	return {
		workflow: "demo",
		runId: "run-1",
		state: "completed",
		liveness: "verified",
		generatedAt: "2026-01-01T00:00:00.000Z",
		logs: [],
		phases: [],
		agents: [],
		artifacts: [],
		missingFiles: [],
		clampNotes: [],
		...overrides,
	};
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-run-report-mermaid",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "run-report-html.ts"),
		outName: "run-report-html.mjs",
	});
	const { buildRunMermaidSource } = await loadModule(url);
	check("buildRunMermaidSource is exported", typeof buildRunMermaidSource === "function");

	// Sin agentes: diagrama mínimo, sin romper (no hay nada que agrupar).
	const empty = buildRunMermaidSource(baseModel());
	check("sin agentes: arranca con flowchart TD", empty.startsWith("flowchart TD"));
	check("sin agentes: nota que no hubo agentes", /no agents|sin agentes/i.test(empty));

	// Dos fases, cada una con agentes; una fase con un agente failed.
	const model = baseModel({
		agents: [
			{ id: 1, name: "scout-1", state: "completed", ok: true, phaseId: 1, phaseLabel: "Scout" },
			{ id: 2, name: "scout-2", state: "completed", ok: true, phaseId: 1, phaseLabel: "Scout" },
			{ id: 3, name: "judge", state: "failed", ok: false, phaseId: 2, phaseLabel: "Judge" },
		],
	});
	const mermaid = buildRunMermaidSource(model);
	check("agrupa nodos bajo un subgraph por fase (Scout)", mermaid.includes('subgraph phase1["Scout"]'));
	check("agrupa nodos bajo un subgraph por fase (Judge)", mermaid.includes('subgraph phase2["Judge"]'));
	check("nodo de agente incluye su nombre", mermaid.includes("scout-1"));
	check("nodo de agente incluye su nombre (judge)", mermaid.includes("judge"));
	check("conecta las fases en orden de aparición", mermaid.includes("phase1 --> phase2"));
	check("clasifica el agente failed con su clase de estado", /class A3 .*failed/.test(mermaid) || mermaid.includes("class A3 failed"));
	check("clasifica los agentes completed con su clase de estado", mermaid.includes("class A1 completed") && mermaid.includes("class A2 completed"));
	check("define classDef para completed y failed", mermaid.includes("classDef completed") && mermaid.includes("classDef failed"));

	// Agentes sin fase (phaseId/phaseLabel ausentes): van a un grupo de fallback, no rompen.
	const noPhase = buildRunMermaidSource(baseModel({ agents: [{ id: 9, name: "solo", state: "running" }] }));
	check("agente sin fase cae en un grupo de fallback", noPhase.includes("solo"));
	check("agente sin fase no genera un subgraph vacío roto", noPhase.includes("subgraph"));

	// Labels con caracteres que rompen sintaxis Mermaid (comillas, corchetes) se sanean.
	const unsafe = buildRunMermaidSource(
		baseModel({ agents: [{ id: 5, name: 'weird"name[x]', state: "completed", ok: true, phaseId: 1, phaseLabel: 'Phase "1"' }] }),
	);
	check("labels de agente se sanean (sin comillas/corchetes crudos)", !/name\["weird"name\[x\]"\]/.test(unsafe));
	check("labels de fase se sanean (sin comillas crudas)", !unsafe.includes('subgraph phase1["Phase "1""]'));

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
