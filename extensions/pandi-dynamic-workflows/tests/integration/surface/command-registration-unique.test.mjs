#!/usr/bin/env node
/**
 * Regresión: cada slash command se registra exactamente UNA VEZ.
 *
 * Review Farley 2026-07-03, hallazgo #6: /ultracode se registraba dos veces — el
 * registro compartido makeWorkflowRoutingHandler y, justo debajo, el bloque inline
 * viejo que el refactor olvidó borrar. El registro posterior sobrescribe el anterior,
 * así un closure handler queda permanentemente como dead code inalcanzable
 * y la descripción de palette viene silenciosamente del sobreviviente.
 *
 * Contrato pineado acá:
 *   - activate() registra cada nombre de comando como mucho una vez (sin overwrite silencioso).
 *   - /ultracode todavía funciona: con una task manda UN user message que lleva la
 *     task; sin task avisa usage.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, sdkStub } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

function makePi() {
	const registrations = [];
	const tools = new Map();
	const sent = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, def) => registrations.push({ name, def }),
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendUserMessage: (text, opts) => sent.push({ text, opts }),
		getThinkingLevel: () => undefined,
		getActiveTools: () => [...tools.keys()],
		getAllTools: () => [...tools.values()],
		setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, registrations, sent };
}

function makeCtx(cwd) {
	const notes = [];
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		_notes: notes,
		ui: {
			theme: { fg: (_c, v) => v },
			notify: (msg, type) => notes.push({ msg, type }),
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
	const { url } = await buildExtension({
		name: "pi-dwf-command-unique",
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-cmd-unique-"));
	const { pi, registrations, sent } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));

	// --- ningún nombre de comando registrado dos veces ---------------------------
	const byName = new Map();
	for (const r of registrations) byName.set(r.name, (byName.get(r.name) ?? 0) + 1);
	const dupes = [...byName.entries()].filter(([, n]) => n > 1);
	check("no duplicate command registrations", dupes.length === 0, JSON.stringify(dupes));
	check("ultracode registered exactly once", byName.get("ultracode") === 1, String(byName.get("ultracode")));

	// --- el /ultracode sobreviviente todavía se comporta -------------------------
	const ultra = registrations.filter((r) => r.name === "ultracode").at(-1)?.def;
	check("ultracode handler present", typeof ultra?.handler === "function");
	if (typeof ultra?.handler === "function") {
		const ctx = makeCtx(project);
		await ultra.handler("audit the repo", ctx);
		check(
			"with a task: sends one user message",
			sent.length === 1,
			JSON.stringify(sent.map((s) => s.text?.slice(0, 40))),
		);
		check("the message carries the task", sent[0]?.text?.includes("audit the repo"), sent[0]?.text?.slice(0, 120));
		const before = sent.length;
		// (notify() routea a console en modo print, así que acá solo pineamos el contrato
		// observable: no se manda user message sin una task.)
		await ultra.handler("", makeCtx(project));
		check("without a task: sends nothing", sent.length === before, String(sent.length - before));
	}

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
