#!/usr/bin/env node
/**
 * Test durable de comportamiento para safeJson de extensions/pandi-dynamic-workflows format.ts.
 *
 * Issue #36: safeJson usaba un WeakSet global que nunca removía entries, así que CUALQUIER
 * referencia repetida al mismo objeto — incluso una que aparecía en dos ramas independientes
 * y no solapadas del árbol (un DAG, no un ciclo) — se marcaba erróneamente como
 * "[Circular]" y perdía sus valores reales. El patrón correcto (journal.ts
 * stableStringify) trackea "seen" por PATH de traversal: agrega al entrar a un nodo, borra
 * al salir, así solo un ancestro-en-el-path-actual dispara el sentinel.
 *
 * Contrato pineado acá:
 * - shared-but-not-circular: el MISMO objeto child referenciado desde dos ramas sibling
 *   independientes serializa con los valores reales del child en AMBAS ramas — sin sentinel
 *   "[Circular]" en ninguna parte del output.
 * - self-reference genuina: un nodo cuyo descendiente apunta de vuelta a un ancestro en
 *   el mismo path SÍ sigue marcado como "[Circular]" (prueba que el test no es vacuo y
 *   que la protección contra true-cycle sobrevive al fix).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

async function scenarioSharedRefs(url) {
	const { safeJson } = await loadModule(url);

	check("safeJson is exported as a function", typeof safeJson === "function");

	// --- Shared-but-not-circular: mismo objeto child en dos ramas independientes ---
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

	// --- Self-reference genuina: un descendiente apunta a un ancestro en el mismo path ---
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
		// format.ts es puro y dependency-free (solo MAX_TOOL_TEXT, definido in-file),
		// así que no hacen falta stubs/aliases para bundlearlo standalone.
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "lib", "format.ts"),
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
