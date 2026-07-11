#!/usr/bin/env node
/**
 * Test de contrato conductual para el bloque de detail compartido "Selected agent".
 *
 * El tab Monitor (renderMonitorAgents) y el tab Agents (renderAgents) renderizan una
 * sección de detail "Selected agent" para el agente enfocado. Esa sección antes era una
 * copia casi idéntica en cada método; ahora la produce un helper privado
 * (renderSelectedAgentDetail), parametrizado por las únicas diferencias intencionales:
 *
 *   - Agents antepone un header workflow/run/parallel; Monitor no.
 *   - Agents agrega un sufijo "• schema …" en la línea `state:`; Monitor no.
 *   - prompt preview / output usan compactInline width 260 (Agents) vs 220 (Monitor).
 *
 * Este test fija el contrato OBSERVABLE que antes no tenía cobertura: para un agente
 * equivalente, cada línea de detail SIN diferencias (agent/phase/prompt/tools/skills/
 * extensions/keys) es byte-identical entre ambos tabs, mientras se preservan las tres
 * diferencias intencionales. Protege contra divergencias silenciosas entre las dos copias
 * (p. ej. una edición futura que toque solo el formato de campos de un tab).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

const theme = { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v };
const WIDTH = 10000; // suficientemente ancho para que truncateToWidth no recorte; solo compactInline lo hace

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
		// Más largo que ambos widths de compactInline (220 y 260) para que la diferencia
		// de width sea observable en las líneas renderizadas de preview/output.
		promptPreview: "P".repeat(400),
		output: "O".repeat(400),
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

/** Líneas después del header "Selected agent", como mapa label→line para filas `label:`. */
function detailFields(lines) {
	const idx = lines.findIndex((l) => l.trim() === "Selected agent");
	if (idx < 0) return {};
	const fields = {};
	for (const raw of lines.slice(idx + 1)) {
		const m = raw.match(/^([a-z ]+): /);
		if (m) fields[m[1]] = raw;
	}
	return fields;
}

async function main() {
	const { url } = await buildDwfModule({
		name: "pi-dwf-selected-agent-detail",
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

	const monitorFields = detailFields(build("monitor").render(WIDTH));
	const agentsFields = detailFields(build("agents").render(WIDTH));

	// Ambos tabs renderizan algún detail de Selected agent.
	check(
		"Monitor renders agent detail line",
		typeof monitorFields.agent === "string",
		JSON.stringify(monitorFields.agent),
	);
	check(
		"Agents renders agent detail line",
		typeof agentsFields.agent === "string",
		JSON.stringify(agentsFields.agent),
	);

	// 1) Líneas compartidas, byte-identical entre ambos tabs (el objetivo central del helper).
	for (const label of ["agent", "phase", "prompt", "tools", "skills", "extensions", "keys"]) {
		check(
			`"${label}:" line is byte-identical across Monitor and Agents`,
			monitorFields[label] !== undefined && monitorFields[label] === agentsFields[label],
			`monitor=${JSON.stringify(monitorFields[label])} agents=${JSON.stringify(agentsFields[label])}`,
		);
	}

	// 2) Diferencia intencional A: Agents tiene header workflow/run/parallel; Monitor no.
	check(
		"Agents detail carries workflow/run/parallel header",
		!!agentsFields.workflow && !!agentsFields.run && !!agentsFields.parallel,
		`${agentsFields.workflow} | ${agentsFields.run} | ${agentsFields.parallel}`,
	);
	check(
		"Monitor detail omits the workflow/run/parallel header",
		!monitorFields.workflow && !monitorFields.run && !monitorFields.parallel,
		`${monitorFields.workflow} | ${monitorFields.run} | ${monitorFields.parallel}`,
	);

	// 3) Diferencia intencional B: solo Agents pone el sufijo schema en la línea state.
	check(
		"Agents state line includes the schema suffix",
		typeof agentsFields.state === "string" && agentsFields.state.includes("• schema ok"),
		JSON.stringify(agentsFields.state),
	);
	check(
		"Monitor state line omits the schema suffix",
		typeof monitorFields.state === "string" && !monitorFields.state.includes("schema"),
		JSON.stringify(monitorFields.state),
	);
	check(
		"state lines otherwise share their leading portion",
		typeof monitorFields.state === "string" &&
			typeof agentsFields.state === "string" &&
			agentsFields.state.startsWith(monitorFields.state),
		`monitor=${JSON.stringify(monitorFields.state)} agents=${JSON.stringify(agentsFields.state)}`,
	);

	// 4) Diferencia intencional C: compactInline width 220 (Monitor) vs 260 (Agents).
	for (const label of ["prompt preview", "output"]) {
		const m = monitorFields[label];
		const a = agentsFields[label];
		check(
			`"${label}:" present in both tabs`,
			typeof m === "string" && typeof a === "string",
			`monitor=${typeof m} agents=${typeof a}`,
		);
		check(
			`"${label}:" Agents (width 260) renders longer than Monitor (width 220)`,
			typeof m === "string" && typeof a === "string" && a.length > m.length,
			`monitorLen=${m?.length} agentsLen=${a?.length}`,
		);
	}

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
