#!/usr/bin/env node
/**
 * Prueba de integración conductual estable para extensions/pandi-exit/index.ts.
 *
 * Fija el contrato público de /exit (un alias al estilo Claude para el /quit nativo de pi):
 * - registra un slash command llamado "exit" con una descripción no vacía
 * - el handler dispara un cierre limpio vía ctx.shutdown() exactamente una vez
 * - el handler ignora cualquier argumento y aun así cierra
 * - registra exactamente un comando (el README promete que /exit convive con el
 *   /quit nativo y nunca lo reemplaza) (issue #13)
 * - un ctx.shutdown() que lanza se informa como una nota de error y nunca se propaga,
 *   reflejando el ctx.newSession() protegido de pandi-clear (issue #13)
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

function makeCtx({ throwOnShutdown = false, mode = "tui", hasUI = mode !== "print" } = {}) {
	const calls = { shutdown: 0 };
	const notes = [];
	const ctx = {
		mode,
		hasUI,
		ui: { notify: (msg, type) => notes.push({ msg, type }) },
		shutdown: () => {
			calls.shutdown += 1;
			if (throwOnShutdown) throw new Error("shutdown-refused");
		},
	};
	ctx._calls = calls;
	ctx._notes = notes;
	return ctx;
}

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
		name: "pi-exit-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-exit", "index.ts"),
		outName: "exit.mjs",
	});
	try {
		const exitExtension = await loadDefault(ext.url);

		const h = makePi();
		exitExtension(h.pi);
		const cmd = h.commands.get("exit");
		check("/exit registrado", !!cmd);
		check(
			"/exit registra EXACTAMENTE un comando (nunca reemplaza /quit)",
			h.commands.size === 1,
			JSON.stringify([...h.commands.keys()]),
		);
		check("/exit tiene una descripción", typeof cmd?.description === "string" && cmd.description.length > 0);

		const ctx = makeCtx();
		await cmd.handler("", ctx);
		check("/exit llama a ctx.shutdown() una vez", ctx._calls.shutdown === 1, String(ctx._calls.shutdown));

		const ctx2 = makeCtx();
		await cmd.handler("  some ignored args  ", ctx2);
		check("/exit ignora args y aun así cierra una vez", ctx2._calls.shutdown === 1, String(ctx2._calls.shutdown));

		// Un `shutdown` que lanza (el `shutdownHandler` provisto por el modo puede lanzar)
		// se informa como nota de error y nunca se propaga: mismo contrato que el
		// `ctx.newSession()` protegido de `pandi-clear`.
		const ctxThrow = makeCtx({ throwOnShutdown: true });
		let threw = false;
		try {
			await cmd.handler("", ctxThrow);
		} catch {
			threw = true;
		}
		check("/exit no se rompe cuando shutdown lanza", !threw);
		check(
			"/exit informa un fallo de shutdown como nota de error",
			ctxThrow._notes.some(
				(n) => n.type === "error" && /no se pudo salir/.test(n.msg) && /shutdown-refused/.test(n.msg),
			),
			JSON.stringify(ctxThrow._notes),
		);

		// En headless sin print (p. ej. json/rpc sin UI), una falla debe quedar observable en stderr.
		const ctxJsonThrow = makeCtx({ throwOnShutdown: true, mode: "json", hasUI: false });
		const jsonStreams = await withCapturedConsole(() => cmd.handler("", ctxJsonThrow));
		check(
			"json headless: fallo de shutdown informado en stderr",
			jsonStreams.err.some((l) => /no se pudo salir/.test(l) && /shutdown-refused/.test(l)),
			JSON.stringify(jsonStreams),
		);
		check(
			"json headless: ui.notify no se usa nunca",
			ctxJsonThrow._notes.length === 0,
			JSON.stringify(ctxJsonThrow._notes),
		);

		// En éxito no se emite nada.
		check("/exit es silencioso al tener éxito", ctx._notes.length === 0 && ctx2._notes.length === 0);
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
