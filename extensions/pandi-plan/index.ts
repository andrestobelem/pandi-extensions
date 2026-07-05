/**
 * Claude-style `/plan` ("plan mode") for Pi (P0).
 *
 * Plan mode puts the MAIN agent into a READ-ONLY planning posture. While active,
 * the agent may RESEARCH (read/grep/find/ls + read-only bash) and PRODUCE a plan,
 * but it may NOT mutate the workspace. The deliverable is a PLAN artifact, presented
 * for EXPLICIT user approval, and only on approval does the agent EXIT the mode and
 * IMPLEMENT.
 *
 * The three things that make it plan mode (not "a prompt that says please plan"):
 *   1. The read-only GATE — a pi.on("tool_call") handler HARD-BLOCKS mutating tools
 *      while the mode is active. Enforced, not advisory.
 *   2. The plan as an ARTIFACT — the model emits the plan through a registered tool
 *      (submit_plan), exactly as /loop emits via loop_schedule and /goal via
 *      goal_progress. The plan text is the payload.
 *   3. EXPLICIT approval before any mutation — submit_plan presents the plan in a
 *      scrollable, Markdown-rendered approval OVERLAY (mdview-style; see approval-view.ts),
 *      degrading to ctx.ui.confirm when a custom component can't be shown (≈ Claude's
 *      ExitPlanMode). Approve → lift the gate, re-inject "implement this". Reject → stay
 *      gated, return the rejection to the model.
 *
 * Two ways IN, one way to mutate:
 *   - HUMAN:  /plan <task>                  (the slash command)
 *   - MODEL:  enter_plan_mode({ task })     (a model-callable tool, so Pi can decide ON ITS
 *                                            OWN to plan a risky/multi-step change — "cuando
 *                                            le parezca"). Same armed/persisted state; the
 *                                            only difference is delivery of the planning
 *                                            instruction (command wakes a user message; the
 *                                            tool returns it as its own result). The model can
 *                                            ENTER but never APPROVE — approval stays human.
 *
 * Flow:
 *   /plan <task>   (or model: enter_plan_mode({ task }))
 *     → guard mode (print/json → notify + refuse)
 *     → activate plan-mode (in-memory + persisted) via createAndArmPlan
 *     → arm read-only GATE (tool_call handler blocks mutations)
 *     → deliver the planning instruction (command: inject a user message; tool: return it as
 *       the tool result) — research read-only, then submit_plan
 *          ↓ (model researches with read tools only; mutations blocked)
 *     model calls submit_plan({ plan })
 *     → present the plan for approval (Markdown overlay, or ctx.ui.confirm fallback)
 *          ├─ APPROVE → deactivate, lift gate, persist,
 *          │            wake "Plan approved. Implement now:\n<plan>"
 *          └─ REJECT  → stay in plan-mode, return to model to revise + resubmit
 *
 * /plan status and /plan exit|cancel are out-of-band controls (abort w/o implementing).
 *
 * Mechanically the loop/goal family INVERTED: loop picks WHEN to wake, goal picks WHAT
 * STATE to report, plan SUPPRESSES mutation until an approved plan flips the agent from
 * planning to doing. The wake/persist/rehydrate/status plumbing is the same family; the
 * new parts are the GATE + the approval handshake.
 *
 * Hard rules:
 * - print/json gate: ctx.mode must be tui/rpc; print/json → notify + refuse to enter
 *   (plan mode needs an interactive approval; print is one-shot and cannot deliver it).
 * - never re-inject outside tui/rpc.
 * - deps: typebox + @earendil-works/pi-tui (the approval overlay renders Markdown, like pandi-mdview).
 * - on "fork" do NOT migrate the plan-mode.
 * - the read-only allowlist is BEST-EFFORT and documented (see blockedReason).
 *
 * AUTONOMOUS: this file does not import from extensions/loop/index.ts or extensions/goal/index.ts;
 * patterns (notify, persist via appendEntry, rehydrate, status line, wake) are copied.
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
import { clearPlanStatus, formatStatus, setPlanStatus } from "./status.js";

const PLAN_STATE_TYPE = "plan-state";

type PlanStatus = "planning" | "approved" | "rejected" | "exited" | "planned";

export interface PlanState {
	planId: string;
	/** The task the user handed to /plan. */
	task: string;
	/** True while the read-only GATE is armed (the mode is active). */
	active: boolean;
	status: PlanStatus;
	/** How many times the model called submit_plan. */
	submissions: number;
	/** How many of those were rejected by the user. */
	rejections: number;
	/** The last plan text the model submitted (for status + approval re-injection). */
	lastPlan?: string;
	/**
	 * Posture flags resolved at entry (param -> env -> default). They tune the prompt
	 * wording and, for nonInteractive, the submit_plan lifecycle (plan-only: no approval,
	 * no implementation, gate never lifts). Persisted so the dashboard/status reflect them.
	 */
	nonInteractive?: boolean;
	ultracode?: boolean;
	ultracodeSteps?: boolean;
	startedAt: number;
	/** ISO timestamp of the last write (kept for parity with the loop/goal family). */
	updatedAt: string;
}

