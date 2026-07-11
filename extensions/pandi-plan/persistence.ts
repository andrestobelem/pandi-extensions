/**
 * Persistencia de transiciones de plan-mode: append JSONL vía pi.appendEntry.
 * Extraído de index.ts para achicar el wiring del punto de entrada.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PlanState } from "./state.js";

export const PLAN_STATE_TYPE = "plan-state";

/**
 * Persiste una transición de plan. Marca updatedAt y agrega al JSONL de la sesión (NO
 * va al LLM). Sin sidecar: un plan es short-lived y vive solo dentro de una sesión
 * interactiva, así que la entrada JSONL (reproducida por rehydrate en session_start) es suficiente.
 */
export function persist(pi: ExtensionAPI, plan: PlanState): void {
	plan.updatedAt = new Date().toISOString();
	pi.appendEntry<PlanState>(PLAN_STATE_TYPE, { ...plan });
}
