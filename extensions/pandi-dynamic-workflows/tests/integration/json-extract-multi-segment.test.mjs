/**
 * Guard durable para el fallback balanced-substring de extractJsonCandidate.
 *
 * Reproduce el bug multi-segmento (json-extract.ts): el scanner antes sembraba starts de
 * candidatos SOLO desde el primer '{' y el primer '['. Cuando llaves/corchetes anteriores
 * formaban un segmento balanceado-pero-no-JSON, nunca se alcanzaba el valor JSON real
 * posterior en el output, así que la extracción fallaba aunque siguiera un objeto/array válido.
 *
 * Puro: bundlea la entry self-contained json-extract.ts (sin stubs) y llama la función
 * exportada en memoria.
 *
 * Corrida:
 *   node extensions/pandi-dynamic-workflows/tests/integration/json-extract-multi-segment.test.mjs
 */
import * as path from "node:path";
import { buildExtension, createChecker, loadModule, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

async function loadRuntime() {
	const { url } = await buildExtension({
		name: "pi-dw-json-extract",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "json-extract.ts"),
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
