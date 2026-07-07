#!/usr/bin/env node
/**
 * Test de integración conductual estable para extensions/pandi-clear/index.ts.
 *
 * Fija el contrato público de /clear (un alias al estilo Claude para el /new nativo de pi):
 * - registra un comando slash llamado "clear" con una descripción no vacía
 * - el manejador inicia una sesión nueva vía ctx.newSession() exactamente una vez
 * - una sesión nueva cancelada (una extensión la vetó) no rompe ni notifica error
 * - si newSession lanza, se informa como error y nunca se propaga
 * - el éxito es estrictamente silencioso (sin notificaciones), en `tui` y en modo `print`
 * - modo `print` (mode="print", hasUI=false): una falla va a stderr, nunca a stdout,
 *   nunca a ui.notify; notá que la rama info→stdout de notify() es inalcanzable a través
 *   del contrato público de /clear (su único sitio de llamada a notify usa type "error")
 * - un valor lanzado que no es Error se convierte a string por la rama String(error) (issue #12)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function makePi() {
	const commands = new Map();
	const pi = { registerCommand: (name, opts) => commands.set(name, opts) };
	return { pi, commands };
}

function makeCtx({ throwOnNew = false, throwValue, cancelled = false, mode = "tui" } = {}) {
	const calls = { newSession: 0 };
	const notes = [];
	const ctx = {
		mode,
		hasUI: mode !== "print",
		ui: { notify: (msg, type) => notes.push({ msg, type }) },
		newSession: async () => {
			calls.newSession += 1;
			if (throwOnNew) throw throwValue !== undefined ? throwValue : new Error("boom");
			return { cancelled };
		},
	};
	ctx._calls = calls;
	ctx._notes = notes;
	return ctx;
}

/** Ejecuta `fn` con console.log/console.error capturados; devuelve { out, err }. */
async function withCapturedConsole(fn) {
	const out = [];
	const err = [];
	const savedLog = console.log;
	const savedError = console.error;
	console.log = (...a) => out.push(a.join(" "));
	console.error = (...a) => err.push(a.join(" "));
	try {
		await fn();
	} finally {
		console.log = savedLog;
		console.error = savedError;
	}
	return { out, err };
}

async function main() {
	const ext = await buildExtension({
		name: "pi-clear-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-clear", "index.ts"),
		outName: "clear.mjs",
	});
	try {
		const clearExtension = await loadDefault(ext.url);

		const h = makePi();
		clearExtension(h.pi);
		const cmd = h.commands.get("clear");
		check("/clear está registrado", !!cmd);
		check("/clear tiene una descripción", typeof cmd?.description === "string" && cmd.description.length > 0);

		const ctx = makeCtx();
		await cmd.handler("", ctx);
		check("/clear llama a ctx.newSession() una vez", ctx._calls.newSession === 1, String(ctx._calls.newSession));
		check(
			"/clear es estrictamente silencioso al tener éxito (sin notificaciones)",
			ctx._notes.length === 0,
			JSON.stringify(ctx._notes),
		);

		// Cancelada (por ejemplo, una extensión vetó la sesión nueva): no rompe ni deja una nota de error.
		const ctxCancel = makeCtx({ cancelled: true });
		let threwCancel = false;
		try {
			await cmd.handler("", ctxCancel);
		} catch {
			threwCancel = true;
		}
		check("/clear no se cae cuando se cancela la sesión nueva", !threwCancel);
		check(
			"/clear no notifica error cuando la sesión nueva se cancela",
			!ctxCancel._notes.some((n) => n.type === "error"),
			JSON.stringify(ctxCancel._notes),
		);

		// Si newSession lanza: se informa como error y nunca se propaga.
		const ctxThrow = makeCtx({ throwOnNew: true });
		let threw = false;
		try {
			await cmd.handler("", ctxThrow);
		} catch {
			threw = true;
		}
		check("/clear no se cae cuando newSession lanza", !threw);
		check(
			"/clear reporta la falla de newSession como error",
			ctxThrow._notes.some((n) => n.type === "error" && /clear/i.test(n.msg)),
			JSON.stringify(ctxThrow._notes),
		);

		// Un valor lanzado que no es Error ejercita la rama String(error) del formateo del mensaje.
		const ctxThrowRaw = makeCtx({ throwOnNew: true, throwValue: "nope-not-an-error" });
		await cmd.handler("", ctxThrowRaw);
		check(
			"/clear convierte un throw que no es Error en texto dentro de la nota de error",
			ctxThrowRaw._notes.some((n) => n.type === "error" && /nope-not-an-error/.test(n.msg)),
			JSON.stringify(ctxThrowRaw._notes),
		);

		// Modo `print` (mode="print", hasUI=false): las fallas van a STDERR — nunca a stdout,
		// nunca a ui.notify. Esto fija la rama `print` de notify().
		const ctxPrintFail = makeCtx({ throwOnNew: true, mode: "print" });
		const failStreams = await withCapturedConsole(() => cmd.handler("", ctxPrintFail));
		check(
			"modo print: la falla se informa por stderr",
			failStreams.err.some((l) => /clear falló/.test(l) && /boom/.test(l)),
			JSON.stringify(failStreams),
		);
		check(
			"modo print: no hay salida por stdout ante una falla",
			failStreams.out.length === 0,
			JSON.stringify(failStreams.out),
		);
		check(
			"modo print: nunca se usa ui.notify",
			ctxPrintFail._notes.length === 0,
			JSON.stringify(ctxPrintFail._notes),
		);

		// Modo headless no-print (por ejemplo, json/rpc sin UI): una falla también debe salir por stderr.
		const ctxJsonFail = makeCtx({ throwOnNew: true, mode: "json" });
		ctxJsonFail.hasUI = false;
		const jsonFailStreams = await withCapturedConsole(() => cmd.handler("", ctxJsonFail));
		check(
			"headless json: la falla se informa por stderr",
			jsonFailStreams.err.some((l) => /clear falló/.test(l) && /boom/.test(l)),
			JSON.stringify(jsonFailStreams),
		);
		check(
			"headless json: nunca se usa ui.notify",
			ctxJsonFail._notes.length === 0,
			JSON.stringify(ctxJsonFail._notes),
		);

		// Éxito en modo `print`: estrictamente silencioso en ambos canales.
		const ctxPrintOk = makeCtx({ mode: "print" });
		const okStreams = await withCapturedConsole(() => cmd.handler("", ctxPrintOk));
		check(
			"modo print: el éxito es silencioso en stdout y stderr",
			okStreams.out.length === 0 && okStreams.err.length === 0,
			JSON.stringify(okStreams),
		);
	} finally {
		await fs.rm(ext.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
