/**
 * `/loop` estilo Claude para Pi (P0 dynamic + P1).
 *
 * Ejecuta una tarea iterativamente. Pi no tiene ScheduleWakeup/cron nativo,
 * así que la primitiva se invierte: el modelo decide la próxima cadencia
 * llamando a la tool `loop_schedule`, y esta extensión materializa el wake
 * con setTimeout, reinyectando el prompt de iteración vía pi.sendUserMessage.
 * El loop vive en el proceso Node de la extensión.
 *
 * Alcance P0:
 * - comandos: /loop <task>, /loop stop [id], /loop status [id]
 * - tools: loop_schedule(delaySeconds, reason), loop_stop(reason)
 * - engine: fireWake / scheduleWake / startLoop / stopLoop
 * - estado: activeLoops Map + persistencia vía pi.appendEntry("loop-state", ...)
 * - rehydrate en session_start (sin double-fire; tick único de recuperación)
 * - limpieza en session_shutdown (clearTimeout + abort + persistir "stale")
 * - red de seguridad en agent_end
 * - línea de estado
 *
 * Alcance P1 (todo aditivo sobre P0; comportamiento P0 sin cambios):
 * - modo fixed-interval: `/loop <task> <interval>` donde interval matchea
 *   ^\d+(s|m|h)$ (el último token). Sin interval = dynamic (P0). En fixed mode la
 *   extensión posee el período: rearma después de cada iteración con un timestamp
 *   ABSOLUTO (nextFireAt += periodMs) vía setTimeout rearmado (nunca setInterval,
 *   para que las iteraciones no se solapen). loop_schedule es un NO-OP informativo
 *   en fixed mode (el modelo solo decide continue/stop; el período es fijo).
 * - máquina de estados completa: running|paused|stopped|done|failed|stale, con
 *   `/loop pause [id]` y `/loop resume [id]`.
 * - gate de acciones irreversibles vía pi.on("tool_call"): un flag `autopilot`
 *   por loop se activa cuando fireWake inyecta (el turno fue disparado por un wake,
 *   no por el usuario) y se limpia en agent_end. Mientras autopilot está activo,
 *   las tools destructivas que matchean una allowlist conservadora se confirman
 *   (si hay UI) o se bloquean (si no hay UI).
 * - topes de tiempo/budget: maxWallClockMs (deadline absoluto) además de
 *   maxIterations, más un umbral porcentual best-effort de ctx.getContextUsage().
 *   Se chequean ANTES de rearmar (en fireWake y agent_end). Al tocar un tope -> stop
 *   con status "done" + notify.
 * - persistencia robusta: sidecar JSON ATOMIC (temp+rename) con `updatedAt` además
 *   de appendEntry; en rehydrate gana por updatedAt el más nuevo de {last JSONL entry,
 *   sidecar}. Dual-root: .pi/loops/<id>/state.json si es trusted, o
 *   getAgentDir()/loops/<projectHash>/<id>/state.json. Mantiene un solo catch-up tick.
 * - la red de seguridad en agent_end también cubre fixed mode (rearmado del período) y topes.
 *
 * Alcance P2 (todo aditivo sobre P0/P1; comportamiento P0/P1 sin cambios):
 * - cola FIFO multi-loop de wakes: con N loops vivos, sus callbacks de setTimeout
 *   podrían dispararse casi simultáneamente y llamar cada uno a sendUserMessage,
 *   compitiendo por el turno. Una FIFO a nivel módulo de wakes pendientes los serializa:
 *   un wake se ENTREGA solo cuando ctx.isIdle() Y no hay otro wake autopilot en vuelo
 *   en este turno; si no, se encola y se drena en el siguiente agent_end. Garantiza
 *   exactamente UN turno autopilot a la vez. loop_schedule/loop_stop resuelven el loop
 *   que posee el turno actual (el que tiene el flag autopilot activo), robustecido para
 *   N loops coexistentes.
 * - modo autónomo: `/loop auto <task> [interval]` — un loop SIN tarea de usuario en el
 *   sentido convencional; el texto reinyectado es una sentinela generada por la extensión
 *   (un objetivo recurrente). Iniciar REQUIERE ctx.isProjectTrusted() Y un
 *   ctx.ui.confirm explícito; si falta cualquiera → reject. (Documentado en
 *   handleAutoStart.) El gate de trust también aplica en RE-ENTRY: rehydrate retira
 *   un loop autónomo (terminal "stopped") si el proyecto ya no es trusted, para que un
 *   loop autónomo confirmado una vez no siga disparando sin supervisión tras reloads en
 *   un proyecto que perdió trust.
 * - GC de estado terminal viejo: barre dirs sidecar state.json de loops en status TERMINAL
 *   (done/stopped/failed) cuyo updatedAt es más viejo que GC_MAX_AGE_MS, reflejando
 *   dynamic-workflows getRunDirs. Corre en session_start (y con sweep explícito). NUNCA
 *   toca loops vivos (running/paused/stale).
 * - watchdog anti-zombie: respaldo POR ENCIMA de maxWallClockMs. Un sweep periódico a
 *   nivel módulo force-stoppea (done + cleanup) cualquier loop que pasó un deadline DURO
 *   (startedAt + WATCHDOG_HARD_DEADLINE_MS), capturando loops colgados sin que disparen
 *   los caps normales/agent_end. Los loops sanos nunca se matan.
 *
 * Reglas duras:
 * - gate de print: ctx.mode === "print" → notify + reject.
 * - clampear delaySeconds a [60, 3600] DENTRO de execute() (no confiar en el modelo).
 * - la heurística de cadencia vive en promptGuidelines de loop_schedule, no en código.
 * - sin deps nuevas (typebox ya está presente).
 * - defaults: maxIterations = 25; en "fork" NO migrar el loop.
 * - nunca reinyectar fuera de tui/rpc.
 */

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { capExceeded } from "./caps.js";
import { parseLoopCommandIntent, parseLoopStartArgs } from "./command-intent.js";
import { destructiveReason } from "./gate.js";
import { formatInterval } from "./interval.js";
import { resolveLoop } from "./loop-resolve.js";
import { notify } from "./notify.js";
import { makeLoopIterationPrompt } from "./prompt.js";
import { collectLatestByKey } from "./session-state.js";
import {
	type ActiveLoop,
	createActiveLoop,
	DEFAULT_CONTEXT_PERCENT_CAP,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_MAX_WALL_CLOCK_MS,
	type LoopState,
	type LoopStatus,
	positiveOr,
	shouldRehydrateLoopForSession,
	snapshot,
} from "./state.js";
import { formatStatus } from "./status.js";
import { formatEta } from "./time.js";
import { toolError, toolResult } from "./tool-results.js";

const LOOP_STATE_TYPE = "loop-state";
const LOOP_STATUS_KEY = "loop";
const LOOP_DIR = "loops";
const STATE_FILE = "state.json";
// Tope duro de loops simultáneamente activos (running/paused). Acota la acumulación
// ilimitada de timers/estado por starts repetidos de /loop: cada loop posee un setTimeout,
// y sin esto un usuario podría hacer crecer activeLoops sin límite. Los starts nuevos
// sobre el tope se rechazan; rehydrate de loops ya creados queda exento.
const MAX_CONCURRENT_LOOPS = 20;
const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;
// Cadencia de seguridad cuando un turno cerró sin que el modelo llame loop_schedule.
const SAFETY_NET_DELAY_SECONDS = 1500;
// GC P2: barre dirs sidecar terminales (done/stopped/failed) más viejos que esto.
// Los estados vivos (running/paused/stale) NUNCA se barren sin importar su edad.
const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días.
// Watchdog P2: respaldo ABSOLUTO por encima de maxWallClockMs. Un loop que supere
// startedAt + esto (p. ej. colgado, caps sin disparar) se force-stoppea (done + cleanup).
// Es deliberadamente amplio (por encima del deadline por default de 6h) para captar solo zombies.
const WATCHDOG_HARD_DEADLINE_MS = 25 * 60 * 60 * 1000; // 25h.

