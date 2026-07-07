/**
 * `/goal` estilo Claude para Pi (P0): un agente dirigido por objetivos.
 *
 * `/goal <objective>` es un agente de *persistencia dirigida*: itera hacia un
 * OBJETIVO declarado y, en cada iteración, (a) trabaja, (b) AUTOEVALÚA el avance
 * contra CRITERIOS DE ÉXITO (definición de terminado), (c) decide `continue` |
 * `done` | `blocked`. Termina cuando los criterios se cumplen Y ESTÁN VERIFICADOS
 * (no por la mera autodeclaración del modelo de "done"), cuando se bloquea
 * (necesita a un humano), o por un tope (iteraciones / presupuesto de contexto).
 *
 * Diferencia vs `/loop` (mecánicamente idéntico, semánticamente opuesto):
 * - `/loop` repite una TAREA a una cadencia; el modelo elige CUÁNDO despertar
 *   (delaySeconds); el bucle no tiene noción de "terminado".
 * - `/goal` persigue un OBJETIVO con CRITERIOS; el modelo elige QUÉ ESTADO reportar
 *   (goal_progress({status})). Su sello es el CHEQUEO DE COMPLETITUD: antes de
 *   declarar `done`, el motor fuerza una VERIFICACIÓN explícita del objetivo contra
 *   los criterios. La reinyección es inmediata (delay 0) salvo que el modelo declare
 *   que espera una señal externa (waitSeconds opcional, clampeado).
 *
 * Mecanismo (Pi no tiene programación nativa, misma inversión que /loop): el modelo
 * reporta su decisión llamando a la herramienta `goal_progress` que registramos; ESTA
 * extensión materializa la próxima iteración con setTimeout, reinyectando el prompt
 * vía pi.sendUserMessage. El goal vive en el proceso Node de la extensión.
 *
 * Alcance P0:
 * - comando: /goal <objective> [-- <criteria>], /goal stop [id], /goal status [id]
 * - herramienta: goal_progress({status, assessment, nextStep?, blocker?, waitSeconds?})
 * - motor: fireGoal / scheduleGoal / advanceGoal / startGoal / stopGoal
 * - máquina de estados: pursuing -> verifying -> done | blocked | stopped | stale
 * - chequeo de completitud: un primer `done` NO detiene; transiciona a `verifying`
 *   y reinyecta un prompt de verificación. Solo detiene un `done` confirmado DESDE
 *   `verifying`.
 * - estado: activeGoals Map + persistencia vía pi.appendEntry("goal-state", ...) +
 *   archivo auxiliar atómico
 *
 * Alcance P1 (ADITIVO — verificación adversarial independiente de "done"):
 * - El chequeo de completitud P0 es un AUTOCHEQUEO: el MISMO agente reevalúa en
 *   `verifying`. P1 eleva el `done` CONFIRMADO del modelo a un veredicto
 *   INDEPENDIENTE: cuando el modelo cerraría el goal (un `done` confirmado DESDE
 *   `verifying`), la EXTENSIÓN no se detiene. Transiciona a un nuevo estado
 *   `verifying-independent` y lanza un subagente SEPARADO y escéptico
 *   (`pi -p --no-session --no-extensions`, herramientas de SOLO LECTURA) que juzga el
 *   OBJETIVO contra los CRITERIOS usando solo la evidencia/log de progreso registrado,
 *   y emite un veredicto ANALIZABLE (`VERDICT: PASS` | `VERDICT: FAIL`). Solo un PASS
 *   independiente cierra el goal como `done`.
 * - El mecanismo de subagente espeja extensions/dynamic-workflows/index.ts runSubagent:
 *   piCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND || "pi"; args
 *   ["-p","--no-session", "--no-extensions", "--tools",<read-only>, model?, prompt];
 *   pi.exec(cmd,args,{cwd,timeout, signal}). Corre FUERA del turno del modelo
 *   (proceso propio): NO llama a pi.sendUserMessage durante el veredicto, así que no
 *   dispara el wake ni la compuerta agent_end mientras corre.
 * - FAIL → reinyecta UNA iteración `continue` normal con la devolución del verificador
 *   como nextStep, y sube verifyAttempts. Un TOPE (maxIndependentVerifications,
 *   por defecto 2) de verificaciones independientes FALLIDAS → stopGoal("blocked") con la
 *   devolución (necesita a un humano). Nunca es un bucle infinito.
 * - Configuración (valores por defecto): verifierTools (solo lectura ["read","grep","find","ls"]),
 *   verifierTimeoutMs (120000), maxIndependentVerifications (2).
 * - la máquina de estados crece: pursuing -> verifying -> verifying-independent -> done |
 *   (continue→ pursuing) | blocked. Todas las compuertas/topes/persistencia/rehydrate
 *   de P0 quedan intactos.
 * - rehydrate en session_start (sin doble disparo; un solo tick de puesta al día)
 * - limpieza en session_shutdown (clearTimeout + abort + persist "stale")
 * - red de seguridad en agent_end
 * - línea de estado
 *
 * Reglas estrictas (espejadas de la familia /loop):
 * - compuerta print/json: solo tui/rpc puede sostener un goal; nunca reinyectar en otro modo.
 * - clampear waitSeconds a [MIN, MAX] DENTRO de execute() (no confiar en el modelo).
 * - la heurística / política de decisión vive en goal_progress promptGuidelines, no en código.
 * - sin dependencias nuevas (typebox ya está presente).
 * - valores por defecto: maxIterations = 30; corte de mejor esfuerzo de presupuesto de contexto vía
 *   ctx.getContextUsage().
 * - en "fork" NO migrar el goal.
 *
 * AUTÓNOMO: este archivo no importa desde extensions/loop/index.ts; los patrones están copiados.
 */

