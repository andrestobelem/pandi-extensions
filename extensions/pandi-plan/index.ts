/**
 * `/plan` de estilo Claude ("modo plan") para Pi (P0).
 *
 * El modo plan pone el agente PRINCIPAL en una postura de planificación DE SOLO LECTURA. Mientras está activo,
 * el agente PUEDE INVESTIGAR (read/grep/find/ls + bash de solo lectura) y PRODUCIR un plan,
 * pero NO PUEDE mutar el workspace. El entregable es un artefacto PLAN, presentado
 * para aprobación EXPLÍCITA del usuario, y solo si se aprueba el agente SALE del modo e
 * IMPLEMENTA.
 *
 * Las tres cosas que lo hacen modo plan (no "un prompt que dice porfa planifica"):
 *   1. El GATE de solo lectura — un manejador pi.on("tool_call") HARD-BLOQUEA tools mutantes
 *      mientras el modo está activo. Impuesto, no asesor.
 *   2. El plan como un ARTEFACTO — el modelo emite el plan a través de una tool registrada
 *      (submit_plan), exactamente como /loop emite vía loop_schedule y /goal vía
 *      goal_progress. El texto del plan es el payload.
 *   3. Aprobación antes de cualquier mutación — submit_plan presenta el plan en un
 *      OVERLAY de aprobación scrollable, renderizado Markdown (de estilo mdview; ver approval-view.ts),
 *      degrada a ctx.ui.confirm cuando un componente personalizado no se puede mostrar (≈ ExitPlanMode de Claude).
 *      Por defecto exige una elección humana explícita; con el toggle humano auto-submit, 60s sin elección aprueban.
 *      Aprueba → levanta el gate, reinyecta "implementa esto". Rechaza → sigue
 *      gateado, devuelve el rechazo al modelo.
 *
 * Dos formas EN, una forma de mutar:
 *   - HUMANO:  /plan <task>                  (el comando slash)
 *   - MODELO:  enter_plan_mode({ task })     (una tool llamable por el modelo, así que Pi puede decidir POR SU CUENTA
 *                                            planificar un cambio riesgoso/multi-paso — "cuando
 *                                            le parezca"). Mismo estado armado/persistido; la
 *                                            única diferencia es el delivery de la
 *                                            instrucción de planificación (comando despierta un user message; la
 *                                            tool lo devuelve como su propio resultado). El modelo puede
 *                                            ENTRAR pero nunca APROBAR — la aprobación sigue siendo humana.
 *
 * Flujo:
 *   /plan <task>   (o modelo: enter_plan_mode({ task }))
 *     → guardia de modo (print/json → notify + rechaza)
 *     → activa plan-mode (en-memoria + persistido) vía createAndArmPlan
 *     → arma GATE de solo lectura (tool_call handler bloquea mutaciones)
 *     → entrega la instrucción de planificación (comando: inyecta user message; tool: lo devuelve como
 *       resultado de la tool) — investiga de solo lectura, luego submit_plan
 *          ↓ (modelo investiga con tools de solo lectura; mutaciones bloqueadas)
 *     modelo llama submit_plan({ plan })
 *     → presenta el plan para aprobación (overlay Markdown, o fallback ctx.ui.confirm; auto-submit opt-in)
 *          ├─ APPROVE → desactiva, levanta gate, persiste,
 *          │            despierta "Plan aprobado. Implementa ahora:\n<plan>"
 *          └─ REJECT  → sigue en plan-mode, devuelve al modelo para revisar + reenviar
 *
 * /plan status y /plan exit|cancel son controles out-of-band (aborta sin implementar).
 *
 * Mecánicamente la familia loop/goal INVERTIDA: loop elige CUÁNDO despertar, goal elige QUÉ
 * STATE reportar, plan SUPRIME mutación hasta que un plan aprobado cambia el agente de
 * planificación a acción. El plumbing wake/persist/rehydrate/status es la misma familia; las
 * nuevas partes son el GATE + el handshake de aprobación.
 *
 * Reglas duras:
 * - gate print/json: ctx.mode debe ser tui/rpc; print/json → notify + rechaza entrar
 *   (modo plan necesita una aprobación interactiva; print es one-shot y no puede entregarla).
 * - nunca reinyectes fuera de tui/rpc.
 * - deps: typebox + @earendil-works/pi-tui (el overlay de aprobación renderiza Markdown, como pandi-mdview).
 * - en "fork" NO migres el plan-mode.
 * - el allowlist de solo lectura es BEST-EFFORT y está documentado (ver blockedReason).
 *
 * AUTÓNOMO: este archivo no importa de extensions/loop/index.ts o extensions/goal/index.ts;
 * patrones (notify, persist vía appendEntry, rehydrate, línea de estado, wake) se copian.
 */

