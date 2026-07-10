/**
 * sanitizeEnvForCache debe DISTINGUIR valores env distintos sin FILTRARLOS.
 *
 * El env sanitizado se pliega dentro de la key de cache/journal del agente (vía sanitizeAgentOpts ->
 * computeCallKey), y esa key se escribe a disco. Los valores raw (que pueden ser secretos) no deben
 * aparecer ahí — pero colapsar TODOS los valores a la constante "[set]" hacía que dos valores
 * distintos de la misma var produjeran la MISMA key, así que al resume se reproducía el resultado
 * journaled (stale) en vez de re-ejecutar. El fix hashea el valor: sin leak de plaintext, pero
 * valores distintos producen keys distintas.
 *
 * Test de función pura: bundlea agent-env-persona.ts y llama el sanitizeEnvForCache exportado.
 *
 * Corrida:
 *   node extensions/pandi-dynamic-workflows/tests/integration/env-cache-key-collision.test.mjs
 */
import * as path from "node:path";
import {
	createChecker,
	REPO_ROOT,
	sdkStub,
	buildExtension as sharedBuildExtension,
} from "../../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

async function main() {
	const { url } = await sharedBuildExtension({
		name: "pi-dw-env-cache-key",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "runtime", "agent-env-persona.ts"),
		outName: "agent-env-persona.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
	const { sanitizeEnvForCache } = await import(url);

	const a = sanitizeEnvForCache({ API_KEY: "value-1" });
	const b = sanitizeEnvForCache({ API_KEY: "value-2" });

	check(
		"different values of the same var produce DIFFERENT cache-key entries (no collision)",
		a.API_KEY !== b.API_KEY,
		`a=${a.API_KEY} b=${b.API_KEY}`,
	);
	const det1 = sanitizeEnvForCache({ K: "x" }).K;
	const det2 = sanitizeEnvForCache({ K: "x" }).K;
	check("the same value is deterministic (stable cache key)", det1 === det2, `${det1} vs ${det2}`);
	check(
		"the raw secret value is NOT present in the sanitized key (no plaintext leak)",
		!JSON.stringify(a).includes("value-1"),
		JSON.stringify(a),
	);
	check("undefined env stays undefined", sanitizeEnvForCache(undefined) === undefined);

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		for (const f of counts.failures) console.error(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
