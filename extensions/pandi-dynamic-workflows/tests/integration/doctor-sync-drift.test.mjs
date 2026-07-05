/**
 * Durable test for the sync-drift check added to extensions/pandi-doctor/scripts/doctor.mjs.
 *
 * doctor is a read-only environment reporter. This pins ONE new behavior: doctor surfaces
 * whether the global Claude home (default ~/.claude) is in sync with this repo, delegating to
 * scripts/sync-claude-global.mjs --check. The destination is injectable via CLAUDE_GLOBAL_DIR —
 * the same seam the sync script uses — so this test runs against a throwaway tmp dir and never
 * touches the real $HOME.
 *
 * It pins:
 *   - Presence: doctor always prints a "sync Claude global" line (so the capability is visible).
 *   - In-sync: right after a real sync into the tmp dest, the line reports OK (✓).
 *   - Drift (negative control): tampering a synced file flips the line to a warning (⚠), so the
 *     check is not vacuous.
 *   - Non-fatal: the sync-drift state is OPTIONAL — it never turns a warning into a hard failure
 *     line, i.e. doctor's overall verdict is not driven to exit(1) by drift alone.
 *
 * We assert on stdout only (NO_COLOR path is taken when stdout is not a TTY), never on doctor's
 * exit code, since that depends on unrelated required tools present on the host / CI.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/doctor-sync-drift.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DOCTOR = path.join(REPO_ROOT, "extensions", "pandi-doctor", "scripts", "doctor.mjs");
const SYNC = path.join(REPO_ROOT, "scripts", "sync-claude-global.mjs");

const { check, counts } = createChecker();

function runDoctor(globalDir) {
	return spawnSync(process.execPath, [DOCTOR], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_GLOBAL_DIR: globalDir, NO_COLOR: "1" },
	});
}

function runSync(dest) {
	return spawnSync(process.execPath, [SYNC, "--dest", dest], { cwd: REPO_ROOT, encoding: "utf8" });
}

// The line doctor prints for this capability. Matched loosely (label text may evolve) but must
// name the sync check and carry a status glyph.
const SYNC_LINE = /sync Claude global/i;

function main() {
	check("doctor.mjs exists", fs.existsSync(DOCTOR));
	check("sync-claude-global.mjs exists", fs.existsSync(SYNC));
	if (!fs.existsSync(DOCTOR) || !fs.existsSync(SYNC)) return finish();

	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-global-"));

	// 1) Populate the tmp global, then doctor should report OK for it.
	const sres = runSync(dest);
	check("sync into tmp dest exits 0", sres.status === 0, `exit=${sres.status}`);

	const okRun = runDoctor(dest);
	const okOut = okRun.stdout || "";
	const okLine = okOut.split("\n").find((l) => SYNC_LINE.test(l)) || "";
	check(
		"doctor prints a sync Claude global line",
		okLine !== "",
		`stdout tail: ${okOut.trim().split("\n").slice(-3).join(" | ")}`,
	);
	check("in-sync dest reports OK (✓)", okLine.includes("✓"), `line: ${okLine.trim()}`);

	// 2) Negative control: tamper a synced file → doctor must flip to a warning (⚠), not OK.
	fs.appendFileSync(path.join(dest, "skills", "ultracode", "SKILL.md"), "\n<!-- tampered -->\n");
	const driftRun = runDoctor(dest);
	const driftLine = (driftRun.stdout || "").split("\n").find((l) => SYNC_LINE.test(l)) || "";
	check("drift dest reports a warning (⚠)", driftLine.includes("⚠"), `line: ${driftLine.trim()}`);
	check("drift dest does NOT report OK (✓)", !driftLine.includes("✓"), `line: ${driftLine.trim()}`);
	// Actionable count: exactly one file was tampered, so the line must name that count.
	check("drift line reports the file count (1 archivo)", /\(1 archivo\)/.test(driftLine), `line: ${driftLine.trim()}`);

	fs.rmSync(dest, { recursive: true, force: true });
	finish();
}

function finish() {
	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log(`Failures:\n  - ${counts.failures.join("\n  - ")}`);
		process.exit(1);
	}
}

main();
