#!/usr/bin/env node
/**
 * Contrato de comportamiento para openRunArtifact (run-view.ts): la función que abre un
 * artifact individual de run en el viewer que corresponde.
 *
 * Pinea:
 *   1. Routing — un artifact `.md` abre el Markdown viewer (ctx.ui.custom), un artifact
 *      non-markdown (p. ej. `.log`) abre el text editor (ctx.ui.editor). Exactamente uno, nunca ambos.
 *   2. Path containment — un path relativo que escapa del run directory se RECHAZA con warning
 *      y nunca abre ningún viewer (incluso cuando el archivo escapado existe y es readable).
 *   3. Missing file — muestra un warning, no abre viewer.
 *
 * Este es un test de regresión/caracterización para comportamiento ya shipeado (openRunArtifact
 * existe), escrito test-AFTER — explicitado en vez de etiquetarlo como TDD Red-first.
 * Buildeado con stubs; el ctx fake solo cuenta qué opener de viewer fue invocado.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

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
	const { url } = await buildDwfModule({
		name: "pi-dwf-open-artifact",
		relPath: "tui/run-view.ts",
		outName: "run-view.mjs",
		stubs: { sdk: (dir) => dir && "" },
	});
	const { openRunArtifact } = await loadModule(url);
	check("openRunArtifact is exported", typeof openRunArtifact === "function");

	// Construí un run dir con un artifact markdown y uno non-markdown, más un sibling AFUERA.
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-openartifact-"));
	const runDir = path.join(tmp, "run-xyz");
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(path.join(runDir, "output.md"), "# Artifact\n\nhello", "utf8");
	await fs.writeFile(path.join(runDir, "stdout.log"), "raw log line", "utf8");
	await fs.writeFile(path.join(tmp, "secret.md"), "# Secret\n\noutside the run dir", "utf8");

	// 1) .md → markdown viewer (custom), no el editor.
	const md = makeCtx();
	await openRunArtifact(md.ctx, runDir, "output.md");
	check("'.md' opens the Markdown viewer (custom)", md.customCalls === 1, `custom=${md.customCalls}`);
	check("'.md' does NOT open the text editor", md.editorCalls === 0, `editor=${md.editorCalls}`);

	// 2) .log → text editor, no el markdown viewer.
	const log = makeCtx();
	await openRunArtifact(log.ctx, runDir, "stdout.log");
	check("'.log' opens the text editor", log.editorCalls === 1, `editor=${log.editorCalls}`);
	check("'.log' does NOT open the Markdown viewer", log.customCalls === 0, `custom=${log.customCalls}`);

	// 3) Path traversal que escapa de runDir se rechaza, no abre viewer.
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

	// 4) Missing file → warning, sin viewer.
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
