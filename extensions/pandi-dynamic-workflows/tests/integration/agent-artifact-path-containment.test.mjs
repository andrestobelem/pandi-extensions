/**
 * Security regression test: resolveAgentArtifactPath must contain the artifactPath
 * within run.runDir.
 *
 * artifactPath originates from an untrusted events.jsonl (event-parser copies it
 * verbatim into the agent model). Before the fix, resolveAgentArtifactPath returned
 * absolute paths as-is and path.join'd relatives without any containment check, so a
 * crafted absolute path ("/etc/passwd") or a "../" traversal escaped runDir and reached
 * fs.readFile in formatAgentView — an arbitrary file read. This pins the containment.
 *
 * Self-bootstrapping like the sibling suites: esbuilds agent-view.ts directly (it now
 * exports resolveAgentArtifactPath) with the SDK/tui/typebox aliased to local stubs,
 * then imports the named export. The function is pure (no fs), so no fixtures needed.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/agent-artifact-path-containment.test.mjs
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-agent-artifact-path-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "agent-view.ts"),
		outName: "agent-view.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
}

function run(mod) {
	const { resolveAgentArtifactPath } = mod;
	const runDir = "/runs/abcd";
	const resolve = (artifactPath) => resolveAgentArtifactPath({ runDir }, { artifactPath });

	check(
		"resolveAgentArtifactPath is exported",
		typeof resolveAgentArtifactPath === "function",
		typeof resolveAgentArtifactPath,
	);

	// Legitimate: a relative artifact inside runDir resolves under runDir.
	check(
		"keeps a relative artifact inside runDir",
		resolve("agents/0001-alpha.md") === path.resolve(runDir, "agents/0001-alpha.md"),
		String(resolve("agents/0001-alpha.md")),
	);

	// Missing artifactPath -> undefined.
	check("undefined when no artifactPath", resolve(undefined) === undefined, String(resolve(undefined)));

	// Attack 1: an absolute path that escapes runDir is rejected.
	check(
		"rejects an absolute path outside runDir",
		resolve("/etc/passwd") === undefined,
		String(resolve("/etc/passwd")),
	);

	// Attack 2: a "../" traversal that escapes runDir is rejected.
	check(
		"rejects a ../ traversal escaping runDir",
		resolve("../../etc/passwd") === undefined,
		String(resolve("../../etc/passwd")),
	);

	// Boundary: a traversal that resolves back inside runDir is still allowed.
	check(
		"allows a ../ traversal that stays inside runDir",
		resolve("agents/../answer.md") === path.resolve(runDir, "answer.md"),
		String(resolve("agents/../answer.md")),
	);
}

async function main() {
	const { url } = await buildExtension();
	const mod = await import(`${url}?i=0`);

	run(mod);

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
