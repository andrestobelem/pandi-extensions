import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_DELAY_SECONDS, MIN_DELAY_SECONDS, SAFETY_NET_DELAY_SECONDS } from "./constants.js";
import { destructiveReason } from "./gate.js";
import { formatLoopInterval } from "./interval.js";
import { stopLoop } from "./lifecycle.js";
import { hasRunningAutopilotLoop, scheduleWake } from "./scheduler.js";
import type { ActiveLoop } from "./state.js";
import { toolError, toolResult } from "./tool-results.js";

/** Gatea solo acciones destructivas durante turnos autopilot; turnos humanos no se tocan. */
export async function handleToolCall(
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

function runningLoops(activeLoops: Map<string, ActiveLoop>): ActiveLoop[] {
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

export interface LoopArgumentCompletion {
	value: string;
	label: string;
	description: string;
}

export const STATIC_LOOP_ARGUMENT_COMPLETIONS: LoopArgumentCompletion[] = [
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

export function registerLoopTools(pi: ExtensionAPI, activeLoops: Map<string, ActiveLoop>): void {
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
			const running = runningLoops(activeLoops);
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
			const running = runningLoops(activeLoops);
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
}
