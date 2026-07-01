/**
 * Durable test for scripts/sync-claude-global.mjs — the operator tool that mirrors this
 * repo's Claude-facing assets into a global Claude Code home (default ~/.claude).
 *
 * The destination is injectable (--dest <dir> / CLAUDE_GLOBAL_DIR) precisely so this test can
 * run against a throwaway tmp dir and never touch the real $HOME. Source of truth = the repo.
 *
 * This pins:
 *   - Landing: after a sync, the managed set exists at the destination — workflows (all .js +
 *     README), the runtime script (build-workflow-artifact.mjs), the project skills, and the
 *     ultracode primitives reference (sourced from .pi canonical).
 *   - Idempotent --check: immediately after a sync, `--check` exits 0 (no drift).
 *   - Sensitivity (negative control): tampering one synced file makes `--check` exit 1, so the
 *     check is not vacuous.
 *   - No prune: a foreign file already in the destination (e.g. a global-only skill) survives a
 *     sync — we never delete unmanaged global content.
 *
 * No extension build / no model: a pure filesystem + script-process test.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/sync-claude-global.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SYNC = path.join(REPO_ROOT, "scripts", "sync-claude-global.mjs");

// Committed skills the sync must always publish.
const REQUIRED_SKILLS = [
	"ultracode",
	"karpathy-guidelines",
	"modern-software-engineering",
	"installing-pi-dynamic-workflows",
];
// Local-only skills (e.g. open-prose is intentionally gitignored): synced best-effort when present
// on disk, so this assertion must be conditional or it goes red on a fresh clone / CI.
const OPTIONAL_SKILLS = ["open-prose"];

const { check, counts } = createChecker();

function run(dest, extra = []) {
	return spawnSync("node", [SYNC, "--dest", dest, ...extra], { cwd: REPO_ROOT, encoding: "utf8" });
}

function main() {
	check("sync-claude-global.mjs exists", fs.existsSync(SYNC));
	if (!fs.existsSync(SYNC)) return finish();

	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-"));

	// No-prune fixture: a foreign global-only skill that must survive the sync.
	const foreign = path.join(dest, "skills", "supacode-cli");
	fs.mkdirSync(foreign, { recursive: true });
	fs.writeFileSync(path.join(foreign, "SKILL.md"), "# foreign global-only skill\n");

	// 1) Sync into the tmp dest.
	const res = run(dest);
	check(
		"sync exits 0",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-2).join(" | ")}`,
	);

	// 2) Workflows landed (all .js from .claude/workflows + README).
	const srcWf = path.join(REPO_ROOT, ".claude", "workflows");
	const wantWf = fs.readdirSync(srcWf).filter((f) => f.endsWith(".js")).length;
	const gotWf = fs.existsSync(path.join(dest, "workflows"))
		? fs.readdirSync(path.join(dest, "workflows")).filter((f) => f.endsWith(".js")).length
		: 0;
	check("all workflow .js landed", gotWf === wantWf && wantWf > 0, `want=${wantWf} got=${gotWf}`);
	check("workflows README landed", fs.existsSync(path.join(dest, "workflows", "README.md")));

	// 3) Runtime script landed.
	check(
		"build-workflow-artifact.mjs landed",
		fs.existsSync(path.join(dest, "scripts", "build-workflow-artifact.mjs")),
	);

	// 4) Project skills landed. Required ones must; optional (local-only) ones only if present in source.
	for (const s of REQUIRED_SKILLS) {
		check(`skill '${s}' landed`, fs.existsSync(path.join(dest, "skills", s, "SKILL.md")));
	}
	for (const s of OPTIONAL_SKILLS) {
		if (fs.existsSync(path.join(REPO_ROOT, ".claude", "skills", s, "SKILL.md"))) {
			check(
				`optional skill '${s}' landed (present on disk)`,
				fs.existsSync(path.join(dest, "skills", s, "SKILL.md")),
			);
		}
	}

	// 5) Primitives reference landed (sourced from .pi canonical) — byte-identical, README included.
	const srcPrim = path.join(REPO_ROOT, ".pi", "skills", "ultracode", "reference", "primitives");
	const wantPrim = fs
		.readdirSync(srcPrim)
		.filter((f) => f.endsWith(".md"))
		.sort();
	const dstPrim = path.join(dest, "skills", "ultracode", "reference", "primitives");
	const gotPrim = fs.existsSync(dstPrim)
		? fs
				.readdirSync(dstPrim)
				.filter((f) => f.endsWith(".md"))
				.sort()
		: [];
	check(
		"all primitives docs landed",
		wantPrim.length > 0 && wantPrim.join(",") === gotPrim.join(","),
		`want=${wantPrim.length} got=${gotPrim.length}`,
	);
	const primDrift = wantPrim.filter(
		(f) =>
			!gotPrim.includes(f) ||
			fs.readFileSync(path.join(srcPrim, f), "utf8") !== fs.readFileSync(path.join(dstPrim, f), "utf8"),
	);
	check("primitives docs are byte-identical to canonical", primDrift.length === 0, `drift: ${primDrift.join(", ")}`);

	// 6) Idempotent --check right after a sync: no drift.
	const chk = run(dest, ["--check"]);
	check("--check is in sync after sync", chk.status === 0, `exit=${chk.status}`);

	// 7) Negative control: tamper a synced file → --check must detect drift.
	fs.appendFileSync(path.join(dest, "skills", "ultracode", "SKILL.md"), "\n<!-- tampered -->\n");
	const chk2 = run(dest, ["--check"]);
	check("--check detects drift (negative control)", chk2.status === 1, `exit=${chk2.status}`);

	// 8) No prune: the foreign global-only skill survived.
	check("foreign global-only skill survived (no prune)", fs.existsSync(path.join(foreign, "SKILL.md")));

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