import * as crypto from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parsePlanCommandIntent } from "./command-intent.js";
import { buildPlanDashboardMarkdown, renderPlanDashboardOverlay } from "./dashboard.js";
import {
	getSessionFlagDefault,
	parsePlanCommandFlags,
	resetSessionFlagDefaults,
	resolvePlanFlags,
	setSessionFlagDefault,
} from "./flags.js";
import { blockedReason } from "./gate.js";
import { markPlanExited } from "./lifecycle.js";
import { notify } from "./notify.js";
import type { PlanFlags } from "./posture.js";
import { forceInteractiveApprovalPosture } from "./posture.js";
import { makePlanningPrompt } from "./prompts.js";
import { findActivePlan, findLastPlan, hasActivePlan, overlayRuntimePlans, restoreActivePlans } from "./registry.js";
import { collectLatestByKey } from "./session-state.js";
import type { PlanState } from "./state.js";
import { clearPlanStatus, formatStatus, setPlanStatus } from "./status.js";
import { createSubmitPlanExecute } from "./submit-plan-handler.js";

export type { PlanState, PlanStatus } from "./state.js";

const PLAN_STATE_TYPE = "plan-state";

// Fuente de verdad de "¿está el modo plan activo AHORA?" en este proceso. Un Map para paridad con
// la familia loop/goal, pero /plan es single-session: a lo más un plan activo al tiempo.
const activePlans = new Map<string, PlanState>();

export interface PlanModeGuard {
	isActive(): boolean;
}

export const PLAN_MODE_GUARD_SYMBOL = Symbol.for("pandi-plan.plan-mode.guard");

// ---------------------------------------------------------------------------
// Ayudantes de plan activo
// ---------------------------------------------------------------------------

/** ¿Está el gate de solo lectura armado (algún plan actualmente activo)? */
function planModeActive(): boolean {
	return hasActivePlan(activePlans.values());
}

export function isPlanModeActive(): boolean {
	return planModeActive();
}

const previousPlanModeGuard = (globalThis as Record<symbol, PlanModeGuard | undefined>)[PLAN_MODE_GUARD_SYMBOL];
export const PLAN_MODE_GUARD: PlanModeGuard = {
	isActive: () => {
		if (isPlanModeActive()) return true;
		try {
			return previousPlanModeGuard?.isActive() === true;
		} catch {
			return false;
		}
	},
};
(globalThis as Record<symbol, PlanModeGuard | undefined>)[PLAN_MODE_GUARD_SYMBOL] = PLAN_MODE_GUARD;

/** El único plan actualmente activo (gate armado), o undefined. */
function currentPlan(): PlanState | undefined {
	return findActivePlan(activePlans.values());
}

// ---------------------------------------------------------------------------
// Prompts — ver ./prompts.ts (makePlanningPrompt; makeImplementPrompt vive en submit-plan-handler).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Línea de estado — ver ./status.ts (setPlanStatus / clearPlanStatus / formatStatus).
// ---------------------------------------------------------------------------

/** Refresca el estado desde el plan activo (si existe). */
function refreshPlanStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const plan = currentPlan();
	if (plan) setPlanStatus(ctx, plan);
	else clearPlanStatus(ctx);
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

/**
 * Persiste una transición de plan. Marca updatedAt y agrega al JSONL de la sesión (NO
 * va al LLM). Refleja la persistencia appendEntry de la familia loop/goal. Sin sidecar: un
 * plan es short-lived y vive solo dentro de una sesión interactiva, así que la entrada JSONL
 * (reproducida por rehydrate en session_start) es suficiente.
 */
function persist(pi: ExtensionAPI, plan: PlanState): void {
	plan.updatedAt = new Date().toISOString();
	pi.appendEntry<PlanState>(PLAN_STATE_TYPE, { ...plan });
}

// ---------------------------------------------------------------------------
// Gate de modo (print/json)
// ---------------------------------------------------------------------------

