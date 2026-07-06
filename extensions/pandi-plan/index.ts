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
 *   3. Aprobación EXPLÍCITA antes de cualquier mutación — submit_plan presenta el plan en un
 *      OVERLAY de aprobación scrollable, renderizado Markdown (de estilo mdview; ver approval-view.ts),
 *      degrada a ctx.ui.confirm cuando un componente personalizado no se puede mostrar (≈ ExitPlanMode de Claude).
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
 *     → presenta el plan para aprobación (overlay Markdown, o fallback ctx.ui.confirm)
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
import { renderPlanApprovalOverlay } from "./approval-view.js";
import { buildPlanDashboardMarkdown, renderPlanDashboardOverlay } from "./dashboard.js";
import {
	getSessionFlagDefault,
	parsePlanCommandFlags,
	parsePlanToggleValue,
	resetSessionFlagDefaults,
	resolvePlanFlags,
	setSessionFlagDefault,
} from "./flags.js";
import { blockedReason } from "./gate.js";
import { notify } from "./notify.js";
import { writeAndOpenPlanHtmlArtifact } from "./plan-html.js";
import { makeImplementPrompt, makePlanningPrompt, type PlanFlags } from "./prompts.js";
import { collectLatestByKey } from "./session-state.js";
import type { PlanState } from "./state.js";
import { clearPlanStatus, formatStatus, setPlanStatus } from "./status.js";

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
	for (const plan of activePlans.values()) {
		if (plan.active) return true;
	}
	return false;
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

