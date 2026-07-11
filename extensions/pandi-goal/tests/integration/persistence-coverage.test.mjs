/**
 * Suite de integración de caracterización para extensions/pandi-goal/persistence.ts.
 *
 * Por qué existe este archivo
 * --------------------
 * `npm test` solo hace TYPECHECK. persistence.ts posee el lado durable de la extensión goal: el
 * mapeo de campos persistido (snapshot), el log de progreso acotado y la entry JSONL `goal-state`
 * que constituye la única fuente de recovery. También fija el límite negativo: persist no crea ni
 * actualiza `.pi/goals/<id>/state.json`; sidecars legados quedan inertes. `tsc` no ve nada de eso.
 *
 * Qué es alcanzable
 * -----------------
 * persistence.ts exporta `snapshot` y `persist`. Afirmamos el snapshot y la entry capturada por un
 * mock de `pi.appendEntry`, más la ausencia observable del antiguo artifact en un proyecto temporal.
 *
 * Ejecución:
 *   node extensions/pandi-goal/tests/integration/persistence-coverage.test.mjs
 *
 * Exit 0 = todos los checks pasaron; 1 = falló un check de comportamiento; 2 = falló el harness.
 */

import { deepStrictEqual } from "node:assert";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createChecker, loadModule } from "../../../shared/test/harness.mjs";
import {
	buildPersistence,
	flushFs,
	GOAL_STATE_TYPE,
	makeActiveGoal,
	makeAppendPi,
	PROGRESS_LOG_KEEP,
} from "./goal-test-support.mjs";

const { check, counts } = createChecker();

// ===========================================================================
// snapshot(): mapeo completo de campos
// ===========================================================================
function snapshotCopiesAllFields(mod) {
	const goal = makeActiveGoal();
	// cancelar el timer creado para que no mantenga vivo el event loop
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
		!("timer" in snap) && !("controller" in snap) && !("rearmedThisTurn" in snap) && !("verifierInFlight" in snap),
		`keys=${Object.keys(snap).length}`,
	);
}

// ===========================================================================
// snapshot(): acota assessments vía slice(-PROGRESS_LOG_KEEP), conservando los MÁS RECIENTES.
// ===========================================================================
function snapshotBoundsAssessments(mod) {
	const total = PROGRESS_LOG_KEEP + 5;
	const assessments = Array.from({ length: total }, (_, i) => ({
		iteration: i,
		status: "continue",
		assessment: `a${i}`,
		at: `t${i}`,
	}));
	const goal = makeActiveGoal({ assessments });
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
// persist(): marca updatedAt y agrega el snapshot JSONL sincrónicamente.
// ===========================================================================
function persistAppendsAndStamps(mod) {
	const { pi, entries } = makeAppendPi();
	const ctx = { isProjectTrusted: () => true, cwd: os.tmpdir() };
	const goal = makeActiveGoal({ updatedAt: "1999-01-01T00:00:00.000Z" });
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
// Contrato JSONL-only: persist agrega exactamente una entry y no escribe state.json.
// ===========================================================================
async function persistWritesJsonlOnly(mod) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "goal-jsonl-only-"));
	try {
		const { pi, entries } = makeAppendPi();
		const ctx = { isProjectTrusted: () => true, cwd };
		const goal = makeActiveGoal({ goalId: "jsonl-only-goal" });
		clearTimeout(goal.timer);

		mod.persist(pi, ctx, goal);
		const stateFile = path.join(cwd, ".pi", "goals", goal.goalId, "state.json");
		await flushFs(() => existsSync(stateFile));

		check("persist() appends exactly one JSONL goal-state entry", entries.length === 1, `n=${entries.length}`);
		check(
			"persist() leaves recovery exclusively in JSONL (does not create state.json)",
			!existsSync(stateFile),
			stateFile,
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

async function legacySidecarRemainsInert(mod) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "goal-legacy-sidecar-"));
	try {
		const goal = makeActiveGoal({ goalId: "legacy-sidecar-goal" });
		clearTimeout(goal.timer);
		const stateFile = path.join(cwd, ".pi", "goals", goal.goalId, "state.json");
		const legacyContents = '{"legacy":true}\n';
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await fs.writeFile(stateFile, legacyContents, "utf8");

		const { pi, entries } = makeAppendPi();
		mod.persist(pi, { isProjectTrusted: () => true, cwd }, goal);
		await flushFs(() => false);

		check("persist() still appends one JSONL entry beside a legacy sidecar", entries.length === 1);
		check(
			"persist() leaves an existing legacy state.json inert",
			(await fs.readFile(stateFile, "utf8")) === legacyContents,
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildPersistence();
	try {
		const mod = await loadModule(url);
		snapshotCopiesAllFields(mod);
		snapshotBoundsAssessments(mod);
		persistAppendsAndStamps(mod);
		await persistWritesJsonlOnly(mod);
		await legacySidecarRemainsInert(mod);
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
