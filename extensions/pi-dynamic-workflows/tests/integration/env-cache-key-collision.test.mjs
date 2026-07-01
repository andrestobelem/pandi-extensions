/**
 * sanitizeEnvForCache must DISTINGUISH different env values without LEAKING them.
 *
 * The sanitized env is folded into the agent cache/journal key (via sanitizeAgentOpts ->
 * computeCallKey), and that key is written to disk. Raw values (which can be secrets) must
 * not appear there — but collapsing EVERY value to the constant "[set]" made two different
 * values of the same var produce the SAME key, so on resume the journaled (stale) result was
 * replayed instead of re-executing. The fix hashes the value: no plaintext leak, but distinct
 * values yield distinct keys.
 *
 * Pure function test: bundle agent-env-persona.ts and call the exported sanitizeEnvForCache.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/env-cache-key-collision.test.mjs
 */
import * as path from "node:path";
import {
	createChecker,
	REPO_ROOT,
	sdkStub,
	buildExtension as sharedBuildExtension,
} from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

async function main() {
	const { url } = await sharedBuildExtension({
		name: "pi-dw-env-cache-key",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "agent-env-persona.ts"),
		outName: "agent-env-persona.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
		npx: "--yes",
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
