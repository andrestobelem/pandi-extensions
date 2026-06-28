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
 *   3. EXPLICIT approval before any mutation — submit_plan shows the plan via
 *      ctx.ui.confirm (≈ Claude's ExitPlanMode). Approve → lift the gate, re-inject
 *      "implement this". Reject → stay gated, return the rejection to the model.
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
 *     → ctx.ui.confirm(title, plan)
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
 * - no new deps (typebox already present).
 * - on "fork" do NOT migrate the plan-mode.
 * - the read-only allowlist is BEST-EFFORT and documented (see blockedReason).
 *
 * AUTONOMOUS: this file does not import from extensions/loop/index.ts or extensions/goal/index.ts;
 * patterns (notify, persist via appendEntry, rehydrate, status line, wake) are copied.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import { notify } from "./notify.js";
import { collectLatestByKey } from "./session-state.js";
import { buildPlanDashboardMarkdown, renderPlanDashboardOverlay } from "./dashboard.js";
import { blockedReason } from "./gate.js";
import { type PlanFlags, makeImplementPrompt, makePlanningPrompt } from "./prompts.js";
import {
	getSessionFlagDefault,
	parsePlanCommandFlags,
	parsePlanToggleValue,
	resetSessionFlagDefaults,
	resolvePlanFlags,
	setSessionFlagDefault,
} from "./flags.js";
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

export const PLAN_MODE_GUARD_SYMBOL = Symbol.for("pi-dynamic-workflows.plan-mode.guard");

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
		notify(ctx, "/plan requires a TUI or RPC session (this mode cannot run the approval handshake).", "error");
		return undefined;
	}
	const trimmed = cleanedTask.trim();
	if (!trimmed) {
		notify(ctx, "Usage: /plan [--ultracode] [--ultracode-steps] <task>", "warning");
		return undefined;
	}
	if (planModeActive()) {
		notify(ctx, "Plan mode is already active. Use /plan status, or /plan exit to leave it.", "warning");
		return currentPlan();
	}

	const plan = createAndArmPlan(pi, ctx, trimmed, flags);
	// Command path: inject the planning instruction as a user message (research read-only,
	// then submit_plan when ready), because the command runs out-of-band of the model's turn.
	wake(pi, ctx, makePlanningPrompt(plan));
	notify(ctx, `Entered plan mode (${plan.planId}). Read-only until you approve a plan. Task: ${trimmed}`, "info");
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
	notify(ctx, `Exited plan mode (${plan.planId}): ${reason}. No implementation was started.`, "info");
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
		notify(ctx, plan ? formatStatus(plan) : "Plan mode is not active.", "info");
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
			notify(ctx, `Usage: /plan ${label} [on|off|status]`, "warning");
			return;
		}
		if (action === "on") setSessionFlagDefault(key, true);
		else if (action === "off") setSessionFlagDefault(key, false);
		const current = getSessionFlagDefault(key);
		const state = current === undefined ? "unset (env/param decides)" : current ? "on" : "off";
		notify(ctx, `/plan ${label} session default: ${state}.`, "info");
		return;
	}
	if (firstSpace === -1 && (firstToken === "exit" || firstToken === "cancel")) {
		if (!exitPlan(pi, ctx, `${firstToken} by user`)) {
			notify(ctx, "Plan mode is not active; nothing to exit.", "warning");
		}
		return;
	}

	// Otherwise the whole args is the <task>.
	startPlan(pi, ctx, trimmed);
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default function planExtension(pi: ExtensionAPI): void {
	// The plan artifact tool (≈ ExitPlanMode). The ONLY way to present a plan + exit the mode.
	pi.registerTool({
		name: "submit_plan",
		label: "Submit Plan",
		description:
			"Present your completed implementation plan to the user for approval (≈ ExitPlanMode). The ONLY way to finish plan mode. On approval you exit plan mode and implement; on rejection you stay in plan mode and revise.",
		promptSnippet: "Submit your /plan implementation plan for the user to approve.",
		promptGuidelines: [
			"Do your research FIRST with read-only tools. You cannot edit/write or run mutating shell commands while planning — those are hard-blocked.",
			"When the plan is complete and self-contained, call submit_plan with the FULL plan in Markdown. Do not start implementing: implementation happens only after the user approves.",
			"If the plan is rejected, you will get the rejection back; revise the plan to address the feedback and call submit_plan again.",
		],
		parameters: Type.Object({
			plan: Type.String({
				minLength: 1,
				description: "The full implementation plan in Markdown, ready to present to the user for approval.",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const plan = currentPlan();
			if (!plan) {
				return {
					content: [{ type: "text" as const, text: "No active plan to submit. Plan mode is not active." }],
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
					`Plan ${plan.planId} recorded (plan-only, non-interactive). No approval or implementation here — the plan is the deliverable.`,
					"info",
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Plan recorded (plan-only mode). This is a non-interactive session: there is no approval or implementation step, and the read-only gate stays armed. Output the FULL plan below as your final answer; do NOT implement.\n\n${planText}`,
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
					"Plan ready, but this session cannot show an approval dialog. Run /plan in a TUI or RPC session to approve.",
					"warning",
				);
				return {
					content: [
						{
							type: "text" as const,
							text: "Plan recorded, but approval could not be collected in this session (no interactive UI). A human must run /plan in a TUI/RPC session to approve. Staying in plan mode.",
						},
					],
					details: { planId: plan.planId, status: "planning", approved: false, reason: "no-ui" },
				};
			}

			const approved = await ctx.ui.confirm("Approve this plan?", planText);
			const livePlan = currentPlan();
			if (livePlan?.planId !== plan.planId || livePlan.submissions !== submission) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Plan approval result is stale; plan mode has changed. No action was taken.",
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
				notify(ctx, `Plan ${livePlan.planId} approved. Exiting plan mode and implementing.`, "info");
				return {
					content: [{ type: "text" as const, text: "Plan approved — implementing now." }],
					details: { planId: livePlan.planId, status: "approved" },
				};
			}

			// REJECT: stay in plan mode (gate stays armed), count it, persist, and return to the
			// model so it revises and resubmits in the same turn. No wake.
			livePlan.rejections += 1;
			livePlan.status = "planning"; // remains active; status reflects we're still planning.
			persist(pi, livePlan);
			setPlanStatus(ctx, livePlan);
			notify(ctx, `Plan ${livePlan.planId} rejected. Still in plan mode; the agent will revise.`, "info");
			return {
				content: [
					{
						type: "text" as const,
						text: "Plan rejected. You are still in plan mode (read-only). Revise the plan to address the user's concerns and call submit_plan again.",
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
			"Enter read-only plan mode yourself before implementing a non-trivial, multi-step, or risky change. Arms a read-only gate (write/edit and mutating shell commands are hard-blocked) so you research read-only and draft a plan, then present it via submit_plan for the user's explicit approval before any edits. Needs a TUI/RPC session.",
		promptSnippet: "Enter read-only plan mode to research and present a plan before implementing.",
		promptGuidelines: [
			"Use enter_plan_mode on your own initiative when the user's request is non-trivial, multi-step, ambiguous, destructive, or far-reaching (refactors, migrations, schema/architecture changes, anything touching many files) and they have NOT already approved a concrete approach — it arms a read-only gate so you research safely, then you call submit_plan for explicit approval before any edits.",
			"Do NOT use enter_plan_mode for trivial, single-step, read-only, or already-approved work, for answering questions, or when a plan, /goal, or /loop is already driving the turn — just do those directly.",
			"enter_plan_mode needs an interactive approval, so it only takes effect in a TUI or RPC session; if it reports it could not enter (non-interactive mode) or that plan mode is already active, do NOT retry — continue the task (or, if already planning, keep researching read-only and call submit_plan).",
			"After enter_plan_mode you are READ-ONLY: write/edit and mutating shell commands are hard-blocked until the user approves your plan, so finish researching and then call submit_plan — implementation happens only after approval.",
			"Your plan MAY include running dynamic workflows (dynamic_workflow action=run/start) as post-approval implementation steps for broad, parallel, or high-confidence work (large audits, migrations, exhaustive sweeps, independent verification, deep research); while planning you can inspect the catalog read-only (dynamic_workflow action=list/template/read) to pick or design the right one and describe it in the plan.",
		],
		parameters: Type.Object({
			task: Type.String({
				minLength: 1,
				description:
					"The task you intend to plan before implementing (what you will research and write a plan for).",
			}),
			nonInteractive: Type.Optional(
				Type.Boolean({
					description:
						"Plan-only: enter even in a non-interactive (print/json) session, e.g. a dynamic-workflow subagent. There is no approval or implementation; the plan is the deliverable and the read-only gate never lifts. Defaults from PI_PLAN_NONINTERACTIVE.",
				}),
			),
			ultracode: Type.Optional(
				Type.Boolean({
					description:
						"Tell the planner to research/design the plan using dynamic workflows (ultracode). Defaults from PI_PLAN_ULTRACODE.",
				}),
			),
			ultracodeSteps: Type.Optional(
				Type.Boolean({
					description:
						"Tell the planner/implementer to execute the plan's STEPS via dynamic workflows when warranted. Defaults from PI_PLAN_ULTRACODE_STEPS.",
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
					"Cannot enter plan mode here: this session is not interactive. Pass nonInteractive (or set PI_PLAN_NONINTERACTIVE) for a plan-only session, or proceed without plan mode.",
					"warning",
				);
				return {
					content: [
						{
							type: "text" as const,
							text: "Plan mode requires a TUI or RPC session to run the approval handshake. For a non-interactive session, pass nonInteractive:true (plan-only: produce a plan, no implementation) or set PI_PLAN_NONINTERACTIVE=1. Otherwise do not enter plan mode; proceed with the task normally.",
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
							text: "enter_plan_mode requires a non-empty task describing what to plan.",
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
							text: `Plan mode is already active${current ? ` (${current.planId})` : ""}. Continue researching read-only, then call submit_plan when your plan is ready.`,
						},
					],
					details: { entered: false, reason: "already-active", planId: current?.planId },
				};
			}

			const plan = createAndArmPlan(pi, ctx, trimmed, flags);
			notify(
				ctx,
				plan.nonInteractive
					? `Pi entered plan mode (${plan.planId}, plan-only). Read-only; the plan is the deliverable. Task: ${trimmed}`
					: `Pi entered plan mode (${plan.planId}). Read-only until you approve a plan. Task: ${trimmed}`,
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
			"Enter read-only plan mode: /plan [--ultracode] [--ultracode-steps] <task> — research read-only, write a plan, submit it for approval, then implement. /plan status | /plan dashboard | /plan exit | /plan cancel.",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "Show plan-mode status" },
				{ value: "dashboard", label: "dashboard", description: "Open the plan-mode tracking dashboard" },
				{ value: "--ultracode", label: "--ultracode", description: "Plan using dynamic workflows" },
				{
					value: "--ultracode-steps",
					label: "--ultracode-steps",
					description: "Execute the plan's steps via dynamic workflows",
				},
				{ value: "ultracode", label: "ultracode", description: "Toggle session default: on|off|status" },
				{
					value: "steps-ultracode",
					label: "steps-ultracode",
					description: "Toggle steps-via-workflows session default: on|off|status",
				},
				{ value: "exit", label: "exit", description: "Leave plan mode without implementing" },
				{ value: "cancel", label: "cancel", description: "Leave plan mode without implementing" },
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