// Source of truth of "is plan mode active NOW" in this process. A Map for parity with
// the loop/goal family, but /plan is single-session: at most one active plan at a time.
const activePlans = new Map<string, PlanState>();

export interface PlanModeGuard {
	isActive(): boolean;
}

export const PLAN_MODE_GUARD_SYMBOL = Symbol.for("pandi-plan.plan-mode.guard");

// ---------------------------------------------------------------------------
// Active-plan helpers
// ---------------------------------------------------------------------------

/** Is the read-only gate armed (any plan currently active)? */
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
// Prompts — see ./prompts.ts (makePlanningPrompt / makeImplementPrompt).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Status line — see ./status.ts (setPlanStatus / clearPlanStatus / formatStatus).
// ---------------------------------------------------------------------------

/** Refresh status from the active plan (if any). */
function refreshPlanStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const plan = currentPlan();
	if (plan) setPlanStatus(ctx, plan);
	else clearPlanStatus(ctx);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a plan transition. Stamps updatedAt and appends to the session JSONL (does NOT
 * go to the LLM). Mirrors the loop/goal family's appendEntry persistence. No sidecar: a
 * plan is short-lived and lives only inside one interactive session, so the JSONL entry
 * (replayed by rehydrate on session_start) is sufficient.
 */
function persist(pi: ExtensionAPI, plan: PlanState): void {
	plan.updatedAt = new Date().toISOString();
	pi.appendEntry<PlanState>(PLAN_STATE_TYPE, { ...plan });
}

// ---------------------------------------------------------------------------
// Mode gate (print/json)
// ---------------------------------------------------------------------------

/**
 * Can this session run the INTERACTIVE approval handshake (ctx.ui.confirm) and the wake
 * re-injection? Only TUI and RPC can: "print" is one-shot and "json" is non-interactive
 * (hasUI is true only in tui/rpc). Gates the approval path and the wake. Mirrors canLoopInMode.
 */
function canApproveInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

/**
 * Can plan mode be ENTERED here? Interactive sessions always can. A non-interactive session
 * (print/json — e.g. a dynamic-workflow subagent) can ONLY enter when the nonInteractive
 * (plan-only) flag is set: it produces a plan as its deliverable and never implements, so the
 * absence of an approval handshake is by design (the read-only gate never lifts there).
 */
function canEnterPlanMode(ctx: ExtensionContext, flags: PlanFlags): boolean {
	if (canApproveInMode(ctx)) return true;
	return (ctx.mode === "print" || ctx.mode === "json") && flags.nonInteractive === true;
}

// ---------------------------------------------------------------------------
// Plan flags — see ./flags.ts (envFlag, resolvePlanFlags, parse* + the
// session-default toggle singleton accessed via get/setSessionFlagDefault).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wake (re-inject implementation message after approval)
// ---------------------------------------------------------------------------

/**
 * Re-inject the implementation prompt after approval, mirroring the loop/goal wake:
 * idle → steer (sendUserMessage), busy → followUp. Mode-gated so it never fires outside
 * tui/rpc (defends rehydrate paths too).
 */
function wake(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (!canApproveInMode(ctx)) return;
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

// ---------------------------------------------------------------------------
// The read-only GATE — see ./gate.ts (pure policy: blockedReason / isMutatingBash).
// ---------------------------------------------------------------------------

/**
 * tool_call handler. Gates ONLY while plan mode is active (inverts loop's "only on
 * autopilot turns"), and blocks HARD rather than confirming (in plan mode the correct
 * thing is to block hard — no mutation until an approved plan lifts the gate).
 */
async function handleToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
	if (!planModeActive()) return undefined;
	const reason = blockedReason(event);
	if (!reason) return undefined;
	return { block: true, reason };
}

