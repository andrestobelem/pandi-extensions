/**
 * Modelo de estado de `pandi-loop`: separa snapshots durables de campos runtime-only
 * como timers, AbortController y flags de wake.
 */
import { MAX_FIXED_INTERVAL_SECONDS, MIN_FIXED_INTERVAL_SECONDS } from "./interval.js";

export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_MAX_WALL_CLOCK_MS = 6 * 60 * 60 * 1000; // Deadline default de 6h.
export const DEFAULT_CONTEXT_PERCENT_CAP = 90; // Detiene al superar este % de contexto.

// Sanitiza caps persistidos: 0/NaN/undefined podrían desactivar deadlines o iteraciones
// si pasaran por `??`. Los call sites luego ajustan entero/porcentaje según el cap.
export const positiveOr = (value: unknown, dflt: number): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : dflt;

export type LoopMode = "dynamic" | "fixed";
export type LoopStatus = "running" | "paused" | "stopped" | "done" | "failed" | "stale";

export interface DynamicLoopSchedule {
	mode: "dynamic";
	intervalMs?: never;
}

export interface FixedLoopSchedule {
	mode: "fixed";
	intervalMs: number;
}

export type LoopSchedule = DynamicLoopSchedule | FixedLoopSchedule;

interface LoopStateFields {
	loopId: string;
	task: string;
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

export type LoopState = LoopStateFields & LoopSchedule;

interface ActiveLoopRuntime {
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

export type ActiveLoop = LoopState & ActiveLoopRuntime;
export type FixedActiveLoop = ActiveLoop & FixedLoopSchedule;

export interface CreateActiveLoopInput {
	loopId: string;
	task: string;
	intervalMs?: number;
	now: number;
	autonomous?: boolean;
	ultracode?: boolean;
	ownerSessionId?: string;
}

export interface ParsedLoopStateSnapshot {
	state: LoopState;
	invalidScheduleReason?: string;
}

const MIN_FIXED_INTERVAL_MS = MIN_FIXED_INTERVAL_SECONDS * 1000;
const MAX_FIXED_INTERVAL_MS = MAX_FIXED_INTERVAL_SECONDS * 1000;
const LOOP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Un loopId durable es un único segmento portable. Los IDs actuales (8 hex) y
 * los IDs legacy alfanuméricos con `._-` siguen siendo válidos; separadores,
 * rutas absolutas y segmentos relativos nunca llegan al filesystem.
 */
export function isValidLoopId(value: unknown): value is string {
	return typeof value === "string" && LOOP_ID_PATTERN.test(value);
}

export function isValidFixedIntervalMs(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		Number.isInteger(value) &&
		value >= MIN_FIXED_INTERVAL_MS &&
		value <= MAX_FIXED_INTERVAL_MS
	);
}

/**
 * Normaliza únicamente la frontera de schedule de snapshots persistidos.
 * Los snapshots legacy sin mode siguen siendo dynamic; un fixed inválido queda
 * marcado para retiro y se degrada a una forma runtime segura sin intervalo.
 */
export function parseLoopStateSnapshot(value: unknown): ParsedLoopStateSnapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (!isValidLoopId(raw.loopId) || typeof raw.task !== "string" || typeof raw.status !== "string") {
		return undefined;
	}
	const { mode, intervalMs, ...fields } = raw;
	const stateFields = fields as unknown as LoopStateFields;
	if (mode === undefined || mode === "dynamic") {
		return { state: { ...stateFields, mode: "dynamic" } };
	}
	if (mode === "fixed" && isValidFixedIntervalMs(intervalMs)) {
		return { state: { ...stateFields, mode: "fixed", intervalMs } };
	}
	const invalidScheduleReason =
		mode === "fixed"
			? `schedule fixed inválido: intervalMs debe ser un entero finito entre ${MIN_FIXED_INTERVAL_MS} y ${MAX_FIXED_INTERVAL_MS} ms`
			: `schedule inválido: mode debe ser "dynamic" o "fixed"`;
	return {
		state: { ...stateFields, mode: "dynamic" },
		invalidScheduleReason,
	};
}

export function createActiveLoop(input: CreateActiveLoopInput): ActiveLoop {
	if (!isValidLoopId(input.loopId)) {
		throw new RangeError("loopId must be a portable single path segment");
	}
	let schedule: LoopSchedule = { mode: "dynamic" };
	if (input.intervalMs !== undefined) {
		if (!isValidFixedIntervalMs(input.intervalMs)) {
			throw new RangeError(
				`intervalMs must be a finite integer between ${MIN_FIXED_INTERVAL_MS} and ${MAX_FIXED_INTERVAL_MS}`,
			);
		}
		schedule = { mode: "fixed", intervalMs: input.intervalMs };
	}
	return {
		loopId: input.loopId,
		task: input.task,
		...schedule,
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
	const schedule: LoopSchedule =
		loop.mode === "fixed" ? { mode: "fixed", intervalMs: loop.intervalMs } : { mode: "dynamic" };
	return {
		loopId: loop.loopId,
		task: loop.task,
		...schedule,
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
 * Reconstruye un ActiveLoop desde un snapshot durable (rehydrate).
 * Aplica defaults de modo/caps para snapshots legacy y resetea campos runtime.
 */
export function fromSnapshot(value: unknown, status: LoopStatus): ActiveLoop {
	const parsed = parseLoopStateSnapshot(value);
	if (!parsed) throw new Error("Invalid loop snapshot.");
	const state = parsed.state;
	const retired = parsed.invalidScheduleReason !== undefined;
	return {
		...state,
		maxIterations: positiveOr(Math.trunc(state.maxIterations), DEFAULT_MAX_ITERATIONS),
		maxWallClockMs: positiveOr(state.maxWallClockMs, DEFAULT_MAX_WALL_CLOCK_MS),
		contextPercentCap: Math.min(positiveOr(state.contextPercentCap, DEFAULT_CONTEXT_PERCENT_CAP), 100),
		updatedAt: state.updatedAt ?? new Date().toISOString(),
		status: retired ? "stopped" : status,
		...(retired ? { nextFireAt: null, lastReason: parsed.invalidScheduleReason } : {}),
		timer: null,
		controller: new AbortController(),
		rearmedThisTurn: false,
		autopilot: false,
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
