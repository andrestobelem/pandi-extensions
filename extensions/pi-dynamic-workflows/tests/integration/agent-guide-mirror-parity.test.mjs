/**
 * Durable parity test for the root agent guide: AGENTS.md (SOURCE OF TRUTH, read by Pi and the
 * cross-agent standard) is mirrored byte-identically to CLAUDE.md (read by Claude Code) by
 * `scripts/sync-agent-guides.mjs`. Nothing else pins them, so a hand-edit to one copy would
 * silently drift the guides out of sync.
 *
 * This pins:
 *   - In sync: `sync-agent-guides.mjs --check` exits 0 (CLAUDE.md byte-equals AGENTS.md).
 *   - Sensitivity (negative control): a one-line tweak to CLAUDE.md is detected as drift
 *     (exit 1), then reverted, so the check is not vacuous.
 *
 * No extension build / no model: a pure filesystem + script-process test.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/agent-guide-mirror-parity.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";
import { withMutatedFile } from "../../../shared/test/negative-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SYNC = path.join(REPO_ROOT, "scripts", "sync-agent-guides.mjs");
const AGENTS = path.join(REPO_ROOT, "AGENTS.md");
const CLAUDE = path.join(REPO_ROOT, "CLAUDE.md");

const { check, counts } = createChecker();

function runCheck() {
	return spawnSync("node", [SYNC, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
}

async function main() {
	check("sync-agent-guides.mjs exists", fs.existsSync(SYNC));
	check("AGENTS.md exists (source of truth)", fs.existsSync(AGENTS));
	check("CLAUDE.md exists (mirror)", fs.existsSync(CLAUDE));

	// 1) In sync + byte-identical.
	const res = runCheck();
	check(
		"sync-agent-guides.mjs --check is in sync (CLAUDE.md == AGENTS.md)",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-1).join(" | ")}`,
	);
	if (fs.existsSync(AGENTS) && fs.existsSync(CLAUDE)) {
		const a = fs.readFileSync(AGENTS, "utf8");
		const b = fs.readFileSync(CLAUDE, "utf8");
		check(
			"root agent guide is byte-identical across hosts",
			a === b && a.length > 100,
			`agents=${a.length} claude=${b.length}`,
		);
	}

	// 2) Sensitivity: mutate the mirror by one line and confirm --check catches it, then revert.
	await withMutatedFile(
		CLAUDE,
		(orig) => `${orig}\n<!-- drift -->\n`,
		() => {
			const drifted = runCheck();
			check(
				"a one-line tweak to CLAUDE.md is detected as drift (exit 1)",
				drifted.status === 1,
				`exit=${drifted.status}`,
			);
		},
	);
	check("mirror restored to in-sync after the negative control", runCheck().status === 0);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

await main();
