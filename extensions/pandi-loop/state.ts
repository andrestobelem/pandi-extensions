/**
 * Modelo de estado de `pandi-loop`: separa snapshots durables de campos runtime-only
 * como timers, AbortController y flags de wake.
 */

export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_MAX_WALL_CLOCK_MS = 6 * 60 * 60 * 1000; // Deadline default de 6h.
export const DEFAULT_CONTEXT_PERCENT_CAP = 90; // Detiene al superar este % de contexto.

// Sanitiza caps persistidos: 0/NaN/undefined podrían desactivar deadlines o iteraciones
// si pasaran por `??`. Los call sites luego ajustan entero/porcentaje según el cap.
export const positiveOr = (value: unknown, dflt: number): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : dflt;

export type LoopMode = "dynamic" | "fixed";
export type LoopStatus = "running" | "paused" | "stopped" | "done" | "failed" | "stale";

export interface LoopState {
	loopId: string;
	task: string;
	mode: LoopMode;
	/** Período de fixed-mode en ms (0/undefined para dynamic). La extensión lo posee. */
	intervalMs?: number;
	iteration: number;
	maxIterations: number;
	/** Deadline absoluto de wall-clock (epoch ms): detener cuando Date.now() lo supere. */
	maxWallClockMs: number;
	/** Tope porcentual best-effort de uso de contexto (detener si getContextUsage().percent lo supera). */
	contextPercentCap: number;
	startedAt: number;
	nextFireAt: number | null;
	lastReason?: string;
	status: LoopStatus;
	/** Objetivo recurrente sin turno humano; requiere trust + confirm al crearse. */
	autonomous?: boolean;
	/** Postura Ultracode: apoya el trabajo en dynamic workflows (solo inyección de prompt). */
	ultracode?: boolean;
	/** Id de la sesión/ventana que posee este loop. Evita que otras ventanas del mismo repo adopten el sidecar. */
	ownerSessionId?: string;
	/** Timestamp ISO de la última escritura; resuelve conflictos JSONL-vs-sidecar. */
	updatedAt: string;
}

export interface ActiveLoop extends LoopState {
	timer: ReturnType<typeof setTimeout> | null;
	controller: AbortController;
	/** Verdadero cuando un wake fue (re)armado en el turno actual; se resetea en cada fire. */
	rearmedThisTurn: boolean;
	/** Verdadero mientras el turno en vuelo fue disparado por un wake, no por el usuario. */
	autopilot: boolean;
	/** Remanente del timer dynamic al pausar; null = disparar al reanudar. No persistido. */
	pausedRemainingMs?: number | null;
	/** Target absoluto del tick fixed en vuelo; evita deriva al rearmar. No persistido. */
	fixedAnchor?: number;
}

export interface CreateActiveLoopInput {
	loopId: string;
	task: string;
	intervalMs?: number;
	now: number;
	autonomous?: boolean;
	ultracode?: boolean;
	ownerSessionId?: string;
}

export function createActiveLoop(input: CreateActiveLoopInput): ActiveLoop {
	return {
		loopId: input.loopId,
		task: input.task,
		mode: input.intervalMs ? "fixed" : "dynamic",
		intervalMs: input.intervalMs,
		iteration: 0,
		maxIterations: DEFAULT_MAX_ITERATIONS,
		maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
		contextPercentCap: DEFAULT_CONTEXT_PERCENT_CAP,
		startedAt: input.now,
		nextFireAt: null,
		lastReason: undefined,
		status: "running",
		autonomous: input.autonomous,
		ultracode: input.ultracode,
		ownerSessionId: input.ownerSessionId,
		updatedAt: new Date(input.now).toISOString(),
		timer: null,
		controller: new AbortController(),
		rearmedThisTurn: false,
		autopilot: false,
	};
}

export function snapshot(loop: ActiveLoop): LoopState {
	return {
		loopId: loop.loopId,
		task: loop.task,
		mode: loop.mode,
		intervalMs: loop.intervalMs,
		iteration: loop.iteration,
		maxIterations: loop.maxIterations,
		maxWallClockMs: loop.maxWallClockMs,
		contextPercentCap: loop.contextPercentCap,
		startedAt: loop.startedAt,
		nextFireAt: loop.nextFireAt,
		lastReason: loop.lastReason,
		status: loop.status,
		autonomous: loop.autonomous,
		ultracode: loop.ultracode,
		ownerSessionId: loop.ownerSessionId,
		updatedAt: loop.updatedAt,
	};
}

/**
 * Decide si un snapshot durable pertenece a la sesión actual.
 *
 * Los sidecars viven bajo el cwd del proyecto, compartido por todas las ventanas. Por eso
 * los snapshots nuevos llevan ownerSessionId y solo los revive su dueña. Los snapshots
 * legacy sin owner se aceptan únicamente si también aparecen en el JSONL de ESTA sesión;
 * así no perdemos reloads locales viejos, pero otra ventana no adopta un sidecar legacy.
 */
export function shouldRehydrateLoopForSession(
	state: LoopState,
	currentOwnerSessionId: string | undefined,
	hasSessionEntry: boolean,
): boolean {
	return state.ownerSessionId ? state.ownerSessionId === currentOwnerSessionId : hasSessionEntry;
}
