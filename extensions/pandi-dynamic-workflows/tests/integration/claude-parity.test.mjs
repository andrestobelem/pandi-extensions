/**
 * Durable parity test: the .claude/workflows/*.js scaffolds are GENERATED artifacts,
 * deterministically produced from the canonical pi scaffolds
 * (extensions/pandi-dynamic-workflows/scaffolds/*.js) by
 * .claude/scripts/generate-claude-workflows.mjs.
 *
 * This pins:
 *   - In sync: `generate-claude-workflows.mjs --check` exits 0 (every committed Claude
 *     file byte-equals the generator's output). Fails if anyone hand-edits a Claude
 *     scaffold, or edits a pi scaffold without regenerating.
 *   - Shape: each Claude scaffold is a top-level script — starts with `export const
 *     meta`, is valid top-level-script syntax, and contains NO `export default`
 *     (Claude Code's Workflow tool rejects export-default-main; it needs top-level scripts).
 *   - Sensitivity (negative control): a one-character tweak to a generated file is
 *     detected as drift, so the parity check is not vacuous.
 *
 * No extension build / no model: this is a pure filesystem + generator-process test.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/claude-parity.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";
import { withMutatedFile } from "../../../shared/test/negative-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const GEN = path.join(REPO_ROOT, ".claude", "scripts", "generate-claude-workflows.mjs");
const SRC_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds");
const OUT_DIR = path.join(REPO_ROOT, ".claude", "workflows");
// Second generated destination (#26): the ultracode skill carries its own copy of the
// Claude-side catalog so the skill stays self-contained in standalone installs; it is
// generated from the SAME canonical scaffolds and must stay byte-equal to OUT_DIR.
const SNAPSHOT_DIR = path.join(REPO_ROOT, ".pi", "skills", "ultracode", "reference", "claude-workflows");

const { check, counts } = createChecker();

async function main() {
	// 1) Generated == committed for all scaffolds.
	const res = spawnSync("node", [GEN, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
	check(
		"generate-claude-workflows.mjs --check is in sync (Claude files == generator output)",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" | ")}`,
	);

	// 2) Every Claude scaffold is a valid top-level-script shape, one per pi scaffold.
	const srcNames = fs
		.readdirSync(SRC_DIR)
		.filter((f) => f.endsWith(".js"))
		.sort();
	const outNames = fs
		.readdirSync(OUT_DIR)
		.filter((f) => f.endsWith(".js"))
		.sort();
	check(
		"every pi scaffold has a generated Claude counterpart (1:1)",
		srcNames.length > 0 && srcNames.join(",") === outNames.join(","),
		`pi=${srcNames.length} claude=${outNames.length}`,
	);

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-parity-"));
	for (const name of outNames) {
		const text = fs.readFileSync(path.join(OUT_DIR, name), "utf8");
		check(`${name}: starts with \`export const meta\``, /^export const meta\b/m.test(text.trimStart()));
		check(
			`${name}: contains no \`export default\` (Claude rejects export-default-main)`,
			!/\bexport default\b/.test(text),
		);
		// Valid top-level-script syntax: wrap the body in a function (mirrors how both
		// runtimes execute these) so a top-level `return`/`await` is legal, then node --check.
		const wrapped = path.join(tmp, name.replace(/\.js$/, ".cjs"));
		fs.writeFileSync(wrapped, `(async function(){\n${text.replace(/^export const /m, "const ")}\n})();\n`);
		const chk = spawnSync("node", ["--check", wrapped], { encoding: "utf8" });
		check(
			`${name}: valid top-level-script syntax (wrapped node --check)`,
			chk.status === 0,
			(chk.stderr || "").trim().split("\n")[0],
		);
	}
	fs.rmSync(tmp, { recursive: true, force: true });

	// 3) Snapshot parity (#26): the ultracode skill's reference copy is the SAME generated
	//    artifact — every catalog file must be byte-equal in the snapshot dir.
	for (const name of outNames) {
		let snapText = null;
		try {
			snapText = fs.readFileSync(path.join(SNAPSHOT_DIR, name), "utf8");
		} catch {}
		const catText = fs.readFileSync(path.join(OUT_DIR, name), "utf8");
		check(
			`snapshot: reference/claude-workflows/${name} is byte-equal to .claude/workflows/${name}`,
			snapText === catText,
			snapText === null ? "missing in snapshot dir" : `snapshot=${snapText.length}B catalog=${catText.length}B`,
		);
	}

	// 4) Sensitivity / negative control: a one-char tweak must register as drift.
	const sample = outNames[0];
	const samplePath = path.join(OUT_DIR, sample);
	const original = fs.readFileSync(samplePath, "utf8");
	await withMutatedFile(samplePath, `${original}\nconst __drift_probe__ = 1;\n`, () => {
		const tweaked = spawnSync("node", [GEN, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
		check(
			`negative control: a hand-edit to ${sample} is detected as drift (--check exits non-zero)`,
			tweaked.status !== 0,
			`exit=${tweaked.status}`,
		);
	});
	check(`negative control restored ${sample} byte-for-byte`, fs.readFileSync(samplePath, "utf8") === original);

	// 5) Negative control for the SNAPSHOT destination: --check must also watch it.
	const snapSamplePath = path.join(SNAPSHOT_DIR, sample);
	let snapOriginal = null;
	try {
		snapOriginal = fs.readFileSync(snapSamplePath, "utf8");
	} catch {}
	if (snapOriginal !== null) {
		await withMutatedFile(snapSamplePath, `${snapOriginal}\nconst __snapshot_drift_probe__ = 1;\n`, () => {
			const tweaked = spawnSync("node", [GEN, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
			check(
				`negative control: a hand-edit to the SNAPSHOT copy of ${sample} is detected as drift`,
				tweaked.status !== 0,
				`exit=${tweaked.status}`,
			);
		});
		check(
			`negative control restored snapshot ${sample} byte-for-byte`,
			fs.readFileSync(snapSamplePath, "utf8") === snapOriginal,
		);
	} else {
		check(`negative control: snapshot copy of ${sample} exists`, false, "missing in snapshot dir");
	}

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
	process.exit(0);
}

await main();
