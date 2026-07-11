#!/usr/bin/env node
/**
 * Test durable de comportamiento para lookupJournalRecord en extensions/pandi-dynamic-workflows journal.ts.
 *
 * `lookupJournalRecord(cache, key, occ)` es la LECTURA de resume-cache, extraída byte-for-byte
 * del antiguo `journalLookup` anidado de runWorkflow. Ahora vive junto a las demás responsabilidades
 * de journal (loadJournal / appendJournalRecord) — un hogar cohesivo que la pairing session marcó
 * como responsabilidad separada de la asignación de occurrences. Esta suite pinea el contrato de read,
 * incluyendo los bordes miss que mantienen resume idempotente.
 *
 * Contrato:
 * - hit: devuelve el slot registrado en (key, occ).
 * - miss (key desconocida, u occ más allá de los slots registrados) → undefined.
 * - cache undefined (un run fresco, no resumido) → undefined.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

async function scenarioLookup(url) {
	const { lookupJournalRecord } = await loadModule(url);

	check("lookupJournalRecord is exported as a function", typeof lookupJournalRecord === "function");

	const r0 = { id: 0, output: "zero" };
	const r1 = { id: 1, output: "one" };
	const cache = new Map([["k", [r0, r1]]]);

	check(
		"hit returns the slot at (key, occ)",
		lookupJournalRecord(cache, "k", 0) === r0 && lookupJournalRecord(cache, "k", 1) === r1,
	);
	check("miss on unknown key → undefined", lookupJournalRecord(cache, "nope", 0) === undefined);
	check("miss on occ past recorded slots → undefined", lookupJournalRecord(cache, "k", 5) === undefined);
	check("undefined cache (fresh run) → undefined", lookupJournalRecord(undefined, "k", 0) === undefined);
}

async function main() {
	const built = await buildDwfModule({
		name: "pi-dw-journal-lookup",
		relPath: "runtime/journal.ts",
		outName: "journal.mjs",
	});
	try {
		await scenarioLookup(built.url);
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
