/**
 * Helpers de persistencia para la extensión `/goal`, extraídos a un hermano para que
 * index.ts conserve solo el engine/wiring. Están PARAMETRIZADOS (reciben
 * pi/ctx/goal/state como argumentos) y no cierran sobre estado mutable del módulo, así que
 * se mueven limpiamente. El JSONL de sesión escrito vía pi.appendEntry es la única
 * fuente de persistencia y recuperación.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_STATE_TYPE, PROGRESS_LOG_KEEP } from "./constants.js";
import type { ActiveGoal, GoalState } from "./types.js";

export function snapshot(goal: ActiveGoal): GoalState {
	const {
		timer: _timer,
		controller: _controller,
		rearmedThisTurn: _rearmedThisTurn,
		verifierInFlight: _verifierInFlight,
		...state
	} = goal;
	return {
		...state,
		// Acotar el log persistido para que la entrada JSONL nunca crezca sin límite.
		assessments: state.assessments.slice(-PROGRESS_LOG_KEEP),
	};
}

/**
 * Persiste una transición del goal como entry JSONL de sesión (NO va al LLM).
 * Recovery requiere que esa sesión siga disponible y que su JSONL sea válido.
 */
export function persist(pi: ExtensionAPI, _ctx: ExtensionContext, goal: ActiveGoal): void {
	goal.updatedAt = new Date().toISOString();
	const snap = snapshot(goal);
	pi.appendEntry<GoalState>(GOAL_STATE_TYPE, snap);
}
