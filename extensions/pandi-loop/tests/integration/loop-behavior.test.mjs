/**
 * Test de integración de comportamiento durable para el motor de scheduling de extensions/pandi-loop/index.ts.
 *
 * Por qué existe este archivo
 * --------------------
 * `npm test` es solo TYPECHECK (`tsc --noEmit`). Las compuertas críticas de seguridad de loop.ts
 * (destructive-bash gate, loop_schedule delay clamp) ya tienen cobertura durable en
 * extensions/pandi-plan/tests/integration/plan-gate.test.mjs y extensions/pandi-loop/tests/integration/loop-safety.test.mjs. Lo que NO tenía cobertura durable de comportamiento es el
 * motor de scheduling: la parte que decide CUÁNDO y EN QUÉ ORDEN se disparan las iteraciones
 * autónomas. Una regresión silenciosa ahí es tan grave como un agujero en un gate:
 *   - perder la serialización FIFO -> N loops vivos abren cada uno un turno de autopilot en el MISMO
 *     turno humano/agente (después el destructive gate dispara mal y los turnos compiten por la sesión).
 *   - romper el NO-OP de fixed-mode -> un loop de cadencia fixed deja que el modelo reprograme su
 *     timer mediante loop_schedule, derrotando la cadencia propiedad del usuario.
 *   - romper el watchdog       -> un zombie loop (colgado, caps nunca disparados) vive para siempre.
 *   - romper interval clamping  -> un intervalo `0s` se vuelve busy-spin, o un typo silenciosamente
 *     convierte un loop fixed en uno model-paced (dynamic).
 * Nada de esto es visible para `tsc`; todo es comportamiento puro de runtime.
 *
 * Qué cubre (todo DISTINTO de plan-gate.test.mjs / loop-safety.test.mjs, sin duplicación):
 *   1. Serialización FIFO multi-loop: con varios loops vivos, se entrega exactamente UN turno de autopilot
 *      por vez; el resto queda en cola FIFO y se drena en orden de llegada en agent_end.
 *   2. Cadencia fixed-interval: `/loop <task> 5m` entra en fixed mode; loop_schedule es un
 *      NO-OP informativo ahí (no debe tocar el timer / nextFireAt / cadence).
 *   3. Limpieza terminal: los loops stopped/done/failed persisten su snapshot final pero se
 *      eliminan inmediatamente del active set, para que `/loop status` muestre solo loops vivos.
 *   4. Anti-zombie watchdog: un loop RUNNING que pasó el hard backstop de 25h se fuerza a detener
 *      (done) en un límite de turno; un loop PAUSED de la misma edad se preserva deliberadamente;
 *      un loop sano queda intacto.
 *   5. Interval parsing/clamp: el token final se parsea a fixed mode y el período se
 *      clampa a [1s, 24h]; un token sin match deja el loop dynamic (model-paced).
 *
 * Cómo funciona
 * ------------
 * Self-bootstrapping, con el mismo patrón probado que los tests de integración safety-gates / goal-*:
 * esbuild de extensions/pandi-loop/index.ts ACTUAL a un dir temp del OS en runtime (nunca una copia vieja),
 * alias de los dos paquetes peer (typebox, @earendil-works/pi-coding-agent) a stubs locales mínimos para
 * que corra desde un checkout limpio sin `npm install`; después importa el ESM construido y maneja el
 * comando / tools / event handlers registrados REALES contra un pi/ctx mockeado. Afirma el
 * contrato OBSERVABLE (qué wake se entrega, status persistido, intervalo clampado), nunca una
 * copia de los internals; así sigue al source y falla fuerte si el engine deriva.
 *
 * Manejo del engine SIN timers reales: el primer wake de cada loop dispara sincrónicamente
 * dentro de startLoop (fireWake se llama directamente, no vía setTimeout), y el handler
 * agent_end libera sincrónicamente el in-flight gate y drena el siguiente wake en cola. Así el
 * contrato FIFO completo es observable sin esperar nunca un setTimeout >=60s. Para el
 * watchdog, antedatamos startedAt y pulsamos agent_end (que corre watchdogSweep). Nunca
 * dormimos sobre un timer real.
 *
 * Ejecutarlo:
 *   node extensions/pandi-loop/tests/integration/loop-behavior.test.mjs
 * Exit code 0 = todos los checks pasaron; 1 = falló un check de comportamiento; 2 = el harness crasheó.
 */

