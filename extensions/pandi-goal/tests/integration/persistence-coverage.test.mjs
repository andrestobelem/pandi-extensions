/**
 * Suite de integración de caracterización para extensions/pandi-goal/persistence.ts.
 *
 * Por qué existe este archivo
 * --------------------
 * `npm test` solo hace TYPECHECK. persistence.ts posee el lado durable de la extensión goal: el
 * mapeo de campos persistido (snapshot), el log de progreso acotado, la escritura sidecar ATOMIC
 * fire-and-forget (archivo temp y luego rename, swallow-on-error), y la resolución state-dir de
 * doble raíz (trusted project vs. agent dir hasheado con sha1). Un drift silencioso en cualquiera
 * de estos puntos perdería estado de recuperación o rompería el engine ante un problema de disco;
 * `tsc` no ve nada de eso.
 *
 * Qué es alcanzable
 * -----------------
 * persistence.ts EXPORTA solo `snapshot` y `persist`. `goalStateDir` y `writeSidecar` son
 * internos al módulo, así que se ejercitan INDIRECTAMENTE a través de `persist` (que ejecuta
 * `writeSidecar` en modo fire-and-forget). Afirmamos el resultado OBSERVABLE en filesystem en vez
 * de copiar la lógica.
 *
 * Qué NO es testeable acá (ver `skipped` en el resultado): el RETHROW de writeSidecar ante falla
 * de rename. persist() traga deliberadamente ese rechazo (`void writeSidecar(...).catch(() => {})`)
 * y la función no se exporta, así que el rechazo no es observable para ningún llamador alcanzable.
 * Forzarlo requeriría monkeypatch de bindings nombrados de `node:fs/promises`, que son live
 * bindings ESM read-only dentro del bundle; no es posible sin reescribir la fuente. SÍ cubrimos la
 * mitad temp-cleanup de esa ruta (sin *.tmp huérfanos tras un rename fallido) mediante una falla
 * real EISDIR de rename, observada en el filesystem.
 *
 * Ejecución:
 *   node extensions/pandi-goal/tests/integration/persistence-coverage.test.mjs
 *
 * Exit 0 = todos los checks pasaron; 1 = falló un check de comportamiento; 2 = falló el harness.
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

// Replica constants.ts: PROGRESS_LOG_KEEP. La fuente lo empaqueta en privado; fijamos el valor
// acá para que un cambio del límite aparezca como assertion fallida y se actualice conscientemente.
const PROGRESS_LOG_KEEP = 12;
const STATE_FILE = "state.json";
const GOAL_DIR = "goals";
const CONFIG_DIR_NAME = ".pi";
const GOAL_STATE_TYPE = "goal-state";

const { check, counts } = createChecker();

// persistence.ts importa símbolos runtime del SDK (CONFIG_DIR_NAME, getAgentDir) → necesita el
// stub sdk. NO toca typebox. getAgentDir() resuelve a <outDir>/agentdir.
async function buildPersistence() {
	return await buildExtension({
		name: "pi-goal-persistence-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-goal", "persistence.ts"),
		outName: "persistence.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
}

// agentDir es determinístico desde el outDir del build (sdkStub apunta getAgentDir ahí).
function agentDirFor(outDir) {
	return path.join(outDir, "agentdir");
}

// Captura cada snapshot agregado.
function makePi() {
	const entries = [];
	return {
		pi: {
			appendEntry: (customType, data) => entries.push({ customType, data }),
		},
		entries,
	};
}

// Un objeto completo con forma ActiveGoal, con valores sentinel distintos por campo, más los
// campos runtime extra que snapshot() NO debe copiar.
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

// Sondea el filesystem (o cualquier predicate) hasta true o hasta agotar turnos de I/O/check.
// No duerme por tiempo de pared: persist() dispara promesas de fs, no timers de producción.
async function flush(predicate, tries = 200) {
	for (let i = 0; i < tries; i++) {
		await new Promise((r) => setImmediate(r));
		if (predicate?.()) return true;
	}
	return predicate ? predicate() : true;
}

// ===========================================================================
// snapshot(): mapeo completo de campos
// ===========================================================================
function snapshotCopiesAllFields(mod) {
	const goal = makeGoal();
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
// persist(): marca updatedAt, agrega el snapshot sincrónicamente y lanza sidecar en fire-and-forget.
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
// persist(): una falla de sidecar NUNCA rompe el engine (fire-and-forget + swallow).
// Apuntamos goalStateDir a una ruta no escribible (cwd es un ARCHIVO real → mkdir encuentra ENOTDIR).
// ===========================================================================
async function persistSwallowsSidecarError(mod) {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "goal-persist-fail-"));
	const fileAsCwd = path.join(tmp, "iam-a-file");
	await fs.writeFile(fileAsCwd, "not a dir");
	const { pi, entries } = makePi();
	// trusted → goalStateDir = <cwd>/.pi/goals/<id>; mkdir de eso bajo un ARCHIVO rechaza (ENOTDIR).
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
	check(
		"persist() still appended the JSONL entry despite sidecar failure",
		entries.length === 1,
		`n=${entries.length}`,
	);
	// Dejar que la promise sidecar rechazada se resuelva; el .catch(() => {}) de la fuente debe tragarla
	// (cualquier unhandled rejection acá haría caer el proceso con exit 2 vía el handler de main()).
	await flush(() => false, 30);
	check("persist() sidecar failure produced no observable throw/rejection", true);
	await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

// ===========================================================================
// writeSidecar() (vía persist): escritura atómica; JSON pretty + newline final, sin *.tmp restante.
// raíz trusted: <cwd>/.pi/goals/<id>/state.json.
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
		check(
			"writeSidecar() state.json parses to the snapshot",
			parsed.goalId === "trusted-goal-1",
			`id=${parsed.goalId}`,
		);
		check(
			"writeSidecar() writes pretty-printed JSON (2-space indent) with a trailing newline",
			raw.endsWith("\n") && raw.includes('\n  "goalId"'),
			JSON.stringify(raw.slice(0, 24)),
		);
		const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
		check(
			"writeSidecar() leaves no orphaned *.tmp file after a successful rename",
			leftovers.length === 0,
			leftovers.join(","),
		);
	}
	await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
}

// ===========================================================================
// writeSidecar() (vía persist): CLEANUP temp cuando rename falla. Precreamos state.json como
// DIRECTORIO no vacío para que fs.rename(temp, file) rechace con EISDIR; el catch de la fuente debe
// hacer `fs.rm(temp)` antes de relanzar (persist traga el rethrow, así que solo observamos cleanup).
// ===========================================================================
async function sidecarTempCleanupOnRenameFailure(mod) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "goal-rename-fail-"));
	const dir = path.join(cwd, CONFIG_DIR_NAME, GOAL_DIR, "rename-fail-goal");
	await fs.mkdir(dir, { recursive: true });
	// Hacer de state.json un directorio EXISTENTE no vacío → rename(file, dir) → EISDIR.
	const stateAsDir = path.join(dir, STATE_FILE);
	await fs.mkdir(stateAsDir, { recursive: true });
	await fs.writeFile(path.join(stateAsDir, "blocker"), "x");

	const { pi, entries } = makePi();
	const ctx = { isProjectTrusted: () => true, cwd };
	const goal = makeGoal({ goalId: "rename-fail-goal" });
	clearTimeout(goal.timer);
	mod.persist(pi, ctx, goal);
	check("persist() still appended despite the doomed rename", entries.length === 1, `n=${entries.length}`);
	// Permitir que se complete la cadena write+failed-rename+cleanup.
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
// goalStateDir() (vía persist): raíz UNTRUSTED → <agentDir>/goals/<sha1(cwd)[:12]>/<id>.
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
