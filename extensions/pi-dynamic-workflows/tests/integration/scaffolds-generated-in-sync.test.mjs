/**
 * Durable guard for the scaffold codegen (Option A).
 *
 * The executable workflow scaffolds are authored as real files under
 * extensions/pi-dynamic-workflows/scaffolds/*.js and inlined into
 * scaffolds.generated.ts (EMBEDDED_SCAFFOLD_SOURCES) by scripts/gen-scaffolds.mjs.
 * This pins the invariant that the committed generated map stays byte-identical to
 * the sources, so editing a scaffold without `npm run generate` fails CI rather
 * than silently shipping stale embedded code. Mutation-free: it imports the
 * generator helpers and compares in memory (no scaffold files are touched).
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/scaffolds-generated-in-sync.test.mjs
 */
import * as fs from "node:fs";
import { createChecker } from "../../../shared/test/harness.mjs";
import { OUT_FILE, readSources, render } from "../../../../scripts/gen-scaffolds.mjs";

const { check, counts } = createChecker();

function main() {
	const sources = readSources();
	const keys = Object.keys(sources);

	check("scaffolds: sources discovered", keys.length >= 12, `count=${keys.length}`);
	check("scaffolds: default scaffold present (WORKFLOW_TEMPLATE source)", keys.includes("default"), keys.join(","));

	const committed = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : "";
	const regenerated = render(sources);

	check(
		"scaffolds: committed generated map is in sync with sources",
		committed === regenerated,
		"run `npm run generate`",
	);
	check(
		"scaffolds: generated file has the auto-generated banner",
		/AUTO-GENERATED/.test(committed),
		committed.slice(0, 40),
	);
	check(
		"scaffolds: generated file exports EMBEDDED_SCAFFOLD_SOURCES",
		/export const EMBEDDED_SCAFFOLD_SOURCES: Record<string, string>/.test(committed),
		"",
	);

	// Red proof (in memory): a drifted source must NOT match the committed map.
	const drifted = render({ ...sources, "loop-until-dry": `${sources["loop-until-dry"]}\n// drift\n` });
	check("scaffolds: a drifted source diverges from the committed map", drifted !== committed, "drift not detected");

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main();