import * as fs from "node:fs/promises";
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
// Assertion harness (compartido: extensions/shared/test/harness.mjs)
// ---------------------------------------------------------------------------
const { check, counts } = createChecker();

// ---------------------------------------------------------------------------
// Construye la extensión actual de loop a ESM en un dir temp y devuelve la import URL.
// ---------------------------------------------------------------------------
async function buildLoop() {
	return await buildExtension({
		name: "pi-loop-integration",
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
function makePi({ sendUserMessage } = {}) {
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
		sendUserMessage: sendUserMessage ?? ((content, options) => sentMessages.push({ content, options })),
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	};
	return { pi, tools, commands, handlers, entries, sentMessages };
}

function makeCtx({ mode = "tui", hasUI = true, isIdle = true, trusted = true, cwd } = {}) {
	const notes = [];
	const projectCwd = cwd ?? path.join(TEST_PROJECT_ROOT, `ctx-${++TEST_CTX_SEQ}`);
	const ctx = {
		mode,
		hasUI,
		cwd: projectCwd,
		isIdle: () => (typeof isIdle === "function" ? isIdle() : isIdle),
		isProjectTrusted: () => trusted,
		getContextUsage: () => undefined,
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

// El handler del comando /loop devuelve Promise<void> (rutea por handleLoopCommand y
// nunca expone el ActiveLoop). Entonces resolvemos un loop iniciado por su efecto lateral OBSERVABLE:
// correr el comando y después leer el loopId del snapshot loop-state más nuevo que apareció.
// Devuelve el loopId, o undefined si no se persistió nada nuevo (p. ej. rechazado en print mode).
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

// ===========================================================================
// ESCENARIO 1: serialización FIFO multi-loop.
//   Iniciar un loop dispara su primer wake sincrónicamente. Mientras ese turno de autopilot está en
//   vuelo, iniciar MÁS loops NO debe entregar sus wakes (un turno por vez); se encolan
//   FIFO. agent_end libera el gate y entrega exactamente el SIGUIENTE en orden de llegada.
//   Esta es la garantía central de que N loops nunca compiten por un único turno.
// ===========================================================================
async function fifoSerialization(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	// Iniciar loop A. Su primer wake dispara sincrónicamente (startLoop -> fireWake -> drain).
	await startLoopCmd(commands, entries, "task A", ctx);
	check("fifo: starting A delivers exactly ONE wake", sentMessages.length === 1);
	check("fifo: A's wake names loop A's task", /task A/.test(sentMessages[0]?.content || ""));

	// Mientras el turno de autopilot de A está EN VUELO, iniciar B y C. Sus primeros wakes deben quedar ENCOLADOS,
	// no entregarse: el engine garantiza un único turno de autopilot por vez.
	await startLoopCmd(commands, entries, "task B", ctx);
	await startLoopCmd(commands, entries, "task C", ctx);
	check(
		"fifo: B and C do NOT deliver while A's turn is in flight",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);

	// agent_end cierra el turno de A -> liberar el gate y drenar el SIGUIENTE wake en cola (B, FIFO).
	await fireEvent(handlers, "agent_end", {}, ctx);
	check(
		"fifo: agent_end delivers exactly one more wake (B, FIFO)",
		sentMessages.length === 2,
		`delivered=${sentMessages.length}`,
	);
	check(
		"fifo: the 2nd delivered wake is B (arrival order), not C",
		/task B/.test(sentMessages[1]?.content || ""),
		sentMessages[1]?.content?.slice(0, 40),
	);

	// El siguiente agent_end cierra el turno de B -> entregar C.
	await fireEvent(handlers, "agent_end", {}, ctx);
	check(
		"fifo: 3rd wake is C",
		sentMessages.length === 3 && /task C/.test(sentMessages[2]?.content || ""),
		`delivered=${sentMessages.length}`,
	);

	// Cola ya vacía; otro agent_end rearma la safety net pero no entrega ningún wake nuevo.
	const before = sentMessages.length;
	await fireEvent(handlers, "agent_end", {}, ctx);
	check(
		"fifo: no extra wake once queue is drained",
		sentMessages.length === before,
		`delivered=${sentMessages.length}`,
	);
}

// ===========================================================================
// ESCENARIO 2: un wake NUNCA se entrega mientras el humano posee el turno (isIdle=false).
//   Por esto la entrega está gated por ctx.isIdle(): inyectar en medio del turno humano abriría
//   un turno de autopilot debajo del turno humano (y el destructive gate entonces gatearía los
//   comandos propios del HUMANO). El wake debe permanecer en cola hasta que el agente vuelva a estar idle.
// ===========================================================================
async function noDeliveryWhileBusy(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	let idle = false; // el agente está BUSY (turno humano en progreso).
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: () => idle });

	await startLoopCmd(commands, entries, "busy task", ctx);
	check("busy: no wake delivered while agent is busy", sentMessages.length === 0, `delivered=${sentMessages.length}`);

	// El turno humano termina -> agent_end con el agente ahora idle -> se drena el wake en cola.
	idle = true;
	await fireEvent(handlers, "agent_end", {}, ctx);
	check(
		"busy: queued wake drains once idle at agent_end",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);
}

// ===========================================================================
// ESCENARIO 3: si sendUserMessage lanza, el loop falla de forma terminal y libera el gate
// autopilot. Sin este guard, una excepción de transporte podía congelar la FIFO.
// ===========================================================================
async function wakeDeliveryFailureFailsLoop(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, handlers, entries } = makePi({
		sendUserMessage: () => {
			throw new Error("transport down");
		},
	});
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const loopId = await startLoopCmd(commands, entries, "task with broken transport", ctx);
	const snap = latestSnapshot(entries, loopId);
	check("wake-failure: loop snapshot exists", Boolean(snap));
	check(
		"wake-failure: send failure marks loop failed, not running/autopilot",
		snap?.status === "failed" && snap.autopilot !== true,
		JSON.stringify(snap),
	);
	check("wake-failure: failure reason is durable", /falló la entrega del wake/.test(snap?.lastReason || ""));

	const sentMessages = [];
	pi.sendUserMessage = (content, options) => sentMessages.push({ content, options });
	await startLoopCmd(commands, entries, "next task after failed delivery", ctx);
	await fireEvent(handlers, "agent_end", {}, ctx);
	check(
		"wake-failure: autopilot gate is released for the next loop",
		sentMessages.length === 1 && /next task/.test(sentMessages[0]?.content || ""),
		`delivered=${sentMessages.length}`,
	);
}

// ===========================================================================
// ESCENARIO 4: un loop NO PUEDE correr en un modo no interactivo (print). startLoop rechaza,
//   no se persiste nada, no se inyecta ningún wake. (Refleja el gate canLoopInMode tui/rpc.)
// ===========================================================================
async function refusesNonInteractiveMode(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "print", hasUI: false });

	const startedId = await startLoopCmd(commands, entries, "cannot loop here", ctx);
	check("mode: /loop in print mode starts no loop", startedId === undefined);
	check("mode: print mode persists no loop-state", entries.find((e) => e.customType === "loop-state") === undefined);
	check("mode: print mode injects no wake", sentMessages.length === 0);
}

