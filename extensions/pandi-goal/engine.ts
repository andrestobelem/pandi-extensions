/**
 * Motor de estado de `/goal`: activeGoals, wakes, FSM, verificación independiente
 * y rehidratación. Extraído de index.ts para que el punto de entrada conserve solo
 * el wiring (tools/commands/hooks). Comportamiento byte-idéntico: el Map
 * `activeGoals` es el singleton del módulo; index lo importa de vuelta.
 */

import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseGoalArgs } from "./command-intent.js";
import {
	DEFAULT_CONTEXT_PERCENT_CAP,
	DEFAULT_MAX_INDEPENDENT_VERIFICATIONS,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_VERIFIER_TIMEOUT_MS,
	DEFAULT_VERIFIER_TOOLS,
	GOAL_STATE_TYPE,
	MAX_WAIT_SECONDS,
	MIN_WAIT_SECONDS,
} from "./constants.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { makeGoalIterationPrompt, makeGoalVerificationPrompt } from "./prompts.js";
import { collectLatestByKey } from "./session-state.js";
import { clearGoalStatus, setGoalStatus } from "./status.js";
import type { ActiveGoal, GoalAssessment, GoalState, GoalStatus } from "./types.js";
import { runIndependentVerifier } from "./verifier.js";

// Fuente de verdad de "qué temporizadores viven AHORA". Map soporta varios, pero las
// herramientas P0 resuelven el único goal activo (S4).
export const activeGoals = new Map<string, ActiveGoal>();

// ---------------------------------------------------------------------------
// Línea de estado
// ---------------------------------------------------------------------------

/** Refresca el estado desde el goal actualmente activo (pursuing/verifying), si existe. */
function refreshGoalStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	for (const goal of activeGoals.values()) {
		if (goal.gstatus === "pursuing" || goal.gstatus === "verifying" || goal.gstatus === "verifying-independent") {
			setGoalStatus(ctx, goal);
			return;
		}
	}
	clearGoalStatus(ctx);
}

// ---------------------------------------------------------------------------
// Despertar / programación
// ---------------------------------------------------------------------------

/**
 * Un goal solo puede correr donde el bucle del agente es lo bastante interactivo para
 * reinyectar un prompt y retomar por su cuenta: TUI y RPC. "print" es de una sola
 * ejecución, "json" es no interactivo; ninguno puede sostener un goal.
 */
function canGoalInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

export function normalizeWaitSeconds(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
	return Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, Math.round(raw)));
}

function wake(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	// Compuerta de modo: nunca reinyectar fuera de tui/rpc (también defiende rutas de rehydrate).
	if (!canGoalInMode(ctx)) return;
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

/**
 * Compuerta de mejor esfuerzo de presupuesto de contexto. Devuelve un texto de razón
 * de parada si el porcentaje de uso de contexto supera el tope; si no, undefined. `percent`
 * puede ser null justo después de compactación (según types.d.ts), y en ese caso NO corta.
 */
export function contextBudgetExceeded(ctx: ExtensionContext, goal: ActiveGoal): string | undefined {
	const usage = ctx.getContextUsage?.();
	if (usage && usage.percent !== null && usage.percent >= goal.contextPercentCap) {
		return `presupuesto de contexto agotado (${Math.round(usage.percent)}% ≥ ${goal.contextPercentCap}%)`;
	}
	return undefined;
}

/**
 * Dispara una iteración. Protege el estado, aplica maxIterations + presupuesto de
 * contexto y después reinyecta el prompt adecuado para la fase actual (iteración vs
 * verificación).
 */
function fireGoal(pi: ExtensionAPI, ctx: ExtensionContext, goal: ActiveGoal): void {
	goal.timer = null;
	if (goal.gstatus !== "pursuing" && goal.gstatus !== "verifying") return;

	if (goal.iteration >= goal.maxIterations) {
		stopGoal(pi, ctx, goal.goalId, `alcanzó el límite de maxIterations (${goal.maxIterations})`, "stopped");
		notify(
			ctx,
			`Goal ${goal.goalId} detenido: alcanzó el límite de maxIterations (${goal.maxIterations}).`,
			"warning",
		);
		return;
	}

	// Compuerta de mejor esfuerzo de presupuesto antes de hacer cualquier trabajo.
	const budget = contextBudgetExceeded(ctx, goal);
	if (budget) {
		stopGoal(pi, ctx, goal.goalId, budget, "stopped");
		notify(ctx, `Goal ${goal.goalId} detenido: ${budget}. Podés hacer /compact y retomar.`, "warning");
		return;
	}

	goal.iteration += 1;
	goal.nextFireAt = null;
	goal.rearmedThisTurn = false;
	persist(pi, ctx, goal);
	setGoalStatus(ctx, goal);
	const prompt = goal.gstatus === "verifying" ? makeGoalVerificationPrompt(goal) : makeGoalIterationPrompt(goal);
	try {
		wake(pi, ctx, prompt);
	} catch (err) {
		stopGoal(pi, ctx, goal.goalId, `falló la entrega del wake: ${(err as Error).message}`, "stopped");
		notify(ctx, `Goal ${goal.goalId} detenido: falló la entrega del wake.`, "error");
	}
}

/**
 * Arma el próximo wake después de delaySec (0 = inmediato vía setTimeout(…, 0)). El
 * llamador es responsable de clampear. Lo usan advanceGoal y la transición de verificación.
 */
export function scheduleGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
	delaySec: number,
	reason: string,
): void {
	if (goal.timer) {
		clearTimeout(goal.timer);
		goal.timer = null;
	}
	goal.nextFireAt = delaySec > 0 ? Date.now() + delaySec * 1000 : null;
	goal.lastReason = reason;
	goal.rearmedThisTurn = true;
	persist(pi, ctx, goal);
	setGoalStatus(ctx, goal);
	goal.timer = setTimeout(() => fireGoal(pi, ctx, goal), Math.max(0, delaySec * 1000));
}

