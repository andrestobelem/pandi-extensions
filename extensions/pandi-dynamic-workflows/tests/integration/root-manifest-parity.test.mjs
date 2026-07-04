/**
 * Durable parity test for the root pi manifest: the root package.json `pi.extensions`
 * and `pi.themes` are DERIVED from each `extensions/pandi-<name>/package.json` pi manifest by
 * `scripts/sync-root-manifest.mjs` (source of truth = the sub-packages). Adding an
 * extension must never require hand-editing the root list — and forgetting to register
 * one must be caught here instead of silently not loading.
 *
 * This pins:
 *   - In sync: `sync-root-manifest.mjs --check` exits 0 (root manifest == derivation).
 *   - Coverage: every extensions/pandi package that declares pi.extensions appears in the
 *     root pi.extensions (and likewise pi.themes), so nothing ships unregistered.
 *   - Sensitivity (negative control): dropping one root entry is detected as drift
 *     (exit 1), so the check is not vacuous. The root file is restored afterwards.
 *
 * No extension build / no model: a pure filesystem + script-process test.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/root-manifest-parity.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";
import { withMutatedFile } from "../../../shared/test/negative-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SYNC = path.join(REPO_ROOT, "scripts", "sync-root-manifest.mjs");
const ROOT_PKG = path.join(REPO_ROOT, "package.json");

const { check, counts } = createChecker();

function runCheck() {
	return spawnSync("node", [SYNC, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
}

async function main() {
	check("sync-root-manifest.mjs exists", fs.existsSync(SYNC));

	// 1) Root manifest in sync with the derivation from sub-packages.
	const res = runCheck();
	check(
		"sync-root-manifest.mjs --check is in sync (root pi manifest == derivation)",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" | ")}`,
	);

	// 2) Coverage: every sub-package pi.extensions/pi.themes entry is present in the root.
	const root = JSON.parse(fs.readFileSync(ROOT_PKG, "utf8"));
	const extensionsDir = path.join(REPO_ROOT, "extensions");
	const dirs = fs
		.readdirSync(extensionsDir)
		.filter(
			(d) => (d === "pandi" || d.startsWith("pandi-")) && fs.existsSync(path.join(extensionsDir, d, "package.json")),
		);
	check("extension packages discovered", dirs.length >= 20, `found ${dirs.length}`);
	for (const dir of dirs) {
		const pkg = JSON.parse(fs.readFileSync(path.join(extensionsDir, dir, "package.json"), "utf8"));
		for (const entry of pkg.pi?.extensions ?? []) {
			const rootEntry = `./extensions/${dir}/${entry.replace(/^\.\//, "")}`;
			check(
				`root pi.extensions registers ${dir}`,
				(root.pi?.extensions ?? []).includes(rootEntry),
				`missing ${rootEntry}`,
			);
		}
		for (const entry of pkg.pi?.themes ?? []) {
			const rootEntry = `./extensions/${dir}/${entry.replace(/^\.\//, "")}`;
			check(`root pi.themes registers ${dir}`, (root.pi?.themes ?? []).includes(rootEntry), `missing ${rootEntry}`);
		}
	}

	// 3) Sensitivity: drop the last root pi.extensions entry and confirm --check catches it.
	const dropLastExtension = (orig) => {
		const mutated = JSON.parse(orig);
		mutated.pi.extensions = mutated.pi.extensions.slice(0, -1);
		return `${JSON.stringify(mutated, null, "\t")}\n`;
	};
	await withMutatedFile(ROOT_PKG, dropLastExtension, () => {
		const drifted = runCheck();
		check("a dropped root entry is detected as drift (exit 1)", drifted.status === 1, `exit=${drifted.status}`);
	});
	// Confirm the revert restored sync (guards against leaving the tree dirty).
	check("root manifest restored to in-sync after the negative control", runCheck().status === 0);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

await main();
