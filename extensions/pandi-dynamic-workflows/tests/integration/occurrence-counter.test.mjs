#!/usr/bin/env node
/**
 * Test durable de comportamiento para extensions/pandi-dynamic-workflows occurrence-counter.ts.
 *
 * `OccurrenceCounter` es el índice determinista de occurrences por key detrás del
 * resume cache content-addressed, extraído byte-for-byte del antiguo `nextOcc`/`occCounters`
 * anidado de runWorkflow. Es intencionalmente PURO y sin mutex: el caller
 * (occAssignMutex de runWorkflow) posee la serialización, así que esta clase NO debe reintroducir
 * un lock. Esta suite pinea el contrato de conteo del que depende el determinismo del resume-cache.
 *
 * Contrato:
 * - next(key) devuelve 0, 1, 2, … para keys idénticas repetidas (monotónico, empieza en 0).
 * - keys distintas cuentan independientemente (cada una empieza en 0).
 * - dos instancias de OccurrenceCounter son independientes (sin estado compartido/static).
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
	// keys distintas cuentan independientemente, cada una desde 0
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
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "occurrence-counter.ts"),
		outName: "occurrence-counter.mjs",
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
