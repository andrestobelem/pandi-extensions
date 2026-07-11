/**
 * Predicados de fase para la máquina de estados del goal.
 *
 * Centraliza los subconjuntos de GoalStatus usados en completions, shutdown y la red
 * de seguridad agent_end — cada uno con semántica distinta y no intercambiable.
 */

import type { GoalStatus } from "./types.js";

/** Goals que siguen "vivos" para completions y listados de status. */
export const ACTIVE_GOAL_STATUSES = [
	"pursuing",
	"verifying",
	"verifying-independent",
] as const satisfies readonly GoalStatus[];

/** Goals que la red de seguridad agent_end puede rearmar defensivamente. */
export const SAFETY_NET_STATUSES = ["pursuing", "verifying"] as const satisfies readonly GoalStatus[];

export function isActiveGoalStatus(status: GoalStatus): boolean {
	return (ACTIVE_GOAL_STATUSES as readonly GoalStatus[]).includes(status);
}

export function participatesInSafetyNet(status: GoalStatus): boolean {
	return (SAFETY_NET_STATUSES as readonly GoalStatus[]).includes(status);
}
