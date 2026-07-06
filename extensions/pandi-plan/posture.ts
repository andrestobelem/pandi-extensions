/**
 * Postura de ejecución de `/plan`.
 *
 * Estas banderas no son el estado completo del plan: son los knobs que cambian
 * cómo se planifica y qué ocurre después de `submit_plan`. Mantenerlas en un
 * módulo leaf evita que prompts/flags/index compartan el concepto vía imports
 * accidentales entre sí.
 */

/** Banderas opcionales aceptadas desde comando, tool params, env y defaults de sesión. */
export interface PlanPosture {
	nonInteractive?: boolean;
	ultracode?: boolean;
	ultracodeSteps?: boolean;
}

/** Alias histórico: en las superficies de comando/tool estas posturas se reciben como flags. */
export type PlanFlags = PlanPosture;

/** Postura resuelta: todos los knobs tienen un valor concreto. */
export type ResolvedPlanPosture = Required<PlanPosture>;

/**
 * En sesiones con aprobación humana disponible, plan-only no aplica.
 *
 * Preserva los knobs ultracode y devuelve una copia para que el llamador no dependa
 * de mutar el objeto resuelto por `resolvePlanFlags`.
 */
export function forceInteractiveApprovalPosture(posture: ResolvedPlanPosture): ResolvedPlanPosture {
	return { ...posture, nonInteractive: false };
}
