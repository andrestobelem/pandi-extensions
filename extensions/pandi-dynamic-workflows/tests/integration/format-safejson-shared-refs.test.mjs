#!/usr/bin/env node
/**
 * Durable behavioral test for extensions/pandi-dynamic-workflows format.ts safeJson.
 *
 * Issue #36: safeJson used a global WeakSet that never removed entries, so ANY
 * repeated reference to the same object — even one appearing in two independent,
 * non-overlapping branches of the tree (a DAG, not a cycle) — was wrongly stamped
 * "[Circular]" and lost its real values. The correct pattern (journal.ts
 * stableStringify) tracks "seen" per traversal PATH: add on entering a node, delete
 * on leaving it, so only an ancestor-on-the-current-path trips the sentinel.
 *
 * Contract pinned here:
 * - shared-but-not-circular: the SAME child object referenced from two independent
 *   sibling branches serializes with the child's real values in BOTH branches — no
 *   "[Circular]" sentinel anywhere in the output.
 * - genuine self-reference: a node whose descendant points back to an ancestor on
 *   the same path IS still stamped "[Circular]" (proves the test is not vacuous and
 *   that true-cycle protection survives the fix).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function scenarioSharedRefs(url) {
	const { safeJson } = await loadModule(url);

	check("safeJson is exported as a function", typeof safeJson === "function");

	// --- Shared-but-not-circular: same child object in two independent branches ---
	const child = { value: 42, label: "shared" };
	const root = { a: { child }, b: { child } };
	const out = safeJson(root);
	const parsed = JSON.parse(out);

	check("shared-but-not-circular reference is NOT stamped [Circular]", !out.includes("[Circular]"), out);
	check(
		"both independent branches carry the child's real values",
		parsed.a.child?.value === 42 &&
			parsed.a.child?.label === "shared" &&
			parsed.b.child?.value === 42 &&
			parsed.b.child?.label === "shared",
		out,
	);

	// --- Genuine self-reference: a descendant points back to an ancestor on the same path ---
	const node = { name: "root" };
	node.self = node;
	const cyclic = safeJson(node);
	check("a genuine self-reference IS stamped [Circular]", cyclic.includes("[Circular]"), cyclic);
	const parsedCyclic = JSON.parse(cyclic);
	check(
		"the self-reference site itself resolves to the sentinel",
		parsedCyclic.self === "[Circular]" && parsedCyclic.name === "root",
		cyclic,
	);
}

async function main() {
	const built = await buildExtension({
		name: "pi-dw-format-safejson-shared-refs",
		// format.ts is pure and dependency-free (only MAX_TOOL_TEXT, defined in-file),
		// so no stubs/aliases are needed to bundle it standalone.
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "format.ts"),
		outName: "format.mjs",
	});
	try {
		await scenarioSharedRefs(built.url);
	} finally {
		await fs.rm(built.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
