/**
 * Modelo de estado persistido de `/plan`.
 *
 * Este módulo es un leaf de tipos: nombra el concepto central que comparten
 * runtime, status line y dashboard sin hacer que esos renderers dependan de
 * `index.ts` (el wiring de la extensión). Mantenerlo sin imports preserva la
 * frontera: acá vive la forma del snapshot; las transiciones pequeñas viven en `lifecycle.ts`.
 */

export type PlanStatus = "planning" | "approved" | "rejected" | "exited" | "planned";

export interface PlanState {
	planId: string;
	/** La tarea que el usuario le pasó a /plan. */
	task: string;
	/** Vale true mientras el GATE de solo lectura está armado (el modo sigue activo). */
	active: boolean;
	status: PlanStatus;
	/** Cuántas veces el modelo llamó submit_plan. */
	submissions: number;
	/** Cuántos de esos fueron rechazados por el usuario. */
	rejections: number;
	/** El último texto de plan que el modelo envió (para status + reinyección de aprobación). */
	lastPlan?: string;
	/**
	 * Banderas de postura resueltas en la entrada (param -> env -> default). Sintonizan el texto del prompt
	 * y, para nonInteractive, el ciclo de vida submit_plan (solo plan: sin aprobación,
	 * sin implementación, gate nunca se levanta). Persistidas así que dashboard/status las reflejan.
	 */
	nonInteractive?: boolean;
	ultracode?: boolean;
	ultracodeSteps?: boolean;
	/** Si true, submit_plan aprueba automáticamente tras 60s sin elección humana. */
	autoSubmit?: boolean;
	startedAt: number;
	/** Timestamp ISO de la última escritura (mantenido para paridad con la familia loop/goal). */
	updatedAt: string;
}
