/**
 * Durable guard for extractJsonCandidate's balanced-substring fallback.
 *
 * Reproduces the multi-segment bug (json-extract.ts): the scanner used to seed
 * candidate starts from ONLY the first '{' and the first '['. When earlier braces
 * form a balanced-but-non-JSON segment, the real JSON value later in the output was
 * never reached, so extraction failed even though a valid object/array followed.
 *
 * Pure: bundles the self-contained json-extract.ts entry (no stubs) and calls the
 * exported function in memory.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/json-extract-multi-segment.test.mjs
 */
import * as path from "node:path";
import { buildExtension, createChecker, loadModule, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

async function loadRuntime() {
	const { url } = await buildExtension({
		name: "pi-dw-json-extract",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "json-extract.ts"),
		outName: "json-extract.mjs",
	});
	return await loadModule(url);
}

async function main() {
	const { extractJsonCandidate } = await loadRuntime();
	check("exports extractJsonCandidate", typeof extractJsonCandidate === "function", typeof extractJsonCandidate);

	// Earlier balanced '{...}' segment is NOT valid JSON; the real value comes later.
	const multi = 'Reasoning: { not really json here } and the answer is {"answer": 42}';
	const r1 = extractJsonCandidate(multi);
	check(
		"picks the later valid object past a balanced non-JSON segment",
		r1.ok === true && r1.data && r1.data.answer === 42,
		JSON.stringify(r1),
	);

	// Same shape for arrays: earlier balanced '[...]' non-JSON, valid array later.
	const multiArr = "Steps: [ do a thing ] -> result: [1, 2, 3]";
	const r2 = extractJsonCandidate(multiArr);
	check(
		"picks the later valid array past a balanced non-JSON segment",
		r2.ok === true && Array.isArray(r2.data) && r2.data.length === 3 && r2.data[2] === 3,
		JSON.stringify(r2),
	);

	// Regression: a single leading valid object is still returned as before.
	const single = 'prefix {"x": 1} suffix';
	const r3 = extractJsonCandidate(single);
	check("still returns a single leading valid object", r3.ok === true && r3.data.x === 1, JSON.stringify(r3));

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main();