/**
 * Registra una autoevaluación y arma la próxima iteración `pursuing`. `continue`
 * mantiene el goal en `pursuing`; una verificación fallida (`continue` desde
 * `verifying`) también vuelve a `pursuing`. La cadencia es inmediata (delay 0) salvo
 * que se haya dado waitSeconds (clampeado).
 */
export function advanceGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
	assessment: GoalAssessment,
	delaySec: number,
	reason: string,
): void {
	goal.assessments.push(assessment);
	goal.gstatus = "pursuing";
	scheduleGoal(pi, ctx, goal, delaySec, reason);
}

/**
 * P1: si el modelo CONFIRMA `done` desde `verifying`, no cerramos el goal todavía.
 * Pasamos a `verifying-independent`, lanzamos un subagente verificador y resolvemos:
 *   - PASS                  → stopGoal(done).
 *   - FAIL (bajo el tope)   → incrementar `independentVerifyAttempts`, guardar
 *                             la devolución como assessment y reinyectar una
 *                             iteración `continue` con ese nextStep.
 *   - FAIL (tope alcanzado) → stopGoal(blocked) con la devolución.
 *
 * El verificador corre fuera del turno del modelo. Esta función solo reinyecta
 * después del veredicto, así que la compuerta mantiene la misma semántica.
 *
 * Concurrencia: verifierInFlight evita lanzar dos verificadores para el mismo goal.
 */
