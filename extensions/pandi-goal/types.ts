/**
 * Declaraciones de tipos compartidas para la extensión `/goal`.
 *
 * Declaraciones puras de tipos/interfaces (cero runtime). La state machine, scheduling,
 * persistencia y verificador viven en engine.ts y módulos hermanos; este archivo es una hoja
 * sin imports para que cualquier hermano pueda depender de él.
 */

export type GoalStatus = "pursuing" | "verifying" | "verifying-independent" | "done" | "blocked" | "stopped" | "stale";
export type GoalDecision = "continue" | "done" | "blocked";

export interface GoalAssessment {
	iteration: number;
	status: GoalDecision;
	assessment: string;
	nextStep?: string;
	at: string;
}

export interface GoalState {
	goalId: string;
	objective: string;
	/** Criterios de éxito provistos por el usuario vía `-- <criteria>`, si existen. */
	successCriteria?: string;
	/** Criterios DERIVADOS por el modelo en la iteración 1 cuando el usuario no dio ninguno (S2). */
	derivedCriteria?: string;
	/** Postura Ultracode: apoyarse en dynamic workflows para conducir el trabajo (solo inyección de prompt). */
	ultracode?: boolean;
	iteration: number;
	maxIterations: number;
	/** Tope best-effort de porcentaje de uso de contexto. */
	contextPercentCap: number;
	/** Historial acotado de autoevaluaciones (recortado a PROGRESS_LOG_KEEP al persistir). */
	assessments: GoalAssessment[];
	/** Cantidad de chequeos de completitud que fallaron (verifying → continue). Limita el ping-pong de verificación. */
	verifyAttempts: number;
	/** P1: cantidad de verificaciones INDEPENDENT que devolvieron FAIL. Limita el ping-pong independiente. */
	independentVerifyAttempts: number;
	/** P1: máximo de verificaciones independientes fallidas toleradas antes de bloquear (config, default 2). */
	maxIndependentVerifications: number;
	/** P1: presupuesto de tiempo real (ms) para un subagente de verificación independiente (config). */
	verifierTimeoutMs: number;
	/** P1: tools de solo lectura entregadas al subagente verificador (config). */
	verifierTools: string[];
	gstatus: GoalStatus;
	startedAt: number;
	nextFireAt: number | null;
	lastReason?: string;
	/** Timestamp ISO de la última escritura; usado para resolver conflictos JSONL-vs-sidecar. */
	updatedAt: string;
}

export interface ActiveGoal extends GoalState {
	timer: ReturnType<typeof setTimeout> | null;
	controller: AbortController;
	/** True una vez que un wake fue (re)armado en el turno actual; se resetea en cada fire. */
	rearmedThisTurn: boolean;
	/** P1: true mientras un subagente verificador independiente está en vuelo (debounce del relanzamiento). */
	verifierInFlight: boolean;
}

/** Parámetros normalizados de la tool `goal_progress` (post-esquema TypeBox). */
export interface GoalProgressInput {
	status: GoalDecision;
	assessment: string;
	successCriteria?: string;
	nextStep?: string;
	blocker?: string;
	waitSeconds?: number;
}

/** Forma de retorno de `handleGoalProgress` (content + details de la tool). */
export interface GoalProgressResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}
