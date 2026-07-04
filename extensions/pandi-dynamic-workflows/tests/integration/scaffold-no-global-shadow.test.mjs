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
 * Mutation-free: reads the scaffold sources and pattern-matches.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/scaffold-no-global-shadow.test.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createChecker, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

// The names the runtime injects as globals (worker-source.ts). A default function
// named after any of these would shadow that global inside its own body.
const INJECTED_GLOBALS = new Set([
	"agent",
	"agents",
	"parallel",
	"pipeline",
	"workflow",
	"log",
	"phase",
	"bash",
	"readFile",
	"writeFile",
	"appendFile",
	"listFiles",
	"writeArtifact",
	"appendArtifact",
	"sleep",
	"json",
	"compact",
	"args",
	"limits",
	"runId",
	"runDir",
	"cwd",
]);

const SCAFFOLDS_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds");

function main() {
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
			name === null || !INJECTED_GLOBALS.has(name),
			`named "${name}" (collides with global)`,
		);
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main();
