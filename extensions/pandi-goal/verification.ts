/**
 * Flujo P1 de verificación independiente (subagente escéptico tras `done` confirmado).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeGoals } from "./active-goals.js";
import { stopGoal } from "./goal-stop.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { advanceGoal } from "./scheduler.js";
import { setGoalStatus } from "./status.js";
import type { ActiveGoal, GoalAssessment } from "./types.js";
import { runIndependentVerifier } from "./verifier.js";

/**
 * Si el modelo CONFIRMA `done` desde `verifying`, no cerramos el goal todavía.
 * Pasamos a `verifying-independent`, lanzamos el verificador y resolvemos PASS/FAIL.
 * verifierInFlight evita lanzar dos verificadores para el mismo goal.
 */
export async function beginIndependentVerification(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
): Promise<void> {
	if (goal.verifierInFlight) return;
	if (goal.timer) {
		clearTimeout(goal.timer);
		goal.timer = null;
	}
	goal.verifierInFlight = true;
	goal.gstatus = "verifying-independent";
	goal.nextFireAt = null;
	goal.lastReason = "verificación independiente en curso";
	persist(pi, ctx, goal);
	setGoalStatus(ctx, goal);

	let verdict: Awaited<ReturnType<typeof runIndependentVerifier>>;
	try {
		verdict = await runIndependentVerifier(pi, ctx, goal);
	} catch (err) {
		verdict = {
			pass: false,
			feedback: `verificador independiente falló: ${(err as Error).message}`,
			unparsed: true,
		};
	}
	goal.verifierInFlight = false;

	const live = activeGoals.get(goal.goalId);
	if (!live || live !== goal || goal.gstatus !== "verifying-independent" || goal.controller.signal.aborted) return;

	const at = new Date().toISOString();
	if (verdict.pass) {
		goal.assessments.push({
			iteration: goal.iteration,
			status: "done",
			assessment: `independent verifier PASS: ${verdict.feedback}`.slice(0, 2000),
			at,
		});
		stopGoal(pi, ctx, goal.goalId, "done: verificado de forma independiente contra los criterios de éxito", "done");
		notify(
			ctx,
			`Goal ${goal.goalId} TERMINADO: verificado de forma independiente (un subagente aparte lo confirmó). 🐼`,
			"info",
		);
		return;
	}

	goal.independentVerifyAttempts += 1;
	const feedback = verdict.feedback.trim() || "el verificador independiente rechazó la afirmación sin detalle";
	if (goal.independentVerifyAttempts >= goal.maxIndependentVerifications) {
		goal.assessments.push({
			iteration: goal.iteration,
			status: "blocked",
			assessment:
				`independent verifier FAIL (${goal.independentVerifyAttempts}/${goal.maxIndependentVerifications}): ${feedback}`.slice(
					0,
					2000,
				),
			at,
		});
		const blocker = `la verificación independiente falló ${goal.independentVerifyAttempts} vez(veces); último veredicto: ${feedback}`;
		stopGoal(pi, ctx, goal.goalId, `blocked: ${blocker}`, "blocked");
		notify(
			ctx,
			`Goal ${goal.goalId} está BLOQUEADO: la verificación independiente siguió fallando (necesita a un humano). ${feedback}`,
			"warning",
		);
		return;
	}

	const assessment: GoalAssessment = {
		iteration: goal.iteration,
		status: "continue",
		assessment:
			`independent verifier FAIL (${goal.independentVerifyAttempts}/${goal.maxIndependentVerifications}): ${feedback}`.slice(
				0,
				2000,
			),
		nextStep: `Atendé los hallazgos del verificador independiente antes de volver a declarar done: ${feedback}`.slice(
			0,
			2000,
		),
		at,
	};
	advanceGoal(pi, ctx, goal, assessment, 0, "la verificación independiente falló → continue");
	notify(ctx, `Goal ${goal.goalId}: el verificador independiente devolvió FAIL; iterando de nuevo.`, "info");
}
