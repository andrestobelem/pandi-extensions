#!/usr/bin/env node
/**
 * Regresión: race() debe exponer los errores de ramas en vez de tragárselos.
 *
 * Review Farley 2026-07-03, hallazgo #5: el handler de rejection de race() descartaba
 * el error por completo, así que un bug genuino de thunk (un typo, una excepción lanzada)
 * era indistinguible de "todas las ramas declinaron" — ambos devolvían
 * {winner:null,index:-1,status:'empty'}. Un agujero negro de observabilidad para autores
 * de workflows que debuggean por qué su race no encontró nada.
 *
 * Contrato fijado acá (worker-source.ts race()):
 *   - la semántica status/winner/index no cambia ('won' sigue ganando, all-decline
 *     sigue siendo 'empty').
 *   - El resultado además lleva errors: [{index, error}] para ramas rechazadas,
 *     así una race all-rejected es debuggeable.
 *   - Un all-decline limpio (nulls, sin throws) no reporta errores.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

const WORKFLOW = [
	"export const meta = { name: 'race-errors', description: 'race error surfacing probe' };",
	"const bugged = await race([async () => { throw new Error('real bug in thunk'); }, async () => null]);",
	"const clean = await race([async () => null, async () => null]);",
	"const won = await race([async () => 'yes']);",
	"return { bugged, clean, won };",
].join("\n");

function makePi() {
	const tools = new Map();
	return {
		pi: {
			registerTool: (def) => tools.set(def.name, def),
			registerCommand: () => {},
			registerShortcut: () => {},
			on: () => {},
			appendEntry: () => {},
			sendUserMessage: () => {},
			getThinkingLevel: () => undefined,
			getActiveTools: () => [],
			getAllTools: () => [...tools.values()],
			setActiveTools: () => {},
			exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
		},
		tools,
	};
}

function makeCtx(cwd) {
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, v) => v },
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, i = "") => i,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function main() {
	const { url } = await sharedBuildExtension({
		name: "pi-dw-race-errors",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	const mod = await import(url);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-errors-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "race-errors.js"), `${WORKFLOW}\n`, "utf8");
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");

	const res = await tool.execute(
		"tc-race-errors",
		{ action: "run", name: "race-errors", timeoutMs: 30_000 },
		new AbortController().signal,
		undefined,
		makeCtx(project),
	);
	const out = res?.details?.result?.output;
	check("workflow ran", out != null && typeof out === "object", JSON.stringify(res?.details?.result?.error ?? out));

	// Semántica existente preservada.
	check(
		"won: status won, winner surfaced",
		out?.won?.status === "won" && out?.won?.winner === "yes",
		JSON.stringify(out?.won),
	);
	check("bugged: still status empty", out?.bugged?.status === "empty", JSON.stringify(out?.bugged));
	check("clean: still status empty", out?.clean?.status === "empty", JSON.stringify(out?.clean));

	// El fix: las ramas rechazadas son debuggeables.
	check(
		"bugged: rejection surfaced in errors[]",
		Array.isArray(out?.bugged?.errors) &&
			out.bugged.errors.length === 1 &&
			out.bugged.errors[0].index === 0 &&
			String(out.bugged.errors[0].error).includes("real bug in thunk"),
		JSON.stringify(out?.bugged),
	);
	check(
		"clean: no errors reported for plain declines",
		!out?.clean?.errors || out.clean.errors.length === 0,
		JSON.stringify(out?.clean),
	);

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
