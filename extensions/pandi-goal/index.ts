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
 * - `/goal` persiste un OBJETIVO con CRITERIOS; el modelo elige QUÉ ESTADO reportar
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildGoalArgumentCompletions, handleGoalCommand } from "./command-handler.js";
import { MAX_WAIT_SECONDS, MIN_WAIT_SECONDS } from "./constants.js";
import { activeGoals, rehydrate } from "./engine.js";
import { handleAgentEnd, handleSessionShutdown } from "./lifecycle.js";
import { handleGoalProgress } from "./progress-handler.js";

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
			return await handleGoalProgress(pi, ctx, params);
		},
	});

	pi.registerCommand("goal", {
		description:
			"Perseguí un objetivo hasta que quede verificado como terminado: /goal [--ultracode] <objective> [-- <criteria>] | /goal stop [id] | /goal status [id]",
		getArgumentCompletions: (argumentPrefix: string) =>
			buildGoalArgumentCompletions(activeGoals.values(), argumentPrefix),
		handler: async (args, ctx) => await handleGoalCommand(pi, args, ctx),
	});

	pi.on("session_start", async (event, ctx) => {
		// NO migrar un goal a una sesión bifurcada: un fork hereda las entradas
		// "goal-state" del padre, pero el goal debe seguir corriendo solo en el padre.
		if (event.reason === "fork") return;
		rehydrate(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await handleSessionShutdown(pi, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await handleAgentEnd(pi, ctx);
	});
}
