#!/usr/bin/env node
/**
 * Test de integración conductual estable para extensions/pandi-clear/index.ts.
 *
 * Fija el contrato público de /clear (un alias estilo Claude para el /new nativo de pi):
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
		check("/clear command registered", !!cmd);
		check("/clear has a description", typeof cmd?.description === "string" && cmd.description.length > 0);

		const ctx = makeCtx();
		await cmd.handler("", ctx);
		check("/clear calls ctx.newSession() once", ctx._calls.newSession === 1, String(ctx._calls.newSession));
		check(
			"/clear is STRICTLY silent on success (no notifications at all)",
			ctx._notes.length === 0,
			JSON.stringify(ctx._notes),
		);

		// Cancelada (p. ej. una extensión vetó la sesión nueva): no rompe, no deja nota de error.
		const ctxCancel = makeCtx({ cancelled: true });
		let threwCancel = false;
		try {
			await cmd.handler("", ctxCancel);
		} catch {
			threwCancel = true;
		}
		check("/clear does not crash when the new session is cancelled", !threwCancel);
		check(
			"/clear does not error-notify on a cancelled new session",
			!ctxCancel._notes.some((n) => n.type === "error"),
			JSON.stringify(ctxCancel._notes),
		);

		// newSession lanza: se informa como error y nunca se propaga.
		const ctxThrow = makeCtx({ throwOnNew: true });
		let threw = false;
		try {
			await cmd.handler("", ctxThrow);
		} catch {
			threw = true;
		}
		check("/clear does not crash when newSession throws", !threw);
		check(
			"/clear reports a newSession failure as an error",
			ctxThrow._notes.some((n) => n.type === "error" && /clear/i.test(n.msg)),
			JSON.stringify(ctxThrow._notes),
		);

		// Un valor lanzado que no es Error ejercita la rama String(error) del formateo del mensaje.
		const ctxThrowRaw = makeCtx({ throwOnNew: true, throwValue: "nope-not-an-error" });
		await cmd.handler("", ctxThrowRaw);
		check(
			"/clear stringifies a non-Error throw into the error note",
			ctxThrowRaw._notes.some((n) => n.type === "error" && /nope-not-an-error/.test(n.msg)),
			JSON.stringify(ctxThrowRaw._notes),
		);

		// Modo `print` (mode="print", hasUI=false): las fallas van a STDERR — nunca a stdout,
		// nunca a ui.notify. Esto fija la rama `print` de notify().
		const ctxPrintFail = makeCtx({ throwOnNew: true, mode: "print" });
		const failStreams = await withCapturedConsole(() => cmd.handler("", ctxPrintFail));
		check(
			"print mode: failure reported on stderr",
			failStreams.err.some((l) => /clear falló/.test(l) && /boom/.test(l)),
			JSON.stringify(failStreams),
		);
		check(
			"print mode: nothing on stdout for a failure",
			failStreams.out.length === 0,
			JSON.stringify(failStreams.out),
		);
		check("print mode: ui.notify never used", ctxPrintFail._notes.length === 0, JSON.stringify(ctxPrintFail._notes));

		// Modo headless no-print (p. ej. json/rpc sin UI): una falla también debe salir por stderr.
		const ctxJsonFail = makeCtx({ throwOnNew: true, mode: "json" });
		ctxJsonFail.hasUI = false;
		const jsonFailStreams = await withCapturedConsole(() => cmd.handler("", ctxJsonFail));
		check(
			"json headless: failure reported on stderr",
			jsonFailStreams.err.some((l) => /clear falló/.test(l) && /boom/.test(l)),
			JSON.stringify(jsonFailStreams),
		);
		check("json headless: ui.notify never used", ctxJsonFail._notes.length === 0, JSON.stringify(ctxJsonFail._notes));

		// Éxito en modo `print`: estrictamente silencioso en ambos canales.
		const ctxPrintOk = makeCtx({ mode: "print" });
		const okStreams = await withCapturedConsole(() => cmd.handler("", ctxPrintOk));
		check(
			"print mode: success is silent on stdout and stderr",
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