/**
 * ¿Puede esta sesión ejecutar el handshake de aprobación INTERACTIVO (ctx.ui.confirm) y el wake
 * reinyección? Solo TUI y RPC pueden: "print" es one-shot y "json" es no-interactivo
 * (hasUI es true solo en tui/rpc). Gatean la ruta de aprobación y el wake. Refleja canLoopInMode.
 */
function canApproveInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

/**
 * ¿Se puede ENTRAR al modo plan acá? Las sesiones interactivas siempre pueden. Una sesión no-interactiva
 * (print/json — p. ej. un subagente dynamic-workflow) puede SOLO entrar cuando la bandera nonInteractive
 * (solo plan) se setea: produce un plan como su entregable y nunca implementa, así que la
 * ausencia de un handshake de aprobación es por diseño (el gate de solo lectura nunca se levanta ahí).
 */
function canEnterPlanMode(ctx: ExtensionContext, flags: PlanFlags): boolean {
	if (canApproveInMode(ctx)) return true;
	return (ctx.mode === "print" || ctx.mode === "json") && flags.nonInteractive === true;
}

// ---------------------------------------------------------------------------
// Banderas de plan — ver ./flags.ts (envFlag, resolvePlanFlags, parse* + el
// singleton toggle de defecto de sesión accedido vía get/setSessionFlagDefault).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wake (reinyecta mensaje de implementación después de aprobación)
// ---------------------------------------------------------------------------

/**
 * Reinyecta el prompt de implementación después de aprobación, reflejando loop/goal wake:
 * idle → steer (sendUserMessage), busy → followUp. Mode-gated así que nunca dispara fuera
 * de tui/rpc (defiende rutas rehydrate también).
 */
function wake(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (!canApproveInMode(ctx)) return;
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

// ---------------------------------------------------------------------------
// El GATE de solo lectura — ver ./gate.ts (política pura: blockedReason / isMutatingBash).
// ---------------------------------------------------------------------------

/**
 * Manejador de tool_call. Gatean SOLO mientras el modo plan está activo (invierte "solo en
 * turnos autopilot" de loop), y bloquea DURO en lugar de confirmar (en modo plan lo correcto
 * es bloquear duro — sin mutación hasta que un plan aprobado levante el gate).
 */
async function handleToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
	if (!planModeActive()) return undefined;
	const reason = blockedReason(event);
	if (!reason) return undefined;
	return { block: true, reason };
}

// ---------------------------------------------------------------------------
// Inicio / salida
// ---------------------------------------------------------------------------

/**
 * Crea un plan fresco y ARMA el gate de solo lectura (active=true), lo persiste, y enciende la
 * línea de estado. Puro de cualquier decisión DELIVERY: NO inyecta la instrucción de planificación —
 * el llamador elige cómo el modelo la recibe. El COMANDO /plan despierta un user message; la
 * TOOL enter_plan_mode llamable por modelo devuelve la instrucción como su propio tool result (así que el
 * modelo sigue planificando en el MISMO turno sin un segundo mensaje inyectado). Asume que
 * el llamador ya pasó las guardias (canPlanInMode, task no vacía, sin plan ya activo).
 */
function createAndArmPlan(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	flags: Required<PlanFlags>,
): PlanState {
	const planId = crypto.randomBytes(4).toString("hex");
	const plan: PlanState = {
		planId,
		task,
		active: true,
		status: "planning",
		submissions: 0,
		rejections: 0,
		nonInteractive: flags.nonInteractive,
		ultracode: flags.ultracode,
		ultracodeSteps: flags.ultracodeSteps,
		autoSubmit: flags.nonInteractive ? false : flags.autoSubmit,
		startedAt: Date.now(),
		updatedAt: new Date().toISOString(),
	};
	activePlans.set(planId, plan);
	persist(pi, plan);
	setPlanStatus(ctx, plan);
	return plan;
}