import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseGoalArgs, parseGoalCommandIntent } from "./command-intent.js";
import {
	DEFAULT_CONTEXT_PERCENT_CAP,
	DEFAULT_MAX_INDEPENDENT_VERIFICATIONS,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_VERIFIER_TIMEOUT_MS,
	DEFAULT_VERIFIER_TOOLS,
	GOAL_STATE_TYPE,
	MAX_VERIFY_ATTEMPTS,
	MAX_WAIT_SECONDS,
	MIN_WAIT_SECONDS,
	SAFETY_NET_DELAY_SECONDS,
} from "./constants.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { makeGoalIterationPrompt, makeGoalVerificationPrompt } from "./prompts.js";
import { collectLatestByKey } from "./session-state.js";
import { clearGoalStatus, setGoalStatus } from "./status.js";
import { formatEta } from "./time.js";
import type { ActiveGoal, GoalAssessment, GoalState, GoalStatus } from "./types.js";
import { runIndependentVerifier } from "./verifier.js";

// Fuente de verdad de "qué temporizadores viven AHORA". Map soporta varios, pero las
// herramientas P0 resuelven el único goal activo (S4).
const activeGoals = new Map<string, ActiveGoal>();

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

function normalizeWaitSeconds(raw: unknown): number {
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
function contextBudgetExceeded(ctx: ExtensionContext, goal: ActiveGoal): string | undefined {
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
function scheduleGoal(
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
function advanceGoal(
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
 * P1: el modelo CONFIRMÓ done desde `verifying`. En vez del cierre inmediato de P0,
 * corre un verificador adversarial INDEPENDIENTE (proceso separado, mirada fresca).
 * Transiciona a `verifying-independent`, lanza el subagente y después resuelve:
 *   - PASS                       → stopGoal(done) (cerrado al fin, confirmado independientemente).
 *   - FAIL (bajo el tope)        → registra la devolución del verificador como assessment de
 *                                  progreso y reinyecta UNA iteración `continue` normal con
 *                                  esa devolución como nextStep; sube independentVerifyAttempts.
 *   - FAIL (tope alcanzado)      → stopGoal(blocked) con la devolución (necesita a un humano).
 * El subagente corre FUERA del turno del modelo; esta función solo reinyecta (wake)
 * DESPUÉS del veredicto, igual que un `continue`, así que la semántica de la compuerta no cambia.
 *
 * Concurrencia: protegida por verifierInFlight para que una reentrada suelta (p. ej.
 * una confirmación duplicada) no pueda lanzar dos verificadores para el mismo goal.
 */
async function beginIndependentVerification(pi: ExtensionAPI, ctx: ExtensionContext, goal: ActiveGoal): Promise<void> {
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
			`Goal ${goal.goalId} DONE: verificado de forma independiente (un subagente aparte lo confirmó). 🐼`,
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
			`Goal ${goal.goalId} está BLOCKED: la verificación independiente siguió fallando (necesita a un humano). ${feedback}`,
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

function startGoal(pi: ExtensionAPI, ctx: ExtensionContext, args: string): ActiveGoal | undefined {
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
async function resolveGoal(
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

function stopGoal(
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
function activeGoal(): ActiveGoal | undefined {
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
function rehydrate(pi: ExtensionAPI, ctx: ExtensionContext): void {
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

// ---------------------------------------------------------------------------
// Manejo de comandos
// ---------------------------------------------------------------------------

function formatStatus(goal: GoalState): string {
	const phase =
		goal.gstatus === "verifying"
			? " (verificando)"
			: goal.gstatus === "verifying-independent"
				? " (verificación independiente)"
				: "";
	const eta =
		goal.gstatus === "pursuing" || goal.gstatus === "verifying" ? `, próximo ${formatEta(goal.nextFireAt)}` : "";
	const reason = goal.lastReason ? `, razón: ${goal.lastReason}` : "";
	return `${goal.goalId} [${goal.gstatus}]${phase} iter ${goal.iteration}/${goal.maxIterations}${eta}${reason} — ${goal.objective}`;
}

function formatGoalStatusList(goals: GoalState[]): string {
	return goals.map(formatStatus).join("\n");
}

async function handleGoalCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
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

	// Si no: todos los argumentos son el objetivo (posiblemente con criterios ` -- `).
	startGoal(pi, ctx, intent.rest);
}

// ---------------------------------------------------------------------------
// Punto de entrada de la extensión
// ---------------------------------------------------------------------------

export default function goalExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "goal_progress",
		label: "Progreso del goal",
		description:
			"Reporta el progreso del /goal activo después de autoevaluar contra sus criterios de éxito. Es la ÚNICA forma de avanzar, terminar o bloquear un goal.",
		promptSnippet:
			"Reportá el progreso del /goal: autoevaluá contra los criterios de éxito y decidí continue/done/blocked.",
		promptGuidelines: [
			"Antes de declarar `done`, confrontá CADA criterio de éxito con evidencia concreta y verificable (un comando que corriste, un test que pasó, un archivo que existe). Nunca declares `done` por intuición.",
			"Después de un primer `done`, vas a recibir un turno de VERIFICACIÓN: revisá tu propio trabajo de forma adversarial. Confirmá `done` solo si la evidencia respalda cada criterio; si no, devolvé `continue` con el nextStep que falta.",
			"Confirmar `done` desde el turno de verificación NO cierra el goal: después, un verificador INDEPENDIENTE (un subagente aparte, escéptico y con acceso de solo lectura) juzga el objetivo contra los criterios usando tu evidencia registrada. Cierra solo si ese verificador independiente devuelve PASS. Por eso dejá evidencia durable e inspeccionable (archivos commiteados, tests que pasan, artefactos) — no solo afirmaciones en tu assessment — porque un tercero tiene que poder confirmar cada criterio sin confiar en vos.",
			"Si el verificador independiente devuelve FAIL, vas a recibir una iteración `continue` con sus hallazgos como nextStep; arreglá exactamente lo que marcó antes de volver a declarar done. FAILs independientes repetidos van a bloquear el goal para un humano.",
			"`continue` requiere un `nextStep` accionable. Si no hay próximo paso, estás `done` o `blocked`.",
			"`blocked` es para lo que ninguna cantidad de iteraciones propias puede resolver (una decisión humana, una credencial o un acceso). Explicá el `blocker` en una oración.",
			"`waitSeconds` solo cuando estás esperando una señal externa real (un deploy, un job). Por default NO esperes — la próxima iteración se dispara de inmediato.",
			"`assessment` siempre es obligatorio: una o dos oraciones sobre dónde estás parado respecto de los criterios. Queda registrado en el progress log y se reinyecta para dar continuidad.",
		],
		parameters: Type.Object({
			status: Type.Union([Type.Literal("continue"), Type.Literal("done"), Type.Literal("blocked")], {
				description:
					"continue = seguí iterando; done = creés que se cumplen todos los criterios; blocked = necesitás a un humano.",
			}),
			assessment: Type.String({
				minLength: 3,
				description: "Autoevaluación contra los criterios de éxito (dónde estás parado y por qué).",
			}),
			successCriteria: Type.Optional(
				Type.String({
					description:
						"Solo cuando el goal empezó SIN criterios de éxito: indicá acá los 2 a 5 criterios concretos y verificables que derivaste (textuales). Se registran UNA VEZ como la definición de terminado — NO pongas los criterios solo en `assessment`.",
				}),
			),
			nextStep: Type.Optional(
				Type.String({
					description: "Obligatorio cuando status es 'continue': el próximo paso accionable.",
				}),
			),
			blocker: Type.Optional(
				Type.String({
					description: "Obligatorio cuando status es 'blocked': la decisión o el acceso humano necesario.",
				}),
			),
			// Sin límites de esquema en waitSeconds a propósito: el SDK rechaza args fuera de rango
			// ANTES de que execute() corra, así que min/max acá tiraría error en vez de dejarnos clampear.
			waitSeconds: Type.Optional(
				Type.Number({
					description: `Opcional: segundos a esperar antes de la próxima iteración cuando estás esperando una señal externa; se clampea a [${MIN_WAIT_SECONDS}, ${MAX_WAIT_SECONDS}]. Default 0 (inmediato).`,
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
				notify(ctx, `Goal ${goal.goalId} está BLOCKED y te necesita: ${blocker}`, "warning");
				return {
					content: [
						{
							type: "text" as const,
							text: `Goal ${goal.goalId} marcado como blocked. Se notificó a un humano.`,
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
					notify(ctx, `Goal ${goal.goalId} está BLOCKED: ${blocker}`, "warning");
					return {
						content: [
							{
								type: "text" as const,
								text: `Goal ${goal.goalId} blocked: el chequeo de completitud falló ${goal.verifyAttempts} vez(veces). Se notificó a un humano.`,
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
		},
	});

	pi.registerCommand("goal", {
		description:
			"Perseguí un objetivo hasta que quede verificado como terminado: /goal [--ultracode] <objective> [-- <criteria>] | /goal stop [id] | /goal status [id]",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items = [
				{ value: "stop", label: "stop", description: "Detener un goal activo" },
				{ value: "status", label: "status", description: "Mostrar el estado del goal" },
				{ value: "--ultracode", label: "--ultracode", description: "Perseguir el goal vía dynamic workflows" },
			];
			for (const goal of activeGoals.values()) {
				if (
					goal.gstatus === "pursuing" ||
					goal.gstatus === "verifying" ||
					goal.gstatus === "verifying-independent"
				) {
					items.push({ value: goal.goalId, label: goal.goalId, description: goal.objective });
				}
			}
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!prefix) return items;
			return items.filter((i) => i.value.toLowerCase().startsWith(prefix));
		},
		handler: async (args, ctx) => await handleGoalCommand(pi, args, ctx),
	});

	pi.on("session_start", async (event, ctx) => {
		// NO migrar un goal a una sesión bifurcada: un fork hereda las entradas
		// "goal-state" del padre, pero el goal debe seguir corriendo solo en el padre.
		if (event.reason === "fork") return;
		rehydrate(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
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
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Red de seguridad: si un goal sigue activo y el turno cerró sin que el modelo llame
		// a goal_progress (sin rearmar) y sin timer vivo, rearmar defensivamente para que el
		// goal no muera en silencio.
		for (const goal of activeGoals.values()) {
			// Solo los goals `pursuing`/`verifying` participan en la red de seguridad. Un goal
			// `verifying-independent` queda EXCLUIDO deliberadamente: su verificador corre en un
			// proceso separado FUERA del turno del modelo y resuelve por sí mismo la próxima
			// transición (done / continue / blocked). Rearmarlo acá competiría con el veredicto
			// en vuelo.
			if (goal.gstatus !== "pursuing" && goal.gstatus !== "verifying") continue;

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
	});
}
