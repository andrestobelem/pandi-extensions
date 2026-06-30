#!/usr/bin/env node
/**
 * Behavioral contract for openRunArtifact (run-view.ts): the function that opens a single
 * run artifact in the viewer that fits it.
 *
 * Pins:
 *   1. Routing — a `.md` artifact opens the Markdown viewer (ctx.ui.custom), a non-markdown
 *      artifact (e.g. `.log`) opens the text editor (ctx.ui.editor). Exactly one, never both.
 *   2. Path containment — a relative path that escapes the run directory is REFUSED with a
 *      warning and never opens any viewer (even when the escaping file exists and is readable).
 *   3. Missing file — surfaces a warning, opens no viewer.
 *
 * This is a regression/characterization test for already-shipped behavior (openRunArtifact
 * exists), written test-AFTER — stated explicitly rather than labelled as Red-first TDD.
 * Built with stubs; the fake ctx only counts which viewer opener was invoked.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function makeCtx() {
	const notes = [];
	let customCalls = 0;
	let editorCalls = 0;
	return {
		ctx: {
			mode: "tui",
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				custom: async () => {
					customCalls++;
					return undefined;
				},
				editor: async () => {
					editorCalls++;
					return undefined;
				},
				notify: (msg, type) => notes.push({ msg, type }),
			},
		},
		notes,
		get customCalls() {
			return customCalls;
		},
		get editorCalls() {
			return editorCalls;
		},
	};
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-open-artifact",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "run-view.ts"),
		outName: "run-view.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
		npx: "--yes",
	});
	const { openRunArtifact } = await loadModule(url);
	check("openRunArtifact is exported", typeof openRunArtifact === "function");

	// Build a run dir with a markdown and a non-markdown artifact, plus a sibling OUTSIDE it.
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-openartifact-"));
	const runDir = path.join(tmp, "run-xyz");
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(path.join(runDir, "output.md"), "# Artifact\n\nhello", "utf8");
	await fs.writeFile(path.join(runDir, "stdout.log"), "raw log line", "utf8");
	await fs.writeFile(path.join(tmp, "secret.md"), "# Secret\n\noutside the run dir", "utf8");

	// 1) .md → markdown viewer (custom), not the editor.
	const md = makeCtx();
	await openRunArtifact(md.ctx, runDir, "output.md");
	check("'.md' opens the Markdown viewer (custom)", md.customCalls === 1, `custom=${md.customCalls}`);
	check("'.md' does NOT open the text editor", md.editorCalls === 0, `editor=${md.editorCalls}`);

	// 2) .log → text editor, not the markdown viewer.
	const log = makeCtx();
	await openRunArtifact(log.ctx, runDir, "stdout.log");
	check("'.log' opens the text editor", log.editorCalls === 1, `editor=${log.editorCalls}`);
	check("'.log' does NOT open the Markdown viewer", log.customCalls === 0, `custom=${log.customCalls}`);

	// 3) Path traversal escaping runDir is refused, no viewer opens.
	const esc = makeCtx();
	await openRunArtifact(esc.ctx, runDir, "../secret.md");
	check(
		"traversal opens no viewer",
		esc.customCalls === 0 && esc.editorCalls === 0,
		`custom=${esc.customCalls} editor=${esc.editorCalls}`,
	);
	check(
		"traversal surfaces a warning mentioning the run directory",
		esc.notes.some((n) => n.type === "warning" && /escapes the run directory/i.test(n.msg)),
		JSON.stringify(esc.notes),
	);

	// 4) Missing file → warning, no viewer.
	const miss = makeCtx();
	await openRunArtifact(miss.ctx, runDir, "does-not-exist.md");
	check("missing file opens no viewer", miss.customCalls === 0 && miss.editorCalls === 0, JSON.stringify(miss.notes));
	check(
		"missing file surfaces a 'cannot read' warning",
		miss.notes.some((n) => n.type === "warning" && /cannot read artifact/i.test(n.msg)),
		JSON.stringify(miss.notes),
	);

	await fs.rm(tmp, { recursive: true, force: true });

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
