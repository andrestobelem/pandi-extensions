import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

async function loadRuntime() {
	const { url } = await buildDwfModule({
		name: "pi-dw-json-extract",
		relPath: "lib/json-extract.ts",
		outName: "json-extract.mjs",
	});
	return await loadModule(url);
}

async function main() {
	const { extractJsonCandidate } = await loadRuntime();
	check("exports extractJsonCandidate", typeof extractJsonCandidate === "function", typeof extractJsonCandidate);

	// El segmento balanceado '{...}' anterior NO es JSON válido; el valor real viene después.
	const multi = 'Reasoning: { not really json here } and the answer is {"answer": 42}';
	const r1 = extractJsonCandidate(multi);
	check(
		"picks the later valid object past a balanced non-JSON segment",
		r1.ok === true && r1.data && r1.data.answer === 42,
		JSON.stringify(r1),
	);

	// Misma forma para arrays: '[...]' anterior balanceado no-JSON, array válido después.
	const multiArr = "Steps: [ do a thing ] -> result: [1, 2, 3]";
	const r2 = extractJsonCandidate(multiArr);
	check(
		"picks the later valid array past a balanced non-JSON segment",
		r2.ok === true && Array.isArray(r2.data) && r2.data.length === 3 && r2.data[2] === 3,
		JSON.stringify(r2),
	);

	// Regresión: un único objeto válido inicial sigue devolviéndose como antes.
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
