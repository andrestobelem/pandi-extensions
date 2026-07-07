/**
 * `/loop` para Pi: ejecuta un objetivo por iteraciones programadas por el modelo
 * (`loop_schedule`) o por una cadencia fija (`/loop <task> <interval>`).
 *
 * Arquitectura:
 * - los wakes viven en memoria (`activeLoops` + `setTimeout`) y se materializan
 *   reinyectando un prompt con `pi.sendUserMessage`;
 * - cada transición se persiste en JSONL y en un sidecar atómico con `updatedAt`;
 * - al recargar, `session_start` rehidrata el estado más nuevo y entrega como máximo
 *   un catch-up tick;
 * - una FIFO a nivel módulo serializa wakes de múltiples loops para mantener un solo
 *   turno autopilot activo;
 * - `agent_end` es la red de seguridad: limpia flags, aplica caps y rearma fixed mode.
 *
 * Invariantes de seguridad:
 * - no correr en `print` ni reinyectar fuera de `tui`/`rpc`;
 * - clampear `delaySeconds` dinámicos a [60, 3600] dentro del tool;
 * - confirmar o bloquear tools destructivas cuando el turno es autopilot;
 * - exigir trust + confirmación explícita para `/loop auto`, y revalidar trust al
 *   rehidratar;
 * - no migrar loops al hacer fork de sesión;
 * - limitar loops activos, iteraciones, wall-clock, contexto y zombies por watchdog.
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
// Límite de runtime: cada loop activo posee timer, estado mutable y posible sidecar.
// La rehidratación queda exenta para no perder loops ya creados.
const MAX_CONCURRENT_LOOPS = 20;
const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;
// Fallback cuando el modelo cierra un turno dinámico sin llamar loop_schedule.
const SAFETY_NET_DELAY_SECONDS = 1500;
// GC solo para sidecars terminales; estados vivos nunca se barren por edad.
const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días.
// Deadline de respaldo, deliberadamente mayor al wall-clock default, para capturar zombies.
const WATCHDOG_HARD_DEADLINE_MS = 25 * 60 * 60 * 1000; // 25h.

// Fuente de verdad de los loops vivos en este proceso.
const activeLoops = new Map<string, ActiveLoop>();

// ---------------------------------------------------------------------------
// Cola FIFO de wakes
// ---------------------------------------------------------------------------

/** Wake pendiente de entrega; el estado mutable vive en `activeLoops`. */
interface PendingWake {
	loopId: string;
}

const wakeQueue: PendingWake[] = [];
// Mientras haya un turno autopilot en vuelo, ningún otro wake puede abrir turno.
let autopilotTurnInFlight = false;

function hasRunningAutopilotLoop(): boolean {
	for (const loop of activeLoops.values()) {
		if (loop.autopilot && loop.status === "running") return true;
	}
	return false;
}

/** ¿El loop dueño del turno autopilot en vuelo sigue presente y running? */
function inFlightOwnerAlive(): boolean {
	return hasRunningAutopilotLoop();
}

// ---------------------------------------------------------------------------
// Línea de estado
// ---------------------------------------------------------------------------

function formatLoopInterval(intervalMs: number | undefined): string {
	return formatInterval(Math.round((intervalMs ?? 0) / 1000));
}

function setLoopStatus(ctx: ExtensionContext, loop: LoopState): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const paused = loop.status === "paused" ? " paused" : "";
	const fixed = loop.mode === "fixed" && loop.intervalMs ? ` @${formatLoopInterval(loop.intervalMs)}` : "";
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

/** Muestra un loop activo en la barra; running tiene prioridad sobre paused. */
function refreshLoopStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
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

// --- Sidecar atómico ------------------------------------------------------------

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

/** Solo TUI/RPC sostienen una sesión viva donde un wake puede reinyectar prompts. */
function canLoopInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

/**
 * Entrega de bajo nivel. La FIFO es el único caller normal: saltarla rompería la
 * garantía de un solo turno autopilot en vuelo.
 */