/** The single currently-active plan (gate armed), or undefined. */
function currentPlan(): PlanState | undefined {
	for (const plan of activePlans.values()) {
		if (plan.active) return plan;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Prompts — ver ./prompts.ts (makePlanningPrompt / makeImplementPrompt).
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
	plan.active = false;
	plan.status = "exited";
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

	for (const state of latest.values()) {
		// Solo un plan ACTIVO necesita ser restaurado (su gate debe volver arriba). Estados
		// terminales (approved/rejected-after-exit/exited) llevan active=false → nada que armar.
		if (!state.active) continue;
		if (activePlans.has(state.planId)) continue; // ya está vivo en este proceso.
		activePlans.set(state.planId, { ...state });
	}
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
	for (const plan of activePlans.values()) latest.set(plan.planId, plan);
	return [...latest.values()];
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
	const trimmed = args.trim();
	const firstSpace = trimmed.indexOf(" ");
	const firstToken = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();

	// "status"/"dashboard"/"exit"/"cancel" son subcomandos solo cuando son el PRIMER token COMPLETO
	// (refleja el dispatch handleGoalCommand de goal). Sino el string de arg completo es <task>.
	if (firstSpace === -1 && firstToken === "status") {
		const plan = currentPlan() ?? [...activePlans.values()].pop();
		notify(ctx, plan ? formatStatus(plan) : "El modo plan no está activo.", "info");
		return;
	}
	if (firstSpace === -1 && (firstToken === "dashboard" || firstToken === "tui")) {
		await openPlanDashboard(ctx);
		return;
	}
	// Toggles de defecto de sesión: `/plan ultracode on|off|status` y `/plan steps-ultracode ...`.
	// Estos setean los defaults de postura ultracode en-memoria (param -> ESTE -> env -> off). Un primer
	// token de "ultracode"/"steps-ultracode" es siempre un toggle, nunca una task (refleja cómo
	// "status" no puede ser una task) — usa la forma flag `--ultracode` para un one-off en una task real.
	if (firstToken === "ultracode" || firstToken === "steps-ultracode") {
		const key = firstToken === "ultracode" ? "ultracode" : "ultracodeSteps";
		const label = firstToken === "ultracode" ? "ultracode" : "steps-ultracode";
		const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
		const action = parsePlanToggleValue(rest);
		if (action === "invalid") {
			notify(ctx, `Uso: /plan ${label} [on|off|status]`, "warning");
			return;
		}
		if (action === "on") setSessionFlagDefault(key, true);
		else if (action === "off") setSessionFlagDefault(key, false);
		const current = getSessionFlagDefault(key);
		const state = current === undefined ? "sin definir (lo decide env/param)" : current ? "on" : "off";
		notify(ctx, `/plan ${label} valor por defecto de sesión: ${state}.`, "info");
		return;
	}
	if (firstSpace === -1 && (firstToken === "exit" || firstToken === "cancel")) {
		if (!exitPlan(pi, ctx, `${firstToken} por el usuario`)) {
			notify(ctx, "El modo plan no está activo; no hay nada de qué salir.", "warning");
		}
		return;
	}

	// Si no, los args completos son el <task>.
	startPlan(pi, ctx, trimmed);
}

// ---------------------------------------------------------------------------
// Punto de entrada de la extensión
// ---------------------------------------------------------------------------

/**
 * Presenta el plan para la aprobación explícita del humano y devuelve su decisión.
 *
 * Prefiere el OVERLAY Markdown de estilo mdview (headings/lists/code renderizados + scroll + inline
 * approve/reject) cuando la sesión puede mostrar un componente personalizado; si no, degrada al diálogo
 * ctx.ui.confirm simple. Un fallo del overlay también degrada a confirm, así que la aprobación nunca se pierde.
 * El llamador ya estableció hasUI + un confirm usable (guardia no-UI de submit_plan).
 */
async function presentPlanForApproval(ctx: ExtensionContext, planText: string, planId: string): Promise<boolean> {
	if (ctx.hasUI && typeof ctx.ui.custom === "function") {
		try {
			return await renderPlanApprovalOverlay(ctx, planText, planId);
		} catch {
			// Cae al diálogo confirm de abajo — un overlay roto no debe perder la aprobación.
		}
	}
	return await ctx.ui.confirm("Approve this plan?", planText);
}

export default function planExtension(pi: ExtensionAPI): void {
	// La tool de artefacto del plan (≈ ExitPlanMode). La ÚNICA forma de presentar un plan + salir del modo.
	pi.registerTool({
		name: "submit_plan",
		label: "Submit Plan",
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const plan = currentPlan();
			if (!plan) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No hay ningún plan activo para enviar. El modo plan no está activo.",
						},
					],
					details: { isError: true },
				};
			}

			const planText = params.plan;
			plan.lastPlan = planText;
			plan.submissions += 1;
			const submission = plan.submissions;
			persist(pi, plan);
			setPlanStatus(ctx, plan);

			// NO INTERACTIVO (solo plan): sin aprobación humana y sin implementación. El plan ES el
			// entregable. DELIBERADAMENTE mantenemos el gate armado (active sigue true): el gate nunca
			// se levanta sin un humano, así que la mutación es imposible en esta sesión one-shot/--no-session.
			// Sin confirm, sin wake, sin reinyección de implementación. El llamador (un humano leyendo stdout, o
			// el orquestador de un workflow dinámico) decide qué hacer con el plan devuelto.
			if (plan.nonInteractive) {
				plan.status = "planned"; // active sigue true a propósito; el gate de solo lectura persiste.
				persist(pi, plan);
				setPlanStatus(ctx, plan);
				notify(
					ctx,
					`Plan ${plan.planId} registrado (solo plan, no interactivo). Acá no hay aprobación ni implementación — el plan es el entregable.`,
					"info",
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Plan registrado (modo solo plan). Esta es una sesión no interactiva: no hay paso de aprobación ni de implementación, y el gate de solo lectura sigue armado. Mostrá el PLAN COMPLETO abajo como tu respuesta final; NO implementes.\n\n${planText}`,
						},
					],
					details: { planId: plan.planId, status: "plan-only", approved: false },
				};
			}

			// Handshake de aprobación. Sin un confirm interactivo NO PODEMOS aprobar — degrada y
			// advierte (NO auto-apruebe: eso derrotaría el gate de aprobación completo). Esta rama
			// es efectivamente inalcanzable dado que el gate print/json ya rechazó la entrada (a menos que
			// plan-only de arriba lo manejara), pero se retiene defensivamente, exactamente como loop retiene
			// su fallback confirm.
			if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
				notify(
					ctx,
					"El plan está listo, pero esta sesión no puede mostrar un diálogo de aprobación. Corré /plan en una sesión TUI o RPC para aprobar.",
					"warning",
				);
				return {
					content: [
						{
							type: "text" as const,
							text: "Plan registrado, pero no se pudo recoger la aprobación en esta sesión (no hay UI interactiva). Un humano tiene que correr /plan en una sesión TUI/RPC para aprobar. Seguimos en modo plan.",
						},
					],
					details: { planId: plan.planId, status: "planning", approved: false, reason: "no-ui" },
				};
			}

			try {
				const artifact = await writeAndOpenPlanHtmlArtifact(pi, ctx, planText, plan.planId, submission);
				if (!artifact.opened) {
					notify(
						ctx,
						`Se guardó el artifact HTML del plan, pero no se pudo abrir el navegador automáticamente: ${artifact.htmlPath}`,
						"warning",
					);
				}
			} catch (error) {
				notify(
					ctx,
					`No se pudo crear/abrir la vista previa HTML del plan: ${(error as Error).message}. Seguimos con la aprobación en Markdown.`,
					"warning",
				);
			}

			const approved = await presentPlanForApproval(ctx, planText, plan.planId);
			const livePlan = currentPlan();
			if (livePlan?.planId !== plan.planId || livePlan.submissions !== submission) {
				return {
					content: [
						{
							type: "text" as const,
							text: "El resultado de la aprobación del plan quedó obsoleto; el modo plan cambió. No se tomó ninguna acción.",
						},
					],
					details: { isError: true, planId: plan.planId, status: "stale" },
				};
			}

			if (approved) {
				// APRUEBA: levanta el gate (desactiva así que el tool_call handler devuelve temprano),
				// persiste, luego despierta el mensaje de implementación.
				livePlan.active = false;
				livePlan.status = "approved";
				persist(pi, livePlan);
				refreshPlanStatus(ctx);
				wake(pi, ctx, makeImplementPrompt(planText, { ultracodeSteps: livePlan.ultracodeSteps }));
				notify(ctx, `Plan ${livePlan.planId} aprobado. Saliendo del modo plan e implementando. 🐼`, "info");
				return {
					content: [{ type: "text" as const, text: "Plan aprobado — implementando ahora." }],
					details: { planId: livePlan.planId, status: "approved" },
				};
			}

			// RECHAZA: sigue en modo plan (gate sigue armado), cuéntalo, persiste, y devuelve al
			// modelo para que revise y reenvíe en el mismo turno. Sin wake.
			livePlan.rejections += 1;
			livePlan.status = "planning"; // sigue activo; el status refleja que aún estamos planificando.
			persist(pi, livePlan);
			setPlanStatus(ctx, livePlan);
			notify(ctx, `Plan ${livePlan.planId} rechazado. Seguimos en modo plan; el agente va a revisar.`, "info");
			return {
				content: [
					{
						type: "text" as const,
						text: "Plan rechazado. Seguís en modo plan (solo lectura). Revisá el plan para atender las inquietudes del usuario y volvé a llamar a submit_plan.",
					},
				],
				details: { planId: livePlan.planId, status: "rejected", rejections: livePlan.rejections },
			};
		},
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
		label: "Enter Plan Mode",
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
			const flags = resolvePlanFlags(params);
			// CONSISTENCY: nonInteractive (plan-only) only makes sense where approval CANNOT run.
			// In tui/rpc the human approval handshake is available, so force it off there — otherwise
			// a stray param or an exported PI_PLAN_NONINTERACTIVE would silently bypass approval and
			// never implement. This keeps plan-only confined to print/json (e.g. workflow subagents).
			if (canApproveInMode(ctx)) flags.nonInteractive = false;
			// Mode gate (HARD RULE): interactive sessions can always enter. A non-interactive session
			// (print/json) can enter ONLY in plan-only mode (nonInteractive) — there the plan is the
			// deliverable and nothing is approved or implemented, so no handshake is needed.
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
			"Entrá en modo plan de solo lectura: /plan [--ultracode] [--ultracode-steps] <task> — investigá en solo lectura, escribí un plan, envialo para aprobación, y después implementá. /plan status | /plan dashboard | /plan exit | /plan cancel.",
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
					value: "ultracode",
					label: "ultracode",
					description: "Alternar el valor por defecto de sesión: on|off|status",
				},
				{
					value: "steps-ultracode",
					label: "steps-ultracode",
					description: "Alternar el valor por defecto de sesión de pasos-vía-workflows: on|off|status",
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