export async function beginIndependentVerification(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
): Promise<void> {
	if (goal.verifierInFlight) return;
	// Estaciona el goal en la fase de verificación independiente. No hay timer armado:
	// el goal no está pursuing ni (auto)verifying, así que fireGoal / la red de
	// seguridad agent_end lo dejan quieto mientras corre el juez externo.
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

	// El goal pudo haberse detenido (usuario /goal stop, shutdown) mientras corría el
	// verificador. Un stop del usuario lo quita de activeGoals; session_shutdown lo mantiene
	// (persistido textual para que rehydrate reejecute el verificador) pero ABORTA su
	// controller; por eso también hay que salir si el controller está abortado. Si no, un
	// veredicto tardío finalizaría el goal (done/blocked), pisaría la instantánea persistida
	// verifying-independent y enviaría un mensaje a una sesión muerta.
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

	// FAIL. Contarlo; si agotamos el presupuesto de verificación independiente, bloquear.
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

	// Bajo el tope → reinyectar una iteración pursuing normal con la devolución del
	// verificador para que el modelo arregle exactamente lo que marcó el juez
	// independiente. Inmediata (delay 0), mecánica idéntica a un `continue`.
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

// ---------------------------------------------------------------------------
// Inicio / parada
// ---------------------------------------------------------------------------

export function startGoal(pi: ExtensionAPI, ctx: ExtensionContext, args: string): ActiveGoal | undefined {
	// Compuerta de modo: solo TUI/RPC puede sostener una sesión persistente de goal.
	if (!canGoalInMode(ctx)) {
		notify(ctx, "/goal requiere una sesión TUI o RPC (este modo no puede sostener un goal).", "error");
		return undefined;
	}
	// Un solo goal activo a la vez: la herramienta P0 (goal_progress) no lleva goalId y resuelve
	// el único goal activo, así que un segundo goal concurrente volvería ambiguos los
	// reportes y haría que dos goals compitan por la reinyección de `wake`. Rechazar iniciar
	// un segundo; el usuario detiene el primero.
	const existing = activeGoal();
	if (existing) {
		notify(
			ctx,
			`Ya hay un goal activo (${existing.goalId}: ${existing.objective}). Detenélo primero con /goal stop.`,
			"warning",
		);
		return undefined;
	}
	const { objective, successCriteria, ultracode } = parseGoalArgs(args);
	if (!objective) {
		notify(ctx, "Uso: /goal [--ultracode] <objective> [-- <success criteria>]", "warning");
		return undefined;
	}

	const goalId = crypto.randomBytes(4).toString("hex");
	const goal: ActiveGoal = {
		goalId,
		objective,
		successCriteria,
		derivedCriteria: undefined,
		ultracode,
		iteration: 0,
		maxIterations: DEFAULT_MAX_ITERATIONS,
		contextPercentCap: DEFAULT_CONTEXT_PERCENT_CAP,
		assessments: [],
		verifyAttempts: 0,
		independentVerifyAttempts: 0,
		maxIndependentVerifications: DEFAULT_MAX_INDEPENDENT_VERIFICATIONS,
		verifierTimeoutMs: DEFAULT_VERIFIER_TIMEOUT_MS,
		verifierTools: [...DEFAULT_VERIFIER_TOOLS],
		gstatus: "pursuing",
		startedAt: Date.now(),
		nextFireAt: null,
		lastReason: undefined,
		updatedAt: new Date().toISOString(),
		timer: null,
		controller: new AbortController(),
		rearmedThisTurn: false,
		verifierInFlight: false,
	};

	activeGoals.set(goalId, goal);
	persist(pi, ctx, goal);

	// Envía el primer prompt de iteración inmediatamente. fireGoal maneja iteration++/persist/status.
	fireGoal(pi, ctx, goal);
	const crit = successCriteria ? " (con criterios)" : " (el modelo va a derivar los criterios)";
	const uc = ultracode ? " [ultracode]" : "";
	notify(ctx, `Goal ${goalId} iniciado${crit}${uc}: ${objective}`, "info");
	return goal;
}

/**
 * Resuelve un goal por id, por candidato único o vía ui.select. `statuses` filtra qué
 * goals son elegibles. Por defecto usa activos (pursuing/verifying).
 */
export async function resolveGoal(
	ctx: ExtensionContext,
	idOrUndef: string | undefined,
	statuses: GoalStatus[] = ["pursuing", "verifying", "verifying-independent"],
): Promise<ActiveGoal | undefined> {
	if (idOrUndef) return activeGoals.get(idOrUndef);
	const candidates = [...activeGoals.values()].filter((g) => statuses.includes(g.gstatus));
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];
	if (ctx.hasUI) {
		const choice = await ctx.ui.select(
			"¿Qué goal?",
			candidates.map((g) => `${g.goalId} — ${g.objective}`),
		);
		if (!choice) return undefined;
		const id = choice.split(" ")[0];
		return activeGoals.get(id);
	}
	return undefined;
}

export function stopGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goalId: string,
	reason: string,
	finalStatus: "done" | "blocked" | "stopped" = "stopped",
): boolean {
	const goal = activeGoals.get(goalId);
	if (!goal) return false;
	if (goal.timer) {
		clearTimeout(goal.timer);
		goal.timer = null;
	}
	goal.controller.abort(reason);
	goal.gstatus = finalStatus;
	goal.nextFireAt = null;
	goal.lastReason = reason;
	persist(pi, ctx, goal);
	// Los goals terminales ya no están activos: conservar la instantánea final persistida
	// para auditoría/rehydrate, pero soltar de inmediato la entrada en memoria (espeja
	// stopLoop -> activeLoops.delete de pandi-loop) para que agent_end/activeGoal()/scan y
	// `/goal status` solo recorran goals vivos en vez de acumular muertos durante la sesión.
	activeGoals.delete(goalId);
	refreshGoalStatus(ctx);
	return true;
}