function wake(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	// Gate por modo: nunca reinyectar fuera de tui/rpc (también defiende rutas de rehydrate).
	if (!canLoopInMode(ctx)) return;
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

/**
 * Entrega como máximo un wake, solo cuando el agente está idle y no hay otro autopilot
 * en vuelo. Las entradas stale se descartan; la iteración avanza recién al entregar.
 */
function drainWakeQueue(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!canLoopInMode(ctx)) return;
	// Nunca abrir un autopilot durante el turno humano: el gate de herramientas
	// destructivas debe aplicar solo a turnos disparados por el loop.
	if (!ctx.isIdle()) return;
	// Serializar loops: un segundo wake espera hasta que termine el turno en vuelo.
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

/** Entrega una iteración: avanza contador, arma autopilot, persiste y reinyecta. */
function deliverWake(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	loop.iteration += 1;
	// Fixed mode rearma desde el target previo para evitar deriva; dynamic no usa anchor.
	loop.fixedAnchor = loop.mode === "fixed" ? (loop.nextFireAt ?? Date.now()) : undefined;
	loop.nextFireAt = null;
	loop.rearmedThisTurn = false;
	// Este turno lo disparó un wake, así que activa el gate autopilot hasta agent_end.
	loop.autopilot = true;
	autopilotTurnInFlight = true;
	persist(pi, ctx, loop);
	setLoopStatus(ctx, loop);
	try {
		wake(pi, ctx, makeLoopIterationPrompt(loop));
	} catch (err) {
		loop.autopilot = false;
		autopilotTurnInFlight = false;
		stopLoop(pi, ctx, loop.loopId, `falló la entrega del wake: ${(err as Error).message}`, "failed");
		notify(ctx, `Loop ${loop.loopId} detenido: falló la entrega del wake.`, "error");
	}
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

/** Valida límites y encola una iteración; la FIFO decide cuándo entregarla. */
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

function clearLoopTimer(loop: ActiveLoop): void {
	if (!loop.timer) return;
	clearTimeout(loop.timer);
	loop.timer = null;
}

/** Arma el próximo wake después de delaySec. El caller es responsable de clampear. */
function scheduleWake(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	loop: ActiveLoop,
	delaySec: number,
	reason: string,
): void {
	clearLoopTimer(loop);
	loop.nextFireAt = Date.now() + delaySec * 1000;
	loop.lastReason = reason;
	loop.rearmedThisTurn = true;
	persist(pi, ctx, loop);
	setLoopStatus(ctx, loop);
	loop.timer = setTimeout(() => fireWake(pi, ctx, loop), delaySec * 1000);
}

/**
 * Rearma fixed mode desde un target absoluto: evita deriva y evita solapar
 * iteraciones lentas. Si el target quedó atrás, entrega un único catch-up inmediato.
 */
function rearmFixed(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	clearLoopTimer(loop);
	const period = loop.intervalMs ?? 0;
	// El target anterior evita deriva; resume/primer armado caen a nextFireAt o now.
	const base = loop.fixedAnchor ?? loop.nextFireAt ?? Date.now();
	loop.fixedAnchor = undefined;
	const target = base + period;
	const delay = Math.max(0, target - Date.now());
	loop.nextFireAt = target;
	loop.lastReason = `auto: intervalo fijo ${formatLoopInterval(period)}`;
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
	notify(ctx, `${commandName} requiere una sesión TUI o RPC (este modo no admite /loop).`, "error");
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
	return ` (cada ${formatLoopInterval(loop.intervalMs)})`;
}

function activateLoop(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	activeLoops.set(loop.loopId, loop);
	persist(pi, ctx, loop);
	// El primer tick pasa por fireWake para compartir límites, persistencia y FIFO.
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
 * Inicia un objetivo autónomo. Como actuará sin un mensaje humano por turno,
 * exige proyecto trusted y confirmación interactiva explícita.
 */
async function startAutonomousLoop(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	rawArgs: string,
): Promise<ActiveLoop | undefined> {
	if (refuseIfCannotLoopInMode(ctx, "/loop auto")) return undefined;
	// Un objetivo autónomo no debe correr en un proyecto sin trust.
	if (!ctx.isProjectTrusted()) {
		notify(ctx, "/loop auto requiere un proyecto de confianza. Corré /trust primero, y reintentá.", "error");
		return undefined;
	}
	const { text: objective, intervalMs, ultracode } = parseLoopStartArgs(rawArgs);
	if (!objective) {
		notify(ctx, "Uso: /loop auto [--ultracode] <objective> [interval]", "warning");
		return undefined;
	}
	// Sin UI no hay consentimiento explícito, así que no se crea el loop.
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
	clearLoopTimer(loop);
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

/** Pausa sin reinyectar; guarda el remanente para poder reanudar la cadencia dynamic. */
function pauseLoop(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): boolean {
	if (loop.status !== "running") return false;
	clearLoopTimer(loop);
	// Offset relativo para que resume restaure la espera que quedaba en este proceso.
	loop.pausedRemainingMs = loop.nextFireAt === null ? null : Math.max(0, loop.nextFireAt - Date.now());
	loop.status = "paused";
	loop.autopilot = false;
	// Paused no debe reinyectar desde la cola.
	dropQueuedWakes(loop.loopId);
	persist(pi, ctx, loop);
	refreshLoopStatus(ctx);
	return true;
}

/** Reanuda y rearma: fixed usa su período; dynamic recupera el remanente disponible. */
function resumeLoop(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): boolean {
	if (loop.status !== "paused") return false;
	loop.status = "running";
	if (loop.mode === "fixed") {
		// Desde resume, fixed arranca una nueva serie anclada en now.
		loop.nextFireAt = Date.now();
		rearmFixed(pi, ctx, loop);
		return true;
	}
	// pausedRemainingMs es transitorio; tras reload, usar nextFireAt persistido. Si tampoco
	// existe, caer a la cadencia de seguridad.
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
		// Revalidar trust en cada re-entry: un objetivo autónomo no debe sobrevivir si el
		// proyecto perdió confianza desde la confirmación original.
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
			// Defaults para snapshots antiguos sin campos de modo/caps.
			mode: state.mode ?? "dynamic",
			maxIterations: positiveOr(Math.trunc(state.maxIterations), DEFAULT_MAX_ITERATIONS),
			maxWallClockMs: positiveOr(state.maxWallClockMs, DEFAULT_MAX_WALL_CLOCK_MS),
			contextPercentCap: Math.min(positiveOr(state.contextPercentCap, DEFAULT_CONTEXT_PERCENT_CAP), 100),
			updatedAt: state.updatedAt ?? new Date().toISOString(),
			// stale vuelve a running; paused conserva su estado idle.
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
	// Barrido final: no rearmar loops que ya son zombies tras el downtime.
	watchdogSweep(pi, ctx);
}

// ---------------------------------------------------------------------------
// GC de sidecars terminales
// ---------------------------------------------------------------------------

/** Root que guarda los sidecars del proyecto actual. */
function loopStateRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, LOOP_DIR);
	const projectHash = crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 12);
	return path.join(getAgentDir(), LOOP_DIR, projectHash);
}

const TERMINAL_STATUSES: ReadonlySet<LoopStatus> = new Set<LoopStatus>(["done", "stopped", "failed"]);

/**
 * Borra sidecars viejos solo si el snapshot es terminal y su `updatedAt` supera
 * GC_MAX_AGE_MS. Los loops vivos o presentes en memoria se preservan siempre.
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
		// Un loop vivo en este proceso puede tener timer armado.
		if (activeLoops.has(loopId)) continue;
		const dir = path.join(root, loopId);
		const file = path.join(dir, STATE_FILE);
		try {
			const body = await fs.readFile(file, "utf8");
			const state = JSON.parse(body) as LoopState;
			if (!state || typeof state.status !== "string") continue;
			// Los estados vivos se preservan indefinidamente.
			if (!TERMINAL_STATUSES.has(state.status)) continue;
			const updated = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
			// Sin fecha confiable no hay borrado.
			if (!Number.isFinite(updated) || now - updated < GC_MAX_AGE_MS) continue;
			await fs.rm(dir, { recursive: true, force: true });
			removed += 1;
		} catch {
			// GC es best-effort: estado corrupto o fallo de rm no debe romper la sesión.
		}
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Watchdog anti-zombie
// ---------------------------------------------------------------------------

/**
 * Último respaldo contra loops running colgados más allá del deadline duro. Paused no
 * es zombie: no tiene timer armado y espera una reanudación explícita del usuario.
 *
 * No hay timer dedicado; los pulsos naturales (session_start, agent_end, fireWake)
 * bastan, y un proceso muerto solo puede recuperarse en el siguiente session_start.
 */
function watchdogSweep(pi: ExtensionAPI, ctx: ExtensionContext, now: number = Date.now()): number {
	let killed = 0;
	for (const loop of [...activeLoops.values()]) {
		// Solo running puede ser zombie; paused está idle a propósito.
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
// Gate de acciones irreversibles
// ---------------------------------------------------------------------------

/** Verdadero si el turno actual fue disparado por un wake de loop. */
function anyAutopilotActive(): boolean {
	return hasRunningAutopilotLoop();
}

/** Gatea solo acciones destructivas durante turnos autopilot; turnos humanos no se tocan. */
async function handleToolCall(
	ctx: ExtensionContext,
	event: ToolCallEvent,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	if (!anyAutopilotActive()) return undefined;
	const reason = destructiveReason(ctx, event);
	if (!reason) return undefined;

	if (ctx.hasUI && typeof ctx.ui.confirm === "function") {
		const approved = await ctx.ui.confirm(
			"El piloto automático quiere ejecutar una acción destructiva",
			`${reason}\n\nEsta iteración del loop se disparó automáticamente (no vos). ¿La permitís?`,
		);
		if (approved) return undefined;
		return { block: true, reason };
	}
	// Sin UI para confirmar, bloquear por seguridad.
	return { block: true, reason };
}

function runningLoops(): ActiveLoop[] {
	return [...activeLoops.values()].filter((loop) => loop.status === "running");
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
		label: "Programar loop",
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
			const running = runningLoops();
			if (running.length === 0) {
				return toolError("No hay ningún loop activo para reprogramar. No hay nada que reprogramar.");
			}
			// Preferir el dueño autopilot; sin dueño explícito, mantener el fallback histórico a dynamic.
			const loop = selectToolOwnerLoop(running, { preferDynamicFallback: true });
			if (!loop) return toolError("No hay ningún loop activo para reprogramar. No hay nada que reprogramar.");
			// En fixed mode la extensión posee la cadencia; loop_schedule solo registra la razón.
			if (loop.mode === "fixed") {
				const periodSec = Math.round((loop.intervalMs ?? 0) / 1000);
				return toolResult(
					`El loop ${loop.loopId} corre en un intervalo fijo (cada ${formatLoopInterval(loop.intervalMs)}); la cadencia es fija y loop_schedule es un no-op. Razón registrada: ${params.reason}.`,
					{ loopId: loop.loopId, mode: "fixed", noop: true, intervalSeconds: periodSec },
				);
			}
			// El schema no clampa; hacerlo acá evita setTimeout(NaN) o delays fuera de rango.
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
		label: "Detener loop",
		description: "Terminá el /loop activo. Llamalo cuando la tarea esté completa o más iteraciones no ayuden.",
		promptSnippet: "Terminá el /loop activo con una razón.",
		parameters: Type.Object({
			reason: Type.String(),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const running = runningLoops();
			if (running.length === 0) {
				return toolError("No hay ningún loop activo para detener.");
			}
			// Preferir el dueño autopilot; sin dueño explícito, usar el fallback histórico.
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

	// Bloquear/confirmar tools destructivas solo en turnos autopilot.
	pi.on("tool_call", async (event, ctx) => await handleToolCall(ctx, event));

	pi.on("session_start", async (event, ctx) => {
		// NO migrar un loop a una sesión forked: un fork hereda las entradas "loop-state"
		// del padre, pero el loop debe seguir corriendo solo en el padre.
		// startup / reload / resume SÍ rehidratan; "new" no trae entradas del padre.
		if (event.reason === "fork") return;
		await rehydrate(pi, ctx);
		// GC después de rehydrate: los loops vivos ya están en activeLoops y no se recolectan.
		await gcOldTerminalLoops(ctx).catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const loop of activeLoops.values()) {
			clearLoopTimer(loop);
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
