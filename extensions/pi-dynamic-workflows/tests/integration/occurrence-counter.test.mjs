#!/usr/bin/env node
/**
 * Durable behavioral test for extensions/pi-dynamic-workflows occurrence-counter.ts.
 *
 * `OccurrenceCounter` is the deterministic per-key occurrence index behind the
 * content-addressed resume cache, extracted byte-for-byte from runWorkflow's former
 * nested `nextOcc`/`occCounters`. It is intentionally PURE and mutex-free: the caller
 * (runWorkflow's occAssignMutex) owns the serialization, so this class must NOT reintroduce
 * a lock. This suite pins the counting contract that resume-cache determinism depends on.
 *
 * Contract:
 * - next(key) returns 0, 1, 2, … for repeated identical keys (monotonic, starts at 0).
 * - distinct keys count independently (each starts at 0).
 * - two OccurrenceCounter instances are independent (no shared/static state).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function scenarioCounterUnit(url) {
	const { OccurrenceCounter } = await loadModule(url);

	check("OccurrenceCounter is exported as a constructor", typeof OccurrenceCounter === "function");

	const c = new OccurrenceCounter();
	check(
		"same key yields 0,1,2,3 in order",
		c.next("a") === 0 && c.next("a") === 1 && c.next("a") === 2 && c.next("a") === 3,
	);

	const c2 = new OccurrenceCounter();
	// distinct keys count independently, each from 0
	const kx0 = c2.next("x");
	const ky0 = c2.next("y");
	const kx1 = c2.next("x");
	const ky1 = c2.next("y");
	check("distinct keys count independently from 0", kx0 === 0 && ky0 === 0 && kx1 === 1 && ky1 === 1);

	const c3 = new OccurrenceCounter();
	c3.next("shared");
	c3.next("shared");
	const fresh = new OccurrenceCounter();
	check("separate instances do not share state", fresh.next("shared") === 0);
}

async function main() {
	const built = await buildExtension({
		name: "pi-dw-occurrence-counter",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "occurrence-counter.ts"),
		outName: "occurrence-counter.mjs",
		npx: "--yes",
	});
	try {
		await scenarioCounterUnit(built.url);
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
