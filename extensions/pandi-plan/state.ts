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
	/** The task the user handed to /plan. */
	task: string;
	/** True while the read-only GATE is armed (the mode is active). */
	active: boolean;
	status: PlanStatus;
	/** Cuántas veces el modelo llamó submit_plan. */
	submissions: number;
	/** Cuántos de esos fueron rechazados por el usuario. */
	rejections: number;
	/** El último texto de plan que el modelo sumitó (para status + reinyección de aprobación). */
	lastPlan?: string;
	/**
	 * Banderas de postura resueltas al entry (param -> env -> default). Sintonizán el wording del prompt
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
