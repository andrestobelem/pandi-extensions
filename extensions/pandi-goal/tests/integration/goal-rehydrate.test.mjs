/**
 * Test de integración conductual durable para la REHYDRATION (recuperación crash/reload) de extensions/pandi-goal/index.ts.
 *
 * Por qué existe este archivo
 * ---------------------------
 * `npm test` es solo TYPECHECK (`tsc --noEmit` sobre las cuatro extensiones). Demuestra que
 * el código compila; no demuestra NADA sobre comportamiento runtime. Un `/goal` es un agente
 * PERSISTENTE, recuperable tras crash: cuando el proceso reinicia, `rehydrate()` (disparado en
 * `session_start`) es lo ÚNICO que revive un goal activo. Su contrato es sutil y totalmente
 * conductual, por eso una regresión silenciosa acá está entre las más peligrosas del paquete:
 *
 *   - Un goal que crasheó durante una verificación INDEPENDIENTE (`verifying-independent`) DEBE
 *     relanzar el subagente escéptico al recargar: su verdict en vuelo se perdió, así que
 *     RE-JUZGAMOS en vez de adivinar. Si rehydrate lo descartara, o lo cerrara como done,
 *     el goal moriría en silencio o cerraría SIN VERIFICAR: la falla exacta que el
 *     verifier independiente existe para prevenir. (goal.ts rehydrate: la rama
 *     `verifying-independent` llama a beginIndependentVerification.)
 *   - Un snapshot `stale` (la forma que `session_shutdown` escribe para un goal pursuing) debe
 *     reanudar como `pursuing` con un único catch-up tick, no una ráfaga de N wakes perdidos.
 *   - Un snapshot `verifying` debe reanudar como `verifying` (el self-check sobrevive un reload).
 *   - Los snapshots TERMINALES (`done`/`blocked`/`stopped`) NO deben recuperarse: un goal
 *     terminado debe seguir terminado tras un reload (sin goals zombie rearmando timers).
 *   - Último gana por goalId en el log append-only; sin double-fire si ya hay un timer vivo
 *     en este proceso; y un `fork` session_start NO debe migrar un goal en ejecución.
 *
 * `tsc` no ve nada de esto. Este archivo fija el contrato de recuperación OBSERVABLE.
 *
 * Cómo funciona
 * --------------
 * Autoarranque, mismo patrón probado que safety-gates / goal-verifier integration test: esbuildea
 * el extensions/pandi-goal/index.ts ACTUAL a un dir temporal del OS en runtime (nunca una copia
 * bundled obsoleta), aliasando los dos peer packages externos (typebox, @earendil-works/pi-coding-agent)
 * a stubs locales mínimos para correr desde un checkout limpio SIN `npm install`. Luego maneja
 * el handler `session_start` REAL registrado contra pi/ctx mockeados cuyo
 * `sessionManager.getEntries()` devuelve entradas `goal-state` persistidas preparadas: exactamente
 * los snapshots que `session_shutdown`/persist habrían escrito. Afirma el resultado OBSERVABLE:
 * qué goals quedan activos, en qué gstatus, si el subprocess verifier (pi.exec) se relanza,
 * y la disposición final persistida. NUNCA copia la lógica de rehydrate; sigue la fuente, así
 * un drift (p. ej. recuperar un goal terminal, o NO relanzar el verifier) pone esta suite en rojo.
 *
 * Ejecutar:
 *   node extensions/pandi-goal/tests/integration/goal-rehydrate.test.mjs
 *
 * Código de salida 0 = todos los checks pasaron; 1 = falló un check conductual; 2 = crash del harness.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pandi-goal/tests/integration/ -> repo root está cuatro niveles arriba.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// Harness de aserciones
// ---------------------------------------------------------------------------
const { check, counts } = createChecker();

// ---------------------------------------------------------------------------
// Compila la extensión goal actual a ESM en un dir temporal; devuelve la URL de import.
// (Misma estrategia de stubs que el sibling goal-verifier.test.mjs.)
// ---------------------------------------------------------------------------
async function buildGoal() {
	// pi-goal solo necesita Type.* para declarar tool-schema (nunca validación) y los símbolos
	// del SDK para resolver state-dir.
	return await buildExtension({
		name: "pi-goal-rehydrate-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-goal", "index.ts"),
		outName: "goal.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
	});
}

// pi-goal mantiene un singleton de módulo (activeGoals). La query cache-busting de loadDefault
// da a cada escenario una instancia FRESH para que los escenarios no filtren estado entre sí.

// Deja asentarse las cadenas async fire-and-forget (`void beginIndependentVerification(...)`) Y el
// catch-up tick de rehydrate. rehydrate arma el catch-up wake con `setTimeout(fireGoal, 0)`
// (goal.ts: un nextFireAt vencido → remaining 0), por eso cada iteración de poll debe ceder a AMBAS
// fases: timer (setTimeout) y check (setImmediate). Esperar solo setImmediate puede hambrear la
// fase timer bajo carga (p. ej. al correr secuencialmente vía run-all.mjs), lo que volvió flaky
// esta suite: los escenarios B/C (stale/verifying con catch-up vencido) a veces no veían el tick.
async function flush(predicate, tries = 100) {
	for (let i = 0; i < tries; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setImmediate(r));
		if (predicate?.()) return;
	}
}

// ---------------------------------------------------------------------------
// Mock de pi + ctx. Capturamos cada snapshot "goal-state" persistido (pi.appendEntry), cada
// mensaje de usuario reinyectado (pi.sendUserMessage) y cada subprocess verifier (pi.exec).
// ctx.sessionManager.getEntries() devuelve el log persistido preparado (la entrada de reload).
// ---------------------------------------------------------------------------
function makePi(execImpl) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const states = []; // cada snapshot goal-state agregado, en orden
	const execCalls = [];
	const messages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: (customType, data) => {
			if (customType === "goal-state") states.push(data);
		},
		sendUserMessage: (prompt, opts) => messages.push({ prompt, opts }),
		exec: async (cmd, args, opts) => {
			execCalls.push({ cmd, args, opts });
			return execImpl ? execImpl(cmd, args, opts) : { code: 0, killed: false, stdout: "", stderr: "" };
		},
	};
	return { pi, tools, commands, handlers, states, execCalls, messages };
}

// Entrada custom goal-state persistida, exactamente la forma que rehydrate() filtra
// (entry.type === "custom" && entry.customType === "goal-state", data = el snapshot).
function entry(snap) {
	return { type: "custom", customType: "goal-state", data: snap };
}

// Snapshot GoalState mínimo completo (los campos que rehydrate copia / rearma).
let _gid = 0;
function snap(overrides = {}) {
	const goalId = overrides.goalId ?? `g${(_gid++).toString(16).padStart(4, "0")}`;
	return {
		goalId,
		objective: "ship the feature",
		successCriteria: "the tests pass",
		derivedCriteria: undefined,
		iteration: 1,
		maxIterations: 20,
		contextPercentCap: 80,
		assessments: [],
		verifyAttempts: 0,
		independentVerifyAttempts: 0,
		maxIndependentVerifications: 2,
		verifierTimeoutMs: 120000,
		verifierTools: ["read", "grep", "find", "ls", "bash"],
		gstatus: "pursuing",
		startedAt: new Date().toISOString(),
		nextFireAt: Date.now() + 1000,
		lastReason: "persisted snapshot",
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeCtx(entries, { reason = "startup", mode = "tui" } = {}) {
	return {
		event: { reason },
		ctx: {
			mode,
			hasUI: true,
			cwd: REPO_ROOT,
			isIdle: () => true,
			isProjectTrusted: () => false,
			getContextUsage: () => undefined,
			ui: {
				theme: { fg: (_c, s) => s },
				notify: () => {},
				setStatus: () => {},
				confirm: async () => true,
				select: async () => undefined,
			},
			sessionManager: { getEntries: () => entries },
		},
	};
}

// Compila la extensión, la registra y dispara session_start con las entradas persistidas preparadas.
async function rehydrateFrom(goalUrl, entries, { reason = "startup", execImpl, mode = "tui" } = {}) {
	const goalExtension = await loadDefault(goalUrl);
	const built = makePi(execImpl);
	goalExtension(built.pi);
	const onStart = built.handlers.get("session_start");
	if (!onStart || onStart.length === 0) throw new Error("no session_start handler registered");
	const { event, ctx } = makeCtx(entries, { reason, mode });
	for (const h of onStart) await h(event, ctx);
	return { ctx, built };
}

// El último gstatus persistido para un goalId dado es su disposición observable.
function lastStatusFor(states, goalId) {
	for (let i = states.length - 1; i >= 0; i--) if (states[i].goalId === goalId) return states[i].gstatus;
	return undefined;
}

// ===========================================================================
// SCENARIO A: un snapshot `verifying-independent` RELANZA el verifier independiente en reload.
// La ruta de rehydrate más consecuente: el verdict perdido se rejuzga, y su resultado decide
// el outcome (PASS cierra done; el goal NO se cierra sin relanzar realmente el judge).
// ===========================================================================
async function verifyingIndependentReRunsVerifierAndPasses(goalUrl) {
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const exec = () => ({
		code: 0,
		killed: false,
		stdout: "Criterion 1: PASS.\nVERDICT: PASS",
		stderr: "",
	});
	const { built } = await rehydrateFrom(goalUrl, [entry(s)], { execImpl: exec });
	await flush(() => lastStatusFor(built.states, s.goalId) === "done");
	check(
		"verifying-independent reload RE-SPAWNS the verifier subprocess",
		built.execCalls.length === 1,
		`execCalls=${built.execCalls.length}`,
	);
	check(
		"verifying-independent reload + verifier PASS closes goal (done)",
		lastStatusFor(built.states, s.goalId) === "done",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
}

// Un verifier relanzado que devuelve FAIL (bajo el límite) NO debe cerrar el goal; itera de vuelta
// a pursuing. (El reload nunca debe producir un "done" falso.)
async function verifyingIndependentReRunFailDoesNotClose(goalUrl) {
	const s = snap({
		gstatus: "verifying-independent",
		nextFireAt: null,
		independentVerifyAttempts: 0,
	});
	const exec = () => ({
		code: 0,
		killed: false,
		stdout: "Criterion 1: FAIL — no real assertion.\nVERDICT: FAIL",
		stderr: "",
	});
	const { built } = await rehydrateFrom(goalUrl, [entry(s)], { execImpl: exec });
	await flush(() => lastStatusFor(built.states, s.goalId) === "pursuing");
	check(
		"verifying-independent reload + verifier FAIL does NOT close as done",
		!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "done"),
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	check(
		"verifying-independent reload + FAIL iterates (continue→pursuing)",
		lastStatusFor(built.states, s.goalId) === "pursuing",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
}

// Un verifier relanzado que devuelve FAIL EN el límite debe BLOCK (requiere humano), nunca cerrar.
async function verifyingIndependentReRunFailAtCapBlocks(goalUrl) {
	// independentVerifyAttempts ya está en cap-1 (=1, con max 2): un FAIL más alcanza el límite.
	const s = snap({
		gstatus: "verifying-independent",
		nextFireAt: null,
		independentVerifyAttempts: 1,
		maxIndependentVerifications: 2,
	});
	const exec = () => ({ code: 0, killed: false, stdout: "VERDICT: FAIL", stderr: "" });
	const { built } = await rehydrateFrom(goalUrl, [entry(s)], { execImpl: exec });
	await flush(() => lastStatusFor(built.states, s.goalId) === "blocked");
	check(
		"verifying-independent reload + FAIL at cap BLOCKS (needs a human)",
		lastStatusFor(built.states, s.goalId) === "blocked",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	check(
		"verifying-independent reload at cap never closes as done",
		!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "done"),
	);
}

// Un goal recuperado en `verifying-independent` relanza el verifier FUERA del turno del modelo. Si
// el modelo dispara goal_progress mientras ese relanzamiento está en vuelo, debe ser IGNORADO (decide
// el verdict, no el reporte reentrante); si no, la reentrada cambiaría gstatus y el liveness guard
// descartaría el verdict en vuelo (el bug MEDIO, acá en la ruta RELOAD).
// Gateamos el verifier relanzado en vuelo, tocamos goal_progress y luego liberamos: el verdict lo cierra.
async function verifyingIndependentReloadIgnoresReentry(goalUrl) {
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	const exec = async () => {
		await gate;
		return { code: 0, killed: false, stdout: "Criterion 1: PASS.\nVERDICT: PASS", stderr: "" };
	};
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const { ctx, built } = await rehydrateFrom(goalUrl, [entry(s)], { execImpl: exec });

	// Relanzamiento iniciado y gateado → goal estacionado en verifying-independent.
	check(
		"reload re-spawns the verifier once (in flight)",
		built.execCalls.length === 1,
		`execCalls=${built.execCalls.length}`,
	);
	check(
		"reloaded goal sits in verifying-independent before re-entry",
		lastStatusFor(built.states, s.goalId) === "verifying-independent",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);

	const progress = built.tools.get("goal_progress");
	if (!progress) throw new Error("goal_progress tool not registered");
	const r = await progress.execute(
		"tcReload",
		{ status: "done", assessment: "racing the re-run verifier on reload" },
		undefined,
		undefined,
		ctx,
	);
	check(
		"re-entrant goal_progress during reloaded verification is ignored",
		r?.details?.ignored === true,
		JSON.stringify(r?.details),
	);
	check(
		"re-entry does NOT change gstatus (stays verifying-independent)",
		lastStatusFor(built.states, s.goalId) === "verifying-independent",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	check(
		"re-entry does NOT spawn a second verifier",
		built.execCalls.length === 1,
		`execCalls=${built.execCalls.length}`,
	);

	// Libera el relanzamiento gateado: su PASS, no la reentrada descartada, cierra el goal.
	release();
	await flush(() => lastStatusFor(built.states, s.goalId) === "done");
	check(
		"the reloaded verifier's verdict still closes the goal (done)",
		lastStatusFor(built.states, s.goalId) === "done",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
}

// La red de seguridad agent_end NO debe rearmar un goal verifying-independent recargado: su verifier
// corre FUERA del turno y resuelve solo la siguiente transición; rearmar competiría (y podría
// descartar) el verdict en vuelo. En la ruta RELOAD `rearmedThisTurn` es false, así que la EXCLUSIÓN
// por gstatus (goal.ts agent_end) es el ÚNICO guard acá: este es su punto crítico.
async function verifyingIndependentReloadSurvivesAgentEnd(goalUrl) {
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	const exec = async () => {
		await gate;
		return { code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" };
	};
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const { ctx, built } = await rehydrateFrom(goalUrl, [entry(s)], { execImpl: exec });
	check(
		"reload parks the goal in verifying-independent (verifier in flight)",
		lastStatusFor(built.states, s.goalId) === "verifying-independent",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);

	// Dispara la red de seguridad mientras el verifier relanzado está en vuelo.
	for (const h of built.handlers.get("agent_end") ?? []) await h({}, ctx);
	check(
		"agent_end does NOT re-arm a reloaded verifying-independent goal",
		!built.states.some((st) => st.goalId === s.goalId && st.lastReason === "auto: el turno cerró sin goal_progress"),
		"unexpected auto re-arm",
	);
	check(
		"agent_end does not spawn a second verifier on reload",
		built.execCalls.length === 1,
		`calls=${built.execCalls.length}`,
	);

	release();
	await flush(() => lastStatusFor(built.states, s.goalId) === "done");
	check(
		"the reloaded verifier's verdict still closes the goal after agent_end (done)",
		lastStatusFor(built.states, s.goalId) === "done",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
}

// ===========================================================================
// SCENARIO B: un snapshot `stale` reanuda como `pursuing` (la forma de shutdown para un goal
// pursuing). rehydrate baja stale→pursuing en memoria y arma un único catch-up tick. Hacemos que
// nextFireAt esté vencido (en el pasado) para que ese tick dispare de inmediato y pruebe que el goal
// vuelve a estar GENUINAMENTE activo como pursuing: persiste un snapshot fresco con la iteración subida
// y reinyecta UN wake pursuing; no se descarta, no es un verifier ni un prompt verifying.
// ===========================================================================
async function staleResumesPursuing(goalUrl) {
	const s = snap({ gstatus: "stale", iteration: 3, nextFireAt: Date.now() - 1000 });
	const { built } = await rehydrateFrom(goalUrl, [entry(s)]);
	// Espera que el catch-up setTimeout(...,0) dispare y persista la siguiente iteración.
	await flush(() => built.states.some((st) => st.goalId === s.goalId && st.iteration > 3));
	const fired = built.states.find((st) => st.goalId === s.goalId && st.iteration > 3);
	check("stale snapshot is recovered (catch-up tick fires)", !!fired, `states=${built.states.length}`);
	check(
		"stale resumes as pursuing (re-armed goal fires in the pursuing phase)",
		!!fired && fired.gstatus === "pursuing",
		`firedStatus=${fired ? fired.gstatus : "<none>"}`,
	);
	check(
		"stale resume re-injects exactly one pursuing wake",
		built.messages.length === 1,
		`messages=${built.messages.length}`,
	);
	check("stale resume does NOT spawn a verifier", built.execCalls.length === 0, `execCalls=${built.execCalls.length}`);
}

// ===========================================================================
// SCENARIO C: un snapshot `verifying` reanuda como `verifying` (el self-completeness check
// sobrevive un reload: NO se baja a pursuing y NO lanza el verifier independiente, que solo
// dispara desde un done CONFIRMADO).
// ===========================================================================
async function verifyingResumesVerifying(goalUrl) {
	// Catch-up tick vencido: el goal rearmado dispara de inmediato y debe disparar en fase VERIFYING
	// (reinyectando el prompt de verificación), probando que el self-check sobrevivió el reload.
	const s = snap({ gstatus: "verifying", iteration: 4, nextFireAt: Date.now() - 1000 });
	const { built } = await rehydrateFrom(goalUrl, [entry(s)]);
	await flush(() => built.states.some((st) => st.goalId === s.goalId && st.iteration > 4));
	const fired = built.states.find((st) => st.goalId === s.goalId && st.iteration > 4);
	check("verifying snapshot is recovered (catch-up tick fires)", !!fired, `states=${built.states.length}`);
	check(
		"verifying resumes as verifying (NOT downgraded to pursuing)",
		!!fired && fired.gstatus === "verifying",
		`firedStatus=${fired ? fired.gstatus : "<none>"}`,
	);
	check(
		"verifying resume re-injects exactly one wake",
		built.messages.length === 1,
		`messages=${built.messages.length}`,
	);
	check(
		"verifying snapshot does NOT spawn the independent verifier on reload",
		built.execCalls.length === 0,
		`execCalls=${built.execCalls.length}`,
	);
	check(
		"verifying reload never silently closes the goal as done",
		!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "done"),
	);
}

// ===========================================================================
// SCENARIO D: los snapshots TERMINALES (done / blocked / stopped) NO se recuperan. Un goal terminado
// sigue terminado tras reload: sin goal zombie rearmando un timer o un verifier. Verificamos recargando
// un snapshot terminal y confirmando que NADA se reagenda o rejuzga.
// ===========================================================================
async function terminalSnapshotsAreNotRecovered(goalUrl) {
	for (const term of ["done", "blocked", "stopped"]) {
		const s = snap({ gstatus: term, nextFireAt: null });
		const { built } = await rehydrateFrom(goalUrl, [entry(s)]);
		await flush();
		check(
			`terminal '${term}' snapshot does NOT re-spawn a verifier on reload`,
			built.execCalls.length === 0,
			`execCalls=${built.execCalls.length}`,
		);
		check(
			`terminal '${term}' snapshot does NOT re-inject a wake on reload`,
			built.messages.length === 0,
			`messages=${built.messages.length}`,
		);
		check(
			`terminal '${term}' snapshot persists nothing new (stays finished)`,
			built.states.length === 0,
			`states=${built.states.length}`,
		);
	}
}

// ===========================================================================
// SCENARIO E: último gana por goalId. El log append-only tiene varios snapshots del MISMO
// goal; rehydrate conserva el LATEST. Si el último es terminal, el goal NO se recupera aunque
// exista un snapshot 'pursuing' anterior; a la inversa, una secuencia terminal-then-live (el
// goal se reinició) recupera el vivo.
// ===========================================================================
async function lastWinsByGoalId(goalUrl) {
	const id = "deadbeef";
	// pursuing (early) ... luego done (latest): latest es terminal -> NO se recupera.
	{
		const early = snap({
			goalId: id,
			gstatus: "pursuing",
			iteration: 1,
			nextFireAt: Date.now() + 1000,
		});
		const latest = snap({ goalId: id, gstatus: "done", iteration: 5, nextFireAt: null });
		const { built } = await rehydrateFrom(goalUrl, [entry(early), entry(latest)]);
		await flush();
		check(
			"last-wins: pursuing-then-done keeps the DONE (terminal) → goal not re-armed",
			built.execCalls.length === 0 && built.messages.length === 0 && built.states.length === 0,
			`exec=${built.execCalls.length} msg=${built.messages.length} states=${built.states.length}`,
		);
	}
	// done (early) ... luego verifying-independent (latest, el goal se reinició): recuperado + rejuzgado.
	{
		const early = snap({ goalId: id, gstatus: "done", iteration: 5, nextFireAt: null });
		const latest = snap({
			goalId: id,
			gstatus: "verifying-independent",
			iteration: 6,
			nextFireAt: null,
		});
		const exec = () => ({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
		const { built } = await rehydrateFrom(goalUrl, [entry(early), entry(latest)], {
			execImpl: exec,
		});
		await flush(() => lastStatusFor(built.states, id) === "done");
		check(
			"last-wins: done-then-verifying-independent keeps the LATEST → verifier re-runs",
			built.execCalls.length === 1,
			`execCalls=${built.execCalls.length}`,
		);
	}
}

// ===========================================================================
// SCENARIO F: un `fork` session_start NO migra un goal en ejecución. Una sesión forked hereda
// las entradas goal-state del padre, pero el goal debe seguir corriendo solo en el padre:
// rehydrate debe ser no-op en fork.
// ===========================================================================
async function forkDoesNotMigrateGoal(goalUrl) {
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const exec = () => ({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	const { built } = await rehydrateFrom(goalUrl, [entry(s)], { reason: "fork", execImpl: exec });
	await flush();
	check(
		"fork session_start does NOT re-spawn the verifier",
		built.execCalls.length === 0,
		`execCalls=${built.execCalls.length}`,
	);
	check(
		"fork session_start does NOT re-inject a wake",
		built.messages.length === 0,
		`messages=${built.messages.length}`,
	);
	check(
		"fork session_start persists nothing (no migration)",
		built.states.length === 0,
		`states=${built.states.length}`,
	);
}

// ===========================================================================
// SCENARIO G: rehydrate es robusto ante basura en el log. Entradas non-goal-state, entradas
// sin goalId y un snapshot con gstatus DESCONOCIDO se ignoran: nunca crashean rehydrate ni
// producen un goal activo fantasma.
// ===========================================================================
async function junkEntriesAreIgnored(goalUrl) {
	const good = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const exec = () => ({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	const entries = [
		{ type: "message", role: "user", content: "hello" }, // no custom
		{ type: "custom", customType: "something-else", data: { goalId: "x" } }, // customType incorrecto
		{ type: "custom", customType: "goal-state", data: { objective: "no id" } }, // falta goalId
		{ type: "custom", customType: "goal-state", data: snap({ gstatus: "weird-unknown-status" }) }, // status desconocido
		entry(good), // el único recuperable
	];
	const { built } = await rehydrateFrom(goalUrl, entries, { execImpl: exec });
	await flush(() => lastStatusFor(built.states, good.goalId) === "done");
	check(
		"junk/foreign/malformed entries do not crash rehydrate; only the valid goal recovers",
		built.execCalls.length === 1 && lastStatusFor(built.states, good.goalId) === "done",
		`execCalls=${built.execCalls.length} last=${lastStatusFor(built.states, good.goalId)}`,
	);
}

// ===========================================================================
// SCENARIO H: sin double-fire. Si rehydrate corre de nuevo mientras el timer de un goal ya está vivo
// en este proceso (p. ej. un segundo session_start), NO debe rearmar un duplicado. Disparamos
// session_start dos veces en la MISMA instancia de extensión con un goal stale vencido y afirmamos que
// el catch-up wake ocurre UNA vez, no dos.
// ===========================================================================
async function noDoubleFireOnSecondRehydrate(goalUrl) {
	const goalExtension = await loadDefault(goalUrl);
	const built = makePi();
	goalExtension(built.pi);
	const onStart = built.handlers.get("session_start");
	const s = snap({ gstatus: "stale", iteration: 7, nextFireAt: Date.now() - 1000 });
	const { event, ctx } = makeCtx([entry(s)]);
	// El primer rehydrate arma el goal (y agenda un catch-up tick vencido).
	for (const h of onStart) await h(event, ctx);
	// Segundo rehydrate con timer/goal ya vivo: debe ser no-op para este goal.
	for (const h of onStart) await h(event, ctx);
	await flush(() => built.messages.length >= 1);
	// Da chance a que cualquier duplicado erróneo también dispare antes de afirmar "exactly one".
	await flush(() => false, 20);
	check(
		"second rehydrate does NOT double-arm: exactly one catch-up wake",
		built.messages.length === 1,
		`messages=${built.messages.length}`,
	);
}

// ===========================================================================
// SCENARIO I: rehydrate NON-INTERACTIVE (print / json) es NO-OP. Un /goal solo puede sostenerse
// en tui/rpc: startGoal() ya rechaza INICIAR uno en print/json. La misma gate debe regir en la ruta
// RELOAD: rehydrate no debe rearmar un catch-up timer NI lanzar el subprocess verifier independiente
// en una sesión one-shot/non-interactive que nunca puede avanzar el goal. Que wake() esté mode-gated
// solo suprime la REINYECCIÓN del prompt; NO impide que rehydrate (a) lance un verifier pesado `pi -p`
// para un snapshot verifying-independent o (b) dispare un catch-up tick vencido que sube la iteración
// y persiste un snapshot fresco. Ambos son side effects que una sesión non-interactive no debe producir;
// el estado persistido debe quedar intacto para que una sesión tui/rpc posterior lo recupere intacto.
// ===========================================================================
async function nonInteractiveRehydrateIsNoOp(goalUrl) {
	for (const mode of ["print", "json"]) {
		// (a) Ruta pesada: un snapshot verifying-independent NO debe lanzar el verifier.
		{
			const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
			const exec = () => ({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
			const { built } = await rehydrateFrom(goalUrl, [entry(s)], { mode, execImpl: exec });
			await flush();
			check(
				`[${mode}] verifying-independent reload does NOT spawn the verifier subprocess`,
				built.execCalls.length === 0,
				`execCalls=${built.execCalls.length}`,
			);
			check(
				`[${mode}] verifying-independent reload persists nothing (state left intact)`,
				built.states.length === 0,
				`states=${built.states.length}`,
			);
			check(
				`[${mode}] verifying-independent reload never closes the goal as done`,
				!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "done"),
				"unexpected done",
			);
		}
		// (b) Ruta de timer: un snapshot stale VENCIDO NO debe disparar un catch-up tick (sin
		// suba de iteración, sin snapshot persistido, sin wake); el goal no puede correr en este modo.
		{
			const s = snap({ gstatus: "stale", iteration: 3, nextFireAt: Date.now() - 1000 });
			const { built } = await rehydrateFrom(goalUrl, [entry(s)], { mode });
			await flush();
			check(
				`[${mode}] stale reload does NOT re-inject a wake`,
				built.messages.length === 0,
				`messages=${built.messages.length}`,
			);
			check(
				`[${mode}] stale reload does NOT bump the iteration / persist a snapshot`,
				built.states.length === 0,
				`states=${built.states.length}`,
			);
		}
	}
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildGoal();
	try {
		await verifyingIndependentReRunsVerifierAndPasses(url);
		await verifyingIndependentReRunFailDoesNotClose(url);
		await verifyingIndependentReRunFailAtCapBlocks(url);
		await verifyingIndependentReloadIgnoresReentry(url);
		await verifyingIndependentReloadSurvivesAgentEnd(url);
		await staleResumesPursuing(url);
		await verifyingResumesVerifying(url);
		await terminalSnapshotsAreNotRecovered(url);
		await lastWinsByGoalId(url);
		await forkDoesNotMigrateGoal(url);
		await junkEntriesAreIgnored(url);
		await noDoubleFireOnSecondRehydrate(url);
		await nonInteractiveRehydrateIsNoOp(url);
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
	// Los goals recuperados se rearman con timers setTimeout que mantienen abierto el event loop;
	// salir explícitamente en vez de colgar tras una corrida verde.
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
