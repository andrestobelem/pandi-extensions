/**
 * Durable guard against the global-shadowing footgun.
 *
 * Workflows run with injected GLOBALS (agent, parallel, pipeline, workflow, log,
 * phase, args, …). If a scaffold declares `export default async function workflow()`
 * and then calls the global `workflow(name, args)` to compose, the identifier
 * `workflow` inside the body binds to the function itself (named function
 * expression), shadowing the global — so the scaffold recurses into itself instead
 * of dispatching (observed: composition scaffolds blew through maxAgents).
 *
 * Fix + guard: the canonical default function is named `main` (or any non-global
 * name). This test asserts no scaffold names its default export after an injected
 * global, so the bug cannot silently return.
 *
 * Mutation-free: derives injected globals from the worker source export, then scans scaffold sources.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/scaffold-no-global-shadow.test.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createChecker } from "../../../shared/test/harness.mjs";
import { EXT_DIR, loadInjectedGlobals } from "./worker-source-test-support.mjs";

const { check, counts } = createChecker();

const SCAFFOLDS_DIR = path.join(EXT_DIR, "scaffolds");

async function main() {
	const injected = await loadInjectedGlobals("pi-dw-scaffold-shadow-globals");
	check("extracted injected globals from worker source", injected.size > 0, `count=${injected.size}`);
	check(
		"extraction includes composition + HITL sentinels",
		["workflow", "race", "ask"].every((name) => injected.has(name)),
		[...injected].sort().join(","),
	);
	const files = fs
		.readdirSync(SCAFFOLDS_DIR)
		.filter((f) => f.endsWith(".js"))
		.sort();
	check("found scaffolds to scan", files.length > 0, `count=${files.length}`);

	const declRe = /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
	for (const file of files) {
		const src = fs.readFileSync(path.join(SCAFFOLDS_DIR, file), "utf8");
		const m = declRe.exec(src);
		const name = m ? m[1] : null;
		// A scaffold may be a top-level script (no named default fn) OR a named default
		// fn — but if named, the name must not collide with an injected global.
		check(
			`${file}: default fn name does not shadow an injected global`,
			name === null || !injected.has(name),
			`named "${name}" (collides with global)`,
		);
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
