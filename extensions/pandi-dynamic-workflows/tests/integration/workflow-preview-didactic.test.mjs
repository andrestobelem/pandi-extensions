#!/usr/bin/env node
/**
 * workflow-preview-didactic — pins the didactic workflow artifact journey.
 *
 * The preview/report HTML should orient the reader before showing raw structure:
 * preview mode starts with a short explanation then the diagram; post-run mode
 * starts with results and visible failure callouts when any agent failed.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
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

const argsJson = JSON.stringify({ task: "revisar visualización", items: ["uno", "dos"] });

function indexOfNeedle(html, needle) {
	const i = html.indexOf(needle);
	return i < 0 ? Number.POSITIVE_INFINITY : i;
}

async function writeFailedRunFixture() {
	const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-preview-didactic-run-"));
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify({
			runId: "2026-01-01T00-00-00-000Z-didactic-preview-aaaa1111",
			state: "completed",
			active: false,
			agentCount: 2,
			elapsedMs: 4200,
		}),
	);
	const events = [
		{ type: "agent", id: 1, name: "worker-ok", state: "completed", ok: true, output: "ok" },
		{ type: "agent", id: 2, name: "worker-fail", state: "completed", ok: false, output: "failed" },
	]
		.map((event) => JSON.stringify(event))
		.join("\n");
	await fs.writeFile(path.join(runDir, "events.jsonl"), `${events}\n`);
	await fs.writeFile(path.join(runDir, "result.json"), JSON.stringify({ output: { decision: "revisar fallas" } }));
	await fs.writeFile(path.join(runDir, "summary.md"), "# Síntesis\n\nRevisar la tarjeta fallida primero.\n");
	return runDir;
}

async function writeNoResultsRunFixture() {
	const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-preview-no-results-run-"));
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify({
			runId: "2026-01-01T00-00-00-000Z-no-results-preview-cccc3333",
			state: "completed",
			active: false,
			agentCount: 1,
			elapsedMs: 1000,
		}),
	);
	await fs.writeFile(
		path.join(runDir, "events.jsonl"),
		`${JSON.stringify({ type: "agent", id: 1, name: "worker-only", state: "completed", ok: true, output: "ok" })}\n`,
	);
	return runDir;
}

async function writeContractRunFixture() {
	const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-preview-contract-run-"));
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify({
			runId: "2026-01-01T00-00-00-000Z-contract-preview-bbbb2222",
			state: "completed",
			active: false,
			agentCount: 0,
			elapsedMs: 1000,
		}),
	);
	await fs.writeFile(
		path.join(runDir, "result.json"),
		JSON.stringify({
			output: {
				improvedTask: "Traducir el artefacto de workflow",
				successCriteria: ["El preview orienta en español"],
				assumptions: ["Los tokens de API quedan sin traducir"],
				nonGoals: ["Traducir nombres de campos JSON"],
				constraints: ["Mantener pandi-artifact-style"],
				routingHints: {
					shape: "single",
					pattern: "inline",
					maxAgents: 0,
					concurrency: 1,
					rationale: "Cambio chico",
				},
				verificationPlan: "Correr el test de preview.",
				blockers: [],
			},
		}),
	);
	return runDir;
}

const pre = await buildArtifact({ scriptPath: SCAFFOLD, argsJson });
const preHtml = pre.html;

check("preview has a didactic opening", /class="opening"[^>]*>[^<]*Vista estática antes de ejecutar/i.test(preHtml));
check(
	"preview opening appears before tabs",
	indexOfNeedle(preHtml, 'class="opening"') < indexOfNeedle(preHtml, '<nav class="tabs"'),
);
check("preview uses Spanish static-preview kicker", preHtml.includes("Workflow dinámico · preview estático"));
check(
	"preview no longer uses the old fixed English kicker",
	!preHtml.includes("Dynamic workflow · review before launch"),
);
check(
	"preview keeps Diagram first and active",
	/<button data-t="overview" class="active">Diagrama<\/button>/.test(preHtml),
);
check("preview labels agents in Spanish", preHtml.includes("Agentes y prompts"));
check("preview labels based-on in Spanish", preHtml.includes("Basado en"));
check("preview labels full script in Spanish", preHtml.includes("Script completo"));
check("client labels node-count chip in Spanish", preHtml.includes("tipos de nodo"));
check("client copy action is Spanish", preHtml.includes(">copiar</button>"));
check("client labels provenance helper in Spanish", preHtml.includes("Scaffolds base de este workflow"));
check("client labels empty results in Spanish", preHtml.includes("El run no produjo artefactos."));
check("client no longer emits English node-count chip", !preHtml.includes("node types"));
check("client no longer emits English copy action", !preHtml.includes(">copy</button>"));
check("client no longer emits English provenance label", !preHtml.includes("<b>Based on</b>"));
check(
	"client no longer emits English generated-from label",
	!preHtml.includes('<div class="subh">Generated from</div>'),
);
check("client no longer emits English return-value label", !preHtml.includes('<span class="nid">return value</span>'));
check("client no longer emits English empty-results label", !preHtml.includes("Run produced no artifacts."));
check("diagram labels args input in Spanish", preHtml.includes("entrada args"));
check("diagram labels empty phases in Spanish", preHtml.includes("sin agentes · solo bash o no alcanzado"));
check("diagram no longer emits English args input", !preHtml.includes("args input"));
check("diagram render is deferred until the visible tab", preHtml.includes("function renderMermaidOnce()"));
check(
	"diagram clears Mermaid autostart state before rendering",
	preHtml.includes('mmEl.removeAttribute("data-processed")'),
);
check("diagram renders when the overview tab opens", preHtml.includes('b.dataset.t==="overview"'));
check("results include a first-read guide", preHtml.includes("Qué mirar primero"));
check("results prefer summary.md when available", preHtml.includes('a.name==="summary.md"'));

const runDir = await writeFailedRunFixture();
try {
	const post = await buildArtifact({ scriptPath: SCAFFOLD, argsJson, runDir });
	const postHtml = post.html;

	check("post-run has a run-report kicker", postHtml.includes("Workflow dinámico · reporte de run"));
	check("post-run opening mentions the failed agent", /1 de 2 agentes fall[oó]/i.test(postHtml));
	check(
		"post-run surfaces failures as an error callout",
		/<div class="callout error">[\s\S]*agente fall[oó]/i.test(postHtml),
	);
	check(
		"post-run puts Results before Diagram",
		indexOfNeedle(postHtml, 'data-t="results"') < indexOfNeedle(postHtml, 'data-t="overview"'),
	);
	check(
		"post-run makes Results the active tab",
		/<button data-t="results" id="tabresults" class="active">Resultados<\/button>/.test(postHtml),
	);
	check("post-run makes the results section active", /<section data-s="results" class="active">/.test(postHtml));
	check(
		"post-run puts Agents before Diagram",
		indexOfNeedle(postHtml, 'data-t="agents"') < indexOfNeedle(postHtml, 'data-t="overview"'),
	);
	check(
		"post-run keeps Diagram available after Agents",
		postHtml.includes('<button data-t="overview">Diagrama</button>'),
	);
} finally {
	await fs.rm(runDir, { recursive: true, force: true });
}

const noResultsRunDir = await writeNoResultsRunFixture();
try {
	const noResults = await buildArtifact({ scriptPath: SCAFFOLD, argsJson, runDir: noResultsRunDir });
	const noResultsHtml = noResults.html;

	check("run without results explains the missing output", noResultsHtml.includes("sin output final"));
	check(
		"run without results starts from Agents",
		/<button data-t="agents" class="active">Agentes y prompts<\/button>/.test(noResultsHtml),
	);
	check(
		"run without results puts Agents before Diagram",
		indexOfNeedle(noResultsHtml, 'data-t="agents"') < indexOfNeedle(noResultsHtml, 'data-t="overview"'),
	);
} finally {
	await fs.rm(noResultsRunDir, { recursive: true, force: true });
}

const contractRunDir = await writeContractRunFixture();
try {
	const contract = await buildArtifact({ scriptPath: SCAFFOLD, argsJson, runDir: contractRunDir });
	const contractHtml = contract.html;

	check("contract tab label is Spanish", contractHtml.includes('data-t="contract">Contrato</button>'));
	check("contract section heading is Spanish", contractHtml.includes("Contrato — contrato de tarea del gate"));
	check("contract renderer labels success criteria in Spanish", contractHtml.includes("Criterios de éxito"));
	check("contract renderer labels verification plan in Spanish", contractHtml.includes("Plan de verificación"));
	check("contract renderer labels no blockers in Spanish", contractHtml.includes("ninguno — se puede avanzar"));
	check("contract renderer no longer emits English success heading", !contractHtml.includes("## Success criteria"));
	check(
		"contract renderer no longer emits English verification heading",
		!contractHtml.includes("## Verification plan"),
	);
	check("contract renderer no longer emits English blockers heading", !contractHtml.includes("## Blockers"));
} finally {
	await fs.rm(contractRunDir, { recursive: true, force: true });
}

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