// ---------------------------------------------------------------------------
// Start / exit
// ---------------------------------------------------------------------------

/**
 * Create a fresh plan and ARM the read-only gate (active=true), persist it, and light the
 * status line. Pure of any DELIVERY decision: it does NOT inject the planning instruction —
 * the caller chooses how the model receives it. The /plan COMMAND wakes a user message; the
 * model-callable enter_plan_mode TOOL returns the instruction as its own tool result (so the
 * model keeps planning in the SAME turn without a second injected message). Assumes the
 * caller already passed the guards (canPlanInMode, non-empty task, no plan already active).
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
	// The command path is interactive-only: non-interactive (plan-only) entry is the
	// enter_plan_mode tool's job, so resolve flags WITHOUT non-interactive here.
	const flags = resolvePlanFlags({ ...commandFlags, nonInteractive: false });
	// Mode gate (HARD RULE): the /plan command needs an interactive approval; print/json
	// cannot deliver it. Refuse to enter.
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
	// Command path: inject the planning instruction as a user message (research read-only,
	// then submit_plan when ready), because the command runs out-of-band of the model's turn.
	wake(pi, ctx, makePlanningPrompt(plan));
	notify(
		ctx,
		`Entraste en modo plan (${plan.planId}). Solo lectura hasta que apruebes un plan. Tarea: ${trimmed}`,
		"info",
	);
	return plan;
}

/**
 * Leave plan mode WITHOUT implementing: lift the gate (active=false) and persist a terminal
 * state. Used by /plan exit|cancel. A no-op (false) if no plan is active.
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
// Rehydration (session_start)
// ---------------------------------------------------------------------------

/**
 * Rebuild plan state from persisted entries (last-wins by planId). Re-arms the read-only
 * GATE for any plan that was still active when the session ended (so a reload mid-planning
 * keeps the gate up). Avoids double-registration: if activePlans already has the plan in
 * this process, skip. Does NOT re-inject the planning prompt — the conversation already
 * carries it; we only restore the in-memory gate flag + status line.
 */