// ===========================================================================
// ESCENARIO 4: fixed-interval mode + loop_schedule NO-OP.
//   `/loop <task> 5m` entra en fixed mode. El primer wake dispara (iteration 1). Luego el modelo
//   llama loop_schedule en un loop FIXED: debe ser un NO-OP informativo; NO cambia
//   la cadence, el timer ni nextFireAt (el usuario posee el período). Contrasta con un loop dynamic
//   donde loop_schedule SÍ rearma. Afirmamos la diferencia observable.
// ===========================================================================
async function fixedModeAndScheduleNoop(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, tools, handlers, entries } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	// Iniciar un loop FIXED (token final "5m" -> fixed cadence, 300s). Su primer wake dispara
	// sincrónicamente, así que este loop posee el turno de autopilot in-flight (loop_schedule lo resuelve).
	const fixedId = await startLoopCmd(commands, entries, "watch the build 5m", ctx);
	check("fixed: started a loop with a trailing interval token", !!fixedId);
	const snap = latestSnapshot(entries, fixedId);
	check("fixed: mode persisted as 'fixed'", snap?.mode === "fixed", `mode=${snap?.mode}`);
	check("fixed: intervalMs is 300000 (5m)", snap?.intervalMs === 300000, `intervalMs=${snap?.intervalMs}`);
	check("fixed: task token stripped of the interval", snap?.task === "watch the build", `task=${snap?.task}`);

	// Ahora el modelo (turno de autopilot en flight) llama loop_schedule en el loop FIXED.
	const sched = tools.get("loop_schedule");
	const res = await sched.execute("tc", { delaySeconds: 90, reason: "want sooner" }, undefined, undefined, ctx);
	check(
		"fixed: loop_schedule reports a NO-OP on a fixed loop",
		res?.details?.noop === true,
		JSON.stringify(res?.details),
	);
	check(
		"fixed: loop_schedule does NOT change the fixed cadence (intervalSeconds=300)",
		res?.details?.intervalSeconds === 300,
		JSON.stringify(res?.details),
	);
	// Un no-op no debe haber persistido un re-arm (ningún snapshot loop-state nuevo desde scheduleWake).
	const afterSnap = latestSnapshot(entries, fixedId);
	check(
		"fixed: no-op did not re-arm nextFireAt via loop_schedule",
		afterSnap?.nextFireAt == null || afterSnap?.nextFireAt === snap?.nextFireAt,
		`nextFireAt=${afterSnap?.nextFireAt}`,
	);
	check("fixed: no-op did not change mode away from fixed", afterSnap?.mode === "fixed");

	// Contraste: el loop_schedule de un loop DYNAMIC SÍ arma un delay real (clampado). Misma tool,
	// resultado observable distinto -> prueba que el no-op es específico del modo, no un path muerto.
	// Detenemos primero el loop fixed para que el loop dynamic posea inequívocamente el próximo turno.
	await commands.get("loop").handler(`stop ${fixedId}`, ctx);
	await startLoopCmd(commands, entries, "dynamic sibling", ctx);
	await fireEvent(handlers, "agent_end", {}, ctx); // entregar el wake dynamic en cola (FIFO)
	const dres = await sched.execute("tc2", { delaySeconds: 1800, reason: "dynamic re-arm" }, undefined, undefined, ctx);
	check(
		"dynamic: loop_schedule is NOT a no-op for a dynamic loop",
		!dres?.details?.noop,
		JSON.stringify(dres?.details),
	);
	check(
		"dynamic: loop_schedule arms the clamped delay (1800)",
		dres?.details?.delaySeconds === 1800,
		JSON.stringify(dres?.details),
	);
}

