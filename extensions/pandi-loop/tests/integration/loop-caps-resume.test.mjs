/**
 * Test durable de integración de comportamiento para la superficie de DURABILITY de extensions/pandi-loop/index.ts:
 * el gate de CAPS, PAUSE/RESUME y REHYDRATE del loop — nada de eso está cubierto por
 * loop-behavior.test.mjs (esa suite cubre serialización FIFO, el no-op de
 * loop_schedule en fixed-mode, el watchdog anti-zombie y parse/clamp de intervalos).
 *
 * Por qué existe este archivo
 * --------------------
 * `npm test` es solo TYPECHECK (`tsc --noEmit`). loop.ts tiene TRES contratos de durabilidad
 * que son comportamiento puro de runtime (invisible para tsc) y que las suites existentes
 * NO tocan:
 *
 *   1. Gate de CAPS (loop.ts capExceeded / stopForCap, chequeado en fireWake + agent_end +
 *      rehydrate): un loop debe hacer hard-stop con status "done" — no seguir disparando
 *      silenciosamente — cuando llega a cualquiera de los tres caps:
 *        - maxIterations  (iteration >= maxIterations)
 *        - maxWallClockMs (Date.now() - startedAt >= deadline)
 *        - contextPercentCap (best-effort ctx.getContextUsage().percent >= cap)
 *      Una regresión que se traga un cap = un loop autónomo que corre más allá de su presupuesto /
 *      para siempre — exactamente el runaway que los caps existen para prevenir.
 *
 *   2. PAUSE / RESUME (loop.ts pauseLoop / resumeLoop, /loop pause|resume): pause debe
 *      limpiar el timer, setear status "paused", descartar cualquier wake encolado y recordar el
 *      delay restante; NO debe reinyectar. Resume debe rearmar: un loop dinámico con
 *      el remanente capturado, un loop fixed con su propio período. Una regresión acá
 *      deja varado para siempre a un loop pausado o deja que un loop pausado siga disparando.
 *
 *   3. REHYDRATE después de reload (loop.ts rehydrate on session_start): el MÁS NUEVO de
 *      {last JSONL entry, sidecar} por loopId es la fuente de verdad; un snapshot "running"/"stale"
 *      se revive running (un solo catch-up tick, sin double-fire), "paused" queda
 *      pausado (sin rearmar), los snapshots terminales NO se recuperan, y un loop autónomo en
 *      un proyecto que ya NO ES TRUSTED queda RETIRADO (terminal "stopped"), nunca queda rearmado
 *      sin supervisión. Una regresión acá = un loop autónomo ya confirmado que dispara para siempre
 *      entre reloads incluso después de revocar trust, o un double-fire en reload.
 *
 * Qué cubre (todo DISTINTO de loop-behavior.test.mjs — sin duplicación):
 *   A. Caps cortan a "done": maxIterations, maxWallClockMs y contextPercentCap
 *      frenan el loop limpiamente (status "done", reason menciona el cap) y un loop sano
 *      bajo los tres caps sigue corriendo. Tanto la ruta agent_end como la ruta fireWake.
 *   B. Pause limpia el timer + preserva state y NO reinyecta; resume rearma
 *      (dynamic remainder; fixed period); pause es no-op en un loop non-running y
 *      resume es no-op en un loop non-paused; pause descarta un wake encolado.
 *   C. Rehydrate revive running/stale (un solo catch-up, sin double-fire en un 2do
 *      session_start), mantiene paused como paused, ignora terminal, sobrevive same-process
 *      shutdown→startup, last-wins por updatedAt entre JSONL y el crash state sidecar-only,
 *      retira un loop autónomo cuando el proyecto ya no es trusted, y un cap
 *      ya excedido durante downtime se detiene limpiamente.
 *
 * Cómo funciona
 * ------------
 * Self-bootstrapping, mismo patrón probado que los integration tests loop-behavior / safety-gates / goal-*:
 * esbuild de extensions/pandi-loop/index.ts ACTUAL en un dir temp del OS en runtime (nunca una copia
 * stale), alias de los dos peer packages (typebox, @earendil-works/pi-coding-agent) a stubs
 * locales mínimos para que corra desde un checkout limpio sin `npm install`, luego importa el
 * ESM construido y maneja el comando / tools / event handlers registrados REALES contra un
 * pi/ctx mockeado. Afirma el contrato OBSERVABLE (status/reason de loop-state persistido,
 * wakes re-injected, si se armó un timer) — nunca una copia de los internals.
 *
 * Manejo del engine SIN timers reales: el primer wake de un /loop dispara sincrónicamente
 * dentro de startLoop. Para caps ponemos el loop en la condición de cap (avanzar iteration vía
 * ciclos de re-arm de agent_end, backdate de startedAt vía un snapshot de rehydrate, o manejar
 * getContextUsage), luego pulsamos agent_end / session_start que ejecutan el gate de caps
 * sincrónicamente. Nunca dormimos sobre un setTimeout real >=60s.
 *
 * Correrlo:
 *   node extensions/pandi-loop/tests/integration/loop-caps-resume.test.mjs
 * Exit code 0 = todos los checks pasaron; 1 = falló un check de comportamiento; 2 = el harness crasheó.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pandi-loop/tests/integration/ -> el repo root está cuatro niveles arriba.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
// cwd de proyecto mockeado por default. main() apunta esto al dir temp de build para que el
// escritor sidecar del loop nunca ensucie el .pi/loops del repo real durante los tests.
let TEST_PROJECT_ROOT = REPO_ROOT;
let TEST_CTX_SEQ = 0;

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------
const { check, counts } = createChecker();

// ---------------------------------------------------------------------------
// Construye la extensión actual de loop a ESM en un dir temp y devuelve la import URL.
// ---------------------------------------------------------------------------
async function buildLoop() {
	return await buildExtension({
		name: "pi-loop-caps-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-loop", "index.ts"),
		outName: "loop.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
	});
}

// pandi-loop mantiene un Map singleton activeLoops + una wakeQueue FIFO a nivel módulo. La query
// cache-busting de loadDefault le da a cada escenario una instancia FRESCA para que nunca filtren estado.

// ---------------------------------------------------------------------------
// Mock de pi + ctx. Registra los SIDE EFFECTS que produce el engine: prompts de wake
// reinyectados (sendUserMessage), snapshots loop-state persistidos (appendEntry), y
// resultados de scheduling tool — es decir, la superficie observable, nunca los internals.
// ---------------------------------------------------------------------------
function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const entries = [];
	const sentMessages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (content, options) => sentMessages.push({ content, options }),
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	};
	return { pi, tools, commands, handlers, entries, sentMessages };
}

// usage es un getter para que un escenario pueda cambiar el context percent reportado a mitad de vuelo.
function makeCtx({ mode = "tui", hasUI = true, isIdle = true, trusted = true, usage, cwd } = {}) {
	const notes = [];
	const projectCwd = cwd ?? path.join(TEST_PROJECT_ROOT, `ctx-${++TEST_CTX_SEQ}`);
	const ctx = {
		mode,
		hasUI,
		cwd: projectCwd,
		isIdle: () => (typeof isIdle === "function" ? isIdle() : isIdle),
		isProjectTrusted: () => (typeof trusted === "function" ? trusted() : trusted),
		getContextUsage: () => (typeof usage === "function" ? usage() : usage),
		ui: {
			theme: { fg: (_c, s) => s },
			notify: (msg, type) => notes.push({ msg, type }),
			setStatus: () => {},
			confirm: async () => true,
			select: async () => undefined,
		},
		sessionManager: { getEntries: () => [] },
	};
	ctx._notes = notes;
	return ctx;
}

// Último snapshot persistido para un loopId (last-wins, refleja cómo rehydrate lee el JSONL).
function latestSnapshot(entries, loopId) {
	let snap;
	for (const e of entries) {
		if (e.customType === "loop-state" && e.data && e.data.loopId === loopId) snap = e.data;
	}
	return snap;
}

// El handler del comando /loop devuelve Promise<void> (nunca expone el ActiveLoop). Entonces
// resolvemos un loop iniciado por su efecto lateral OBSERVABLE: correr el comando y luego leer el loopId
// del snapshot loop-state más nuevo que apareció. undefined si no se persistió nada nuevo.
async function startLoopCmd(commands, entries, args, ctx) {
	const before = entries.length;
	await commands.get("loop").handler(args, ctx);
	for (let i = entries.length - 1; i >= before; i--) {
		const e = entries[i];
		if (e.customType === "loop-state" && e.data && e.data.loopId) return e.data.loopId;
	}
	return undefined;
}

// Dispara cada handler registrado para un evento (el engine registra exactamente uno de cada tipo acá).
async function fireEvent(handlers, event, payload, ctx) {
	for (const h of handlers.get(event) || []) await h(payload, ctx);
}

function snap(loopId, over = {}) {
	const now = Date.now();
	return {
		loopId,
		task: `task ${loopId}`,
		prompt: "p",
		mode: "dynamic",
		iteration: 0,
		maxIterations: 25,
		maxWallClockMs: 6 * 60 * 60 * 1000,
		contextPercentCap: 90,
		startedAt: now,
		nextFireAt: now + 60 * 60 * 1000, // futuro lejano: sin catch-up fire salvo override
		status: "stale",
		updatedAt: new Date(now).toISOString(),
		...over,
	};
}

function seedEntries(ctx, snaps) {
	ctx.sessionManager.getEntries = () => snaps.map((data) => ({ type: "custom", customType: "loop-state", data }));
}

// rehydrate arma un timer de catch-up de 0ms (setTimeout(fireWake, 0)) para un loop DUE.
// Ceder a la macrotask queue para que ese timer dispare antes de hacer assert.
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ===========================================================================
// ESCENARIO A1: el cap maxIterations corta el loop a "done" cuando dispararía.
//   El gate maxIterations vive en fireWake / drainWakeQueue (NO en la safety net de agent_end,
//   que solo re-arms / chequea los caps wall-clock + context). Entonces manejamos
//   la ruta fire REAL: rehydrate de un snapshot running que está EN su iteration cap y DUE
//   para disparar. rehydrate arma un único catch-up tick (setTimeout(fireWake, 0)); cuando eso
//   dispara, el gate maxIterations debe detener el loop en "done" en vez de entregar un wake.
//   También fijamos el maxIterations default vía un loop recién iniciado (documenta el cap 25).
// ===========================================================================
async function maxIterationsCap(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const id = await startLoopCmd(commands, entries, "burn iterations", ctx);
	check(
		"maxIter: loop started, first wake delivered (iteration 1)",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);
	const s1 = latestSnapshot(entries, id);
	check("maxIter: iteration advanced to 1 on first wake", s1?.iteration === 1, `it=${s1?.iteration}`);
	check("maxIter: default maxIterations is 25", s1?.maxIterations === 25, `max=${s1?.maxIterations}`);

	// Manejar el iteration cap vía su gate REAL (fireWake). Sembrar un snapshot running en el
	// cap Y due, para que rehydrate arme un catch-up tick de 0ms; fireWake entonces pega en el guard
	// maxIterations y lo detiene en "done" en vez de disparar una iteration (capped).
	const ctx2 = makeCtx({ mode: "tui", hasUI: true, isIdle: true });
	const { pi: pi2, handlers: h2, entries: e2, sentMessages: sent2 } = makePi();
	const loopExtension2 = await loadDefault(url);
	loopExtension2(pi2);
	const now = Date.now();
	seedEntries(ctx2, [
		snap("atcap", {
			status: "running",
			iteration: 3,
			maxIterations: 3, // ya EN el cap
			maxWallClockMs: 24 * 60 * 60 * 1000, // generoso: aislar el iteration cap
			startedAt: now - 1000,
			nextFireAt: now - 1000, // DUE -> rehydrate arma un catch-up tick de 0ms (fireWake)
			updatedAt: new Date(now).toISOString(),
		}),
	]);
	await fireEvent(h2, "session_start", { reason: "startup" }, ctx2);
	await tick(); // dejar correr el catch-up fireWake de 0ms
	const cap = latestSnapshot(e2, "atcap");
	check(
		"maxIter: a DUE loop AT maxIterations is stopped 'done' by the fire gate",
		cap?.status === "done",
		`status=${cap?.status}`,
	);
	check(
		"maxIter: stop reason names maxIterations",
		/maxIterations/i.test(cap?.lastReason || ""),
		`reason=${cap?.lastReason}`,
	);
	check(
		"maxIter: capped loop delivered NO new wake (iteration not advanced)",
		sent2.length === 0 && cap?.iteration === 3,
		`delivered=${sent2.length} it=${cap?.iteration}`,
	);
}

// ===========================================================================
// ESCENARIO A2: maxWallClockMs (deadline absoluto) corta el loop a "done".
//   Hacemos rehydrate de un snapshot running cuyo startedAt es MÁS VIEJO que su maxWallClockMs y
//   cuyo nextFireAt está en el futuro (entonces rehydrate mismo lo revive sin disparar).
//   El caps gate en rehydrate (capExceeded antes de re-arm) — y la safety net agent_end —
//   debe detenerlo en "done" con un reason wall-clock, nunca re-arm.
// ===========================================================================
async function wallClockCap(url) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	const wall = 6 * 60 * 60 * 1000; // budget de 6h
	seedEntries(ctx, [
		snap("overtime", {
			status: "running",
			iteration: 4,
			maxIterations: 25, // NO es el iteration cap — aislar el wall-clock cap
			maxWallClockMs: wall,
			startedAt: now - (wall + 60 * 1000), // hace 6h+1m: pasado el deadline
			nextFireAt: now + 60 * 60 * 1000, // futuro: el catch-up propio de rehydrate no dispara
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	const s = latestSnapshot(entries, "overtime");
	check(
		"wallclock: loop past its deadline is stopped 'done' on rehydrate",
		s?.status === "done",
		`status=${s?.status}`,
	);
	check(
		"wallclock: stop reason mentions the wall-clock deadline",
		/wall-clock|deadline/i.test(s?.lastReason || ""),
		`reason=${s?.lastReason}`,
	);
	check(
		"wallclock: NOT mislabeled as an iteration cap",
		!/maxIterations/i.test(s?.lastReason || ""),
		`reason=${s?.lastReason}`,
	);
	check(
		"wallclock: NO wake delivered for an over-deadline loop",
		sentMessages.length === 0,
		`delivered=${sentMessages.length}`,
	);
}

// ===========================================================================
// ESCENARIO A3: contextPercentCap (best-effort budget) corta el loop a "done", y un
//   loop sano BAJO el cap sigue corriendo. Manejamos ctx.getContextUsage() directamente.
//   Este es el único cap que depende de una señal runtime, así que el control positivo (under) +
//   negativo (over) prueba que la suite sigue el threshold, no una dead path.
// ===========================================================================
async function contextPercentCap(url) {
	// Sobre el cap: un loop running debe detenerse en "done" en agent_end.
	{
		const loopExtension = await loadDefault(url);
		const { pi, commands, handlers, entries, sentMessages } = makePi();
		loopExtension(pi);
		let pct = 10; // sano al inicio
		const ctx = makeCtx({
			mode: "tui",
			hasUI: true,
			isIdle: true,
			usage: () => ({ percent: pct }),
		});

		const id = await startLoopCmd(commands, entries, "fill the context", ctx);
		check("ctxcap: loop started while context is low", sentMessages.length === 1, `delivered=${sentMessages.length}`);

		// Primer agent_end mientras sigue sano: debe re-arm, NO detener.
		await fireEvent(handlers, "agent_end", {}, ctx);
		const healthy = latestSnapshot(entries, id);
		check(
			"ctxcap: under the cap (10% < 90%), loop keeps running",
			healthy?.status === "running",
			`status=${healthy?.status}`,
		);

		// Ahora el context supera el cap; el siguiente agent_end debe detenerlo en "done".
		pct = 95;
		await fireEvent(handlers, "agent_end", {}, ctx);
		const over = latestSnapshot(entries, id);
		check(
			"ctxcap: over the cap (95% >= 90%), loop is stopped 'done'",
			over?.status === "done",
			`status=${over?.status}`,
		);
		check(
			"ctxcap: stop reason mentions the context budget",
			/context budget|%/i.test(over?.lastReason || ""),
			`reason=${over?.lastReason}`,
		);
	}
	// Control negativo: usage unavailable (undefined) o percent null NUNCA debe detener el loop
	// (best-effort: una señal ausente no es un cap hit).
	{
		const loopExtension = await loadDefault(url);
		const { pi, commands, handlers, entries } = makePi();
		loopExtension(pi);
		const ctx = makeCtx({
			mode: "tui",
			hasUI: true,
			isIdle: true,
			usage: () => ({ percent: null }),
		});
		const id = await startLoopCmd(commands, entries, "unknown context", ctx);
		await fireEvent(handlers, "agent_end", {}, ctx);
		const s = latestSnapshot(entries, id);
		check(
			"ctxcap: null context percent is NOT a cap hit (loop stays running)",
			s?.status === "running",
			`status=${s?.status}`,
		);
	}
}

// ===========================================================================
// ESCENARIO B: pause limpia el timer + preserva state + NO re-inject; resume
//   re-arms. Pause es no-op en un loop non-running; resume es no-op en un loop non-paused.
//   Pause descarta un wake encolado para que un loop pausado nunca re-inject desde la FIFO.
// ===========================================================================
async function pauseResume(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	// Iniciar un loop DYNAMIC. El primer wake dispara (iteration 1). agent_end re-arms un timer real
	// (safety-net delay) para que haya un nextFireAt live que preservar durante pause.
	const id = await startLoopCmd(commands, entries, "pausable work", ctx);
	await fireEvent(handlers, "agent_end", {}, ctx);
	const armed = latestSnapshot(entries, id);
	check(
		"pause: loop is running with a future nextFireAt before pause",
		armed?.status === "running" && typeof armed?.nextFireAt === "number" && armed.nextFireAt > Date.now(),
		`status=${armed?.status} next=${armed?.nextFireAt}`,
	);

	const sentBeforePause = sentMessages.length;
	await commands.get("loop").handler(`pause ${id}`, ctx);
	const paused = latestSnapshot(entries, id);
	check("pause: status persisted as 'paused'", paused?.status === "paused", `status=${paused?.status}`);
	check(
		"pause: pausing does NOT re-inject a wake",
		sentMessages.length === sentBeforePause,
		`delivered=${sentMessages.length}`,
	);
	check(
		"pause: iteration is preserved across pause (not reset)",
		paused?.iteration === armed?.iteration,
		`it=${paused?.iteration} vs ${armed?.iteration}`,
	);

	// Un loop paused NO debe disparar aunque su timer se haya armado antes: pause lo limpió.
	// Pulsar agent_end (la safety net solo re-arms loops RUNNING): sin wake nuevo, sigue paused.
	const sentBeforeIdle = sentMessages.length;
	await fireEvent(handlers, "agent_end", {}, ctx);
	const stillPaused = latestSnapshot(entries, id);
	check(
		"pause: paused loop is NOT re-armed by the agent_end safety net",
		stillPaused?.status === "paused",
		`status=${stillPaused?.status}`,
	);
	check(
		"pause: paused loop delivers no wake on agent_end",
		sentMessages.length === sentBeforeIdle,
		`delivered=${sentMessages.length}`,
	);

	// Resume: status vuelve a running y se re-arma un nextFireAt futuro fresco.
	await commands.get("loop").handler(`resume ${id}`, ctx);
	const resumed = latestSnapshot(entries, id);
	check("resume: status back to 'running'", resumed?.status === "running", `status=${resumed?.status}`);
	check(
		"resume: re-arms a future nextFireAt",
		typeof resumed?.nextFireAt === "number" && resumed.nextFireAt > Date.now(),
		`next=${resumed?.nextFireAt}`,
	);
	check(
		"resume: reason notes it was resumed by the user",
		/resume|reanudado/i.test(resumed?.lastReason || ""),
		`reason=${resumed?.lastReason}`,
	);

	// Guards no-op: resume de un loop ya running, pause de un loop inexistente.
	const beforeNoop = entries.length;
	await commands.get("loop").handler(`resume ${id}`, ctx); // ya running
	const afterResumeNoop = latestSnapshot(entries, id);
	check(
		"resume: resuming an already-running loop is a no-op (stays running)",
		afterResumeNoop?.status === "running",
		`status=${afterResumeNoop?.status}`,
	);
	check(
		"resume: no-op on running loop persists no spurious 'paused' snapshot",
		!entries
			.slice(beforeNoop)
			.some((e) => e.customType === "loop-state" && e.data?.loopId === id && e.data?.status === "paused"),
	);
}

// ===========================================================================
// ESCENARIO B2: pause descarta un wake QUEUED (un wake encolado pero aún no entregado no debe
//   disparar una vez que su loop queda paused). Loop A retiene el turno in-flight; el primer wake
//   de B se encola detrás. Pause B, luego cerrar el turno de A: solo drena el slot de A, B (paused) no dispara.
// ===========================================================================
async function pauseDropsQueuedWake(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const idA = await startLoopCmd(commands, entries, "loop A holds turn", ctx);
	check(
		"pausequeue: A delivered its wake (holds the in-flight turn)",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);
	const idB = await startLoopCmd(commands, entries, "loop B queues behind A", ctx);
	check(
		"pausequeue: B's wake is QUEUED, not delivered (one turn at a time)",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);

	// Pause B mientras su wake sigue en la FIFO. La entry encolada debe descartarse para que
	// nunca re-inject cuando cierre el turno de A.
	await commands.get("loop").handler(`pause ${idB}`, ctx);
	const bPaused = latestSnapshot(entries, idB);
	check("pausequeue: B is paused", bPaused?.status === "paused", `status=${bPaused?.status}`);

	// Cerrar el turno de A: la queue drena. B fue descartado, así que NO se entrega wake nuevo.
	await fireEvent(handlers, "agent_end", {}, ctx);
	check(
		"pausequeue: paused B does NOT fire from the queue after agent_end",
		!sentMessages.some((m) => /loop B queues behind A/.test(m.content || "")),
		`delivered=${sentMessages.length}`,
	);
	void idA;
}

// ===========================================================================
// ESCENARIO C1: rehydrate revive un snapshot running/stale, dispara un ÚNICO catch-up tick,
//   y NO hace double-fire en un segundo session_start. Un snapshot "stale" se normaliza
//   de vuelta a "running".
// ===========================================================================
async function rehydrateRevivesNoDoubleFire(url) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	seedEntries(ctx, [
		snap("revive", {
			status: "stale",
			iteration: 2,
			nextFireAt: now - 1000, // DUE: un único catch-up tick debería dispararlo
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	await tick();
	const s = latestSnapshot(entries, "revive");
	check("rehydrate: stale snapshot normalized back to 'running'", s?.status === "running", `status=${s?.status}`);
	check(
		"rehydrate: due catch-up tick delivered exactly ONE wake",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);
	check("rehydrate: catch-up advanced iteration (2 -> 3)", s?.iteration === 3, `it=${s?.iteration}`);

	// Segundo session_start (same process): el loop ya está en activeLoops con un timer live
	// -> rehydrate debe omitirlo (sin double-fire).
	const before = sentMessages.length;
	await fireEvent(handlers, "session_start", { reason: "reload" }, ctx);
	check(
		"rehydrate: second session_start does NOT double-fire (already live)",
		sentMessages.length === before,
		`delivered=${sentMessages.length}`,
	);
}

// ===========================================================================
// ESCENARIO C2: rehydrate mantiene PAUSED un snapshot "paused" (sin re-arm, sin wake), ignora
//   por completo los snapshots terminales (done/stopped/failed), y resuelve last-wins por updatedAt
//   entre múltiples entries JSONL para el mismo loopId.
// ===========================================================================
async function rehydratePausedTerminalLastWins(url) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	seedEntries(ctx, [
		// paused: debe quedar paused, sin wake, sin re-arm.
		snap("paused1", {
			status: "paused",
			nextFireAt: null,
			updatedAt: new Date(now - 5000).toISOString(),
		}),
		// terminal: debe ignorarse (sin recover, sin wake).
		snap("doneone", {
			status: "done",
			nextFireAt: null,
			updatedAt: new Date(now - 5000).toISOString(),
		}),
		snap("stopd", {
			status: "stopped",
			nextFireAt: null,
			updatedAt: new Date(now - 5000).toISOString(),
		}),
		// last-wins: dos entries para el MISMO loopId; el updatedAt POSTERIOR (terminal) debe ganar
		// sobre el anterior (running). El orden en JSONL es earlier-then-later.
		snap("lastwins", {
			status: "running",
			nextFireAt: now - 1000,
			updatedAt: new Date(now - 9000).toISOString(),
		}),
		snap("lastwins", {
			status: "stopped",
			nextFireAt: null,
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);

	const pausedSnap = latestSnapshot(entries, "paused1");
	check(
		"rehydrate: paused snapshot stays paused (recovered idle)",
		pausedSnap == null || pausedSnap.status === "paused",
		`status=${pausedSnap?.status}`,
	);

	// Los loops terminales no están en activeLoops y no producen snapshot nuevo desde rehydrate.
	const newDone = entries.some((e) => e.customType === "loop-state" && e.data?.loopId === "doneone");
	const newStopd = entries.some((e) => e.customType === "loop-state" && e.data?.loopId === "stopd");
	check("rehydrate: terminal 'done' snapshot is ignored (no persist)", !newDone);
	check("rehydrate: terminal 'stopped' snapshot is ignored (no persist)", !newStopd);

	// last-wins: ganó el terminal posterior, así que el loop NO fue revived -> sin catch-up wake de él.
	check(
		"rehydrate: last-wins picks the LATER (terminal) snapshot, so it is not revived",
		sentMessages.length === 0,
		`delivered=${sentMessages.length}`,
	);

	// Un segundo session_start con las direcciones invertidas: la entry POSTERIOR ahora es running ->
	// debe revivirse y disparar su due catch-up. (Prueba last-wins en ambas direcciones.)
	const ctx2 = makeCtx({ mode: "tui", hasUI: true, isIdle: true });
	const { pi: pi2, handlers: h2, entries: e2, sentMessages: sent2 } = makePi();
	const loopExtension2 = await loadDefault(url);
	loopExtension2(pi2);
	const now2 = Date.now();
	seedEntries(ctx2, [
		snap("lw2", {
			status: "stopped",
			nextFireAt: null,
			updatedAt: new Date(now2 - 9000).toISOString(),
		}),
		snap("lw2", {
			status: "running",
			nextFireAt: now2 - 1000,
			updatedAt: new Date(now2 - 1000).toISOString(),
		}),
	]);
	await fireEvent(h2, "session_start", { reason: "startup" }, ctx2);
	await tick();
	const lw2 = latestSnapshot(e2, "lw2");
	check(
		"rehydrate: last-wins (other direction) revives the LATER running snapshot",
		lw2?.status === "running",
		`status=${lw2?.status}`,
	);
	check(
		"rehydrate: revived later-running loop fires its due catch-up wake",
		sent2.length === 1,
		`delivered=${sent2.length}`,
	);
}

// ===========================================================================
// ESCENARIO C3: gate de re-entry AUTONOMOUS. Un loop autónomo persistido desde un proceso previo
//   debe quedar RETIRED (terminal "stopped") en rehydrate cuando el proyecto ya NO ES TRUSTED
//   — nunca re-armed unattended. Un proyecto trusted todavía lo revive. Esta es la garantía
//   de seguridad load-bearing para acciones unattended entre reloads.
// ===========================================================================
async function rehydrateAutonomousTrustGate(url) {
	// Untrusted: retirar.
	{
		const loopExtension = await loadDefault(url);
		const { pi, handlers, entries, sentMessages } = makePi();
		loopExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: false });
		const now = Date.now();
		seedEntries(ctx, [
			snap("autoloop", {
				status: "running",
				autonomous: true,
				nextFireAt: now - 1000, // estaría due, pero el trust gate debe retirarlo primero
				updatedAt: new Date(now - 1000).toISOString(),
			}),
		]);
		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		const s = latestSnapshot(entries, "autoloop");
		check(
			"autotrust: autonomous loop in an UNTRUSTED project is retired 'stopped'",
			s?.status === "stopped",
			`status=${s?.status}`,
		);
		check(
			"autotrust: retire reason mentions trust",
			/trust|confianza/i.test(s?.lastReason || ""),
			`reason=${s?.lastReason}`,
		);
		check(
			"autotrust: a retired autonomous loop fires NO wake",
			sentMessages.length === 0,
			`delivered=${sentMessages.length}`,
		);
	}
	// Trusted: revivir y disparar el due catch-up (control positivo — prueba que el retire está
	// causado por la trust revocation, no porque los loops autónomos sean unrecoverable en general).
	{
		const loopExtension = await loadDefault(url);
		const { pi, handlers, entries, sentMessages } = makePi();
		loopExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: true });
		const now = Date.now();
		seedEntries(ctx, [
			snap("autoloop2", {
				status: "running",
				autonomous: true,
				nextFireAt: now - 1000, // due -> único catch-up tick
				updatedAt: new Date(now - 1000).toISOString(),
			}),
		]);
		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		await tick();
		const s = latestSnapshot(entries, "autoloop2");
		check(
			"autotrust: autonomous loop in a TRUSTED project is revived running",
			s?.status === "running",
			`status=${s?.status}`,
		);
		check(
			"autotrust: trusted autonomous loop fires its due catch-up wake",
			sentMessages.length === 1,
			`delivered=${sentMessages.length}`,
		);
	}
}

// ===========================================================================
// ESCENARIO C4: un cap ya excedido durante downtime detiene el loop limpiamente en rehydrate
//   en vez de re-armarlo hacia otra iteration over-budget. (rehydrate ejecuta capExceeded
//   ANTES de armar el catch-up timer.) Se empareja con A2 pero aísla la colisión "due AND over-budget":
//   el loop está DUE para disparar, aun así el cap debe ganar.
// ===========================================================================
async function rehydrateRespectsCap(url) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	const wall = 6 * 60 * 60 * 1000;
	seedEntries(ctx, [
		snap("dueovercap", {
			status: "stale",
			iteration: 7,
			maxWallClockMs: wall,
			startedAt: now - (wall + 60 * 1000), // sobre el deadline
			nextFireAt: now - 1000, // DUE: tienta un catch-up fire
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	const s = latestSnapshot(entries, "dueovercap");
	check(
		"rehydrate-cap: a due-but-over-budget loop is stopped 'done', not re-armed",
		s?.status === "done",
		`status=${s?.status}`,
	);
	check(
		"rehydrate-cap: it fires NO catch-up wake despite being due",
		sentMessages.length === 0,
		`delivered=${sentMessages.length}`,
	);
	check("rehydrate-cap: iteration is NOT advanced (the loop never fired)", s?.iteration === 7, `it=${s?.iteration}`);
}

// ===========================================================================
// ESCENARIO C5: shutdown→startup same-process. session_shutdown persiste state stale,
// limpia timers y puede ser seguido por un session_start fresco en el mismo
// proceso de extension. El loop stale in-memory NO debe hacer que rehydrate omita el
// snapshot persistido; un catch-up wake debería armarse desde el durable state.
// ===========================================================================
async function shutdownThenStartupRehydrates(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const id = await startLoopCmd(commands, entries, "survive same-process reload", ctx);
	check(
		"shutdown-reload: loop started before shutdown",
		!!id && sentMessages.length === 1,
		`id=${id} delivered=${sentMessages.length}`,
	);

	await fireEvent(handlers, "session_shutdown", { reason: "reload" }, ctx);
	const stale = latestSnapshot(entries, id);
	check(
		"shutdown-reload: shutdown persists running loop as stale",
		stale?.status === "stale",
		`status=${stale?.status}`,
	);

	ctx.sessionManager.getEntries = () => entries;
	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	await tick();
	const revived = latestSnapshot(entries, id);
	check(
		"shutdown-reload: same-process startup rehydrates stale loop",
		revived?.status === "running",
		`status=${revived?.status}`,
	);
	check(
		"shutdown-reload: rehydrated loop delivers a catch-up wake",
		sentMessages.length === 2,
		`delivered=${sentMessages.length}`,
	);
	check(
		"shutdown-reload: rehydrated catch-up advances iteration",
		revived?.iteration === 2,
		`it=${revived?.iteration}`,
	);
}

// ===========================================================================
// ESCENARIO C6: recuperación sidecar-only. Si un crash deja state.json presente pero
// el JSONL de session no tiene ese loopId, rehydrate aún debe recuperarlo aunque
// el JSONL contenga entries de loops no relacionados.
// ===========================================================================
async function rehydrateSidecarOnly(url) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-loop-sidecar-only-"));
	try {
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: true, cwd });
		loopExtension(pi);
		const now = Date.now();
		const state = snap("onlysidecar", {
			status: "running",
			iteration: 4,
			nextFireAt: now - 1000,
			updatedAt: new Date(now - 1000).toISOString(),
		});
		const dir = path.join(cwd, ".pi", "loops", state.loopId);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
		seedEntries(ctx, [snap("jsonl-terminal", { status: "done", updatedAt: new Date(now).toISOString() })]);

		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		await tick();
		const s = latestSnapshot(entries, "onlysidecar");
		check("rehydrate: sidecar-only loopId is recovered", s?.status === "running", `status=${s?.status}`);
		check(
			"rehydrate: sidecar-only due loop fires one catch-up wake",
			sentMessages.length === 1,
			`delivered=${sentMessages.length}`,
		);
		check("rehydrate: sidecar-only catch-up advances iteration", s?.iteration === 5, `it=${s?.iteration}`);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

// ===========================================================================
// ESCENARIO P1: cap concurrent-loop. Iniciar loops hasta MAX_CONCURRENT_LOOPS funciona; el
//   siguiente /loop es REFUSED (no se crea un loop nuevo, se le informa al usuario) para que timers/state no puedan
//   acumularse sin límite. El valor del cap (20) queda pinned acá como contrato observable.
// ===========================================================================
async function concurrentLoopCap(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, entries } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const CAP = 20; // refleja MAX_CONCURRENT_LOOPS en index.ts
	const started = [];
	for (let i = 0; i < CAP; i++) {
		const id = await startLoopCmd(commands, entries, `cap task ${i}`, ctx);
		if (id) started.push(id);
	}
	check(`concurrency: started ${CAP} loops up to the cap`, started.length === CAP, `started=${started.length}`);

	const before = ctx._notes.length;
	const overflow = await startLoopCmd(commands, entries, "one too many", ctx);
	check("concurrency: the (cap+1)th /loop is REFUSED (no new loop created)", overflow === undefined, `id=${overflow}`);
	const refused = ctx._notes
		.slice(before)
		.some(
			(n) =>
				(n.type === "error" || n.type === "warning") && /concurrent|max|cap|limit|too many|demasiados/i.test(n.msg),
		);
	check(
		"concurrency: the refusal is surfaced to the user",
		refused,
		`notes=${JSON.stringify(ctx._notes.slice(before))}`,
	);
}

// ===========================================================================
// ESCENARIO P3a: rehydrate sanitiza un maxWallClockMs <= 0 persistido. Un sidecar corrupt/tampered
//   con maxWallClockMs:0 NO debe deshabilitar silenciosamente el wall-clock cap (caps.ts
//   gates on `> 0`, y `0 ?? DEFAULT` mantiene 0). Después de sanitize -> DEFAULT, un
//   loop over-deadline se detiene en "done" en rehydrate.
// ===========================================================================
async function rehydrateZeroWallClockSanitized(url) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	const wall = 6 * 60 * 60 * 1000; // DEFAULT_MAX_WALL_CLOCK_MS
	seedEntries(ctx, [
		snap("zerocap", {
			status: "running",
			iteration: 4,
			maxIterations: 25, // no es el iteration cap
			maxWallClockMs: 0, // corrupt: deshabilitaría el wall-clock cap salvo que se sanitice
			startedAt: now - (wall + 60 * 1000), // hace 6h+1m: pasado el DEFAULT deadline
			nextFireAt: now + 60 * 60 * 1000,
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	const s = latestSnapshot(entries, "zerocap");
	check(
		"sanitize: maxWallClockMs<=0 sanitized so an over-deadline loop stops 'done'",
		s?.status === "done",
		`status=${s?.status}`,
	);
	check(
		"sanitize: stop reason mentions the wall-clock deadline",
		/wall-clock|deadline/i.test(s?.lastReason || ""),
		`reason=${s?.lastReason}`,
	);
	check(
		"sanitize: NO wake delivered for the over-deadline loop",
		sentMessages.length === 0,
		`delivered=${sentMessages.length}`,
	);
}

// ===========================================================================
// ESCENARIO P3b: rehydrate sanitiza un maxIterations faltante/inválido. Un snapshot pre-P1 (o
//   tampered) sin maxIterations NO debe hacer que `iteration >= undefined` sea
//   always-false (iteration gate deshabilitado silenciosamente). Después de sanitize -> DEFAULT, un loop DUE
//   arriba del cap se detiene en "done" en el fire gate en vez de entregar otro wake.
// ===========================================================================
async function rehydrateMissingMaxIterationsSanitized(url) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	seedEntries(ctx, [
		snap("noiter", {
			status: "running",
			iteration: 999,
			maxIterations: undefined, // missing: deshabilitaría el iteration gate
			maxWallClockMs: 24 * 60 * 60 * 1000, // generoso: aislar el iteration cap
			startedAt: now - 1000,
			nextFireAt: now - 1000, // DUE -> rehydrate arma un catch-up fireWake de 0ms
			updatedAt: new Date(now).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	await tick();
	const s = latestSnapshot(entries, "noiter");
	check(
		"sanitize: missing maxIterations sanitized so a DUE over-cap loop stops 'done'",
		s?.status === "done",
		`status=${s?.status}`,
	);
	check(
		"sanitize: stop reason names maxIterations",
		/maxIterations/i.test(s?.lastReason || ""),
		`reason=${s?.lastReason}`,
	);
	check("sanitize: capped loop delivered NO new wake", sentMessages.length === 0, `delivered=${sentMessages.length}`);
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildLoop();
	TEST_PROJECT_ROOT = path.join(outDir, "project");
	await fs.mkdir(TEST_PROJECT_ROOT, { recursive: true });
	try {
		await maxIterationsCap(url);
		await wallClockCap(url);
		await contextPercentCap(url);
		await pauseResume(url);
		await pauseDropsQueuedWake(url);
		await rehydrateRevivesNoDoubleFire(url);
		await rehydratePausedTerminalLastWins(url);
		await rehydrateAutonomousTrustGate(url);
		await rehydrateRespectsCap(url);
		await shutdownThenStartupRehydrates(url);
		await rehydrateSidecarOnly(url);
		await concurrentLoopCap(url);
		await rehydrateZeroWallClockSanitized(url);
		await rehydrateMissingMaxIterationsSanitized(url);
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
	// Los loops revived/started dejan timers setTimeout live (period / safety-net / catch-up
	// re-arm) que mantienen abierto el event loop, así que salir explícitamente en vez de colgarse después de green.
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
