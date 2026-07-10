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

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { capExceeded } from "./caps.js";
import { handleLoopCommand } from "./command-handler.js";
import { MAX_DELAY_SECONDS, MIN_DELAY_SECONDS, SAFETY_NET_DELAY_SECONDS } from "./constants.js";
import { destructiveReason } from "./gate.js";
import { formatLoopInterval } from "./interval.js";
import { configureLifecycle, stopLoop } from "./lifecycle.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { makeLoopIterationPrompt } from "./prompt.js";
import {
	clearAutopilotInFlight,
	clearLoopTimer,
	clearWakeQueue,
	configureScheduler,
	drainWakeQueue,
	hasRunningAutopilotLoop,
	rearmFixed,
	scheduleWake,
	stopForCap,
} from "./scheduler.js";
import { configureRecovery, gcOldTerminalLoops, rehydrate, watchdogSweep } from "./session-recovery.js";
import type { ActiveLoop } from "./state.js";
import { clearLoopStatus, setLoopStatus } from "./status.js";
import { toolError, toolResult } from "./tool-results.js";

// Fuente de verdad de los loops vivos en este proceso.
const activeLoops = new Map<string, ActiveLoop>();

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
	configureRecovery({
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
		handler: async (args, ctx) => await handleLoopCommand(pi, args, ctx, activeLoops),
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
