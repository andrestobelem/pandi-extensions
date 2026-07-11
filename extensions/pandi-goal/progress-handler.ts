/**
 * Máquina de estados de `goal_progress`: blocked, done (verifying / verifying-independent)
 * y continue. Extraído de index.ts para que el punto de entrada conserve solo el wiring
 * de la tool.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_VERIFY_ATTEMPTS } from "./constants.js";
import {
	activeGoal,
	advanceGoal,
	beginIndependentVerification,
	normalizeWaitSeconds,
	scheduleGoal,
	stopGoal,
} from "./engine.js";
import { notify } from "./notify.js";
import type { GoalAssessment, GoalProgressInput, GoalProgressResult } from "./types.js";

export async function handleGoalProgress(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: GoalProgressInput,
): Promise<GoalProgressResult> {
	const goal = activeGoal();
	if (!goal) {
		return {
			content: [
				{
					type: "text" as const,
					text: "No hay ningún goal activo. No hay nada sobre lo que reportar progreso.",
				},
			],
			details: { isError: true },
		};
	}

	// Un verificador INDEPENDIENTE está juzgando este goal ahora mismo (proceso
	// separado, lanzado desde un `done` confirmado previo). Su veredicto, no esta
	// llamada, decide el resultado. Rechazar cualquier goal_progress reentrante para
	// que no pueda mutar gstatus por debajo del veredicto en vuelo (eso corrompería la
	// máquina de estados y lo descartaría en silencio).
	if (goal.gstatus === "verifying-independent") {
		return {
			content: [
				{
					type: "text" as const,
					text: `El goal ${goal.goalId} está bajo verificación INDEPENDIENTE en este momento; ese veredicto (no este reporte) decide si se cierra. Esperalo — este reporte no fue registrado.`,
				},
			],
			details: { goalId: goal.goalId, status: "verifying-independent", ignored: true },
		};
	}

	// Clampear waitSeconds DENTRO de execute(); nunca confiar en el modelo.
	const raw = params.waitSeconds;
	const delaySec = normalizeWaitSeconds(raw);

	const assessmentEntry: GoalAssessment = {
		iteration: goal.iteration,
		status: params.status,
		assessment: params.assessment,
		nextStep: params.nextStep,
		at: new Date().toISOString(),
	};

	// Si los criterios fueron derivados (todavía no hay criterios del usuario),
	// capturarlos desde el campo DEDICADO `successCriteria` como definición de terminado
	// para que las iteraciones posteriores los lleven. Nunca reutilizar `assessment`:
	// eso es una autoevaluación, no una lista de criterios.
	if (!goal.successCriteria && !goal.derivedCriteria && params.successCriteria?.trim()) {
		goal.derivedCriteria = params.successCriteria.trim();
	}

	if (params.status === "blocked") {
		goal.assessments.push(assessmentEntry);
		const blocker = params.blocker?.trim() || params.assessment;
		stopGoal(pi, ctx, goal.goalId, `blocked: ${blocker}`, "blocked");
		notify(ctx, `Goal ${goal.goalId} está BLOQUEADO y te necesita: ${blocker}`, "warning");
		return {
			content: [
				{
					type: "text" as const,
					text: `Goal ${goal.goalId} marcado como bloqueado. Se notificó a un humano.`,
				},
			],
			details: { goalId: goal.goalId, status: "blocked", blocker },
		};
	}

	if (params.status === "done") {
		if (goal.gstatus === "verifying") {
			// P1: el modelo CONFIRMÓ done después de su autochequeo. NO cerrar todavía:
			// escalar a un verificador adversarial INDEPENDIENTE (subagente escéptico
			// separado). Solo un PASS independiente cierra el goal. Registrar la confirmación
			// del modelo y lanzar el verificador FUERA de este turno (sin esperar: el
			// proceso del subagente resuelve el veredicto y cierra, reinyecta continue o
			// bloquea). Volvemos al modelo ahora para que su turno termine limpio; el goal
			// queda en `verifying-independent`.
			goal.assessments.push(assessmentEntry);
			void beginIndependentVerification(pi, ctx, goal);
			return {
				content: [
					{
						type: "text" as const,
						text: `Registramos tu 'done' confirmado para el goal ${goal.goalId}. TODAVÍA NO se cerró — un verificador INDEPENDIENTE (subagente aparte) está juzgando el objetivo contra los criterios con la evidencia disponible. El goal se cierra solo si ese verificador independiente devuelve PASS.`,
					},
				],
				details: { goalId: goal.goalId, status: "verifying-independent" },
			};
		}
		// Primer `done` desde `pursuing` → NO detener. Transicionar a verifying y
		// reinyectar el prompt de verificación (el sello del chequeo de completitud).
		goal.assessments.push(assessmentEntry);
		goal.gstatus = "verifying";
		scheduleGoal(pi, ctx, goal, 0, "done autodeclarado → verifying");
		return {
			content: [
				{
					type: "text" as const,
					text: `Registramos un primer 'done' para el goal ${goal.goalId}. TODAVÍA NO terminó — un turno de verificación va a confrontar cada criterio con evidencia antes de que el goal pueda cerrarse.`,
				},
			],
			details: { goalId: goal.goalId, status: "verifying" },
		};
	}

	// status === "continue".
	// Un `continue` que llega DESDE `verifying` significa que el chequeo de completitud
	// FALLÓ: contarlo. Si la verificación sigue fallando, el modelo está haciendo
	// ida y vuelta done↔verify sin progreso real; detener como blocked en vez de quemar en
	// silencio todo el presupuesto de iteraciones.
	if (goal.gstatus === "verifying") {
		goal.verifyAttempts += 1;
		if (goal.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
			goal.assessments.push(assessmentEntry);
			const blocker = `la verificación siguió fallando después de ${goal.verifyAttempts} intento(s); última brecha: ${
				params.nextStep || params.assessment
			}`;
			stopGoal(pi, ctx, goal.goalId, `blocked: ${blocker}`, "blocked");
			notify(ctx, `Goal ${goal.goalId} está BLOQUEADO: ${blocker}`, "warning");
			return {
				content: [
					{
						type: "text" as const,
						text: `Goal ${goal.goalId} bloqueado: el chequeo de completitud falló ${goal.verifyAttempts} vez(veces). Se notificó a un humano.`,
					},
				],
				details: {
					goalId: goal.goalId,
					status: "blocked",
					verifyAttempts: goal.verifyAttempts,
				},
			};
		}
	}

	// Registra + arma la próxima iteración pursuing.
	const reason = params.nextStep ? `continue: ${params.nextStep}` : "continue";
	advanceGoal(pi, ctx, goal, assessmentEntry, delaySec, reason);
	const when = delaySec > 0 ? `en ${delaySec}s` : "de inmediato";
	return {
		content: [
			{
				type: "text" as const,
				text: `Registramos el progreso del goal ${goal.goalId}; próxima iteración ${when}.`,
			},
		],
		details: {
			goalId: goal.goalId,
			status: "continue",
			delaySeconds: delaySec,
			clampedFrom: raw !== delaySec ? raw : undefined,
		},
	};
}
