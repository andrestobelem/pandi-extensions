#!/usr/bin/env node
/**
 * Regresión de theme-awareness para los meters de Monitor (dark / light / auto).
 *
 * El dashboard nunca elige colores ANSI/hex raw por su cuenta: pinta a través de los tokens
 * semánticos del theme activo (`theme.fg("accent"|"success"|"muted", …)`), y pi los resuelve
 * por background activo, incluido `auto`, que alterna dark↔light en render time.
 * Así los meters se adaptan automáticamente MIENTRAS sus glyphs fluyan por theme.fg y
 * nunca estén hardcodeados.
 *
 * Esto pinea exactamente eso, para que una edición futura no regrese light/auto inlineando un color:
 *   - El run filled (█) del meter de progreso de agentes está envuelto por el token `success`.
 *   - El run filled (█) del meter de utilización paralela está envuelto por el token `accent`.
 *   - El run empty (░) de ambos está envuelto por el token `muted`.
 *   - Ningún glyph de meter (█/░) se emite jamás FUERA de un wrapper de token de theme.
 *
 * Lo asertamos con un theme token-tagging que bracketiza cada llamada fg(), y lo corremos para un
 * namespace de tags "dark" y "light" para probar que se usa el MISMO code path en ambos casos.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const WIDTH = 10000;

// Theme cuyo fg() bracketiza su output con el nombre del token, para que el test vea qué
// token semántico pintó cada glyph. `ns` namespacea los tags para probar que los renders dark y
// light toman la ruta idéntica basada en tokens.
function taggingTheme(ns) {
	return { fg: (token, v) => `⟦${ns}:${token}⟧${v}⟦/${ns}:${token}⟧`, bg: (_t, v) => v, bold: (v) => v };
}

function makeAgent() {
	return { id: 1, name: "scout", state: "running", elapsedMs: 4200, promptAvailable: true };
}

function makeRun() {
	const now = Date.now();
	return {
		workflow: "flow-a",
		scope: "project",
		file: "/nonexistent/x.js",
		runId: "run-aaaaaaaaaaaa",
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
		bashDone: 0,
		artifactCount: 1,
		agents: [agent],
		runDir: run.runDir,
		priority: "active",
		canCancel: true,
		canRerun: false,
	};
}

let WorkflowDashboard;

function renderWith(ns) {
	const run = makeRun();
	const agent = makeAgent();
	const d = new WorkflowDashboard(
		[],
		[run],
		[],
		[],
		[makeMonitorModel(run, agent)],
		[{ run, agent }],
		taggingTheme(ns),
		() => {},
		() => {},
		"monitor",
	);
	return d.render(WIDTH);
}

// True si y solo si cada glyph de meter (█ / ░) en el string queda DENTRO de un wrapper ⟦ns:token⟧…⟦/ns:token⟧.
function everyMeterGlyphIsTokenWrapped(s, ns) {
	// Quitá todos los spans envueltos por tokens, luego asertá que no quede ningún glyph de meter pelado.
	const stripped = s.replace(new RegExp(`⟦${ns}:[a-z]+⟧[\\s\\S]*?⟦/${ns}:[a-z]+⟧`, "g"), "");
	return !/[█░]/.test(stripped);
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-monitor-meters-theme",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "workflow-dashboard.ts"),
		outName: "workflow-dashboard.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
	});
	({ WorkflowDashboard } = await loadModule(url));

	for (const ns of ["dark", "light"]) {
		const lines = renderWith(ns);
		const agentsLine = lines.find((l) => l.includes("done/started"));
		// El label de detail `parallel:` es la línea con el running count y el sufijo peak
		// (la FILA de agente también dice "running" pero nunca lleva "peak:"). El prefijo del label
		// en sí está token-wrapped, así que no podemos matchear un "parallel:" inicial.
		const parallelLine = lines.find((l) => l.includes("running") && l.includes("peak:3"));

		check(`[${ns}] agents line exists`, typeof agentsLine === "string", JSON.stringify(agentsLine));
		check(`[${ns}] parallel line exists`, typeof parallelLine === "string", JSON.stringify(parallelLine));

		// Glyphs filled pintados por el token semántico esperado (success para progreso, accent para util).
		check(
			`[${ns}] agents filled glyphs use the success token`,
			new RegExp(`⟦${ns}:success⟧█+⟦/${ns}:success⟧`).test(agentsLine ?? ""),
			JSON.stringify(agentsLine),
		);
		check(
			`[${ns}] parallel filled glyphs use the accent token`,
			new RegExp(`⟦${ns}:accent⟧█+⟦/${ns}:accent⟧`).test(parallelLine ?? ""),
			JSON.stringify(parallelLine),
		);
		// Glyphs empty pintados por el token muted en ambos meters.
		check(
			`[${ns}] agents empty glyphs use the muted token`,
			new RegExp(`⟦${ns}:muted⟧░+⟦/${ns}:muted⟧`).test(agentsLine ?? ""),
			JSON.stringify(agentsLine),
		);
		check(
			`[${ns}] parallel empty glyphs use the muted token`,
			new RegExp(`⟦${ns}:muted⟧░+⟦/${ns}:muted⟧`).test(parallelLine ?? ""),
			JSON.stringify(parallelLine),
		);

		// Garantía hard: NINGÚN glyph de meter se emite fuera de un wrapper de token de theme,
		// así no hay color hardcodeado que pueda romper light/auto.
		check(
			`[${ns}] no meter glyph is emitted outside a theme token`,
			everyMeterGlyphIsTokenWrapped(agentsLine ?? "", ns) && everyMeterGlyphIsTokenWrapped(parallelLine ?? "", ns),
			`agents=${JSON.stringify(agentsLine)} parallel=${JSON.stringify(parallelLine)}`,
		);
	}

	// Los dos namespaces son estructuralmente idénticos salvo por el tag ns → mismo code path,
	// probando que dark/light/auto renderizan todos por los mismos meters basados en tokens.
	const darkShape = renderWith("dark")
		.find((l) => l.includes("done/started"))
		?.replace(/dark:/g, "X:");
	const lightShape = renderWith("light")
		.find((l) => l.includes("done/started"))
		?.replace(/light:/g, "X:");
	check("dark and light agents lines are structurally identical", darkShape === lightShape, `${darkShape}`);

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
