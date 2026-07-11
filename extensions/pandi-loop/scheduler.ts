/**
 * Scheduler de `pandi-loop`: serializa wakes FIFO y posee los timers runtime.
 * `index.ts` conserva `activeLoops` como fuente de verdad del ciclo de vida.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { preWakeLimit, watchdogHardDeadlineReason } from "./caps.js";
import { formatLoopInterval } from "./interval.js";
import type { NotifyType } from "./notify.js";
import type { persist } from "./persistence.js";
import type { makeLoopIterationPrompt } from "./prompt.js";
import type { ActiveLoop, FixedActiveLoop } from "./state.js";
import type { setLoopStatus } from "./status.js";

export type SchedulerDeps = {
	getLoop: (loopId: string) => ActiveLoop | undefined;
	loops: () => IterableIterator<ActiveLoop>;
	persist: typeof persist;
	setLoopStatus: typeof setLoopStatus;
	stopLoop: (
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		loopId: string,
		reason: string,
		finalStatus?: "stopped" | "done" | "failed",
	) => boolean;
	notify: (ctx: ExtensionContext, message: string, type?: NotifyType) => void;
	makeLoopIterationPrompt: typeof makeLoopIterationPrompt;
};

let schedulerDeps: SchedulerDeps;

/** Registra los límites del ciclo de vida que el scheduler necesita consultar. */
export function configureScheduler(deps: SchedulerDeps): void {
	schedulerDeps = deps;
}

/** Wake pendiente de entrega; el estado mutable vive en `activeLoops`. */
interface PendingWake {
	loopId: string;
}

const wakeQueue: PendingWake[] = [];
// Mientras haya un turno autopilot en vuelo, ningún otro wake puede abrir turno.
let autopilotTurnInFlight = false;

/** ¿Hay un loop running cuyo turno actual lo disparó un wake (no el usuario)? */
export function hasRunningAutopilotLoop(): boolean {
	for (const loop of schedulerDeps.loops()) {
		if (loop.autopilot && loop.status === "running") return true;
	}
	return false;
}

/** Solo TUI/RPC sostienen una sesión viva donde un wake puede reinyectar prompts. */
export function canLoopInMode(ctx: ExtensionContext): boolean {
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
export function drainWakeQueue(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!canLoopInMode(ctx)) return;
	// Nunca abrir un autopilot durante el turno humano: el gate de herramientas
	// destructivas debe aplicar solo a turnos disparados por el loop.
	if (!ctx.isIdle()) return;
	// Serializar loops: un segundo wake espera hasta que termine el turno en vuelo.
	if (autopilotTurnInFlight && hasRunningAutopilotLoop()) return;

	while (wakeQueue.length > 0) {
		const next = wakeQueue.shift()!;
		const loop = schedulerDeps.getLoop(next.loopId);
		// Descartar entradas stale: el loop fue stopped/paused/removido antes de su turno.
		if (loop?.status !== "running") continue;
		// Guards rechequeados al entregar (el estado puede haber cambiado en cola).
		const limit = preWakeLimit(ctx, loop);
		if (limit?.kind === "maxIterations") {
			stopForMaxIterations(pi, ctx, loop);
			continue;
		}
		if (limit?.kind === "cap") {
			stopForCap(pi, ctx, loop, limit.reason);
			continue;
		}
		deliverWake(pi, ctx, loop);
		return; // exactamente un turno autopilot a la vez.
	}
}

/** Entrega una iteración: avanza contador, arma autopilot, persiste y reinyecta. */
export function deliverWake(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	loop.iteration += 1;
	// Fixed mode rearma desde el target previo para evitar deriva; dynamic no usa anchor.
	loop.fixedAnchor = loop.mode === "fixed" ? (loop.nextFireAt ?? Date.now()) : undefined;
	loop.nextFireAt = null;
	loop.rearmedThisTurn = false;
	// Este turno lo disparó un wake, así que activa el gate autopilot hasta agent_end.
	loop.autopilot = true;
	autopilotTurnInFlight = true;
	schedulerDeps.persist(pi, ctx, loop);
	schedulerDeps.setLoopStatus(ctx, loop);
	try {
		wake(pi, ctx, schedulerDeps.makeLoopIterationPrompt(loop));
	} catch (err) {
		loop.autopilot = false;
		autopilotTurnInFlight = false;
		schedulerDeps.stopLoop(pi, ctx, loop.loopId, `falló la entrega del wake: ${(err as Error).message}`, "failed");
		schedulerDeps.notify(ctx, `Loop ${loop.loopId} detenido: falló la entrega del wake.`, "error");
	}
}