/** El único goal activo (pursuing, en autoverificación o en verificación independiente), o undefined. */
export function activeGoal(): ActiveGoal | undefined {
	return [...activeGoals.values()].find(
		(g) => g.gstatus === "pursuing" || g.gstatus === "verifying" || g.gstatus === "verifying-independent",
	);
}

// ---------------------------------------------------------------------------
// Rehidratación (session_start)
// ---------------------------------------------------------------------------

/**
 * Reconstruye el estado de goals desde entradas persistidas (gana la última por
 * goalId) y rearma goals activos. Evita doble disparo: si activeGoals ya tiene el goal
 * (timer vivo en este proceso), salta. Solo un tick de puesta al día, sin reproducir N
 * activaciones perdidas.
 */
export function rehydrate(pi: ExtensionAPI, ctx: ExtensionContext): void {
	// Compuerta de modo (espeja startGoal): un /goal solo se puede sostener en tui/rpc. En
	// una sesión no interactiva (print de una sola ejecución, json) el goal nunca puede
	// avanzar, así que la ruta de recarga debe ser un NO-OP: no rearmar un timer de puesta
	// al día (fireGoal subiría la iteración y persistiría mientras wake() no hace nada) y,
	// sobre todo, no lanzar el subproceso del verificador independiente para una instantánea
	// verifying-independent. wake() ya suprime la REINYECCIÓN del prompt, pero solo
	// rechazar rehydrate acá frena esos efectos. Dejar intacto el estado persistido
	// permite que una sesión tui/rpc posterior lo recupere.
	if (!canGoalInMode(ctx)) return;
	const entries = ctx.sessionManager.getEntries();
	const latest = collectLatestByKey<GoalState>(entries, GOAL_STATE_TYPE, (d) => d.goalId);

	for (const state of latest.values()) {
		// Recupera goals que estaban vivos ("pursuing"/"verifying"/"verifying-independent") o
		// estacionados limpiamente ("stale").
		if (
			state.gstatus !== "pursuing" &&
			state.gstatus !== "verifying" &&
			state.gstatus !== "verifying-independent" &&
			state.gstatus !== "stale"
		) {
			continue;
		}
		// Timer todavía vivo en este proceso → no rearmar (sin doble disparo).
		if (activeGoals.has(state.goalId)) continue;

		const goal: ActiveGoal = {
			...state,
			// Una instantánea "stale" recuperada retoma pursuing; una instantánea "verifying" retoma
			// verifying (el chequeo de completitud sobrevive a recarga); una instantánea
			// "verifying-independent" retoma reejecutando abajo el verificador independiente
			// (su veredicto se perdió en la caída, así que rejuzgamos en vez de adivinar).
			gstatus: state.gstatus === "stale" ? "pursuing" : state.gstatus,
			assessments: Array.isArray(state.assessments) ? state.assessments : [],
			verifyAttempts: typeof state.verifyAttempts === "number" ? state.verifyAttempts : 0,
			// Completa campos P1 para instantáneas escritas por una versión pre-P1 (valores por defecto defensivos).
			independentVerifyAttempts:
				typeof state.independentVerifyAttempts === "number" ? state.independentVerifyAttempts : 0,
			maxIndependentVerifications:
				typeof state.maxIndependentVerifications === "number"
					? state.maxIndependentVerifications
					: DEFAULT_MAX_INDEPENDENT_VERIFICATIONS,
			verifierTimeoutMs:
				typeof state.verifierTimeoutMs === "number" ? state.verifierTimeoutMs : DEFAULT_VERIFIER_TIMEOUT_MS,
			verifierTools: Array.isArray(state.verifierTools) ? state.verifierTools : [...DEFAULT_VERIFIER_TOOLS],
			timer: null,
			controller: new AbortController(),
			rearmedThisTurn: false,
			verifierInFlight: false,
		};
		activeGoals.set(goal.goalId, goal);

		if (goal.gstatus === "verifying-independent") {
			// Retoma la verificación independiente perdida: relanza el subagente (sin timer;
			// el veredicto asíncrono maneja la próxima transición). Lanzamiento único;
			// verifierInFlight protege.
			void beginIndependentVerification(pi, ctx, goal);
			continue;
		}

		const remaining = goal.nextFireAt === null ? 0 : Math.max(0, goal.nextFireAt - Date.now());
		// Un solo tick de puesta al día (clampeado a >= 0); nunca una ráfaga.
		goal.timer = setTimeout(() => fireGoal(pi, ctx, goal), remaining);
	}
	refreshGoalStatus(ctx);
}
