/**
 * Modelo de estado de `pandi-loop`.
 *
 * Este módulo separa la forma durable del loop (lo que se persiste/re-hidrata) de
 * los campos runtime-only del engine (timer, AbortController, flags de wake). No conoce
 * ExtensionContext, filesystem ni la registración de comandos/tools.
 */

export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_MAX_WALL_CLOCK_MS = 6 * 60 * 60 * 1000; // Deadline absoluto por default de 6h.
export const DEFAULT_CONTEXT_PERCENT_CAP = 90; // Detiene si getContextUsage().percent supera esto.

// Trata un tope persistido como válido solo si es un número finito > 0; si no, usa el
// valor por default. Defiende rehydrate de un sidecar corrupto/manipulado donde `0`/NaN/undefined
// pasarían por `??` (que solo reemplaza null/undefined) y desactivarían un tope en silencio
// (maxWallClockMs<=0 anula el deadline; maxIterations ausente hace que `iter >= undefined`
// sea siempre false y anule el gate de iteraciones). Los call sites ajustan por tope:
// Math.trunc para el conteo entero y clamp Math.min(.,100) para el tope porcentual.
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
	/**
	 * Modo autónomo (P2): true si este loop no tiene tarea de usuario convencional; el
	 * texto reinyectado es una sentinela generada por la extensión (un objetivo recurrente).
	 * El start requiere trust + confirm explícito. Persistido para sobrevivir reloads.
	 */
	autonomous?: boolean;
	/** Postura Ultracode: apoya el trabajo en dynamic workflows (solo inyección de prompt). */
	ultracode?: boolean;
	/** Timestamp ISO de la última escritura; resuelve conflictos JSONL-vs-sidecar. */
	updatedAt: string;
}

export interface ActiveLoop extends LoopState {
	timer: ReturnType<typeof setTimeout> | null;
	controller: AbortController;
	/** Verdadero cuando un wake fue (re)armado en el turno actual; se resetea en cada fire. */
	rearmedThisTurn: boolean;
	/** Verdadero mientras el turno ACTUAL fue disparado por un wake (fireWake), no por el usuario. */
	autopilot: boolean;
	/**
	 * Transitorio: ms restantes del timer dynamic al pausar, para que resume rearme
	 * con el remanente. null = "fire immediately" (estaba en límite de iteración). No persistido.
	 */
	pausedRemainingMs?: number | null;
	/**
	 * Transitorio (fixed mode): timestamp absoluto para el que se programó la iteración
	 * en vuelo. El próximo rearmado es fixedAnchor + period, así la cadencia no deriva
	 * aunque una iteración tarde. No persistido.
	 */
	fixedAnchor?: number;
}

export interface CreateActiveLoopInput {
	loopId: string;
	task: string;
	intervalMs?: number;
	now: number;
	autonomous?: boolean;
	ultracode?: boolean;
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
		updatedAt: loop.updatedAt,
	};
}