function startPlan(pi: ExtensionAPI, ctx: ExtensionContext, task: string): PlanState | undefined {
	const { task: cleanedTask, flags: commandFlags } = parsePlanCommandFlags(task);
	// La ruta del comando es solo interactiva: la entrada no-interactiva (solo plan) es
	// trabajo de la tool enter_plan_mode, así que resuelve flags SIN no-interactiva acá.
	const flags = resolvePlanFlags({ ...commandFlags, nonInteractive: false });
	// Gate de modo (REGLA DURA): el comando /plan necesita una aprobación interactiva; print/json
	// no puede entregarla. Rechaza entrar.
	if (!canApproveInMode(ctx)) {
		notify(
			ctx,
			"/plan requiere una sesión TUI o RPC (este modo no puede ejecutar el protocolo de aprobación).",
			"error",
		);
		return undefined;
	}
	const trimmed = cleanedTask.trim();
	if (!trimmed) {
		notify(ctx, "Uso: /plan [--ultracode] [--ultracode-steps] <task>", "warning");
		return undefined;
	}
	if (planModeActive()) {
		notify(ctx, "El modo plan ya está activo. Usá /plan status, o /plan exit para salir.", "warning");
		return currentPlan();
	}

	const plan = createAndArmPlan(pi, ctx, trimmed, flags);
	// Ruta del comando: inyecta la instrucción de planificación como user message (investiga de solo lectura,
	// luego submit_plan cuando esté listo), porque el comando se ejecuta out-of-band del turno del modelo.
	wake(pi, ctx, makePlanningPrompt(plan));
	notify(
		ctx,
		`Entraste en modo plan (${plan.planId}). Solo lectura hasta que apruebes un plan. Tarea: ${trimmed}`,
		"info",
	);
	return plan;
}

/**
 * Sale del modo plan SIN implementar: levanta el gate (active=false) y persiste un
 * estado terminal. Usado por /plan exit|cancel. Un no-op (false) si no hay plan activo.
 */
function exitPlan(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): boolean {
	const plan = currentPlan();
	if (!plan) return false;
	markPlanExited(plan);
	persist(pi, plan);
	refreshPlanStatus(ctx);
	notify(ctx, `Saliste del modo plan (${plan.planId}): ${reason}. No se inició ninguna implementación.`, "info");
	return true;
}

// ---------------------------------------------------------------------------
// Rehidratación (session_start)
// ---------------------------------------------------------------------------

/**
 * Reconstruye el estado del plan desde entradas persistidas (last-wins por planId). Re-arma el
 * GATE de solo lectura para cualquier plan que estuviera aún activo cuando la sesión terminó (así que un reload
 * mid-planning mantiene el gate arriba). Evita double-registration: si activePlans ya tiene el plan en
 * este proceso, salta. NO reinyecta el prompt de planificación — la conversación ya lo
 * lleva; solo restauramos el flag gate en-memoria + línea de estado.
 */
function rehydrate(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getEntries();
	const latest = collectLatestByKey<PlanState>(entries, PLAN_STATE_TYPE, (d) => d.planId);

	restoreActivePlans(activePlans, latest.values());
	refreshPlanStatus(ctx);
}

// ---------------------------------------------------------------------------
// Manejo de comandos
// ---------------------------------------------------------------------------

/**
 * Junta cada plan en esta sesión para el dashboard: el snapshot persistido más reciente por
 * planId (historial) con los planes en-memoria superpuestos arriba (más actual — llevan los
 * conteos/lastPlan más frescos antes del siguiente persist). Lectura pura; sin mutación.
 */
function collectAllPlans(ctx: ExtensionContext): PlanState[] {
	const latest = collectLatestByKey<PlanState>(ctx.sessionManager.getEntries(), PLAN_STATE_TYPE, (d) => d.planId);
	return overlayRuntimePlans(latest, activePlans.values());
}

/**
 * Abre el dashboard de seguimiento de modo plan. En un TUI muestra un overlay scrollable renderizado
 * desde el reporte Markdown; en modos no-interactivos imprime el reporte. El overlay
 * mismo vive en dashboard.ts (`renderPlanDashboardOverlay`).
 */
async function openPlanDashboard(ctx: ExtensionContext): Promise<void> {
	const markdown = buildPlanDashboardMarkdown(collectAllPlans(ctx));
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		console.log(markdown);
		return;
	}
	await renderPlanDashboardOverlay(ctx, markdown);
}

