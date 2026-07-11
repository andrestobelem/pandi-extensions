#!/usr/bin/env node
/**
 * workflow-preview-didactic — pins the didactic workflow artifact journey.
 *
 * The preview/report HTML should orient the reader before showing raw structure:
 * preview and post-run mode start with the Monitor; raw evidence tabs stay
 * reachable for audit and debugging.
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

const argsJson = JSON.stringify({ task: "revisar visualización", items: ["uno", "dos"] });

function indexOfNeedle(html, needle) {
	const i = html.indexOf(needle);
	return i < 0 ? Number.POSITIVE_INFINITY : i;
}

function sectionHtml(html, id) {
	const start = html.indexOf(`<section data-s="${id}"`);
	if (start < 0) return "";
	const end = html.indexOf("</section>", start);
	return end < 0 ? html.slice(start) : html.slice(start, end);
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
				improvedTask: "Traducir el artifact de workflow",
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
const preMonitorHtml = sectionHtml(preHtml, "monitor");
const prePlanHtml = sectionHtml(preHtml, "plan");

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
	"preview keeps Monitor first and active",
	/<button data-t="monitor" class="active">Monitor<\/button>/.test(preHtml),
);
check(
	"preview puts Monitor before Plan",
	indexOfNeedle(preHtml, 'data-t="monitor"') < indexOfNeedle(preHtml, 'data-t="plan"'),
);
check(
	"preview puts Plan before Diagram",
	indexOfNeedle(preHtml, 'data-t="plan"') < indexOfNeedle(preHtml, 'data-t="overview"'),
);
check("preview renders an explicit Monitor section", /<section data-s="monitor" class="active">/.test(preHtml));
check("monitor labels the workflow status in Spanish", preMonitorHtml.includes("Estado del workflow"));
check("monitor labels progress in Spanish", preMonitorHtml.includes("Progreso"));
check("monitor labels activity in Spanish", preMonitorHtml.includes("Actividad"));
check("monitor labels agents in Spanish", preMonitorHtml.includes("Agentes"));
check(
	"monitor derives phase content from the workflow",
	preMonitorHtml.includes("Scout") && preMonitorHtml.includes("Review"),
);
check("preview renders an explicit Plan section", /<section data-s="plan">/.test(preHtml));
check("plan labels the workflow summary in Spanish", prePlanHtml.includes("Qué va a ejecutar"));
check("plan labels phases in Spanish", prePlanHtml.includes("Fases"));
check("plan labels agents in Spanish", prePlanHtml.includes("Agentes y contratos"));
check("plan derives phase content from the workflow", prePlanHtml.includes("Scout") && prePlanHtml.includes("Review"));
check("preview labels agents in Spanish", preHtml.includes("Agentes y prompts"));
check("preview labels schemas tab", preHtml.includes('<button data-t="schemas">Schemas</button>'));
check("preview labels based-on in Spanish", preHtml.includes("Basado en"));
check("preview labels full script in Spanish", preHtml.includes("Script completo"));
check(
	"preview keeps empty Results available for raw evidence",
	preHtml.includes('<button data-t="results" id="tabresults">Resultados</button>'),
);
check(
	"client keeps empty Results visible instead of hiding the tab",
	!preHtml.includes('rt.style.display="none"') && !preHtml.includes('rsec.style.display="none"'),
);
check("client sanitizes artifact markdown before innerHTML", preHtml.includes("sanitizeRenderedHtml"));
check("client labels node-count chip in Spanish", preHtml.includes("tipos de nodo"));
check("client copy action is Spanish", preHtml.includes(">copiar</button>"));
check("client labels provenance helper in Spanish", preHtml.includes("Scaffolds base de este workflow"));
check("client labels empty results in Spanish", preHtml.includes("El run no produjo artifacts."));
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
		"post-run keeps Monitor before Results",
		indexOfNeedle(postHtml, 'data-t="monitor"') < indexOfNeedle(postHtml, 'data-t="results"'),
	);
	check(
		"post-run puts Results before Plan",
		indexOfNeedle(postHtml, 'data-t="results"') < indexOfNeedle(postHtml, 'data-t="plan"'),
	);
	check(
		"post-run keeps Plan before Diagram",
		indexOfNeedle(postHtml, 'data-t="plan"') < indexOfNeedle(postHtml, 'data-t="overview"'),
	);
	check(
		"post-run makes Monitor the active tab",
		/<button data-t="monitor" class="active">Monitor<\/button>/.test(postHtml),
	);
	check("post-run makes the monitor section active", /<section data-s="monitor" class="active">/.test(postHtml));
	check(
		"post-run keeps Results available",
		/<button data-t="results" id="tabresults">Resultados<\/button>/.test(postHtml),
	);
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
		"run without results starts from Monitor",
		/<button data-t="monitor" class="active">Monitor<\/button>/.test(noResultsHtml),
	);
	check(
		"run without results keeps Monitor before Plan",
		indexOfNeedle(noResultsHtml, 'data-t="monitor"') < indexOfNeedle(noResultsHtml, 'data-t="plan"'),
	);
	check(
		"run without results keeps Plan before Diagram",
		indexOfNeedle(noResultsHtml, 'data-t="plan"') < indexOfNeedle(noResultsHtml, 'data-t="overview"'),
	);
	check(
		"run without results keeps Results available",
		noResultsHtml.includes('<button data-t="results" id="tabresults">Resultados</button>'),
	);
	check(
		"run without results keeps Schemas available",
		noResultsHtml.includes('<button data-t="schemas">Schemas</button>'),
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
	check(
		"contract renderer escapes raw HTML before marked",
		contractHtml.includes("escapeMarkdownHtml(contractMd(D.contract))"),
	);
	check(
		"contract renderer sanitizes marked output before innerHTML",
		contractHtml.includes("cEl.innerHTML=sanitizeRenderedHtml(html)"),
	);
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
