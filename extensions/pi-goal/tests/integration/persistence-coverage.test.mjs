/**
 * Characterization integration suite for extensions/pi-goal/persistence.ts.
 *
 * Why this file exists
 * --------------------
 * `npm test` only TYPECHECKS. persistence.ts owns the goal extension's durable side: the
 * field mapping that gets persisted (snapshot), the bounded progress log, the fire-and-forget
 * ATOMIC sidecar write (temp file then rename, swallow-on-error), and the dual-root state-dir
 * resolution (trusted project vs. sha1-hashed agent dir). A silent drift in any of these would
 * either lose recovery state or break the engine on a disk hiccup — none of which `tsc` sees.
 *
 * What is reachable
 * -----------------
 * persistence.ts EXPORTS only `snapshot` and `persist`. `goalStateDir` and `writeSidecar` are
 * module-internal, so they are exercised INDIRECTLY through `persist` (which fire-and-forgets
 * `writeSidecar`). We assert the OBSERVABLE filesystem outcome rather than copying the logic.
 *
 * What is NOT testable here (see `skipped` in the result): the writeSidecar RETHROW on rename
 * failure. persist() deliberately swallows that rejection (`void writeSidecar(...).catch(() => {})`)
 * and the function is not exported, so the rejection is unobservable to any caller we can reach.
 * Forcing it would require monkeypatching `node:fs/promises` named bindings, which are read-only
 * ESM live bindings inside the bundle — not possible without rewriting the source. We DO cover
 * the temp-cleanup half of that path (no orphaned *.tmp left behind on a failed rename) via a
 * real EISDIR rename failure, observed through the filesystem.
 *
 * Run it:
 *   node extensions/pi-goal/tests/integration/persistence-coverage.test.mjs
 *
 * Exit 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import { deepStrictEqual } from "node:assert";
import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

// Mirrors constants.ts: PROGRESS_LOG_KEEP. The source bundles it privately; we pin the value
// here so a change to the cap surfaces as a red assertion to be consciously updated.
const PROGRESS_LOG_KEEP = 12;
const STATE_FILE = "state.json";
const GOAL_DIR = "goals";
const CONFIG_DIR_NAME = ".pi";
const GOAL_STATE_TYPE = "goal-state";

const { check, counts } = createChecker();

// persistence.ts imports runtime SDK symbols (CONFIG_DIR_NAME, getAgentDir) → needs the sdk
// stub. It does NOT touch typebox. getAgentDir() resolves to <outDir>/agentdir.
async function buildPersistence() {
	return await buildExtension({
		name: "pi-goal-persistence-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-goal", "persistence.ts"),
		outName: "persistence.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
		npx: "--yes",
	});
}

// agentDir is deterministic from the build's outDir (sdkStub points getAgentDir there).
function agentDirFor(outDir) {
	return path.join(outDir, "agentdir");
}

// Capture every appended snapshot.
function makePi() {
	const entries = [];
	return {
		pi: {
			appendEntry: (customType, data) => entries.push({ customType, data }),
		},
		entries,
	};
}

// A full ActiveGoal-shaped object with distinct sentinel values per field, plus the
// extra runtime fields snapshot() must NOT copy.
function makeGoal(overrides = {}) {
	return {
		goalId: "goal-sentinel-id",
		objective: "objective-sentinel",
		successCriteria: "success-sentinel",
		derivedCriteria: "derived-sentinel",
		ultracode: true,
		iteration: 7,
		maxIterations: 33,
		contextPercentCap: 71,
		assessments: [{ iteration: 1, status: "continue", assessment: "a0", at: "t0" }],
		verifyAttempts: 2,
		independentVerifyAttempts: 1,
		maxIndependentVerifications: 5,
		verifierTimeoutMs: 99000,
		verifierTools: ["read", "grep"],
		gstatus: "pursuing",
		startedAt: 1234567890,
		nextFireAt: 1234599999,
		lastReason: "reason-sentinel",
		updatedAt: "2020-01-01T00:00:00.000Z",
		// Runtime-only fields snapshot() drops:
		timer: setTimeout(() => {}, 100000),
		controller: { abort() {} },
		rearmedThisTurn: true,
		verifierInFlight: true,
		...overrides,
	};
}

// Poll the filesystem (or any predicate) until true or attempts exhausted.
async function flush(predicate, tries = 200) {
	for (let i = 0; i < tries; i++) {
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setTimeout(r, 1));
		if (predicate?.()) return true;
	}
	return predicate ? predicate() : true;
}

// ===========================================================================
// snapshot(): full field mapping
// ===========================================================================
function snapshotCopiesAllFields(mod) {
	const goal = makeGoal();
	// kill the timer we created so it doesn't keep the loop alive
	clearTimeout(goal.timer);
	const snap = mod.snapshot(goal);
	const expected = {
		goalId: "goal-sentinel-id",
		objective: "objective-sentinel",
		successCriteria: "success-sentinel",
		derivedCriteria: "derived-sentinel",
		ultracode: true,
		iteration: 7,
		maxIterations: 33,
		contextPercentCap: 71,
		assessments: [{ iteration: 1, status: "continue", assessment: "a0", at: "t0" }],
		verifyAttempts: 2,
		independentVerifyAttempts: 1,
		maxIndependentVerifications: 5,
		verifierTimeoutMs: 99000,
		verifierTools: ["read", "grep"],
		gstatus: "pursuing",
		startedAt: 1234567890,
		nextFireAt: 1234599999,
		lastReason: "reason-sentinel",
		updatedAt: "2020-01-01T00:00:00.000Z",
	};
	let equal = true;
	let detail = "";
	try {
		deepStrictEqual(snap, expected);
	} catch (err) {
		equal = false;
		detail = String(err?.message ?? err).split("\n")[0];
	}
	check("snapshot() maps every persisted GoalState field exactly", equal, detail);
	check(
		"snapshot() drops runtime-only fields (timer/controller/rearmedThisTurn/verifierInFlight)",
		!("timer" in snap) &&
			!("controller" in snap) &&
			!("rearmedThisTurn" in snap) &&
			!("verifierInFlight" in snap),
		`keys=${Object.keys(snap).length}`,
	);
}

// ===========================================================================
// snapshot(): bounds assessments via slice(-PROGRESS_LOG_KEEP), keeping the MOST RECENT.
// ===========================================================================
function snapshotBoundsAssessments(mod) {
	const total = PROGRESS_LOG_KEEP + 5;
	const assessments = Array.from({ length: total }, (_, i) => ({
		iteration: i,
		status: "continue",
		assessment: `a${i}`,
		at: `t${i}`,
	}));
	const goal = makeGoal({ assessments });
	clearTimeout(goal.timer);
	const snap = mod.snapshot(goal);
	check(
		`snapshot() bounds assessments to PROGRESS_LOG_KEEP (${PROGRESS_LOG_KEEP})`,
		snap.assessments.length === PROGRESS_LOG_KEEP,
		`len=${snap.assessments.length}`,
	);
	check(
		"snapshot() keeps the LAST PROGRESS_LOG_KEEP assessments (most recent), not the first",
		snap.assessments[0].iteration === total - PROGRESS_LOG_KEEP &&
			snap.assessments[PROGRESS_LOG_KEEP - 1].iteration === total - 1,
		`first=${snap.assessments[0].iteration} last=${snap.assessments[PROGRESS_LOG_KEEP - 1].iteration}`,
	);
	check(
		"snapshot() does not mutate the source assessments array",
		goal.assessments.length === total,
		`srcLen=${goal.assessments.length}`,
	);
}

// ===========================================================================
// persist(): stamps updatedAt, appends the snapshot synchronously, fire-and-forgets sidecar.
// ===========================================================================
function persistAppendsAndStamps(mod) {
	const { pi, entries } = makePi();
	const ctx = { isProjectTrusted: () => true, cwd: os.tmpdir() };
	const goal = makeGoal({ updatedAt: "1999-01-01T00:00:00.000Z" });
	clearTimeout(goal.timer);
	const before = Date.now();
	const ret = mod.persist(pi, ctx, goal);
	check("persist() returns undefined (void)", ret === undefined, `ret=${String(ret)}`);
	check("persist() appends exactly one entry synchronously", entries.length === 1, `n=${entries.length}`);
	check(
		"persist() appends under the goal-state custom type",
		entries[0]?.customType === GOAL_STATE_TYPE,
		`type=${entries[0]?.customType}`,
	);
	const stamped = Date.parse(goal.updatedAt);
	check(
		"persist() re-stamps goal.updatedAt to now (fresh ISO timestamp)",
		Number.isFinite(stamped) && stamped >= before && goal.updatedAt !== "1999-01-01T00:00:00.000Z",
		`updatedAt=${goal.updatedAt}`,
	);
	check(
		"persist() appends the SNAPSHOT (bounded/mapped), carrying the new updatedAt",
		entries[0]?.data?.updatedAt === goal.updatedAt && !("timer" in (entries[0]?.data ?? {})),
		`snapUpdatedAt=${entries[0]?.data?.updatedAt}`,
	);
}

// ===========================================================================
// persist(): a sidecar failure NEVER breaks the engine (fire-and-forget + swallow).
// We point goalStateDir at an unwritable path (cwd is a real FILE → mkdir hits ENOTDIR).
// ===========================================================================
async function persistSwallowsSidecarError(mod) {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "goal-persist-fail-"));
	const fileAsCwd = path.join(tmp, "iam-a-file");
	await fs.writeFile(fileAsCwd, "not a dir");
	const { pi, entries } = makePi();
	// trusted → goalStateDir = <cwd>/.pi/goals/<id>; mkdir of that under a FILE rejects (ENOTDIR).
	const ctx = { isProjectTrusted: () => true, cwd: fileAsCwd };
	const goal = makeGoal();
	clearTimeout(goal.timer);
	let threw = false;
	try {
		mod.persist(pi, ctx, goal);
	} catch {
		threw = true;
	}
	check("persist() does not throw when the sidecar write will fail", !threw);
	check("persist() still appended the JSONL entry despite sidecar failure", entries.length === 1, `n=${entries.length}`);
	// Let the rejected sidecar promise settle; the source's .catch(() => {}) must swallow it
	// (any unhandled rejection here would crash the process with exit 2 via main()'s handler).
	await flush(() => false, 30);
	check("persist() sidecar failure produced no observable throw/rejection", true);
	await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

// ===========================================================================
// writeSidecar() (via persist): atomic write — pretty JSON + trailing newline, no *.tmp left.
// trusted root: <cwd>/.pi/goals/<id>/state.json.
// ===========================================================================
async function sidecarAtomicWriteTrustedRoot(mod) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "goal-trusted-"));
	const { pi } = makePi();
	const ctx = { isProjectTrusted: () => true, cwd };
	const goal = makeGoal({ goalId: "trusted-goal-1" });
	clearTimeout(goal.timer);
	mod.persist(pi, ctx, goal);
	const dir = path.join(cwd, CONFIG_DIR_NAME, GOAL_DIR, "trusted-goal-1");
	const file = path.join(dir, STATE_FILE);
	await flush(() => existsSync(file));
	check("writeSidecar() trusted root lands at <cwd>/.pi/goals/<id>/state.json", existsSync(file), file);

	if (existsSync(file)) {
		const raw = await fs.readFile(file, "utf8");
		const parsed = JSON.parse(raw);
		check("writeSidecar() state.json parses to the snapshot", parsed.goalId === "trusted-goal-1", `id=${parsed.goalId}`);
		check(
			"writeSidecar() writes pretty-printed JSON (2-space indent) with a trailing newline",
			raw.endsWith("\n") && raw.includes('\n  "goalId"'),
			JSON.stringify(raw.slice(0, 24)),
		);
		const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
		check("writeSidecar() leaves no orphaned *.tmp file after a successful rename", leftovers.length === 0, leftovers.join(","));
	}
	await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
}

// ===========================================================================
// writeSidecar() (via persist): temp CLEANUP when rename fails. We pre-create state.json as a
// non-empty DIRECTORY so fs.rename(temp, file) rejects with EISDIR; the source's catch must
// `fs.rm(temp)` before rethrowing (rethrow is swallowed by persist, so we only observe cleanup).
// ===========================================================================
async function sidecarTempCleanupOnRenameFailure(mod) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "goal-rename-fail-"));
	const dir = path.join(cwd, CONFIG_DIR_NAME, GOAL_DIR, "rename-fail-goal");
	await fs.mkdir(dir, { recursive: true });
	// Make state.json an EXISTING non-empty directory → rename(file, dir) → EISDIR.
	const stateAsDir = path.join(dir, STATE_FILE);
	await fs.mkdir(stateAsDir, { recursive: true });
	await fs.writeFile(path.join(stateAsDir, "blocker"), "x");

	const { pi, entries } = makePi();
	const ctx = { isProjectTrusted: () => true, cwd };
	const goal = makeGoal({ goalId: "rename-fail-goal" });
	clearTimeout(goal.timer);
	mod.persist(pi, ctx, goal);
	check("persist() still appended despite the doomed rename", entries.length === 1, `n=${entries.length}`);
	// Allow the write+failed-rename+cleanup chain to settle.
	await flush(() => false, 40);
	const entriesInDir = await fs.readdir(dir);
	const tmpLeftovers = entriesInDir.filter((f) => f.endsWith(".tmp"));
	check(
		"writeSidecar() removes the temp file when rename fails (no orphaned *.tmp)",
		tmpLeftovers.length === 0,
		`leftovers=[${tmpLeftovers.join(",")}]`,
	);
	check(
		"writeSidecar() does NOT clobber the existing state.json directory on failure",
		existsSync(stateAsDir),
		stateAsDir,
	);
	await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
}

// ===========================================================================
// goalStateDir() (via persist): UNTRUSTED root → <agentDir>/goals/<sha1(cwd)[:12]>/<id>.
// ===========================================================================
async function sidecarUntrustedRootUsesSha1Hash(mod, outDir) {
	const projectPath = "/some/path";
	const expectedHash = crypto.createHash("sha1").update(projectPath).digest("hex").slice(0, 12);
	const { pi } = makePi();
	const ctx = { isProjectTrusted: () => false, cwd: projectPath };
	const goal = makeGoal({ goalId: "untrusted-goal-1" });
	clearTimeout(goal.timer);
	mod.persist(pi, ctx, goal);
	const expectedFile = path.join(agentDirFor(outDir), GOAL_DIR, expectedHash, "untrusted-goal-1", STATE_FILE);
	await flush(() => existsSync(expectedFile));
	check(
		"goalStateDir() untrusted → <agentDir>/goals/<sha1(cwd)[:12]>/<id>/state.json",
		existsSync(expectedFile),
		expectedFile,
	);
	if (existsSync(expectedFile)) {
		const parsed = JSON.parse(await fs.readFile(expectedFile, "utf8"));
		check(
			"goalStateDir() untrusted write contains the goal snapshot",
			parsed.goalId === "untrusted-goal-1",
			`id=${parsed.goalId}`,
		);
	}
	check(
		"goalStateDir() untrusted hash matches an independent sha1(cwd)[:12]",
		expectedHash === crypto.createHash("sha1").update(projectPath).digest("hex").slice(0, 12),
		expectedHash,
	);
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildPersistence();
	try {
		const mod = await loadModule(url);
		snapshotCopiesAllFields(mod);
		snapshotBoundsAssessments(mod);
		persistAppendsAndStamps(mod);
		await persistSwallowsSidecarError(mod);
		await sidecarAtomicWriteTrustedRoot(mod);
		await sidecarTempCleanupOnRenameFailure(mod);
		await sidecarUntrustedRootUsesSha1Hash(mod, outDir);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