// ===========================================================================
// ESCENARIO 5: los loops terminales desaparecen del status activo inmediatamente.
//   Un loop stopped/done/failed todavía persiste su snapshot final para decisiones de
//   audit/recovery, pero debe eliminarse enseguida del active set en memoria. De lo contrario,
//   `/loop status` sigue mostrando loops stopped hasta reload, lo que parece que el loop
//   no desapareció.
// ===========================================================================
async function terminalLoopsDisappearFromActiveStatus(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, entries } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const id = await startLoopCmd(commands, entries, "do thing 30s", ctx);
	check("terminal: started a loop to stop", !!id);

	await commands.get("loop").handler(`stop ${id}`, ctx);
	const stopped = latestSnapshot(entries, id);
	check("terminal: final stopped snapshot is persisted", stopped?.status === "stopped", `status=${stopped?.status}`);

	await commands.get("loop").handler("status", ctx);
	check(
		"terminal: default /loop status no longer lists the stopped loop",
		ctx._notes.at(-1)?.msg === "No hay loops.",
		ctx._notes.at(-1)?.msg,
	);

	await commands.get("loop").handler(`status ${id}`, ctx);
	check(
		"terminal: explicit status id is gone from the live set",
		ctx._notes.at(-1)?.msg === `No hay ningún loop con id ${id}. Usá /loop status para listar los loops activos.`,
		ctx._notes.at(-1)?.msg,
	);
}

