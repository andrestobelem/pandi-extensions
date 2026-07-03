#!/usr/bin/env node
/**
 * Regression: race() must surface branch errors instead of swallowing them.
 *
 * Farley review 2026-07-03, finding #5: race()'s rejection handler discarded
 * the error entirely, so a genuine thunk bug (a typo, a thrown exception) was
 * indistinguishable from "every branch declined" — both returned
 * {winner:null,index:-1,status:'empty'}. An observability black hole for
 * workflow authors debugging why their race found nothing.
 *
 * Contract pinned here (worker-source.ts race()):
 *   - status/winner/index semantics are unchanged ('won' still wins, all-decline
 *     is still 'empty').
 *   - The result additionally carries errors: [{index, error}] for rejected
 *     branches, so an all-rejected race is debuggable.
 *   - A clean all-decline (nulls, no throws) reports no errors.
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
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
		npx: "--yes",
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

	// Existing semantics preserved.
	check("won: status won, winner surfaced", out?.won?.status === "won" && out?.won?.winner === "yes", JSON.stringify(out?.won));
	check("bugged: still status empty", out?.bugged?.status === "empty", JSON.stringify(out?.bugged));
	check("clean: still status empty", out?.clean?.status === "empty", JSON.stringify(out?.clean));

	// The fix: rejected branches are debuggable.
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