// Calca activeRuns de dynamic-workflows: fuente de verdad de "qué timers viven AHORA".
const activeLoops = new Map<string, ActiveLoop>();

// ---------------------------------------------------------------------------
// Cola FIFO de wakes (P2): serializa turnos autopilot entre N loops
// ---------------------------------------------------------------------------

/**
 * Un wake autopilot pendiente. Cuando varios timers de loops disparan casi al mismo
 * tiempo, cada uno llamaría sendUserMessage y competiría por el turno. Los serializamos:
 * solo se entrega UN wake a la vez, y solo cuando el agente está idle y no hay otro turno
 * autopilot en vuelo. El resto se encola acá, FIFO, y se drena en agent_end.
 */
interface PendingWake {
	loopId: string;
}

// FIFO a nivel módulo de wakes esperando entrega. Orden = orden de llegada.
const wakeQueue: PendingWake[] = [];
// Verdadero desde que se entrega un wake hasta que termina el turno que disparó (agent_end).
// Mientras sea verdadero, no se entrega otro wake (un turno autopilot a la vez).
let autopilotTurnInFlight = false;

/** ¿El loop dueño del turno autopilot en vuelo sigue presente y running? */
function inFlightOwnerAlive(): boolean {
	for (const loop of activeLoops.values()) {
		if (loop.autopilot && loop.status === "running") return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Hojas puras extraídas a siblings de profundidad uno:
//   ./prompt.ts   — makeLoopIterationPrompt
//   ./interval.ts — parseInterval / formatInterval
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Línea de estado
// ---------------------------------------------------------------------------

function setLoopStatus(ctx: ExtensionContext, loop: LoopState): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const paused = loop.status === "paused" ? " paused" : "";
	const fixed =
		loop.mode === "fixed" && loop.intervalMs ? ` @${formatInterval(Math.round(loop.intervalMs / 1000))}` : "";
	const eta = loop.status === "running" && loop.nextFireAt ? ` next ${formatEta(loop.nextFireAt)}` : "";
	const reason = loop.lastReason ? ` · ${loop.lastReason}` : "";
	ctx.ui.setStatus(
		LOOP_STATUS_KEY,
		`${theme.fg("accent", "↻ loop")} ${theme.fg("dim", `it ${loop.iteration}/${loop.maxIterations}${fixed}${paused}${eta}${reason}`)}`,
	);
}

function clearLoopStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(LOOP_STATUS_KEY, undefined);
}

/** Refresca el status desde el loop actualmente running o paused, si hay. */
function refreshLoopStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	// Preferir un loop running; usar uno paused como fallback para que el usuario lo siga viendo.
	for (const loop of activeLoops.values()) {
		if (loop.status === "running") {
			setLoopStatus(ctx, loop);
			return;
		}
	}
	for (const loop of activeLoops.values()) {
		if (loop.status === "paused") {
			setLoopStatus(ctx, loop);
			return;
		}
	}
	clearLoopStatus(ctx);
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

/**
 * Persiste una transición de loop. Marca `updatedAt` (para resolver conflictos
 * JSONL vs sidecar por recencia), agrega al JSONL de sesión (NO va al LLM), y
 * dispara sin esperar una escritura sidecar ATOMIC que cubre un crash duro donde
 * el JSONL podría perder el último append.
 */
function currentOwnerSessionId(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.trim() ? id : undefined;
	} catch {
		return undefined;
	}
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	loop.updatedAt = new Date().toISOString();
	const snap = snapshot(loop);
	pi.appendEntry<LoopState>(LOOP_STATE_TYPE, snap);
	// Sidecar atómico best-effort (nunca lanza al engine).
	void writeSidecar(ctx, snap).catch(() => {});
}

// --- Sidecar atómico (P1) -------------------------------------------------------

/**
 * Dir de estado dual-root, reflejando dynamic-workflows getRunRoot:
 * - proyecto trusted → <cwd>/.pi/loops/<id>
 * - si no            → <agentDir>/loops/<projectHash>/<id>
 */
function loopStateDir(ctx: ExtensionContext, loopId: string): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, LOOP_DIR, loopId);
	const projectHash = crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 12);
	return path.join(getAgentDir(), LOOP_DIR, projectHash, loopId);
}

/** Escritura atómica: temp file y rename, para que un crash a mitad de escritura no trunque state.json. */
async function writeSidecar(ctx: ExtensionContext, state: LoopState): Promise<void> {
	const dir = loopStateDir(ctx, state.loopId);
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, STATE_FILE);
	const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	try {
		await fs.rename(temp, file);
	} catch (err) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw err;
	}
}

/** Lee un sidecar state.json para un loopId, o undefined si falta o está corrupto. */
async function readSidecar(ctx: ExtensionContext, loopId: string): Promise<LoopState | undefined> {
	try {
		const file = path.join(loopStateDir(ctx, loopId), STATE_FILE);
		const body = await fs.readFile(file, "utf8");
		const data = JSON.parse(body) as LoopState;
		if (!data || typeof data.loopId !== "string") return undefined;
		return data;
	} catch {
		return undefined;
	}
}

