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
 *   (delaySeconds); el loop no tiene noción de "terminado".
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
 *   devolución (necesita a un humano). Nunca es un loop infinito.
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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseGoalCommandIntent } from "./command-intent.js";
import { MAX_VERIFY_ATTEMPTS, MAX_WAIT_SECONDS, MIN_WAIT_SECONDS, SAFETY_NET_DELAY_SECONDS } from "./constants.js";
import {
	activeGoal,
	activeGoals,
	advanceGoal,
	beginIndependentVerification,
	contextBudgetExceeded,
	normalizeWaitSeconds,
	rehydrate,
	resolveGoal,
	scheduleGoal,
	startGoal,
	stopGoal,
} from "./engine.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { clearGoalStatus } from "./status.js";
import { formatEta } from "./time.js";
import type { GoalAssessment, GoalState } from "./types.js";

type GoalArgumentCompletion = { value: string; label: string; description: string };

const STATIC_GOAL_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
	{ value: "stop", label: "stop", description: "Detener un goal activo" },
	{ value: "status", label: "status", description: "Mostrar el estado del goal" },
	{ value: "--ultracode", label: "--ultracode", description: "Perseguir el goal vía dynamic workflows" },
];

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
			"Confirmar `done` desde el turno de verificación NO cierra el goal: después, un verificador INDEPENDIENTE (un subagente aparte, escéptico y con acceso de solo lectura) juzga el objetivo contra los criterios usando tu evidencia registrada. Cierra solo si ese verificador independiente devuelve PASS. Por eso dejá evidencia durable e inspeccionable (archivos commiteados, tests que pasan, artifacts) — no solo afirmaciones en tu assessment — porque un tercero tiene que poder confirmar cada criterio sin confiar en vos.",
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
		},
	});

	pi.registerCommand("goal", {
		description:
			"Perseguí un objetivo hasta que quede verificado como terminado: /goal [--ultracode] <objective> [-- <criteria>] | /goal stop [id] | /goal status [id]",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items: GoalArgumentCompletion[] = [...STATIC_GOAL_ARGUMENT_COMPLETIONS];
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
