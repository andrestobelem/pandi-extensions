import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

async function main() {
	const { url } = await buildDwfModule({
		name: "pi-dw-env-cache-key",
		relPath: "runtime/agent-env-persona.ts",
		outName: "agent-env-persona.mjs",
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