/** Descubrimiento best-effort de loopIds que existen solo en estado sidecar. */
async function discoverSidecarLoopIds(ctx: ExtensionContext): Promise<string[]> {
	try {
		const dirents = await fs.readdir(loopStateRoot(ctx), { withFileTypes: true });
		return dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Wake / scheduling
// ---------------------------------------------------------------------------

/**
 * Un loop solo puede correr donde el agent loop sea suficientemente interactivo
 * para reinyectar un prompt y reanudarse solo: TUI y RPC. "print" es one-shot, y
 * "json" no es interactivo (hasUI es true solo en tui/rpc); ninguno sostiene una
 * sesión de loop. Refleja wakeAgentForWorkflowResult en dynamic-workflows.
 */
function canLoopInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

/**
 * Primitiva de entrega de bajo nivel: reinyecta un prompt en la sesión. Refleja
 * wakeAgentForWorkflowResult (idle → steer; busy → followUp). Tiene gate por modo.
 * La cola FIFO (deliverWake/drainWakeQueue) es el único caller; nunca llamar esto
 * directamente para reinyectar una iteración autopilot porque saltearía la serialización.
 *
 * NOTE (P2): drainWakeQueue ahora gatea la entrega con ctx.isIdle(), así que el único
 * camino alcanzable acá es la rama idle (steer); la rama followUp se conserva
 * defensivamente (un caller futuro / modo distinto podría alcanzarla), pero la cola
 * nunca entrega mientras está busy.
 */
function wake(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	// Gate por modo: nunca reinyectar fuera de tui/rpc (también defiende rutas de rehydrate).
	if (!canLoopInMode(ctx)) return;
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

/**
 * Intenta entregar el siguiente wake encolado (P2). Entrega COMO MÁXIMO UNO, y solo
 * cuando el agente está idle (nunca en medio de un turno de usuario) Y no hay otro turno
 * autopilot en vuelo. Garantiza un único turno autopilot a la vez entre N loops y nunca
 * abre un turno autopilot mientras el humano todavía posee el turno. Lo demás queda
 * encolado (FIFO) y se reintenta en el siguiente agent_end. Saltea/descarta entradas cuyo
 * loop ya no está running (stopped/paused/gone), para que una entrada stale nunca reinyecte.
 *
 * El contador de iteración avanza y el flag autopilot se arma ACÁ (al entregar), no al
 * encolar, así un loop encolado pero no entregado no avanza ni bloquea el gate de
 * acciones destructivas.
 */
function drainWakeQueue(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!canLoopInMode(ctx)) return;
	// Entregar SOLO cuando el agente está idle: un wake inyectado durante el turno del usuario
	// abriría un turno autopilot en medio del turno humano (anyAutopilotActive() entonces gatearía
	// los comandos destructivos del humano, violando "a human-driven turn is never gated"). Si el
	// agente está busy, dejar todo encolado; agent_end vuelve a drenar cuando el turno termina y el
	// agente está idle otra vez.
	if (!ctx.isIdle()) return;
	// Un turno autopilot a la vez: nunca entregar un segundo wake mientras ya hay un turno
	// en vuelo (su loop dueño sigue running). Esta serialización evita que N loops inyecten
	// en el mismo turno.
	if (autopilotTurnInFlight && inFlightOwnerAlive()) return;

	while (wakeQueue.length > 0) {
		const next = wakeQueue.shift()!;
		const loop = activeLoops.get(next.loopId);
		// Descartar entradas stale: el loop fue stopped/paused/removido antes de su turno.
		if (loop?.status !== "running") continue;
		// Guards rechequeados al entregar (el estado puede haber cambiado en cola).
		if (loop.iteration >= loop.maxIterations) {
			stopForMaxIterations(pi, ctx, loop);
			continue;
		}
		const cap = capExceeded(ctx, loop);
		if (cap) {
			stopForCap(pi, ctx, loop, cap);
			continue;
		}
		deliverWake(pi, ctx, loop);
		return; // exactamente un turno autopilot a la vez.
	}
}

/** Entrega una iteración de loop: avanza contador, arma autopilot, persiste, reinyecta. */
function deliverWake(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	loop.iteration += 1;
	// En modo fixed, recordar el timestamp ABSOLUTO para el que se programó esta iteración
	// para que el próximo rearmado sea previousTarget + period (sin deriva). En modo dynamic
	// el modelo elige la próxima cadencia, así que se limpia el anchor.
	loop.fixedAnchor = loop.mode === "fixed" ? (loop.nextFireAt ?? Date.now()) : undefined;
	loop.nextFireAt = null;
	loop.rearmedThisTurn = false;
	// Este turno lo disparó un wake (no el usuario): armar el gate autopilot y marcar un
	// turno en vuelo para que no se entregue otro wake encolado hasta que termine.
	loop.autopilot = true;
	autopilotTurnInFlight = true;
	persist(pi, ctx, loop);
	setLoopStatus(ctx, loop);
	wake(pi, ctx, makeLoopIterationPrompt(loop));
}

/** Detiene un loop porque alcanzó su tope de iteraciones. Status "done" (fin limpio y esperado). */
function stopForMaxIterations(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	stopLoop(pi, ctx, loop.loopId, `alcanzó el límite de maxIterations (${loop.maxIterations})`, "done");
	notify(ctx, `Loop ${loop.loopId} detenido: alcanzó el límite de maxIterations (${loop.maxIterations}).`, "warning");
}

/** Detiene un loop porque se tocó un tope. Status "done" (fin limpio y esperado). */
function stopForCap(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop, reason: string): void {
	stopLoop(pi, ctx, loop.loopId, reason, "done");
	notify(ctx, `Loop ${loop.loopId} detenido: ${reason}.`, "warning");
}

/**
 * Dispara una iteración. Valida status, aplica maxIterations + caps, luego ENCOLA el
 * wake en la FIFO del módulo e intenta drenarla. Con N loops cuyos timers disparan casi
 * al mismo instante, esto los serializa: drainWakeQueue entrega como máximo un turno
 * autopilot a la vez; el resto queda en cola y se drena en agent_end. (P2 cambió esto
 * de reinyectar directo a enqueue+drain; el bookkeeping por iteración pasó a deliverWake.)
 */
function fireWake(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	loop.timer = null;
	if (loop.status !== "running") return;

	// El timer de este loop disparó, lo que significa que su turno PREVIO terminó (el timer
	// solo se arma en scheduleWake/rearmFixed/agent_end, es decir, después del turno). Si
	// este loop era el dueño autopilot en vuelo, liberar el gate ahora para que pueda
	// entregarse un wake fresco (cubre rutas donde agent_end no corrió entre turnos,
	// p. ej. tests / edge RPC).
	if (loop.autopilot) {
		loop.autopilot = false;
		autopilotTurnInFlight = false;
	}

	// Respaldo: si ESTE loop es zombi (pasó el deadline duro), detener en vez de disparar.
	// (El gate de caps de abajo cubre maxWallClockMs; esto también captura loops cuyo
	// maxWallClockMs quedó absurdamente alto.)
	if (Date.now() - loop.startedAt >= WATCHDOG_HARD_DEADLINE_MS) {
		const reason = `watchdog: superó el deadline de respaldo duro (${Math.round(WATCHDOG_HARD_DEADLINE_MS / 3600000)}h)`;
		stopLoop(pi, ctx, loop.loopId, reason, "done");
		notify(ctx, `Loop ${loop.loopId} forzado a detenerse por el watchdog (respaldo anti-zombie).`, "warning");
		return;
	}

	if (loop.iteration >= loop.maxIterations) {
		stopForMaxIterations(pi, ctx, loop);
		return;
	}

	// Gate de caps antes de hacer trabajo: nunca disparar una iteración pasado un deadline/budget.
	const cap = capExceeded(ctx, loop);
	if (cap) {
		stopForCap(pi, ctx, loop, cap);
		return;
	}

	// Encolar el wake de este loop (dedup: nunca encolar el mismo loop dos veces a la vez)
	// e intentar entregarlo. deliverWake hace iteration++/autopilot/persist/reinyección.
	// Solo se encola loopId: deliverWake reconstruye el prompt fresco vía
	// makeLoopIterationPrompt(loop) al entregar (reflejando la iteración recién incrementada),
	// así que cargar un prompt string en la entrada de cola sería dato muerto y stale.
	if (!wakeQueue.some((w) => w.loopId === loop.loopId)) {
		wakeQueue.push({ loopId: loop.loopId });
	}
	drainWakeQueue(pi, ctx);
}

/** Arma el próximo wake después de delaySec. El caller es responsable de clampear. */
function scheduleWake(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	loop: ActiveLoop,
	delaySec: number,
	reason: string,
): void {
	if (loop.timer) {
		clearTimeout(loop.timer);
		loop.timer = null;
	}
	loop.nextFireAt = Date.now() + delaySec * 1000;
	loop.lastReason = reason;
	loop.rearmedThisTurn = true;
	persist(pi, ctx, loop);
	setLoopStatus(ctx, loop);
	loop.timer = setTimeout(() => fireWake(pi, ctx, loop), delaySec * 1000);
}

/**
 * Rearmado fixed-mode (P1). La extensión posee la cadencia: programa el próximo wake
 * en un timestamp ABSOLUTO (nextFireAt += periodMs) para que los períodos no deriven,
 * y usa un setTimeout rearmado (nunca setInterval) para que una iteración lenta no se
 * solape con la siguiente. Si el target absoluto ya está en el pasado (iteración larga),
 * dispara en el siguiente tick (delay 0): un solo catch-up, nunca un burst.
 */
function rearmFixed(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	if (loop.timer) {
		clearTimeout(loop.timer);
		loop.timer = null;
	}
	const period = loop.intervalMs ?? 0;
	// Anclar al fire time programado previo (seteado por fireWake) para que los períodos
	// no deriven; fallback al nextFireAt actual (primer armado / resume) o now.
	const base = loop.fixedAnchor ?? loop.nextFireAt ?? Date.now();
	loop.fixedAnchor = undefined;
	const target = base + period;
	const delay = Math.max(0, target - Date.now());
	loop.nextFireAt = target;
	loop.lastReason = `auto: intervalo fijo ${formatInterval(Math.round(period / 1000))}`;
	loop.rearmedThisTurn = true;
	persist(pi, ctx, loop);
	setLoopStatus(ctx, loop);
	loop.timer = setTimeout(() => fireWake(pi, ctx, loop), delay);
}

// ---------------------------------------------------------------------------
// Inicio / stop
// ---------------------------------------------------------------------------

function refuseIfCannotLoopInMode(ctx: ExtensionContext, commandName: "/loop" | "/loop auto"): boolean {
	if (canLoopInMode(ctx)) return false;
	notify(ctx, `${commandName} requiere una sesión TUI o RPC (este modo no puede loopear).`, "error");
	return true;
}

function refuseIfLoopLimitReached(ctx: ExtensionContext): boolean {
	if (activeLoops.size < MAX_CONCURRENT_LOOPS) return false;
	notify(
		ctx,
		`Demasiados loops activos (${activeLoops.size}/${MAX_CONCURRENT_LOOPS}). Detené uno con /loop stop antes de iniciar otro.`,
		"error",
	);
	return true;
}

function formatFixedModeLabel(loop: ActiveLoop): string {
	if (loop.mode !== "fixed") return "";
	return ` (cada ${formatInterval(Math.round((loop.intervalMs ?? 0) / 1000))})`;
}

function activateLoop(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	activeLoops.set(loop.loopId, loop);
	persist(pi, ctx, loop);
	// Enviar de inmediato el primer prompt de iteración. fireWake maneja iteration++/persist/status.
	// deliverWake construye el prompt fresco vía makeLoopIterationPrompt(loop), así que nunca
	// se guarda en el loop: solo estaría stale cuando se leyera.
	fireWake(pi, ctx, loop);
}

interface StartLoopDraft {
	task: string;
	intervalMs?: number;
	ultracode: boolean;
	autonomous?: boolean;
}

function createStartedLoop(ctx: ExtensionContext, draft: StartLoopDraft): ActiveLoop {
	return createActiveLoop({
		loopId: crypto.randomBytes(4).toString("hex"),
		task: draft.task,
		intervalMs: draft.intervalMs,
		now: Date.now(),
		autonomous: draft.autonomous,
		ultracode: draft.ultracode,
		ownerSessionId: currentOwnerSessionId(ctx),
	});
}

function notifyLoopStarted(
	ctx: ExtensionContext,
	loop: ActiveLoop,
	taskText: string,
	options: { autonomous?: boolean; includeUltracode?: boolean } = {},
): void {
	const modeLabel = formatFixedModeLabel(loop);
	const uc = options.includeUltracode && loop.ultracode ? " [ultracode]" : "";
	const kind = options.autonomous ? "Loop autónomo" : "Loop";
	notify(ctx, `${kind} ${loop.loopId} iniciado${modeLabel}${uc}: ${taskText}`, "info");
}

function startLoop(pi: ExtensionAPI, ctx: ExtensionContext, task: string): ActiveLoop | undefined {
	// Gate por modo: solo TUI/RPC puede sostener una sesión persistente de loop.
	if (refuseIfCannotLoopInMode(ctx, "/loop")) return undefined;
	const { text: taskText, intervalMs, ultracode } = parseLoopStartArgs(task);
	if (!taskText) {
		notify(ctx, "Uso: /loop [--ultracode] <task> [interval]", "warning");
		return undefined;
	}
	if (refuseIfLoopLimitReached(ctx)) return undefined;

	const loop = createStartedLoop(ctx, { task: taskText, intervalMs, ultracode });
	activateLoop(pi, ctx, loop);
	notifyLoopStarted(ctx, loop, taskText, { includeUltracode: true });
	return loop;
}

/**
 * Inicia un loop AUTÓNOMO (P2): un loop cuyo texto reinyectado es un sentinel/objective
 * generado por la extensión, no una tarea de usuario puntual. Como ese loop seguirá
 * actuando sin un humano en el turno, el umbral es más alto:
 *   - el proyecto DEBE ser trusted (ctx.isProjectTrusted()), y
 *   - el usuario DEBE confirmar explícitamente vía ctx.ui.confirm.
 * Si falta CUALQUIERA → reject (no se crea loop). Sin UI no hay forma de confirmar, así
 * que el modo autónomo también se rechaza. Todo lo demás (modes, caps, persistencia,
 * gate de acciones irreversibles, cola FIFO, watchdog) se comparte con startLoop.
 */
async function startAutonomousLoop(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	rawArgs: string,
): Promise<ActiveLoop | undefined> {
	if (refuseIfCannotLoopInMode(ctx, "/loop auto")) return undefined;
	// Gate de trust PRIMERO: un loop autónomo nunca debe correr en un proyecto untrusted.
	if (!ctx.isProjectTrusted()) {
		notify(ctx, "/loop auto requiere un proyecto de confianza. Corré /trust primero, y reintentá.", "error");
		return undefined;
	}
	const { text: objective, intervalMs, ultracode } = parseLoopStartArgs(rawArgs);
	if (!objective) {
		notify(ctx, "Uso: /loop auto [--ultracode] <objective> [interval]", "warning");
		return undefined;
	}
	// Confirmación obligatoria: si no hay UI para confirmar → rechazar (no se puede obtener consentimiento).
	if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
		notify(ctx, "/loop auto requiere una confirmación interactiva; corrélo desde una sesión TUI o RPC.", "error");
		return undefined;
	}
	const approved = await ctx.ui.confirm(
		"¿Iniciar un loop autónomo?",
		`Este loop va a actuar por su cuenta (sin mensaje del usuario en cada turno) para perseguir:\n\n${objective}\n\nLas acciones destructivas siguen bloqueadas, pero va a correr sin supervisión. ¿Lo iniciás?`,
	);
	if (!approved) {
		notify(ctx, "El loop autónomo no se inició (no se confirmó).", "info");
		return undefined;
	}
	if (refuseIfLoopLimitReached(ctx)) return undefined;

	const loop = createStartedLoop(ctx, { task: objective, intervalMs, autonomous: true, ultracode });
	activateLoop(pi, ctx, loop);
	notifyLoopStarted(ctx, loop, objective, { autonomous: true });
	return loop;
}

function stopLoop(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	loopId: string,
	reason: string,
	finalStatus: "stopped" | "done" | "failed" = "stopped",
): boolean {
	const loop = activeLoops.get(loopId);
	if (!loop) return false;
	if (loop.timer) {
		clearTimeout(loop.timer);
		loop.timer = null;
	}
	loop.controller.abort(reason);
	loop.status = finalStatus;
	loop.nextFireAt = null;
	loop.lastReason = reason;
	loop.autopilot = false;
	// Descartar cualquier wake pendiente de este loop para que nunca reinyecte tras stop.
	dropQueuedWakes(loopId);
	persist(pi, ctx, loop);
	// Los loops terminales ya no están activos: conservar el snapshot final persistido
	// para decisiones de audit/rehydrate, pero quitar el loop en memoria de inmediato
	// para que /loop status, completions, GC y refresh de línea de estado vean solo loops vivos.
	activeLoops.delete(loopId);
	refreshLoopStatus(ctx);
	return true;
}

/** Quita wakes encolados de un loop (usado en stop/pause para que nunca se entreguen). */
function dropQueuedWakes(loopId: string): void {
	for (let i = wakeQueue.length - 1; i >= 0; i--) {
		if (wakeQueue[i].loopId === loopId) wakeQueue.splice(i, 1);
	}
}

/**
 * Pausa un loop (P1): limpia el timer, conserva todo el estado y setea status "paused".
 * Registra el delay restante para que resume (dynamic) rearme con lo que quedaba.
 * NO reinyecta. NO-OP si el loop no está running.
 */
function pauseLoop(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): boolean {
	if (loop.status !== "running") return false;
	if (loop.timer) {
		clearTimeout(loop.timer);
		loop.timer = null;
	}
	// Preservar el delay restante como offset relativo para que resume pueda restaurarlo
	// incluso tras persist/rehydrate (rederivamos nextFireAt desde esto en resume).
	loop.pausedRemainingMs = loop.nextFireAt === null ? null : Math.max(0, loop.nextFireAt - Date.now());
	loop.status = "paused";
	loop.autopilot = false;
	// Descartar cualquier wake pendiente para que un loop paused nunca reinyecte desde la cola.
	dropQueuedWakes(loop.loopId);
	persist(pi, ctx, loop);
	refreshLoopStatus(ctx);
	return true;
}

/**
 * Reanuda un loop paused (P1): status vuelve a "running" y rearma. Los loops dynamic usan
 * el delay restante capturado al pausar (fallback: cadencia de seguridad si se desconoce);
 * los loops fixed rearma por su período propio. NO-OP si el loop no está paused.
 */
function resumeLoop(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): boolean {
	if (loop.status !== "paused") return false;
	loop.status = "running";
	if (loop.mode === "fixed") {
		// Fixed: anclar el próximo fire absoluto en now + period (sin deriva desde resume).
		loop.nextFireAt = Date.now();
		rearmFixed(pi, ctx, loop);
		return true;
	}
	// Preferir el remanente capturado al pausar (pause/resume en el mismo proceso). Si
	// ya no está (p. ej. el loop fue pausado, persistido y rehidratado tras un reload:
	// pausedRemainingMs es transitorio y NO persistido), usar como fallback el nextFireAt
	// absoluto persistido, que SÍ sobrevive un reload (refleja lo que rehydrate hace con
	// loops running). Solo cuando ninguno existe usamos la cadencia de seguridad.
	const remaining =
		loop.pausedRemainingMs != null
			? loop.pausedRemainingMs
			: loop.nextFireAt != null
				? Math.max(0, loop.nextFireAt - Date.now())
				: SAFETY_NET_DELAY_SECONDS * 1000;
	loop.pausedRemainingMs = undefined;
	scheduleWake(pi, ctx, loop, Math.round(remaining / 1000), "reanudado por el usuario");
	return true;
}

// ---------------------------------------------------------------------------
// Rehidratación (session_start)
// ---------------------------------------------------------------------------

/**
 * Elige el más nuevo de dos snapshots por updatedAt (los strings ISO comparan léxicamente
 * porque comparten formato; updatedAt ausente se trata como lo más viejo). Usado para resolver
 * conflictos JSONL-vs-sidecar: gana el que se escribió último.
 */
function newerState(a: LoopState | undefined, b: LoopState | undefined): LoopState | undefined {
	if (!a) return b;
	if (!b) return a;
	const ta = a.updatedAt ?? "";
	const tb = b.updatedAt ?? "";
	return tb > ta ? b : a;
}

/**
 * Reconstruye estado de loop y rearma. La fuente de verdad por loopId es el MÁS NUEVO
 * entre la última entrada JSONL y el sidecar atómico (por updatedAt), cubriendo un crash
 * duro donde el JSONL podría perder el último append. Evita double-fire: si activeLoops
 * ya tiene el loop (timer vivo en este proceso), saltea. Solo un catch-up tick: sin burst.
 * Recupera loops "paused" como paused (sin rearmar). Respeta caps (nunca rearma pasado uno).
 */
async function rehydrate(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const entries = ctx.sessionManager.getEntries();
	const latestJsonl = collectLatestByKey<LoopState>(entries, LOOP_STATE_TYPE, (d) => d.loopId);

	// Resolver cada loopId contra su sidecar (gana el más nuevo por updatedAt). Incluir
	// también loopIds sidecar-only: el sidecar es específicamente el fallback de crash recovery
	// para una transición que llegó a state.json pero no al JSONL de sesión.
	const resolved = new Map<string, LoopState>();
	const sidecarLoopIds = await discoverSidecarLoopIds(ctx);
	const ownerSessionId = currentOwnerSessionId(ctx);
	for (const loopId of new Set([...latestJsonl.keys(), ...sidecarLoopIds])) {
		const jsonlState = latestJsonl.get(loopId);
		const sidecar = await readSidecar(ctx, loopId);
		const winner = newerState(jsonlState, sidecar);
		if (winner && shouldRehydrateLoopForSession(winner, ownerSessionId, latestJsonl.has(loopId))) {
			resolved.set(loopId, winner);
		}
	}

	for (const state of resolved.values()) {
		// "running" = estaba vivo en un proceso previo; "stale" = persistido por un
		// session_shutdown limpio (reload/quit); "paused" = recuperar y mantener paused.
		// Todo lo demás (stopped/done/failed) es terminal → saltear.
		if (state.status !== "running" && state.status !== "stale" && state.status !== "paused") continue;
		// Timer todavía vivo en este proceso → no rearmar (sin double-fire).
		if (activeLoops.has(state.loopId)) continue;
		// Gate de re-entry AUTÓNOMO (seguridad P2): un loop autónomo actúa sin humano en
		// el turno, así que su start requirió trust + confirm explícito. Esa garantía debe
		// sostenerse en CADA re-entry, no solo en el start interactivo; si no, un loop
		// autónomo confirmado una vez seguiría disparando sin supervisión tras reloads aunque
		// el proyecto deje de ser trusted. Si el proyecto ya no es trusted, retirarlo
		// (terminal "stopped") en vez de rearmarlo. (Un proyecto trusted todavía lo rehidrata;
		// no repreguntamos confirm en rehydrate porque no hay usuario interactivo en
		// session_start, y trust es el gate crítico para acción sin supervisión.)
		if (state.autonomous && !ctx.isProjectTrusted()) {
			const retired: ActiveLoop = {
				...state,
				mode: state.mode ?? "dynamic",
				maxIterations: positiveOr(Math.trunc(state.maxIterations), DEFAULT_MAX_ITERATIONS),
				maxWallClockMs: positiveOr(state.maxWallClockMs, DEFAULT_MAX_WALL_CLOCK_MS),
				contextPercentCap: Math.min(positiveOr(state.contextPercentCap, DEFAULT_CONTEXT_PERCENT_CAP), 100),
				updatedAt: state.updatedAt ?? new Date().toISOString(),
				status: "stopped",
				timer: null,
				controller: new AbortController(),
				rearmedThisTurn: false,
				autopilot: false,
			};
			activeLoops.set(retired.loopId, retired);
			stopLoop(pi, ctx, retired.loopId, "loop autónomo retirado: el proyecto ya no es de confianza", "stopped");
			continue;
		}

		const recoverPaused = state.status === "paused";
		const loop: ActiveLoop = {
			...state,
			// Compatibilidad hacia atrás para snapshots pre-P1 a los que les faltan los campos nuevos.
			mode: state.mode ?? "dynamic",
			maxIterations: positiveOr(Math.trunc(state.maxIterations), DEFAULT_MAX_ITERATIONS),
			maxWallClockMs: positiveOr(state.maxWallClockMs, DEFAULT_MAX_WALL_CLOCK_MS),
			contextPercentCap: Math.min(positiveOr(state.contextPercentCap, DEFAULT_CONTEXT_PERCENT_CAP), 100),
			updatedAt: state.updatedAt ?? new Date().toISOString(),
			// Normalizar un snapshot "stale" recuperado de vuelta a "running"; dejar "paused" como está.
			status: recoverPaused ? "paused" : "running",
			timer: null,
			controller: new AbortController(),
			rearmedThisTurn: false,
			autopilot: false,
		};
		activeLoops.set(loop.loopId, loop);

		// Los loops paused se recuperan idle (sin timer) hasta /loop resume.
		if (recoverPaused) continue;

		// Un cap ya excedido durante el downtime → detener limpiamente en vez de rearmar.
		const cap = capExceeded(ctx, loop);
		if (cap) {
			stopForCap(pi, ctx, loop, cap);
			continue;
		}

		const remaining = loop.nextFireAt === null ? 0 : Math.max(0, loop.nextFireAt - Date.now());
		// Un único tick de catch-up (clampeado a >= 0); nunca un burst de wakes perdidos.
		loop.timer = setTimeout(() => fireWake(pi, ctx, loop), remaining);
	}
	refreshLoopStatus(ctx);
	// Barrido de respaldo: un loop que quedó colgado durante el downtime (más allá del deadline duro)
	// se force-stoppea acá en vez de rearmarse hacia otra iteración zombie.
	watchdogSweep(pi, ctx);
}

// ---------------------------------------------------------------------------
// GC de estado terminal viejo (P2)
// ---------------------------------------------------------------------------

/**
 * Root que guarda dirs sidecar por loop, espejando el padre de loopStateDir:
 * - proyecto trusted → <cwd>/.pi/loops
 * - si no            → <agentDir>/loops/<projectHash>
 * (Misma partición que dynamic-workflows getRunRoot, así que GC recorre el árbol correcto.)
 */
function loopStateRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, LOOP_DIR);
	const projectHash = crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 12);
	return path.join(getAgentDir(), LOOP_DIR, projectHash);
}

