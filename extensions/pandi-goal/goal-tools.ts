import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_WAIT_SECONDS, MIN_WAIT_SECONDS } from "./constants.js";
import { handleGoalProgress } from "./progress-handler.js";

const GOAL_PROGRESS_PROMPT_GUIDELINES = [
	"Antes de declarar `done`, confrontá CADA criterio de éxito con evidencia concreta y verificable (un comando que corriste, un test que pasó, un archivo que existe). Nunca declares `done` por intuición.",
	"Después de un primer `done`, vas a recibir un turno de VERIFICACIÓN: revisá tu propio trabajo de forma adversarial. Confirmá `done` solo si la evidencia respalda cada criterio; si no, devolvé `continue` con el nextStep que falta.",
	"Confirmar `done` desde el turno de verificación NO cierra el goal: después, un verificador INDEPENDIENTE (un subagente aparte, escéptico y con acceso de solo lectura) juzga el objetivo contra los criterios usando tu evidencia registrada. Cierra solo si ese verificador independiente devuelve PASS. Por eso dejá evidencia durable e inspeccionable (archivos commiteados, tests que pasan, artifacts) — no solo afirmaciones en tu assessment — porque un tercero tiene que poder confirmar cada criterio sin confiar en vos.",
	"Si el verificador independiente devuelve FAIL, vas a recibir una iteración `continue` con sus hallazgos como nextStep; arreglá exactamente lo que marcó antes de volver a declarar done. FAILs independientes repetidos van a bloquear el goal para un humano.",
	"`continue` requiere un `nextStep` accionable. Si no hay próximo paso, estás `done` o `blocked`.",
	"`blocked` es para lo que ninguna cantidad de iteraciones propias puede resolver (una decisión humana, una credencial o un acceso). Explicá el `blocker` en una oración.",
	"`waitSeconds` solo cuando estás esperando una señal externa real (un deploy, un job). Por default NO esperes — la próxima iteración se dispara de inmediato.",
	"`assessment` siempre es obligatorio: una o dos oraciones sobre dónde estás parado respecto de los criterios. Queda registrado en el progress log y se reinyecta para dar continuidad.",
];

export function registerGoalProgressTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "goal_progress",
		label: "Progreso del goal",
		description:
			"Reporta el progreso del /goal activo después de autoevaluar contra sus criterios de éxito. Es la ÚNICA forma de avanzar, terminar o bloquear un goal.",
		promptSnippet:
			"Reportá el progreso del /goal: autoevaluá contra los criterios de éxito y decidí continue/done/blocked.",
		promptGuidelines: GOAL_PROGRESS_PROMPT_GUIDELINES,
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
}