// ===========================================================================
// ESCENARIO 6: anti-zombie watchdog en un límite de turno.
//   Un loop RUNNING cuyo startedAt es anterior al hard backstop de 25h se fuerza a detener
//   (status "done") en el siguiente agent_end (que pulsa watchdogSweep). Un loop PAUSED de la
//   misma edad se SPARED deliberadamente (un loop pausado está idle intencionalmente, no es zombie).
//   Un loop running sano queda intacto.
// ===========================================================================
async function watchdogHealthyUntouched(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, handlers, entries } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	// Dos loops running frescos manejados a través de varios límites de turno (cada uno pulsa watchdogSweep).
	// Un loop sano (bien dentro del backstop de 25h) NUNCA debe ser forzado a detenerse por el sweep.
	const id1 = await startLoopCmd(commands, entries, "healthy one", ctx);
	await fireEvent(handlers, "agent_end", {}, ctx);
	const id2 = await startLoopCmd(commands, entries, "healthy two", ctx);
	await fireEvent(handlers, "agent_end", {}, ctx);
	await fireEvent(handlers, "agent_end", {}, ctx);

	const s1 = latestSnapshot(entries, id1);
	const s2 = latestSnapshot(entries, id2);
	check(
		"watchdog: healthy running loops survive repeated agent_end sweeps",
		s1?.status === "running" && s2?.status === "running",
		`s1=${s1?.status} s2=${s2?.status}`,
	);
	// El path de kill aged/zombie se ejercita en agedRehydrateWatchdog (que puede antedatar startedAt).
}

// ===========================================================================
// ESCENARIO 6b: watchdog realmente FIRES en un loop aged, vía el path de entrada rehydrate.
//   Alimentamos session_start con un snapshot "stale" cuyo startedAt es de hace 26h. rehydrate lo revive
//   (running) y luego watchdogSweep (corre después de rehydrate en session_start) debe
//   forzarlo a detenerse como zombie -> status persistido "done". Un segundo snapshot, aged pero
//   "paused", debe rehidratarse como paused y SPARED. Un snapshot stale fresco sobrevive.
// ===========================================================================
async function agedRehydrateWatchdog(url) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries } = makePi();
	loopExtension(pi);

	const now = Date.now();
	const WATCHDOG_MS = 25 * 60 * 60 * 1000;
	const aged = now - 26 * 60 * 60 * 1000; // hace 26h: pasado el backstop de 25h.
	const fresh = now - 60 * 1000; // hace 1 min: sano.

	const seed = [
		{
			loopId: "zombie",
			task: "hung forever",
			prompt: "p",
			mode: "dynamic",
			iteration: 3,
			maxIterations: 25,
			maxWallClockMs: 6 * 60 * 60 * 1000,
			contextPercentCap: 90,
			startedAt: aged,
			nextFireAt: now - 1000, // due (catch-up), pero debería morir antes de disparar
			status: "stale",
			updatedAt: new Date(now - 1000).toISOString(),
		},
		{
			loopId: "pausedold",
			task: "paused over the weekend",
			prompt: "p",
			mode: "dynamic",
			iteration: 5,
			maxIterations: 25,
			maxWallClockMs: 6 * 60 * 60 * 1000,
			contextPercentCap: 90,
			startedAt: aged,
			nextFireAt: null,
			status: "paused",
			updatedAt: new Date(now - 1000).toISOString(),
		},
		{
			loopId: "healthy",
			task: "running fine",
			prompt: "p",
			mode: "dynamic",
			iteration: 1,
			maxIterations: 25,
			maxWallClockMs: 6 * 60 * 60 * 1000,
			contextPercentCap: 90,
			startedAt: fresh,
			nextFireAt: now + 60 * 60 * 1000, // lejos en el futuro, sin catch-up fire
			status: "stale",
			updatedAt: new Date(now - 1000).toISOString(),
		},
	];

	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });
	ctx.sessionManager.getEntries = () => seed.map((data) => ({ type: "custom", customType: "loop-state", data }));

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);

	const zSnap = latestSnapshot(entries, "zombie");
	check(
		"watchdog: aged RUNNING zombie is force-stopped (done) on rehydrate sweep",
		zSnap?.status === "done",
		`status=${zSnap?.status}`,
	);
	check(
		"watchdog: the stop reason mentions the backstop/watchdog",
		/watchdog|backstop|deadline/i.test(zSnap?.lastReason || ""),
		`reason=${zSnap?.lastReason}`,
	);

	const pSnap = latestSnapshot(entries, "pausedold");
	check(
		"watchdog: aged PAUSED loop is SPARED (stays paused, not a zombie)",
		pSnap == null || pSnap.status === "paused",
		`status=${pSnap?.status}`,
	);

	const hSnap = latestSnapshot(entries, "healthy");
	check(
		"watchdog: healthy fresh loop is NOT touched by the sweep",
		hSnap == null || hSnap.status === "running",
		`status=${hSnap?.status}`,
	);

	// Sanity sobre la constante alrededor de la cual codificamos el escenario (documenta el contrato).
	check("watchdog: backstop window encoded as 25h", WATCHDOG_MS === 90000000);
}

