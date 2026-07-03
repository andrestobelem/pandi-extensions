#!/usr/bin/env node
/**
 * Regression: every slash command is registered exactly ONCE.
 *
 * Farley review 2026-07-03, finding #6: /ultracode was registered twice — the
 * shared makeWorkflowRoutingHandler registration and, right below it, the older
 * inline block the refactor forgot to delete. The later registration overwrites
 * the earlier one, so one handler closure is permanently unreachable dead code
 * and the palette description silently comes from the survivor.
 *
 * Contract pinned here:
 *   - activate() registers each command name at most once (no silent overwrite).
 *   - /ultracode still works: with a task it sends ONE user message carrying the
 *     task; without a task it warns usage.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
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
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
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

	// --- no command name registered twice ---------------------------------------
	const byName = new Map();
	for (const r of registrations) byName.set(r.name, (byName.get(r.name) ?? 0) + 1);
	const dupes = [...byName.entries()].filter(([, n]) => n > 1);
	check("no duplicate command registrations", dupes.length === 0, JSON.stringify(dupes));
	check("ultracode registered exactly once", byName.get("ultracode") === 1, String(byName.get("ultracode")));

	// --- the surviving /ultracode still behaves ----------------------------------
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
		// (notify() routes to console in print mode, so only pin the observable
		// contract here: no user message is sent without a task.)
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
