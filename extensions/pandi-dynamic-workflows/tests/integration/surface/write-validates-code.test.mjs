#!/usr/bin/env node
/**
 * Regression: action=write validates the workflow code BEFORE persisting.
 *
 * Farley review 2026-07-03, finding #8: the write handler persisted params.code
 * verbatim without running the extension's own transformWorkflowCode contract
 * check, so invalid code (static imports, unparseable meta, syntax errors)
 * round-tripped through the tool successfully and only failed much later at
 * run/start — the slowest possible feedback loop for the model authoring it.
 *
 * Contract pinned here (command-handlers.ts):
 *   - Valid code writes and reports the path (existing behavior).
 *   - Code that violates the authoring contract (static import) is REJECTED with
 *     the transform's instructive error and nothing is persisted.
 *   - Code with a plain syntax error is REJECTED and nothing is persisted.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

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

const settle = (p) =>
	p.then(
		(v) => ({ ok: true, v }),
		(e) => ({ ok: false, msg: String(e?.message ?? e) }),
	);

async function main() {
	const { url } = await buildDwfExtension({ name: "pi-dwf-write-validates" });
	const mod = await import(url);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-write-validate-"));
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);
	const write = (name, code) =>
		settle(tool.execute(`tc-${name}`, { action: "write", name, code }, new AbortController().signal, undefined, ctx));
	const draftPath = (name) => path.join(project, ".pi", "workflows", "drafts", `${name}.js`);
	const exists = (p) =>
		fs.access(p).then(
			() => true,
			() => false,
		);

	// --- valid code still writes ---------------------------------------------
	const good = await write("good", "export const meta = { name: 'good' };\nlog('hi');\nreturn 1;\n");
	check("valid code: write succeeds", good.ok === true, good.ok ? "" : good.msg);
	check("valid code: draft persisted", await exists(draftPath("good")));

	// --- contract violation: static import -----------------------------------
	const imported = await write("bad-import", "import fs from 'node:fs';\nreturn 1;\n");
	check("static import: write rejects", imported.ok === false, JSON.stringify(imported).slice(0, 200));
	check(
		"static import: instructive transform error",
		!imported.ok && /static import/i.test(imported.msg),
		imported.ok ? "" : imported.msg.slice(0, 160),
	);
	check("static import: nothing persisted", !(await exists(draftPath("bad-import"))));

	// --- plain syntax error ----------------------------------------------------
	const broken = await write("bad-syntax", "const x = {;\nreturn 1;\n");
	check("syntax error: write rejects", broken.ok === false, JSON.stringify(broken).slice(0, 200));
	check("syntax error: nothing persisted", !(await exists(draftPath("bad-syntax"))));

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