const TERMINAL_STATUSES: ReadonlySet<LoopStatus> = new Set<LoopStatus>(["done", "stopped", "failed"]);

/**
 * Barre dirs sidecar terminales viejos (P2). Para cada <root>/<id>/state.json, lo parsea y
 * quita el dir SOLO cuando el loop está en un estado terminal (done/stopped/failed) Y su
 * updatedAt es más viejo que GC_MAX_AGE_MS. Los loops vivos (running/paused/stale) y los loops
 * todavía presentes en activeLoops NUNCA se quitan sin importar la edad. De mejor esfuerzo: cualquier
 * error de read/parse/rm se traga para que GC nunca pueda crashear la sesión. Devuelve cuántos dirs quitó.
 *
 * Refleja dynamic-workflows getRunDirs (readdir withFileTypes + stat), pero la decisión de recencia
 * usa el updatedAt persistido (no el mtime del dir), así que un FS con skew de reloj no puede hacernos
 * borrar estado fresco — y además seguimos exigiendo un estado TERMINAL, así que un loop vivo está seguro
 * aunque su state.json sea antiquísimo.
 */
async function gcOldTerminalLoops(ctx: ExtensionContext, now: number = Date.now()): Promise<number> {
	const root = loopStateRoot(ctx);
	if (!existsSync(root)) return 0;
	let removed = 0;
	let dirents: import("node:fs").Dirent[];
	try {
		dirents = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const dirent of dirents) {
		if (!dirent.isDirectory()) continue;
		const loopId = dirent.name;
		// Nunca hacer GC de un loop que está vivo en este proceso (el timer puede estar armado).
		if (activeLoops.has(loopId)) continue;
		const dir = path.join(root, loopId);
		const file = path.join(dir, STATE_FILE);
		try {
			const body = await fs.readFile(file, "utf8");
			const state = JSON.parse(body) as LoopState;
			if (!state || typeof state.status !== "string") continue;
			// Solo los estados terminales son elegibles; los estados vivos se preservan indefinidamente.
			if (!TERMINAL_STATUSES.has(state.status)) continue;
			const updated = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
			// Exigir un updatedAt parseable y suficientemente viejo antes de borrar.
			if (!Number.isFinite(updated) || now - updated < GC_MAX_AGE_MS) continue;
			await fs.rm(dir, { recursive: true, force: true });
			removed += 1;
		} catch {
			// state.json faltante/corrupto o fallo de rm → saltear (nunca lanzar hacia el engine).
		}
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Watchdog anti-zombie (P2)
// ---------------------------------------------------------------------------

/**
 * Force-stoppea cualquier loop que haya superado su deadline ABSOLUTO de respaldo (P2). Esta es una
 * red de último recurso POR ENCIMA de maxWallClockMs / el cap de contexto: esos se chequean al momento
 * de rearmar, así que un loop que se colgó SIN llegar a un agent_end (o cuyos caps de algún modo nunca
 * dispararon) podría vivir para siempre. Acá hard-stoppeamos (done + cleanup completo) cualquier loop
 * RUNNING cuyo startedAt + WATCHDOG_HARD_DEADLINE_MS quedó en el pasado.
 * Los loops sanos (bien dentro del deadline) no se tocan. Devuelve la cantidad force-stoppeada.
 *
 * Los loops PAUSED NO son zombies y se excluyen deliberadamente: un loop pausado no tiene timer armado
 * y no consume nada — está idle a propósito esperando /loop resume, un estado totalmente legítimo.
 * Su wall-clock desde startedAt sigue creciendo mientras está paused, así que medirlo contra startedAt
 * mataría un loop paused sano a espaldas del usuario (p. ej. pausado durante un fin de semana). Un loop
 * paused solo pasa a ser elegible para el watchdog después de reanudarse (status de vuelta a "running").
 * El cap blando de wall-clock (capExceeded) ya nunca dispara sobre un loop paused, así que excluir paused
 * acá mantiene consistente el respaldo duro con eso.
 *
 * Sin timer periódico dedicado: el barrido se dispara desde los puntos naturales de pulso
 * (session_start después de rehydrate, cada agent_end y cada fireWake). Eso evita
 * agregar un timer de módulo ortogonal (y es igual de efectivo — un proceso muerto tampoco
 * correría un timer periódico; la recuperación pasa en el siguiente session_start).
 */
function watchdogSweep(pi: ExtensionAPI, ctx: ExtensionContext, now: number = Date.now()): number {
	let killed = 0;
	for (const loop of [...activeLoops.values()]) {
		// Solo los loops RUNNING pueden ser zombies; un loop paused está idle a propósito (ver docstring).
		if (loop.status !== "running") continue;
		if (now - loop.startedAt < WATCHDOG_HARD_DEADLINE_MS) continue;
		const reason = `watchdog: superó el deadline de respaldo duro (${Math.round(WATCHDOG_HARD_DEADLINE_MS / 3600000)}h)`;
		stopLoop(pi, ctx, loop.loopId, reason, "done");
		notify(ctx, `Loop ${loop.loopId} forzado a detenerse por el watchdog (respaldo anti-zombie).`, "warning");
		killed += 1;
	}
	return killed;
}

// ---------------------------------------------------------------------------
// Manejo de comandos
// ---------------------------------------------------------------------------

function formatLoopStatusList(loops: ActiveLoop[]): string {
	return loops.map(formatStatus).join("\n");
}

async function handleLoopCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const intent = parseLoopCommandIntent(args);

	if (intent.kind === "stop") {
		const loop = await resolveLoop(ctx, activeLoops, intent.rest || undefined, ["running", "paused"]);
		if (!loop) {
			notify(
				ctx,
				"No hay ningún loop que coincida para detener. Usá /loop status para ver los loops activos.",
				"warning",
			);
			return;
		}
		stopLoop(pi, ctx, loop.loopId, "detenido por el usuario (/loop stop)", "stopped");
		notify(ctx, `Loop ${loop.loopId} detenido.`, "info");
		return;
	}

	if (intent.kind === "pause") {
		const loop = await resolveLoop(ctx, activeLoops, intent.rest || undefined, ["running"]);
		if (!loop) {
			notify(
				ctx,
				"No hay ningún loop corriendo para pausar. Usá /loop status para ver los loops activos.",
				"warning",
			);
			return;
		}
		if (pauseLoop(pi, ctx, loop)) notify(ctx, `Loop ${loop.loopId} pausado.`, "info");
		else notify(ctx, `El loop ${loop.loopId} no está corriendo.`, "warning");
		return;
	}

	if (intent.kind === "resume") {
		const loop = await resolveLoop(ctx, activeLoops, intent.rest || undefined, ["paused"]);
		if (!loop) {
			notify(
				ctx,
				"No hay ningún loop pausado para reanudar. Usá /loop status para ver los loops activos.",
				"warning",
			);
			return;
		}
		if (resumeLoop(pi, ctx, loop)) notify(ctx, `Loop ${loop.loopId} reanudado.`, "info");
		else notify(ctx, `El loop ${loop.loopId} no está pausado.`, "warning");
		return;
	}

	if (intent.kind === "auto") {
		// Modo autónomo (P2): requiere trust + una confirmación explícita (forzada adentro).
		await startAutonomousLoop(pi, ctx, intent.rest);
		return;
	}

	if (intent.kind === "status") {
		if (intent.rest) {
			const loop = activeLoops.get(intent.rest);
			notify(
				ctx,
				loop
					? formatStatus(loop)
					: `No hay ningún loop con id ${intent.rest}. Usá /loop status para listar los loops activos.`,
				loop ? "info" : "warning",
			);
			return;
		}
		const all = [...activeLoops.values()];
		if (all.length === 0) {
			notify(ctx, "No hay loops.", "info");
			return;
		}
		notify(ctx, formatLoopStatusList(all), "info");
		return;
	}

	// Si no: args entero es la tarea (posiblemente con un token interval al final).
	startLoop(pi, ctx, intent.rest);
}

// ---------------------------------------------------------------------------
// Gate de acciones irreversibles (P1) — política pura en ./gate.ts (destructiveReason); cableado abajo.
// ---------------------------------------------------------------------------

/** Verdadero si ALGÚN loop considera este turno, actualmente, como un turno autopilot (disparado por wake). */
function anyAutopilotActive(): boolean {
	for (const loop of activeLoops.values()) {
		if (loop.autopilot && loop.status === "running") return true;
	}
	return false;
}

/**
 * Handler de tool_call (P1). Solo gatea cuando el turno actual es autopilot (disparado por wake)
 * Y la tool/args matchean la allowlist destructiva. Con UI: pedir ctx.ui.confirm y
 * bloquear si se rechaza. Sin UI (todavía caso tui/rpc edge, o confirm no disponible): bloqueo duro.
 * Un turno impulsado por un humano (sin flag autopilot) nunca se gatea.
 */
async function handleToolCall(
	ctx: ExtensionContext,
	event: ToolCallEvent,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	if (!anyAutopilotActive()) return undefined;
	const reason = destructiveReason(ctx, event);
	if (!reason) return undefined;

	if (ctx.hasUI && typeof ctx.ui.confirm === "function") {
		const approved = await ctx.ui.confirm(
			"Autopilot quiere ejecutar una acción destructiva",
			`${reason}\n\nEsta iteración del loop se disparó automáticamente (no vos). ¿La permitís?`,
		);
		if (approved) return undefined;
		return { block: true, reason };
	}
	// Sin UI interactiva para confirmar → bloquear para mantener la seguridad.
	return { block: true, reason };
}

function selectToolOwnerLoop(
	running: ActiveLoop[],
	options: { preferDynamicFallback?: boolean } = {},
): ActiveLoop | undefined {
	return (
		running.find((loop) => loop.autopilot) ??
		(options.preferDynamicFallback ? running.find((loop) => loop.mode === "dynamic") : undefined) ??
		running[0]
	);
}

function clampLoopDelaySeconds(raw: number): number {
	if (!Number.isFinite(raw)) return SAFETY_NET_DELAY_SECONDS;
	return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(raw)));
}

