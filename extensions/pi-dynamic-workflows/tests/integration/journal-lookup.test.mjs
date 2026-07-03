#!/usr/bin/env node
/**
 * Durable behavioral test for extensions/pi-dynamic-workflows journal.ts lookupJournalRecord.
 *
 * `lookupJournalRecord(cache, key, occ)` is the resume-cache READ, extracted byte-for-byte
 * from runWorkflow's former nested `journalLookup`. It now lives beside the other journal
 * concerns (loadJournal / appendJournalRecord) — a cohesive home the pairing session called
 * out as a separate responsibility from occurrence assignment. This suite pins the read
 * contract, including the miss edges that keep resume idempotent.
 *
 * Contract:
 * - hit: returns the slot recorded at (key, occ).
 * - miss (unknown key, or occ past the recorded slots) → undefined.
 * - undefined cache (a fresh, non-resumed run) → undefined.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

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
	const built = await buildExtension({
		name: "pi-dw-journal-lookup",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "journal.ts"),
		outName: "journal.mjs",
		// journal.ts has a runtime import cycle with index.ts, so bundling it pulls the whole
		// extension graph. Stub the heavy pi runtime deps (same set as engine-smoke) so the
		// bundle loads without cross-spawn's dynamic require of child_process.
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
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
