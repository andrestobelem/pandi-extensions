#!/usr/bin/env node
/**
 * Contrato de comportamiento del componente independiente del dashboard de sesiones Pandi.
 *
 * Es intencionalmente una UI de sesiones enfocada, no una pestaña dentro del
 * dashboard de workflows. El componente renderiza filas/detalles de sesión y emite
 * acciones semánticas; la orquestación se encarga del cambio y la limpieza.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

async function buildDashboard() {
	return await buildExtension({
		name: "pandi-session-dashboard",
		src: path.join(REPO_ROOT, "extensions", "pandi-session", "session-dashboard.ts"),
		outName: "session-dashboard.mjs",
	});
}

const theme = {
	fg: (_c, value) => value,
	bg: (_c, value) => value,
	bold: (value) => value,
};

function mkSession(id, overrides = {}) {
	const now = new Date().toISOString();
	return {
		id,
		pid: overrides.pid ?? 123,
		mode: overrides.mode ?? "tui",
		cwd: overrides.cwd ?? "/project",
		startedAt: overrides.startedAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
		file: overrides.file ?? `/project/.pi/pandi-session/live/${id}.json`,
		live: overrides.live ?? true,
		current: overrides.current ?? false,
		ageMs: overrides.ageMs ?? 50,
		sessionId: overrides.sessionId ?? `${id}-sid`,
		sessionFile: overrides.sessionFile ?? `/project/.pi/sessions/${id}.jsonl`,
		sessionName: overrides.sessionName ?? `Sesión ${id}`,
		trusted: overrides.trusted ?? true,
		idle: overrides.idle ?? true,
		...(overrides.staleReason ? { staleReason: overrides.staleReason } : {}),
	};
}

async function main() {
	const { outDir, url } = await buildDashboard();
	try {
		const { PandiSessionDashboard } = await import(url);
		let renders = 0;
		let captured = null;
		const component = new PandiSessionDashboard(
			[mkSession("current", { current: true }), mkSession("other", { live: false, staleReason: "PID finalizado" })],
			theme,
			() => {
				renders += 1;
			},
			(result) => {
				captured = result;
			},
		);

		const text = component.render(120).join("\n");
		check("el encabezado del dashboard nombra Sesiones Pandi", text.includes("Sesiones Pandi"), text);
		check("el dashboard renderiza los conteos live/stale", text.includes("live:1") && text.includes("stale:1"), text);
		check(
			"el dashboard renderiza el detalle de la sesión seleccionada",
			text.includes("Sesión Pandi seleccionada") && text.includes("current-sid"),
			text,
		);

		component.handleInput("down");
		check("la tecla down pide redibujar", renders > 0, String(renders));
		component.handleInput("enter");
		check(
			"Enter emite switchSession para la fila seleccionada",
			captured?.type === "switchSession" && captured.session?.id === "other",
			JSON.stringify(captured),
		);

		captured = null;
		component.setSessions([mkSession("fresh"), mkSession("other", { live: true })]);
		component.handleInput("enter");
		check(
			"setSessions preserva la fila seleccionada por session id",
			captured?.type === "switchSession" && captured.session?.id === "other",
			JSON.stringify(captured),
		);
		let ss3Captured = null;
		const ss3Down = new PandiSessionDashboard(
			[mkSession("current", { current: true }), mkSession("other", { live: false, staleReason: "PID finalizado" })],
			theme,
			() => {},
			(result) => {
				ss3Captured = result;
			},
		);
		ss3Down.handleInput("\x1bOB");
		ss3Down.handleInput("enter");
		check(
			"la secuencia de flecha abajo SS3 selecciona la fila siguiente",
			ss3Captured?.type === "switchSession" && ss3Captured.session?.id === "other",
			JSON.stringify(ss3Captured),
		);

		let ss3UpCaptured = null;
		const ss3Up = new PandiSessionDashboard(
			[mkSession("current", { current: true }), mkSession("other", { live: false, staleReason: "PID finalizado" })],
			theme,
			() => {},
			(result) => {
				ss3UpCaptured = result;
			},
		);
		ss3Up.handleInput("down");
		ss3Up.handleInput("\x1bOA");
		ss3Up.handleInput("enter");
		check(
			"la secuencia de flecha arriba SS3 selecciona la fila anterior",
			ss3UpCaptured?.type === "switchSession" && ss3UpCaptured.session?.id === "current",
			JSON.stringify(ss3UpCaptured),
		);

		let rightCaptured = null;
		const rightDashboard = new PandiSessionDashboard(
			[mkSession("current", { current: true }), mkSession("other", { live: false, staleReason: "PID finalizado" })],
			theme,
			() => {},
			(result) => {
				rightCaptured = result;
			},
		);
		rightDashboard.handleInput("down");
		rightDashboard.handleInput("\x1bOC");
		check(
			"la secuencia de flecha derecha SS3 no cambia de sesión",
			rightCaptured === null,
			JSON.stringify(rightCaptured),
		);
		rightDashboard.handleInput("right");
		check("la tecla right nombrada no cambia de sesión", rightCaptured === null, JSON.stringify(rightCaptured));
		rightDashboard.handleInput("enter");
		check(
			"Enter sigue cambiando a la fila seleccionada",
			rightCaptured?.type === "switchSession" && rightCaptured.session?.id === "other",
			JSON.stringify(rightCaptured),
		);

		component.markRefreshError("collector failed noisily");
		check(
			"los errores de actualización se ven en el dashboard",
			component.render(120).join("\n").includes("advertencia de actualización"),
		);
		component.markRefreshOk();
		check(
			"refresh ok limpia la advertencia del dashboard",
			!component.render(120).join("\n").includes("advertencia de actualización"),
		);

		captured = null;
		component.handleInput("C");
		check("C emite la acción cleanup", captured?.type === "cleanup", JSON.stringify(captured));

		captured = "not-null";
		component.handleInput("q");
		check("q cierra con null", captured === null, JSON.stringify(captured));
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	if (counts.failed) {
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