interface LoopArgumentCompletion {
	value: string;
	label: string;
	description: string;
}

const STATIC_LOOP_ARGUMENT_COMPLETIONS: LoopArgumentCompletion[] = [
	{ value: "auto", label: "auto", description: "Iniciar un loop autónomo (confianza + confirmación)" },
	{ value: "stop", label: "stop", description: "Detener un loop" },
	{ value: "pause", label: "pause", description: "Pausar un loop en ejecución" },
	{ value: "resume", label: "resume", description: "Reanudar un loop pausado" },
	{ value: "status", label: "status", description: "Mostrar el estado del loop" },
	{
		value: "--ultracode",
		label: "--ultracode",
		description: "Correr las iteraciones del loop vía dynamic workflows",
	},
];

const LOOP_SCHEDULE_PROMPT_GUIDELINES = [
	"Pensá QUÉ estás esperando, no cuánto tiempo querés dormir — y elegí una cadencia acorde. El delay se clampea a [60, 3600] segundos.",
	"Usá un delay corto (<300s) para sondear un estado externo que cambia rápido (p. ej. un run de CI, un deploy) manteniendo caliente la caché de trabajo, pero nunca exactamente 300s.",
	"Usá un delay largo (300-3600s) cuando esperás un cambio lento o estás esperando algo que tarda varios minutos.",
	"Si estás ocioso sin ninguna señal concreta que esperar, programá un fallback largo (1200-1800s) en vez de hacer busy-polling.",
	"NO sondees trabajo que el harness ya trackea por vos (jobs de background, subagentes, workflows) — programá un fallback largo y dejá que te reporte.",
	"Pasá siempre una razón de una oración explicando qué elegíste y por qué; se muestra en la línea de estado y se reinyecta en la próxima iteración para dar continuidad.",
];