async function handlePlanCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const intent = parsePlanCommandIntent(args);

	if (intent.kind === "status") {
		const plan = currentPlan() ?? findLastPlan(activePlans.values());
		notify(ctx, plan ? formatStatus(plan) : "El modo plan no está activo.", "info");
		return;
	}
	if (intent.kind === "dashboard") {
		await openPlanDashboard(ctx);
		return;
	}
	if (intent.kind === "invalid-toggle") {
		notify(ctx, `Uso: /plan ${intent.label} [on|off|status]`, "warning");
		return;
	}
	if (intent.kind === "toggle") {
		if (intent.action === "on") setSessionFlagDefault(intent.key, true);
		else if (intent.action === "off") setSessionFlagDefault(intent.key, false);
		const current = getSessionFlagDefault(intent.key);
		const state = current === undefined ? "sin definir (lo decide env/param)" : current ? "on" : "off";
		notify(ctx, `/plan ${intent.label} valor por defecto de sesión: ${state}.`, "info");
		return;
	}
	if (intent.kind === "exit") {
		if (!exitPlan(pi, ctx, intent.reason)) {
			notify(ctx, "El modo plan no está activo; no hay nada de qué salir.", "warning");
		}
		return;
	}

	startPlan(pi, ctx, intent.task);
}

// ---------------------------------------------------------------------------
// Punto de entrada de la extensión
// ---------------------------------------------------------------------------