function rehydrate(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getEntries();
	const latest = collectLatestByKey<PlanState>(entries, PLAN_STATE_TYPE, (d) => d.planId);

	for (const state of latest.values()) {
		// Only an ACTIVE plan needs to be restored (its gate must come back up). Terminal
		// states (approved/rejected-after-exit/exited) carry active=false → nothing to arm.
		if (!state.active) continue;
		if (activePlans.has(state.planId)) continue; // already live in this process.
		activePlans.set(state.planId, { ...state });
	}
	refreshPlanStatus(ctx);
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

/**
 * Gather every plan in this session for the dashboard: the latest persisted snapshot per
 * planId (history) with the in-memory plans overlaid on top (most current — they carry the
 * freshest counts/lastPlan before the next persist). Pure read; no mutation.
 */
function collectAllPlans(ctx: ExtensionContext): PlanState[] {
	const latest = collectLatestByKey<PlanState>(ctx.sessionManager.getEntries(), PLAN_STATE_TYPE, (d) => d.planId);
	for (const plan of activePlans.values()) latest.set(plan.planId, plan);
	return [...latest.values()];
}

/**
 * Open the plan-mode tracking dashboard. In a TUI it shows a scrollable overlay rendered
 * from the Markdown report; in non-interactive modes it prints the report. The overlay
 * itself lives in dashboard.ts (`renderPlanDashboardOverlay`).
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

	// "status"/"dashboard"/"exit"/"cancel" are subcommands only when they are the WHOLE first
	// token (mirrors goal's handleGoalCommand dispatch). Otherwise the whole arg string is <task>.
	if (firstSpace === -1 && firstToken === "status") {
		const plan = currentPlan() ?? [...activePlans.values()].pop();
		notify(ctx, plan ? formatStatus(plan) : "El modo plan no está activo.", "info");
		return;
	}
	if (firstSpace === -1 && (firstToken === "dashboard" || firstToken === "tui")) {
		await openPlanDashboard(ctx);
		return;
	}
	// Session-default toggles: `/plan ultracode on|off|status` and `/plan steps-ultracode ...`.
	// These set the in-memory ultracode posture defaults (param -> THIS -> env -> off). A first
	// token of "ultracode"/"steps-ultracode" is always a toggle, never a task (mirrors how
	// "status" cannot be a task) — use the `--ultracode` flag form for a one-off on a real task.
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

	// Otherwise the whole args is the <task>.
	startPlan(pi, ctx, trimmed);
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

/**
 * Present the plan for the human's explicit approval and return their decision.
 *
 * Prefers the mdview-style Markdown OVERLAY (rendered headings/lists/code + scroll + inline
 * approve/reject) when the session can show a custom component; otherwise degrades to the plain
 * ctx.ui.confirm dialog. An overlay failure also degrades to confirm, so approval is never lost.
 * The caller has already established hasUI + a usable confirm (submit_plan's no-UI guard).
 */
async function presentPlanForApproval(ctx: ExtensionContext, planText: string, planId: string): Promise<boolean> {
	if (ctx.hasUI && typeof ctx.ui.custom === "function") {
		try {
			return await renderPlanApprovalOverlay(ctx, planText, planId);
		} catch {
			// Fall through to the confirm dialog below — a broken overlay must not lose the approval.
		}
	}
	return await ctx.ui.confirm("Approve this plan?", planText);
}

export default function planExtension(pi: ExtensionAPI): void {
	// The plan artifact tool (≈ ExitPlanMode). The ONLY way to present a plan + exit the mode.
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

			// NON-INTERACTIVE (plan-only): no human approval and no implementation. The plan IS the
			// deliverable. We DELIBERATELY keep the gate armed (active stays true): the gate never
			// lifts without a human, so mutation is impossible in this one-shot/--no-session session.
			// No confirm, no wake, no implement re-injection. The caller (a human reading stdout, or
			// the orchestrator of a dynamic workflow) decides what to do with the returned plan.
			if (plan.nonInteractive) {
				plan.status = "planned"; // active stays true on purpose; the read-only gate persists.
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

			// Approval handshake. Without an interactive confirm we CANNOT approve — degrade and
			// warn (do NOT auto-approve: that would defeat the whole approval gate). This branch
			// is effectively unreachable given the print/json gate already refused entry (unless
			// plan-only above handled it), but it is retained defensively, exactly as loop retains
			// its confirm fallback.
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
				// APPROVE: lift the gate (deactivate so the tool_call handler returns early),
				// persist, then wake the implementation message.
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

			// REJECT: stay in plan mode (gate stays armed), count it, persist, and return to the
			// model so it revises and resubmits in the same turn. No wake.
			livePlan.rejections += 1;
			livePlan.status = "planning"; // remains active; status reflects we're still planning.
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

	// Model-callable AUTONOMOUS entry into plan mode (≈ Claude requesting plan mode itself).
	// This is the affordance that lets Pi decide ON ITS OWN to plan before mutating — the gate,
	// the approval handshake, and exit semantics are all unchanged; only the ENTRY is new. It
	// reuses createAndArmPlan (the exact armed/persisted state the /plan command produces) and
	// hands the planning instruction back AS ITS OWN RESULT so the model keeps planning in the
	// same turn (no wake / second user message). It can ENTER but never APPROVE: the human still
	// approves via submit_plan + ctx.ui.confirm.
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
			// Idempotent no-op when a plan is already active (single-plan invariant): do NOT create a
			// second plan; report the current one so the model keeps planning instead of re-entering.
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
			// Tool path: hand the planning instruction back as THIS tool's result (no wake), so the
			// model reads it immediately and keeps planning read-only in the same turn.
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

	// The read-only GATE: hard-block mutating tools while plan mode is active.
	pi.on("tool_call", async (event, _ctx) => await handleToolCall(event));

	pi.on("session_start", async (event, ctx) => {
		// Session boundaries must not inherit in-memory plan state from another session.
		activePlans.clear();
		resetSessionFlagDefaults();
		// Do NOT migrate plan mode into a forked session: a fork inherits the parent's
		// "plan-state" entries, but plan mode must keep running only in the parent.
		if (event.reason === "fork") return;
		rehydrate(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Persist the active plan verbatim (active=true) so a reload re-arms the gate; do not
		// change its status. Terminal plans are already persisted.
		const plan = currentPlan();
		if (plan) persist(pi, plan);
		clearPlanStatus(ctx);
	});
}
