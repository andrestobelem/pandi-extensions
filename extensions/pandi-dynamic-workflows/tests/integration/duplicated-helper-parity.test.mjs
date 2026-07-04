/**
 * Duplicated-helper parity GUARDIAN: intentionally duplicated runtime helpers must
 * stay byte-identical across the extensions that vendor them.
 *
 * Why this file exists
 * --------------------
 * Pi loads each extension self-contained (a single file or its own dir); a
 * `../shared/` runtime import only resolves while the whole monorepo is present
 * and breaks when the extension is installed standalone. Per-extension
 * duplication is therefore INTENTIONAL for tiny stable helpers like notify.ts,
 * session-state.ts, and time.ts.
 *
 * This guardian makes that contract executable: a declared manifest lists each
 * intentionally duplicated helper family, and the test fails if any member stops
 * being byte-identical to the others.
 *
 * Run directly:
 *   node extensions/pandi-dynamic-workflows/tests/integration/duplicated-helper-parity.test.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const MANIFEST = [
	{
		helper: "notify.ts",
		files: [
			"extensions/pandi-dynamic-workflows/notify.ts",
			"extensions/pandi-goal/notify.ts",
			"extensions/pandi-loop/notify.ts",
			"extensions/pandi-plan/notify.ts",
		],
	},
	{
		helper: "session-state.ts",
		files: [
			"extensions/pandi-goal/session-state.ts",
			"extensions/pandi-loop/session-state.ts",
			"extensions/pandi-plan/session-state.ts",
		],
	},
	{
		helper: "time.ts",
		files: ["extensions/pandi-goal/time.ts", "extensions/pandi-loop/time.ts"],
	},
];

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
	if (!ok) {
		failures++;
		if (detail) console.log(`   -> ${String(detail).slice(0, 600)}`);
	}
}

function compareFamily(helper, absoluteFiles) {
	if (absoluteFiles.length < 2) return [];
	const baselinePath = absoluteFiles[0];
	const baselineBytes = readFileSync(baselinePath);
	const mismatches = [];
	for (const candidatePath of absoluteFiles.slice(1)) {
		const candidateBytes = readFileSync(candidatePath);
		if (!candidateBytes.equals(baselineBytes)) {
			mismatches.push(
				`${helper}: ${path.relative(REPO_ROOT, candidatePath)} differs from ${path.relative(REPO_ROOT, baselinePath)}`,
			);
		}
	}
	return mismatches;
}

function makeDivergentFixture() {
	const dir = mkdtempSync(path.join(tmpdir(), "duplicated-helper-parity-"));
	const first = path.join(dir, "first.ts");
	const second = path.join(dir, "second.ts");
	writeFileSync(first, "export const fixture = 'same';\n");
	writeFileSync(second, "export const fixture = 'different';\n");
	return { dir, files: [first, second] };
}

function main() {
	check("manifest declares helper families", MANIFEST.length > 0, `found ${MANIFEST.length}`);

	const fixture = makeDivergentFixture();
	try {
		const fixtureMismatches = compareFamily("fixture.ts", fixture.files);
		check(
			"guardian detects byte mismatches on an intentional divergent temp fixture",
			fixtureMismatches.length > 0,
			fixtureMismatches.join(" | ") || "comparator reported no mismatch",
		);
	} finally {
		rmSync(fixture.dir, { force: true, recursive: true });
	}

	for (const family of MANIFEST) {
		const absoluteFiles = family.files.map((file) => path.join(REPO_ROOT, file));
		const mismatches = compareFamily(family.helper, absoluteFiles);
		check(
			`${family.helper}: ${family.files.length} declared copies stay byte-identical`,
			mismatches.length === 0,
			mismatches.join(" | "),
		);
	}

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main();
