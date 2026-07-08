#!/usr/bin/env node
/**
 * buildRunMermaidSource (run-report-html.ts): el reporte de un run textual no traía ningún
 * diagrama del run concreto (fases → agentes con su estado). El viewer estático ya tiene un
 * generador Mermaid para el GRAFO ESTÁTICO del código del workflow (workflow-graph.ts); esto
 * cubre el caso distinto — un flowchart de LA CORRIDA real, agrupado por fase, coloreado por
 * estado (completed/failed/running/...). Sigue el contrato de seguridad pineado en
 * run-report-security.test.mjs: la fuente Mermaid se escapa como texto dentro del
 * contenedor que Mermaid renderiza y también queda disponible como fallback colapsable;
 * el render client-side usa solo scripts fijos pineados con securityLevel:"sandbox".
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
	check("nodos de agente usan forma stadium/pill", mermaid.includes('A1(["scout-1"])'));
	check("conecta las fases en orden de aparición", /phase1_out\s*-->\s*phase2_in/.test(mermaid), mermaid);
	check(
		"clasifica el agente failed con su clase de estado",
		/class A3 .*failed/.test(mermaid) || mermaid.includes("class A3 failed"),
	);
	check(
		"clasifica los agentes completed con su clase de estado",
		mermaid.includes("class A1 completed") && mermaid.includes("class A2 completed"),
	);
	check(
		"define classDef para completed y failed",
		mermaid.includes("classDef completed") && mermaid.includes("classDef failed"),
	);

	// Grupos grandes se resumen: evita diagramas Mermaid gigantes que el browser muestra como
	// un lienzo horizontal casi vacío o puede fallar al renderizar.
	const largeGroup = buildRunMermaidSource(
		baseModel({
			agents: Array.from({ length: 20 }, (_, i) => ({
				id: i + 1,
				name: `worker-${i + 1}`,
				state: "completed",
				ok: true,
				phaseId: 1,
				phaseLabel: "Workers",
			})),
		}),
	);
	check(
		"grupo grande se resume en un nodo compacto",
		largeGroup.includes('phase1_summary(["20 agents · 20 completed"])'),
		largeGroup,
	);
	check("grupo grande no dibuja cada agente", !largeGroup.includes('A13(["worker-13"])'), largeGroup);
	check("el nodo resumen conserva clase de estado", largeGroup.includes("class phase1_summary completed"), largeGroup);

	// Agentes sin phaseId/phaseLabel explícitos pueden inferirse desde timestamps de phases estructuradas.
	const inferred = buildRunMermaidSource(
		baseModel({
			phases: [
				{ id: 1, label: "review", time: "2026-01-01T00:00:00.000Z", source: "event" },
				{ id: 2, label: "synthesize", time: "2026-01-01T00:00:10.000Z", source: "event" },
			],
			agents: [
				{ id: 1, name: "review-1", state: "completed", ok: true, startedAt: "2026-01-01T00:00:01.000Z" },
				{ id: 2, name: "review-2", state: "completed", ok: true, startedAt: "2026-01-01T00:00:02.000Z" },
				{ id: 3, name: "synthesize", state: "completed", ok: true, startedAt: "2026-01-01T00:00:11.000Z" },
			],
		}),
	);
	check("infiere grupo review por timestamp", inferred.includes('subgraph phase1["review"]'), inferred);
	check("infiere grupo synthesize por timestamp", inferred.includes('subgraph phase2["synthesize"]'), inferred);
	check("dibuja flecha entre fases inferidas", /phase1_out\s*-->\s*phase2_in/.test(inferred), inferred);
	check(
		"fase paralela usa fork/join",
		inferred.includes('phase1_in(("fork"))') && inferred.includes('phase1_out(("join"))'),
		inferred,
	);
	check(
		"agentes paralelos apuntan al join",
		/phase1_in\s*-->\s*A1[\s\S]*A1\s*-->\s*phase1_out/.test(inferred),
		inferred,
	);

	// Agentes sin fase ni timestamps: van a un grupo de fallback, no rompen.
	const noPhase = buildRunMermaidSource(baseModel({ agents: [{ id: 9, name: "solo", state: "running" }] }));
	check("agente sin fase cae en un grupo de fallback", noPhase.includes("solo"));
	check("agente sin fase no genera un subgraph vacío roto", noPhase.includes("subgraph"));

	// Labels con caracteres que rompen sintaxis Mermaid (comillas, corchetes) se sanean.
	const unsafe = buildRunMermaidSource(
		baseModel({
			agents: [{ id: 5, name: 'weird"name[x]', state: "completed", ok: true, phaseId: 1, phaseLabel: 'Phase "1"' }],
		}),
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