/** Detiene un loop porque se tocó un tope. Status "done" (fin limpio y esperado). */
export function stopForCap(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop, reason: string): void {
	schedulerDeps.stopLoop(pi, ctx, loop.loopId, reason, "done");
	schedulerDeps.notify(ctx, `Loop ${loop.loopId} detenido: ${reason}.`, "warning");
}

/** Caso particular de stopForCap: se alcanzó maxIterations (mismo motivo en stopLoop y notify). */
export function stopForMaxIterations(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	stopForCap(pi, ctx, loop, `alcanzó el límite de maxIterations (${loop.maxIterations})`);
}

/** Force-stop por watchdog: mismo mensaje y status en fireWake y watchdogSweep. */
export function stopByWatchdog(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	schedulerDeps.stopLoop(pi, ctx, loop.loopId, watchdogHardDeadlineReason(), "done");
	schedulerDeps.notify(
		ctx,
		`Loop ${loop.loopId} forzado a detenerse por el watchdog (respaldo anti-zombie).`,
		"warning",
	);
}

/** Valida límites y encola una iteración; la FIFO decide cuándo entregarla. */
export function fireWake(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
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
	// maxWallClockMs quedó absurdamente alto.) Orden: watchdog → maxIterations → caps.
	const limit = preWakeLimit(ctx, loop, { includeWatchdog: true });
	if (limit?.kind === "watchdog") {
		stopByWatchdog(pi, ctx, loop);
		return;
	}
	if (limit?.kind === "maxIterations") {
		stopForMaxIterations(pi, ctx, loop);
		return;
	}
	if (limit?.kind === "cap") {
		stopForCap(pi, ctx, loop, limit.reason);
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

export function clearLoopTimer(loop: ActiveLoop): void {
	if (!loop.timer) return;
	clearTimeout(loop.timer);
	loop.timer = null;
}

/** Arma el próximo wake después de delaySec. El caller es responsable de clampear. */
export function scheduleWake(
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
	schedulerDeps.persist(pi, ctx, loop);
	schedulerDeps.setLoopStatus(ctx, loop);
	loop.timer = setTimeout(() => fireWake(pi, ctx, loop), delaySec * 1000);
}

/**
 * Rearma fixed mode desde un target absoluto: evita deriva y evita solapar
 * iteraciones lentas. Si el target quedó atrás, entrega un único catch-up inmediato.
 */
export function rearmFixed(pi: ExtensionAPI, ctx: ExtensionContext, loop: FixedActiveLoop): void {
	clearLoopTimer(loop);
	const period = loop.intervalMs;
	// El target anterior evita deriva; resume/primer armado caen a nextFireAt o now.
	const base = loop.fixedAnchor ?? loop.nextFireAt ?? Date.now();
	loop.fixedAnchor = undefined;
	const target = base + period;
	const delay = Math.max(0, target - Date.now());
	loop.nextFireAt = target;
	loop.lastReason = `auto: intervalo fijo ${formatLoopInterval(period)}`;
	loop.rearmedThisTurn = true;
	schedulerDeps.persist(pi, ctx, loop);
	schedulerDeps.setLoopStatus(ctx, loop);
	loop.timer = setTimeout(() => fireWake(pi, ctx, loop), delay);
}

/** Quita wakes encolados de un loop para que nunca se entreguen tras stop/pause. */
export function dropQueuedWakes(loopId: string): void {
	for (let i = wakeQueue.length - 1; i >= 0; i--) {
		if (wakeQueue[i].loopId === loopId) wakeQueue.splice(i, 1);
	}
}

/** Limpia todos los wakes durante un cierre de sesión. */
export function clearWakeQueue(): void {
	wakeQueue.length = 0;
}

/** Libera el gate al cerrar el turno autopilot. */
export function clearAutopilotInFlight(): void {
	autopilotTurnInFlight = false;
}
