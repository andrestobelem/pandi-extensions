/**
 * Transiciones de ciclo de vida para `/loop`.
 *
 * `index.ts` conserva el Map vivo como fuente de verdad y lo inyecta acá para
 * evitar que este módulo posea estado de proceso o forme un ciclo con scheduler.
 */

import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseLoopStartArgs } from "./command-intent.js";
import { MAX_CONCURRENT_LOOPS, SAFETY_NET_DELAY_SECONDS } from "./constants.js";
import { formatLoopInterval } from "./interval.js";
import { notify } from "./notify.js";
import { currentOwnerSessionId, persist } from "./persistence.js";
import { canLoopInMode, clearLoopTimer, dropQueuedWakes, fireWake, rearmFixed, scheduleWake } from "./scheduler.js";
import { type ActiveLoop, createActiveLoop } from "./state.js";
import { refreshLoopStatus } from "./status.js";

export type LifecycleDeps = {
	getActiveLoops: () => Map<string, ActiveLoop>;
};

let lifecycleDeps: LifecycleDeps;

/** Registra el estado vivo que permanece bajo propiedad de index.ts. */
export function configureLifecycle(deps: LifecycleDeps): void {
	lifecycleDeps = deps;
}

export function refuseIfCannotLoopInMode(ctx: ExtensionContext, commandName: "/loop" | "/loop auto"): boolean {
	if (canLoopInMode(ctx)) return false;
	notify(ctx, `${commandName} requiere una sesión TUI o RPC (este modo no admite /loop).`, "error");
	return true;
}

export function refuseIfLoopLimitReached(ctx: ExtensionContext): boolean {
	const activeLoops = lifecycleDeps.getActiveLoops();
	if (activeLoops.size < MAX_CONCURRENT_LOOPS) return false;
	notify(
		ctx,
		`Demasiados loops activos (${activeLoops.size}/${MAX_CONCURRENT_LOOPS}). Detené uno con /loop stop antes de iniciar otro.`,
		"error",
	);
	return true;
}

export function formatFixedModeLabel(loop: ActiveLoop): string {
	if (loop.mode !== "fixed") return "";
	return ` (cada ${formatLoopInterval(loop.intervalMs)})`;
}

export function activateLoop(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	lifecycleDeps.getActiveLoops().set(loop.loopId, loop);
	persist(pi, ctx, loop);
	// El primer tick pasa por fireWake para compartir límites, persistencia y FIFO.
	fireWake(pi, ctx, loop);
}

export interface StartLoopDraft {
	task: string;
	intervalMs?: number;
	ultracode: boolean;
	autonomous?: boolean;
}

export function createStartedLoop(ctx: ExtensionContext, draft: StartLoopDraft): ActiveLoop {
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

export function notifyLoopStarted(
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

export function startLoop(pi: ExtensionAPI, ctx: ExtensionContext, task: string): ActiveLoop | undefined {
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
export async function startAutonomousLoop(
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

export function stopLoop(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	loopId: string,
	reason: string,
	finalStatus: "stopped" | "done" | "failed" = "stopped",
): boolean {
	const activeLoops = lifecycleDeps.getActiveLoops();
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
	refreshLoopStatus(ctx, activeLoops.values());
	return true;
}

/** Pausa sin reinyectar; guarda el remanente para poder reanudar la cadencia dynamic. */
export function pauseLoop(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): boolean {
	if (loop.status !== "running") return false;
	clearLoopTimer(loop);
	// Offset relativo para que resume restaure la espera que quedaba en este proceso.
	loop.pausedRemainingMs = loop.nextFireAt === null ? null : Math.max(0, loop.nextFireAt - Date.now());
	loop.status = "paused";
	loop.autopilot = false;
	// Paused no debe reinyectar desde la cola.
	dropQueuedWakes(loop.loopId);
	persist(pi, ctx, loop);
	refreshLoopStatus(ctx, lifecycleDeps.getActiveLoops().values());
	return true;
}

/** Reanuda y rearma: fixed usa su período; dynamic recupera el remanente disponible. */
export function resumeLoop(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): boolean {
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