// ===========================================================================
// ESCENARIO 7: interval parsing + clamp (observado vía intervalMs / mode persistidos).
//   token final `^\d+(s|m|h)$` -> fixed mode, período clampado a [1s, 24h].
//   Cualquier otra cosa -> dynamic (model-paced), el token tratado como parte de la task.
// ===========================================================================
async function intervalParseAndClamp(url) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, entries } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	async function startAndSnap(args) {
		const id = await startLoopCmd(commands, entries, args, ctx);
		return id ? latestSnapshot(entries, id) : undefined;
	}

	check("interval: '30s' -> fixed 30000ms", (await startAndSnap("do thing 30s"))?.intervalMs === 30000);
	check("interval: '5m' -> fixed 300000ms", (await startAndSnap("do thing 5m"))?.intervalMs === 300000);
	check("interval: '2h' -> fixed 7200000ms", (await startAndSnap("do thing 2h"))?.intervalMs === 7200000);

	// Clamp DOWN: 48h excede el cap de 24h -> clampado a 24h = 86400000ms.
	check(
		"interval: '48h' clamps DOWN to 24h (86400000ms)",
		(await startAndSnap("do thing 48h"))?.intervalMs === 86400000,
	);

	// Un token de valor 0 NO matchea el parser (value <= 0 rechazado) -> dynamic, token conservado.
	const zero = await startAndSnap("do thing 0s");
	check("interval: '0s' is rejected -> dynamic mode (no busy-spin)", zero?.mode === "dynamic", `mode=${zero?.mode}`);
	check("interval: '0s' token stays part of the task", zero?.task === "do thing 0s", `task=${zero?.task}`);

	// Tokens sin match -> dynamic, sin intervalo.
	const dyn1 = await startAndSnap("just a task");
	check("interval: no trailing token -> dynamic", dyn1?.mode === "dynamic" && dyn1?.intervalMs == null);
	const dyn2 = await startAndSnap("refactor module5");
	check(
		"interval: 'module5' (digit not at start) -> dynamic",
		dyn2?.mode === "dynamic" && dyn2?.intervalMs == null,
		`task=${dyn2?.task}`,
	);
	const dyn3 = await startAndSnap("do thing 10x");
	check(
		"interval: '10x' (bad unit) -> dynamic, token kept in task",
		dyn3?.mode === "dynamic" && dyn3?.task === "do thing 10x",
	);
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildLoop();
	TEST_PROJECT_ROOT = path.join(outDir, "project");
	await fs.mkdir(TEST_PROJECT_ROOT, { recursive: true });
	try {
		await fifoSerialization(url);
		await noDeliveryWhileBusy(url);
		await wakeDeliveryFailureFailsLoop(url);
		await refusesNonInteractiveMode(url);
		await fixedModeAndScheduleNoop(url);
		await terminalLoopsDisappearFromActiveStatus(url);
		await watchdogHealthyUntouched(url);
		await agedRehydrateWatchdog(url);
		await intervalParseAndClamp(url);
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
	// Los loops iniciados dejan timers setTimeout vivos (el period / safety-net re-arm) que mantienen
	// abierto el event loop, así que salimos explícitamente en vez de colgar después de una corrida verde.
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
