#!/usr/bin/env node
/**
 * Contrato conductual para la pasada de layout visual del dashboard: más aire
 * (secciones agrupadas) y jerarquía de color theme-aware (tokens dim/border), sin
 * romper ningún formato fijado.
 *
 * Contrato observable fijado acá:
 *   1. El body de detail de Monitor está AGRUPADO: renderiza captions de sección
 *      independientes ("Progress" y "Location") en líneas propias, separando el bloque
 *      denso "label: value" en vez de apilar ~14 líneas sin cortes.
 *   2. El sufijo de chips por fila de agente se espacia con divisor " · " para legibilidad,
 *      y queda BYTE-IDENTICAL entre los tabs Monitor y Agents (un helper).
 *   3. La regla de header (─────) se pinta con el token de theme `border` (no muted),
 *      así sigue el theme activo (dark/light/auto).
 *   4. El detail terciario (path runDir) se pinta con el token de theme `dim`, dando
 *      jerarquía de 3 niveles (accent → muted label → dim path). Sin color hardcodeado.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();
const WIDTH = 10000;

const identityTheme = { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v };
function taggingTheme(ns) {
	return { fg: (token, v) => `⟦${ns}:${token}⟧${v}⟦/${ns}:${token}⟧`, bg: (_t, v) => v, bold: (v) => v };
}

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
		state: "running",
		startedAt: new Date(now - 60000).toISOString(),
		elapsedMs: 60000,
		agentCount: 8,
		agentConcurrency: 4,
		parallelAgents: 2,
		peakParallelAgents: 3,
		logs: [],
	};
}

function makeMonitorModel(run, agent) {
	return {
		run,
		workflow: run.workflow,
		runId: run.runId,
		state: "running",
		active: true,
		stale: false,
		elapsedMs: 60000,
		agentsStarted: 8,
		agentsDone: 3,
		parallelAgents: 2,
		peakParallelAgents: 3,
		agentConcurrency: 4,
		bashDone: 1,
		artifactCount: 5,
		agents: [agent],
		runDir: run.runDir,
		priority: "active",
		canCancel: true,
		canRerun: false,
		lastLog: { time: new Date().toISOString(), message: "scout running" },
	};
}

let WorkflowDashboard;
function build(initialTab, theme = identityTheme) {
	const run = makeRun();
	const agent = makeAgent();
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
}

const rowMeta = (lines) => {
	const row = lines.find((l) => l.includes("prompt✓"));
	return typeof row === "string" ? row.slice(row.indexOf("prompt✓")) : undefined;
};

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-visual-layout",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "workflow-dashboard.ts"),
		outName: "workflow-dashboard.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
	});
	({ WorkflowDashboard } = await loadModule(url));

	// 1) Secciones agrupadas en el body de Monitor.
	const monitor = build("monitor").render(WIDTH);
	check(
		"Monitor renders a 'Progress' section caption",
		monitor.some((l) => l.trim() === "Progress"),
		JSON.stringify(monitor.filter((l) => l.toLowerCase().includes("progress"))),
	);
	check(
		"Monitor renders a 'Location' section caption",
		monitor.some((l) => l.trim() === "Location"),
		JSON.stringify(monitor.filter((l) => l.toLowerCase().includes("location"))),
	);

	// 2) Sufijo de chips espaciado con " · " y byte-identical entre tabs.
	const monitorMeta = rowMeta(monitor);
	const agentsMeta = rowMeta(build("agents").render(WIDTH));
	check("chip suffix uses the ' · ' divider", monitorMeta?.includes(" · "), JSON.stringify(monitorMeta));
	check(
		"chip suffix is byte-identical across Monitor and Agents",
		monitorMeta !== undefined && monitorMeta === agentsMeta,
		`monitor=${JSON.stringify(monitorMeta)} agents=${JSON.stringify(agentsMeta)}`,
	);
	// Todos los chips siguen presentes después del re-spacing.
	check(
		"chip suffix still carries every chip",
		["prompt✓", "schema:ok", "tools:2", "skills:1", "ext:1", "keys:1", "missing:1"].every((c) =>
			monitorMeta?.includes(c),
		),
		JSON.stringify(monitorMeta),
	);

	// 3) La regla de header usa el token `border`.
	const tagged = build("monitor", taggingTheme("t")).render(WIDTH);
	check(
		"header rule is painted with the border token",
		tagged.some((l) => /⟦t:border⟧─+⟦\/t:border⟧/.test(l)),
		JSON.stringify(tagged.find((l) => l.includes("─"))),
	);

	// 4) El path runDir terciario usa el token `dim`.
	const runDirLine = tagged.find((l) => l.includes("runDir:") && l.includes("/tmp/nonexistent-run-dir"));
	check("runDir line exists", typeof runDirLine === "string", JSON.stringify(runDirLine));
	check(
		"runDir path is painted with the dim token",
		/⟦t:dim⟧[^⟦]*\/tmp\/nonexistent-run-dir/.test(runDirLine ?? ""),
		JSON.stringify(runDirLine),
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
