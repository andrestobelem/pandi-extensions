/**
 * Hooks de sesión para `/goal`: cierre limpio (session_shutdown) y red de seguridad
 * (agent_end). Extraído de index.ts para que el punto de entrada conserve solo el wiring.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SAFETY_NET_DELAY_SECONDS } from "./constants.js";
import { activeGoals, contextBudgetExceeded, scheduleGoal, stopGoal } from "./engine.js";
import { participatesInSafetyNet } from "./goal-status.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { clearGoalStatus } from "./status.js";

export async function handleSessionShutdown(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	for (const goal of activeGoals.values()) {
		if (goal.timer) {
			clearTimeout(goal.timer);
			goal.timer = null;
		}
		goal.controller.abort("cierre de sesión");
		if (goal.gstatus === "verifying" || goal.gstatus === "verifying-independent") {
			// Un goal verifying debe retomar verifying después de recarga (el chequeo de
			// completitud sobrevive), así que persistir la fase textual; rehydrate la
			// conserva. Un goal verifying-independent persiste igual; rehydrate REEJECUTA el
			// verificador independiente (el veredicto en vuelo se perdió al abortar acá).
			goal.verifierInFlight = false;
			persist(pi, ctx, goal);
		} else if (goal.gstatus === "pursuing") {
			// Persistir como "stale" (recuperable en el próximo session_start), manteniendo
			// nextFireAt intacto; rehydrate lo retoma como pursuing.
			goal.gstatus = "stale";
			persist(pi, ctx, goal);
		}
	}
	clearGoalStatus(ctx);
}

export async function handleAgentEnd(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	// Red de seguridad: si un goal sigue activo y el turno cerró sin que el modelo llame
	// a goal_progress (sin rearmar) y sin timer vivo, rearmar defensivamente para que el
	// goal no muera en silencio.
	for (const goal of activeGoals.values()) {
		// Solo los goals `pursuing`/`verifying` participan en la red de seguridad. Un goal
		// `verifying-independent` queda EXCLUIDO deliberadamente: su verificador corre en un
		// proceso separado FUERA del turno del modelo y resuelve por sí mismo la próxima
		// transición (done / continue / blocked). Rearmarlo acá competiría con el veredicto
		// en vuelo.
		if (!participatesInSafetyNet(goal.gstatus)) continue;

		// Compuerta de presupuesto ANTES de cualquier rearme (espeja loop.ts agent_end): si el
		// presupuesto de contexto ya está agotado, detener limpiamente en vez de pagar otro
		// turno (la ruta `continue`/advanceGoal arma sin consultar el presupuesto, así que
		// este es el primer lugar honesto para cortar del lado del rearme).
		const budget = contextBudgetExceeded(ctx, goal);
		if (budget) {
			stopGoal(pi, ctx, goal.goalId, budget, "stopped");
			notify(ctx, `Goal ${goal.goalId} detenido: ${budget}. Podés hacer /compact y retomar.`, "warning");
			continue;
		}

		if (goal.rearmedThisTurn) continue;
		if (goal.timer) continue;
		// Ya hay un wake pendiente (p. ej. un disparo delay-0 armado este turno para la
		// transición done→verifying que todavía no corrió): NO apilar un segundo wake
		// encima, porque duplicaría el prompt de verificación / iteración.
		if (goal.nextFireAt !== null) continue;
		// Nunca dejar que la red de seguridad rearme un goal `verifying`. La transición
		// done→verifying arma un wake delay-0 cuyo fireGoal resetea rearmedThisTurn/timer;
		// si ese fireGoal ya inyectó el prompt de verificación antes de este agent_end,
		// rearmar acá inyectaría un SEGUNDO prompt de verificación. El turno de
		// verificación ya está en vuelo; un `continue`/`done` del modelo (o una iteración
		// pursuing posterior) rearmará legítimamente.
		if (goal.gstatus === "verifying") continue;
		scheduleGoal(pi, ctx, goal, SAFETY_NET_DELAY_SECONDS, "auto: el turno cerró sin goal_progress");
	}
}
