#!/usr/bin/env node
/**
 * Test de contrato conductual para el sufijo meta de agente compartido por fila.
 *
 * Cada fila de agente en la tab Monitor (renderMonitorAgents) y en la tab Agents
 * (renderAgents) termina con el mismo sufijo de chips:
 *
 *   prompt<✓|?> schema:… tools:… skills:… ext:… keys:… [missing:…]
 *
 * Ese sufijo antes se construía con expresiones muted/success/warning/error casi idénticas
 * en AMBOS métodos; ahora lo produce un helper privado
 * (renderAgentRowMeta). Las dos filas todavía difieren SOLO en el segmento entre el
 * nombre de agente y ese sufijo:
 *
 *   - Monitor inserta un chip `code:` después de `elapsed:` (sin segmento workflow/run).
 *   - Agents inserta un segmento `— <workflow> <runId>` antes de `elapsed:` (sin chip code).
 *
 * Este test pinea el contrato OBSERVABLE: para un agente equivalente, el sufijo meta
 * (prompt…keys) es byte-idéntico entre ambas tabs, mientras se preservan las dos
 * diferencias intencionales. Protege contra divergencia silenciosa entre las dos copias
 * (p. ej. una edición futura que toque solo el formato de chips de una tab).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

const theme = { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v };
const WIDTH = 10000; // suficientemente ancho para que truncateToWidth nunca recorte la fila

function makeAgent() {
	return {
		id: 1,
		name: "scout",
		state: "completed",
		elapsedMs: 4200,
		code: 0,
		schemaOk: true,
		promptAvailable: true,
		artifactPath: "agent-1/output.md",
		tools: ["read", "grep"],
		excludeTools: ["bash"],
		skills: ["karpathy"],
		includeSkills: true,
		extensions: ["pandi-loop"],
		includeExtensions: false,
		keys: ["OPENAI_API_KEY"],
		missingKeys: ["ANTHROPIC_API_KEY"],
		isolatedEnv: false,
		phaseLabel: "scout phase",
		phaseIndex: 1,
		phaseTotal: 3,
	};
}

function makeRun() {
	const now = Date.now();
	return {
		workflow: "demo-flow",
		scope: "project",
		file: "/nonexistent/demo-flow.js",
		runId: "run-1234567890abcd",
		runDir: "/tmp/nonexistent-run-dir",
		ok: true,
		state: "completed",
		startedAt: new Date(now - 60000).toISOString(),
		endedAt: new Date(now).toISOString(),
		elapsedMs: 60000,
		agentCount: 1,
		agentConcurrency: 2,
		parallelAgents: 1,
		peakParallelAgents: 1,
		logs: [],
	};
}

function makeMonitorModel(run, agent) {
	return {
		run,
		workflow: run.workflow,
		runId: run.runId,
		state: "completed",
		active: false,
		stale: false,
		elapsedMs: 60000,
		agentsStarted: 1,
		agentsDone: 1,
		parallelAgents: 1,
		peakParallelAgents: 1,
		agentConcurrency: 2,
		bashDone: 0,
		artifactCount: 1,
		agents: [agent],
		runDir: run.runDir,
		priority: "latest",
		canCancel: false,
		canRerun: false,
	};
}

/** La línea de FILA de agente es la única línea que lleva el chip de prompt (`prompt✓`). */
function agentRow(lines) {
	return lines.find((l) => l.includes("prompt✓"));
}

/** El sufijo meta compartido = desde el chip prompt hasta fin de línea. */
function rowMeta(row) {
	return typeof row === "string" ? row.slice(row.indexOf("prompt✓")) : undefined;
}

/** El prefijo específico de tab = todo ANTES del sufijo meta compartido. */
function rowPrefix(row) {
	return typeof row === "string" ? row.slice(0, row.indexOf("prompt✓")) : undefined;
}

async function main() {
	const { url } = await buildDwfModule({
		name: "pi-dwf-agent-row-meta",
		relPath: "tui/dashboard.ts",
		outName: "workflow-dashboard.mjs",
		stubs: { sdk: (dir) => dir && "" },
	});
	const { WorkflowDashboard } = await loadModule(url);
	check("WorkflowDashboard class is exported", typeof WorkflowDashboard === "function");

	const build = (initialTab) => {
		const agent = makeAgent();
		const run = makeRun();
		return new WorkflowDashboard(
			[],
			[run],
			[],
			[],
			[makeMonitorModel(run, agent)],
			[{ run, agent }],
			theme,
			() => {},
			() => {},
			initialTab,
		);
	};

	const monitorRow = agentRow(build("monitor").render(WIDTH));
	const agentsRow = agentRow(build("agents").render(WIDTH));

	// Ambas tabs renderizan al menos una fila de agente con chip de prompt.
	check("Monitor renders an agent row", typeof monitorRow === "string", JSON.stringify(monitorRow));
	check("Agents renders an agent row", typeof agentsRow === "string", JSON.stringify(agentsRow));

	const monitorMeta = rowMeta(monitorRow);
	const agentsMeta = rowMeta(agentsRow);

	// 1) El sufijo meta compartido (prompt…keys) es byte-idéntico entre ambas tabs.
	check(
		"per-row meta suffix (prompt…keys) is byte-identical across Monitor and Agents",
		monitorMeta !== undefined && monitorMeta === agentsMeta,
		`monitor=${JSON.stringify(monitorMeta)} agents=${JSON.stringify(agentsMeta)}`,
	);
	// Sanity: el sufijo realmente lleva cada chip que construye el helper.
	check(
		"meta suffix carries every chip",
		typeof monitorMeta === "string" &&
			["prompt✓", "schema:ok", "tools:2", "skills:1", "ext:1", "keys:1", "missing:1"].every((chip) =>
				monitorMeta.includes(chip),
			),
		JSON.stringify(monitorMeta),
	);

	const monitorPrefix = rowPrefix(monitorRow);
	const agentsPrefix = rowPrefix(agentsRow);

	// 2) Diferencia intencional A: solo Monitor lleva el chip `code:`.
	check(
		"Monitor row prefix includes the code chip",
		typeof monitorPrefix === "string" && monitorPrefix.includes("code:0"),
		JSON.stringify(monitorPrefix),
	);
	check(
		"Agents row prefix omits the code chip",
		typeof agentsPrefix === "string" && !agentsPrefix.includes("code:"),
		JSON.stringify(agentsPrefix),
	);

	// 3) Diferencia intencional B: solo Agents lleva el segmento `— <workflow> <runId>`.
	check(
		"Agents row prefix includes the — workflow runId segment",
		typeof agentsPrefix === "string" && agentsPrefix.includes(`— demo-flow ${"run-1234567890abcd".slice(-12)}`),
		JSON.stringify(agentsPrefix),
	);
	check(
		"Monitor row prefix omits the — workflow segment",
		typeof monitorPrefix === "string" && !monitorPrefix.includes("— demo-flow"),
		JSON.stringify(monitorPrefix),
	);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
