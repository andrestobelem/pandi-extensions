/**
 * Real-SDK surface canary (test-review finding P1).
 *
 * Every integration suite bundles its extension against HAND-WRITTEN stubs of the SDK packages
 * (harness.mjs STUB_SOURCES / sdkStub), so "125/125 green" proves nothing about whether the REAL
 * @earendil-works packages still expose the surface the extensions import at runtime. The stubs can
 * silently drift from reality (e.g. `convertToLlm` is used by an extension but isn't even in the
 * default sdk stub), and only `tsc` cross-checks against the real *types* — not the runtime values.
 *
 * This canary imports the REAL installed packages and asserts each RUNTIME value the extensions
 * depend on exists with the expected `typeof`, so a breaking SDK upgrade (a renamed/removed export
 * or a value that changed kind) fails HERE instead of only in production.
 *
 * Refresh the SURFACE map when an extension starts importing a new runtime value:
 *   grep -rhoE 'import \{[^}]+\} from "@earendil-works/[^"]+"' extensions/*\/*.ts
 * Type-only imports are erased at runtime (covered by tsc), so they are intentionally NOT listed.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/sdk-surface-canary.test.mjs
 */

import { createChecker } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

// Runtime values imported from @earendil-works/* across extensions/*/*.ts, with their expected kind
// (a class is `typeof === "function"`; a const string is "string"; a namespace object is "object").
const SURFACE = {
	"@earendil-works/pi-coding-agent": {
		CONFIG_DIR_NAME: "string",
		getAgentDir: "function",
		convertToLlm: "function",
		CustomEditor: "function", // class
	},
	"@earendil-works/pi-ai": {
		StringEnum: "function",
	},
	"@earendil-works/pi-ai/compat": {
		completeSimple: "function",
	},
	"@earendil-works/pi-tui": {
		Image: "function", // class (imported as TerminalImage)
		Key: "object",
		Markdown: "function", // class
		getCapabilities: "function",
		matchesKey: "function",
		truncateToWidth: "function",
		visibleWidth: "function",
	},
};

// Pure predicate: the names in `expected` that are missing from `mod` or have the wrong `typeof`.
function surfaceMismatches(mod, expected) {
	const out = [];
	for (const [name, kind] of Object.entries(expected)) {
		const actual = typeof mod?.[name];
		if (actual !== kind) out.push(`${name}: expected ${kind}, got ${actual}`);
	}
	return out;
}

async function main() {
	// Non-vacuousness: the predicate must FAIL a missing / wrong-kind export and PASS a present one,
	// so the real-import checks below cannot be trivially green.
	check("predicate flags a missing export", surfaceMismatches({}, { foo: "function" }).length === 1);
	check("predicate flags a wrong-kind export", surfaceMismatches({ foo: 1 }, { foo: "function" }).length === 1);
	check("predicate passes a present export", surfaceMismatches({ foo: () => {} }, { foo: "function" }).length === 0);

	for (const [specifier, expected] of Object.entries(SURFACE)) {
		let mod;
		try {
			mod = await import(specifier);
		} catch (err) {
			check(`real ${specifier} imports`, false, String(err));
			continue;
		}
		const miss = surfaceMismatches(mod, expected);
		check(`real ${specifier} exposes the runtime surface extensions import`, miss.length === 0, miss.join("; "));
	}

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

await main();