export default function planExtension(pi: ExtensionAPI): void {
	// La tool de artefacto del plan (≈ ExitPlanMode). La ÚNICA forma de presentar un plan + salir del modo.
	pi.registerTool({
		name: "submit_plan",
		label: "Enviar plan",
		description:
			"Presentale al usuario tu plan de implementación terminado para que lo apruebe (≈ ExitPlanMode). Es la ÚNICA forma de terminar el modo plan. Si se aprueba, salís del modo plan e implementás; si se rechaza, seguís en modo plan y revisás.",
		promptSnippet: "Enviále al usuario tu plan de implementación de /plan para que lo apruebe.",
		promptGuidelines: [
			"Investigá PRIMERO con tools de solo lectura. No podés editar/escribir ni correr comandos de shell mutantes mientras planificás — están bloqueados de forma dura.",
			"Cuando el plan esté completo y autocontenido, llamá a submit_plan con el plan COMPLETO en Markdown. No empieces a implementar: la implementación ocurre solo después de que el usuario apruebe.",
			"Si el plan se rechaza, vas a recibir el rechazo de vuelta; revisá el plan para atender el feedback y volvé a llamar a submit_plan.",
		],
		parameters: Type.Object({
			plan: Type.String({
				minLength: 1,
				description:
					"El plan de implementación completo en Markdown, listo para presentarle al usuario para su aprobación.",
			}),
		}),
		executionMode: "sequential",
		execute: createSubmitPlanExecute({
			pi,
			currentPlan,
			persist,
			refreshPlanStatus,
			wake,
		}),
	});

	// Entrada AUTÓNOMA llamable por modelo al modo plan (≈ Claude solicitando el modo plan mismo).
	// Esta es la affordance que deja que Pi decida POR SU CUENTA planificar antes de mutar — el gate,
	// el handshake de aprobación y semántica de salida no cambian; solo la ENTRADA es nueva. Reutiliza
	// createAndArmPlan (el estado exacto armado/persistido que produce el comando /plan) y
	// devuelve la instrucción de planificación como su PROPIO RESULTADO así que el modelo sigue planificando en el
	// mismo turno (sin wake / segundo user message). Puede ENTRAR pero nunca APROBAR: el humano aún
	// aprueba vía submit_plan + ctx.ui.confirm.
	pi.registerTool({
		name: "enter_plan_mode",
		label: "Entrar en modo plan",
		description:
			"Entrá vos mismo en modo plan de solo lectura antes de implementar un cambio no trivial, de varios pasos, o riesgoso. Arma un gate de solo lectura (write/edit y los comandos de shell mutantes quedan bloqueados de forma dura) para que investigues en solo lectura y redactes un plan, y después lo presentes vía submit_plan para la aprobación explícita del usuario antes de cualquier edición. Necesita una sesión TUI/RPC.",
		promptSnippet: "Entrá en modo plan de solo lectura para investigar y presentar un plan antes de implementar.",
		promptGuidelines: [
			"Usá enter_plan_mode por tu propia iniciativa cuando el pedido del usuario sea no trivial, de varios pasos, ambiguo, destructivo, o de alcance amplio (refactors, migraciones, cambios de schema/arquitectura, cualquier cosa que toque muchos archivos) y todavía NO haya aprobado un enfoque concreto — arma un gate de solo lectura para que investigues de forma segura, y después llamás a submit_plan para la aprobación explícita antes de cualquier edición.",
			"NO uses enter_plan_mode para trabajo trivial, de un solo paso, de solo lectura, o ya aprobado, para responder preguntas, o cuando un plan, /goal, o /loop ya está conduciendo el turno — hacé eso directamente.",
			"enter_plan_mode necesita una aprobación interactiva, así que solo tiene efecto en una sesión TUI o RPC; si reporta que no pudo entrar (modo no interactivo) o que el modo plan ya está activo, NO reintentes — seguí con la tarea (o, si ya estás planificando, seguí investigando en solo lectura y llamá a submit_plan).",
			"Después de enter_plan_mode quedás en SOLO LECTURA: write/edit y los comandos de shell mutantes quedan bloqueados de forma dura hasta que el usuario apruebe tu plan, así que terminá de investigar y después llamá a submit_plan — la implementación ocurre solo después de la aprobación.",
			"Tu plan PUEDE incluir correr dynamic workflows (dynamic_workflow action=run/start) como pasos de implementación posteriores a la aprobación para trabajo amplio, paralelo, o de alta confianza (auditorías grandes, migraciones, barridos exhaustivos, verificación independiente, investigación profunda); mientras planificás podés inspeccionar el catálogo en solo lectura (dynamic_workflow action=list/scaffold/read) para elegir o diseñar el indicado y describirlo en el plan.",
		],
		parameters: Type.Object({
			task: Type.String({
				minLength: 1,
				description:
					"La tarea que pensás planificar antes de implementar (lo que vas a investigar y para lo que vas a escribir un plan).",
			}),
			nonInteractive: Type.Optional(
				Type.Boolean({
					description:
						"Solo plan: entrá incluso en una sesión no interactiva (print/json), p. ej. un subagente de dynamic-workflow. No hay aprobación ni implementación; el plan es el entregable y el gate de solo lectura nunca se levanta. Por defecto toma el valor de PI_PLAN_NONINTERACTIVE.",
				}),
			),
			ultracode: Type.Optional(
				Type.Boolean({
					description:
						"Decile al planificador que investigue/diseñe el plan usando dynamic workflows (ultracode). Por defecto toma el valor de PI_PLAN_ULTRACODE.",
				}),
			),
			ultracodeSteps: Type.Optional(
				Type.Boolean({
					description:
						"Decile al planificador/implementador que ejecute los PASOS del plan vía dynamic workflows cuando se justifique. Por defecto toma el valor de PI_PLAN_ULTRACODE_STEPS.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolvedFlags = resolvePlanFlags(params);
			// CONSISTENCIA: nonInteractive (plan-only) solo tiene sentido donde la aprobación NO puede correr.
			// En tui/rpc el protocolo de aprobación humana sí está disponible, así que acá se fuerza a false:
			// de otro modo, un param colgado o un PI_PLAN_NONINTERACTIVE exportado saltearía la aprobación
			// en silencio y nunca implementaría. Así plan-only queda confinado a print/json (p. ej. subagentes de workflow).
			const flags = canApproveInMode(ctx) ? forceInteractiveApprovalPosture(resolvedFlags) : resolvedFlags;
			// Gate de modo (REGLA DURA): las sesiones interactivas siempre pueden entrar. Una sesión no interactiva
			// (print/json) puede entrar SOLO en modo plan-only (nonInteractive): ahí el plan es el
			// entregable y no se aprueba ni se implementa nada, así que no hace falta handshake.
			if (!canEnterPlanMode(ctx, flags)) {
				notify(
					ctx,
					"No se puede entrar en modo plan acá: esta sesión no es interactiva. Pasá nonInteractive (o seteá PI_PLAN_NONINTERACTIVE) para una sesión solo-plan, o seguí sin modo plan.",
					"warning",
				);
				return {
					content: [
						{
							type: "text" as const,
							text: "El modo plan requiere una sesión TUI o RPC para ejecutar el protocolo de aprobación. Para una sesión no interactiva, pasá nonInteractive:true (solo plan: produce un plan, sin implementación) o seteá PI_PLAN_NONINTERACTIVE=1. Si no, no entres en modo plan; seguí con la tarea normalmente.",
						},
					],
					details: { entered: false, reason: "mode" },
				};
			}
			const trimmed = params.task.trim();
			if (!trimmed) {
				return {
					content: [
						{
							type: "text" as const,
							text: "enter_plan_mode requiere una task no vacía que describa qué planificar.",
						},
					],
					details: { isError: true, entered: false, reason: "empty-task" },
				};
			}
			// No-op idempotente cuando un plan ya está activo (invariante single-plan): NO CREES un
			// segundo plan; reporta el actual para que el modelo siga planificando en vez de re-entrar.
			if (planModeActive()) {
				const current = currentPlan();
				return {
					content: [
						{
							type: "text" as const,
							text: `El modo plan ya está activo${current ? ` (${current.planId})` : ""}. Seguí investigando en solo lectura, y llamá a submit_plan cuando tu plan esté listo.`,
						},
					],
					details: { entered: false, reason: "already-active", planId: current?.planId },
				};
			}

			const plan = createAndArmPlan(pi, ctx, trimmed, flags);
			notify(
				ctx,
				plan.nonInteractive
					? `Pi entró en modo plan (${plan.planId}, solo plan). Solo lectura; el plan es el entregable. Tarea: ${trimmed}`
					: `Pi entró en modo plan (${plan.planId}). Solo lectura hasta que apruebes un plan. Tarea: ${trimmed}`,
				"info",
			);
			// Ruta de tool: devuelve la instrucción de planificación como resultado de ESTA tool (sin wake), así que el
			// modelo la lee inmediatamente y sigue planificando de solo lectura en el mismo turno.
			return {
				content: [{ type: "text" as const, text: makePlanningPrompt(plan) }],
				details: { entered: true, planId: plan.planId, status: "planning" },
			};
		},
	});

	pi.registerCommand("plan", {
		description:
			"Entrá en modo plan de solo lectura: /plan [--ultracode] [--ultracode-steps] [--auto-submit] <task> — investigá en solo lectura, escribí un plan, envialo para aprobación, y después implementá. /plan status | /plan dashboard | /plan exit | /plan cancel.",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "Mostrar el estado del modo plan" },
				{ value: "dashboard", label: "dashboard", description: "Abrir el tablero de seguimiento del modo plan" },
				{ value: "--ultracode", label: "--ultracode", description: "Planificar usando dynamic workflows" },
				{
					value: "--ultracode-steps",
					label: "--ultracode-steps",
					description: "Ejecutar los pasos del plan vía dynamic workflows",
				},
				{
					value: "--auto-submit",
					label: "--auto-submit",
					description: "Aprobar automáticamente el plan tras 60s sin elección",
				},
				{
					value: "ultracode",
					label: "ultracode",
					description: "Alternar el valor por defecto de sesión: on|off|status",
				},
				{
					value: "steps-ultracode",
					label: "steps-ultracode",
					description: "Alternar el valor por defecto de sesión de pasos-vía-workflows: on|off|status",
				},
				{
					value: "auto-submit",
					label: "auto-submit",
					description: "Alternar auto-aprobación tras 60s sin elección: on|off|status",
				},
				{ value: "exit", label: "exit", description: "Salir del modo plan sin implementar" },
				{ value: "cancel", label: "cancel", description: "Salir del modo plan sin implementar" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!prefix) return items;
			return items.filter((i) => i.value.toLowerCase().startsWith(prefix));
		},
		handler: async (args, ctx) => await handlePlanCommand(pi, args, ctx),
	});

	// El GATE de solo lectura: bloquea duro las tools mutantes mientras el modo plan está activo.
	pi.on("tool_call", async (event, _ctx) => await handleToolCall(event));

	pi.on("session_start", async (event, ctx) => {
		// Las fronteras de sesión no deben heredar estado de plan en-memoria de otra sesión.
		activePlans.clear();
		resetSessionFlagDefaults();
		// NO migres el modo plan a una sesión forked: un fork hereda las entradas
		// "plan-state" del padre, pero el modo plan debe seguir corriendo solo en el padre.
		if (event.reason === "fork") return;
		rehydrate(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Persiste el plan activo verbatim (active=true) así que un reload re-arma el gate; no
		// cambies su status. Los planes terminales ya están persistidos.
		const plan = currentPlan();
		if (plan) persist(pi, plan);
		clearPlanStatus(ctx);
	});
}
