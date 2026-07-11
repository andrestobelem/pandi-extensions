/**
 * Manejo de `/goal`: stop, status y delegación de inicio al engine.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseGoalCommandIntent } from "./command-intent.js";
import { activeGoals, resolveGoal, startGoal, stopGoal } from "./engine.js";
import { isActiveGoalStatus } from "./goal-status.js";
import { notify } from "./notify.js";
import { formatGoalStatusList, formatStatus } from "./status.js";
import type { ActiveGoal } from "./types.js";

export type GoalArgumentCompletion = { value: string; label: string; description: string };

export const STATIC_GOAL_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
	{ value: "stop", label: "stop", description: "Detener un goal activo" },
	{ value: "status", label: "status", description: "Mostrar el estado del goal" },
	{ value: "--ultracode", label: "--ultracode", description: "Perseguir el goal vía dynamic workflows" },
];

export function buildGoalArgumentCompletions(
	activeGoalEntries: Iterable<ActiveGoal>,
	argumentPrefix: string,
): GoalArgumentCompletion[] {
	const items: GoalArgumentCompletion[] = [...STATIC_GOAL_ARGUMENT_COMPLETIONS];
	for (const goal of activeGoalEntries) {
		if (isActiveGoalStatus(goal.gstatus)) {
			items.push({ value: goal.goalId, label: goal.goalId, description: goal.objective });
		}
	}
	const prefix = argumentPrefix.trim().toLowerCase();
	if (!prefix) return items;
	return items.filter((item) => item.value.toLowerCase().startsWith(prefix));
}

export async function handleGoalCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const intent = parseGoalCommandIntent(args);

	if (intent.kind === "stop") {
		const goal = await resolveGoal(ctx, intent.rest || undefined);
		if (!goal) {
			notify(ctx, "No hay ningún goal que coincida para detener — revisá el id con /goal status.", "warning");
			return;
		}
		stopGoal(pi, ctx, goal.goalId, "detenido por el usuario (/goal stop)", "stopped");
		notify(ctx, `Goal ${goal.goalId} detenido.`, "info");
		return;
	}

	if (intent.kind === "status") {
		if (intent.rest) {
			const goal = activeGoals.get(intent.rest);
			notify(
				ctx,
				goal
					? formatStatus(goal)
					: `No hay ningún goal con id ${intent.rest} — corré /goal status para listar los goals activos.`,
				goal ? "info" : "warning",
			);
			return;
		}
		const all = [...activeGoals.values()];
		if (all.length === 0) {
			notify(ctx, "No hay goals.", "info");
			return;
		}
		notify(ctx, formatGoalStatusList(all), "info");
		return;
	}

	startGoal(pi, ctx, intent.rest);
}
