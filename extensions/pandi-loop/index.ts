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

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { capExceeded } from "./caps.js";
import { parseLoopCommandIntent } from "./command-intent.js";
import {
	GC_MAX_AGE_MS,
	LOOP_STATE_TYPE,
	MAX_DELAY_SECONDS,
	MIN_DELAY_SECONDS,
	SAFETY_NET_DELAY_SECONDS,
	STATE_FILE,
	WATCHDOG_HARD_DEADLINE_MS,
} from "./constants.js";
import { destructiveReason } from "./gate.js";
import { formatLoopInterval } from "./interval.js";
import { configureLifecycle, pauseLoop, resumeLoop, startAutonomousLoop, startLoop, stopLoop } from "./lifecycle.js";
import { resolveLoop } from "./loop-resolve.js";
import { notify } from "./notify.js";
import {
	currentOwnerSessionId,
	discoverSidecarLoopIds,
	loopStateRoot,
	newerState,
	persist,
	readSidecar,
} from "./persistence.js";
import { makeLoopIterationPrompt } from "./prompt.js";
import {
	clearAutopilotInFlight,
	clearLoopTimer,
	clearWakeQueue,
	configureScheduler,
	drainWakeQueue,
	fireWake,
	hasRunningAutopilotLoop,
	rearmFixed,
	scheduleWake,
	stopByWatchdog,
	stopForCap,
} from "./scheduler.js";
import { collectLatestByKey } from "./session-state.js";
import {
	type ActiveLoop,
	fromSnapshot,
	type LoopState,
	type LoopStatus,
	shouldRehydrateLoopForSession,
} from "./state.js";
import { clearLoopStatus, formatStatus, refreshLoopStatus, setLoopStatus } from "./status.js";
import { toolError, toolResult } from "./tool-results.js";

// Fuente de verdad de los loops vivos en este proceso.
const activeLoops = new Map<string, ActiveLoop>();

// ---------------------------------------------------------------------------
// Rehidratación (session_start)
// ---------------------------------------------------------------------------

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
			const retired = fromSnapshot(state, "stopped");
			activeLoops.set(retired.loopId, retired);
			stopLoop(pi, ctx, retired.loopId, "loop autónomo retirado: el proyecto ya no es de confianza", "stopped");
			continue;
		}

		const recoverPaused = state.status === "paused";
		const loop = fromSnapshot(state, recoverPaused ? "paused" : "running");
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
	refreshLoopStatus(ctx, activeLoops.values());
	// Barrido final: no rearmar loops que ya son zombies tras el downtime.
	watchdogSweep(pi, ctx);
}

// ---------------------------------------------------------------------------
// GC de sidecars terminales
// ---------------------------------------------------------------------------

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
		stopByWatchdog(pi, ctx, loop);
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

/** Gatea solo acciones destructivas durante turnos autopilot; turnos humanos no se tocan. */
async function handleToolCall(
	ctx: ExtensionContext,
	event: ToolCallEvent,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	if (!hasRunningAutopilotLoop()) return undefined;
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
	configureLifecycle({
		getActiveLoops: () => activeLoops,
	});
	configureScheduler({
		getLoop: (loopId) => activeLoops.get(loopId),
		loops: () => activeLoops.values(),
		persist,
		setLoopStatus,
		stopLoop,
		notify,
		makeLoopIterationPrompt,
	});

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
		clearWakeQueue();
		clearAutopilotInFlight();
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
		clearAutopilotInFlight();
		drainWakeQueue(pi, ctx);
		// Barrido anti-zombie oportunista en cada frontera de turno (barato; el timer periódico
		// cubre huecos idle). Force-stoppea cualquier loop pasado su deadline duro de respaldo.
		watchdogSweep(pi, ctx);
	});
}