// ---------------------------------------------------------------------------
// Punto de entrada de la extensión
// ---------------------------------------------------------------------------

export default function loopExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "loop_schedule",
		label: "Loop Schedule",
		description:
			"Programá la próxima iteración del /loop activo. Llamalo cuando haga falta más trabajo o esperar antes de la siguiente pasada.",
		promptSnippet: "Programá la próxima iteración del /loop con un delay y una razón.",
		promptGuidelines: LOOP_SCHEDULE_PROMPT_GUIDELINES,
		parameters: Type.Object({
			// Sin límites de schema a propósito: el SDK valida (y rechaza) args
			// vía validateToolArguments ANTES de que corra execute(), así que min/max acá
			// lanzarían sobre un valor fuera de rango en vez de dejarnos clampear.
			// El clamp dentro de execute() es la única defensa — nunca confíes en el modelo.
			delaySeconds: Type.Number({
				description: `Segundos a esperar antes de la próxima iteración; clampeado a [${MIN_DELAY_SECONDS}, ${MAX_DELAY_SECONDS}].`,
			}),
			reason: Type.String({ minLength: 3 }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const running = [...activeLoops.values()].filter((l) => l.status === "running");
			if (running.length === 0) {
				return toolError("No hay ningún loop activo para reprogramar. No hay nada que reprogramar.");
			}
			// Apuntar al loop cuyo turno autopilot está llamando realmente esta tool. Para schedule,
			// si no hay dueño explícito, preservar el fallback histórico a un loop dynamic antes de cualquier loop.
			const loop = selectToolOwnerLoop(running, { preferDynamicFallback: true });
			if (!loop) return toolError("No hay ningún loop activo para reprogramar. No hay nada que reprogramar.");
			// Modo fixed: la extensión posee la cadencia, así que loop_schedule es un
			// NO-OP informativo — no tocar el timer ni nextFireAt. El modelo solo
			// decide continuar (no hacer nada) vs detenerse (loop_stop) en un intervalo fijo.
			if (loop.mode === "fixed") {
				const periodSec = Math.round((loop.intervalMs ?? 0) / 1000);
				return toolResult(
					`El loop ${loop.loopId} corre en un intervalo fijo (cada ${formatInterval(periodSec)}); la cadencia es fija y loop_schedule es un no-op. Razón registrada: ${params.reason}.`,
					{ loopId: loop.loopId, mode: "fixed", noop: true, intervalSeconds: periodSec },
				);
			}
			// Clampear DENTRO de execute() — nunca confíes en el valor del modelo. Un valor no finito
			// (NaN/Infinity) hace fallback a la cadencia de safety-net en vez de
			// armar setTimeout(NaN) (que dispararía inmediatamente).
			const raw = params.delaySeconds;
			const delaySec = clampLoopDelaySeconds(raw);
			scheduleWake(pi, ctx, loop, delaySec, params.reason);
			return toolResult(
				`Próxima iteración del loop ${loop.loopId} programada en ${delaySec}s (razón: ${params.reason}).`,
				{
					loopId: loop.loopId,
					delaySeconds: delaySec,
					clampedFrom: raw !== delaySec ? raw : undefined,
				},
			);
		},
	});

	pi.registerTool({
		name: "loop_stop",
		label: "Loop Stop",
		description: "Terminá el /loop activo. Llamalo cuando la tarea esté completa o más iteraciones no ayuden.",
		promptSnippet: "Terminá el /loop activo con una razón.",
		parameters: Type.Object({
			reason: Type.String(),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const running = [...activeLoops.values()].filter((l) => l.status === "running");
			if (running.length === 0) {
				return toolError("No hay ningún loop activo para detener.");
			}
			// Resolver el loop que POSEE el turno actual; sin dueño explícito, preservar el fallback histórico.
			const loop = selectToolOwnerLoop(running);
			if (!loop) return toolError("No hay ningún loop activo para detener.");
			stopLoop(pi, ctx, loop.loopId, params.reason || "detenido por loop_stop", "stopped");
			return toolResult(`Loop ${loop.loopId} detenido (razón: ${params.reason}).`, { loopId: loop.loopId });
		},
	});

	pi.registerCommand("loop", {
		description:
			"Corré una tarea de forma iterativa: /loop [--ultracode] <task> [interval] | /loop auto [--ultracode] <objective> [interval] | /loop stop [id] | /loop pause [id] | /loop resume [id] | /loop status [id]. El interval (p. ej. 5m, 30s, 2h) corre en una cadencia fija; omitilo para que lo module el modelo. 'auto' inicia un loop autónomo (requiere un proyecto de confianza + confirmación). --ultracode conduce las iteraciones vía dynamic workflows.",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items: LoopArgumentCompletion[] = [...STATIC_LOOP_ARGUMENT_COMPLETIONS];
			for (const loop of activeLoops.values()) {
				if (loop.status === "running" || loop.status === "paused") {
					items.push({ value: loop.loopId, label: loop.loopId, description: loop.task });
				}
			}
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!prefix) return items;
			return items.filter((i) => i.value.toLowerCase().startsWith(prefix));
		},
		handler: async (args, ctx) => await handleLoopCommand(pi, args, ctx),
	});

	// Gate de acciones irreversibles (P1): bloquear/confirmar tools destructivas en turnos autopilot.
	pi.on("tool_call", async (event, ctx) => await handleToolCall(ctx, event));

	pi.on("session_start", async (event, ctx) => {
		// NO migrar un loop a una sesión forked: un fork hereda las entradas "loop-state"
		// del padre, pero el loop debe seguir corriendo solo en el padre.
		// startup / reload / resume SÍ rehidratan; "new" no trae entradas del padre.
		if (event.reason === "fork") return;
		await rehydrate(pi, ctx);
		// GC de estado sidecar terminal viejo (P2). Corre DESPUÉS de rehydrate para que los loops vivos estén en
		// activeLoops y así nunca se recolecten. De mejor esfuerzo; nunca lanza hacia el engine.
		await gcOldTerminalLoops(ctx).catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const loop of activeLoops.values()) {
			if (loop.timer) {
				clearTimeout(loop.timer);
				loop.timer = null;
			}
			loop.controller.abort("cierre de sesión");
			if (loop.status === "running") {
				// Persistir como "stale" (recuperable en el próximo session_start), manteniendo nextFireAt intacto.
				loop.status = "stale";
				persist(pi, ctx, loop);
			}
			// "paused" se deja tal cual para que se rehidrate como paused. Estados terminales intactos.
		}
		// Limpiar el set in-memory vivo, la cola y el gate in-flight: los snapshots persistidos
		// de arriba son la fuente de verdad del próximo session_start. Mantener acá objetos
		// ActiveLoop stale/paused haría que un reload del mismo proceso saltee rehydrate vía
		// activeLoops.has(...) y deje sin timer armado.
		activeLoops.clear();
		wakeQueue.length = 0;
		autopilotTurnInFlight = false;
		clearLoopStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Fin de un turno autopilot: limpiar el flag autopilot por loop (el próximo turno del usuario
		// no debe gatearse). Después correr la safety net (cubre dynamic + fixed + caps).
		for (const loop of activeLoops.values()) {
			loop.autopilot = false;
			if (loop.status !== "running") continue;

			// Gate de caps antes de cualquier rearmado: si un deadline/budget ya está agotado,
			// detener limpiamente en vez de programar otra iteración.
			const cap = capExceeded(ctx, loop);
			if (cap) {
				stopForCap(pi, ctx, loop, cap);
				continue;
			}

			if (loop.rearmedThisTurn) continue;
			if (loop.timer) continue;

			if (loop.mode === "fixed") {
				// Modo fixed: rearmar por el período propio (timestamp absoluto, sin solapamiento).
				rearmFixed(pi, ctx, loop);
			} else {
				// Modo dynamic: el modelo no llamó a loop_schedule este turno → rearmado defensivo.
				scheduleWake(pi, ctx, loop, SAFETY_NET_DELAY_SECONDS, "auto: el turno cerró sin loop_schedule");
			}
		}
		// El turno autopilot terminó: liberar el gate in-flight y entregar el SIGUIENTE wake
		// encolado (si hay) — acá es donde los loops que perdieron la carrera por este turno reciben el suyo.
		autopilotTurnInFlight = false;
		drainWakeQueue(pi, ctx);
		// Barrido anti-zombie oportunista en cada frontera de turno (barato; el timer periódico
		// cubre huecos idle). Force-stoppea cualquier loop pasado su deadline duro de respaldo.
		watchdogSweep(pi, ctx);
	});
}
