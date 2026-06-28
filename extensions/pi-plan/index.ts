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
import { blockedReason } from "./gate.js";
import { makeImplementPrompt, makePlanningPrompt } from "./prompts.js";

const PLAN_STATE_TYPE = "plan-state";
const PLAN_STATUS_KEY = "plan";

type PlanStatus = "planning" | "approved" | "rejected" | "exited";

interface PlanState {
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
// Status line
// ---------------------------------------------------------------------------

function setPlanStatus(ctx: ExtensionContext, plan: PlanState): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const subs = plan.submissions > 0 ? ` · ${plan.submissions} submitted` : "";
	const rej = plan.rejections > 0 ? `/${plan.rejections} rejected` : "";
	ctx.ui.setStatus(
		PLAN_STATUS_KEY,
		`${theme.fg("accent", "▣ plan")} ${theme.fg("dim", `read-only${subs}${rej}`)}`,
	);
}

function clearPlanStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(PLAN_STATUS_KEY, undefined);
}

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
 * Plan mode needs an INTERACTIVE approval (ctx.ui.confirm) plus the ability to re-inject
 * an implementation message and resume on its own — only TUI and RPC can do that. "print"
 * is one-shot and "json" is non-interactive (hasUI is true only in tui/rpc), so neither
 * can sustain the approval handshake or the wake re-injection. Mirrors canLoopInMode.
 */
function canPlanInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

// ---------------------------------------------------------------------------
// Wake (re-inject implementation message after approval)
// ---------------------------------------------------------------------------

/**
 * Re-inject the implementation prompt after approval, mirroring the loop/goal wake:
 * idle → steer (sendUserMessage), busy → followUp. Mode-gated so it never fires outside
 * tui/rpc (defends rehydrate paths too).
 */
function wake(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (!canPlanInMode(ctx)) return;
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
function createAndArmPlan(pi: ExtensionAPI, ctx: ExtensionContext, task: string): PlanState {
	const planId = crypto.randomBytes(4).toString("hex");
	const plan: PlanState = {
		planId,
		task,
		active: true,
		status: "planning",
		submissions: 0,
		rejections: 0,
		startedAt: Date.now(),
		updatedAt: new Date().toISOString(),
	};
	activePlans.set(planId, plan);
	persist(pi, plan);
	setPlanStatus(ctx, plan);
	return plan;
}

function startPlan(pi: ExtensionAPI, ctx: ExtensionContext, task: string): PlanState | undefined {
	// Mode gate (HARD RULE): plan mode needs an interactive approval; print/json cannot
	// deliver it. Refuse to enter.
	if (!canPlanInMode(ctx)) {
		notify(ctx, "/plan requires a TUI or RPC session (this mode cannot run the approval handshake).", "error");
		return undefined;
	}
	const trimmed = task.trim();
	if (!trimmed) {
		notify(ctx, "Usage: /plan <task>", "warning");
		return undefined;
	}
	if (planModeActive()) {
		notify(ctx, "Plan mode is already active. Use /plan status, or /plan exit to leave it.", "warning");
		return currentPlan();
	}

	const plan = createAndArmPlan(pi, ctx, trimmed);
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

function formatStatus(plan: PlanState): string {
	const gate = plan.active ? "active (read-only gate ARMED)" : `inactive [${plan.status}]`;
	const counts = ` — ${plan.submissions} plan(s) submitted, ${plan.rejections} rejected`;
	return `Plan ${plan.planId}: ${gate}${counts}. Task: ${plan.task}`;
}

async function handlePlanCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const trimmed = args.trim();
	const firstSpace = trimmed.indexOf(" ");
	const firstToken = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();

	// "status"/"exit"/"cancel" are subcommands only when they are the WHOLE first token
	// (mirrors goal's handleGoalCommand dispatch). Otherwise the whole arg string is <task>.
	if (firstSpace === -1 && firstToken === "status") {
		const plan = currentPlan() ?? [...activePlans.values()].pop();
		notify(ctx, plan ? formatStatus(plan) : "Plan mode is not active.", "info");
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

			// Approval handshake. Without an interactive confirm we CANNOT approve — degrade and
			// warn (do NOT auto-approve: that would defeat the whole approval gate). This branch
			// is effectively unreachable given the print/json gate already refused entry, but it
			// is retained defensively, exactly as loop retains its confirm fallback.
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
			if (!livePlan || livePlan.planId !== plan.planId || livePlan.submissions !== submission) {
				return {
					content: [{ type: "text" as const, text: "Plan approval result is stale; plan mode has changed. No action was taken." }],
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
				wake(pi, ctx, makeImplementPrompt(planText));
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
				description: "The task you intend to plan before implementing (what you will research and write a plan for).",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Mode gate (HARD RULE), identical to the /plan command: plan mode needs an interactive
			// approval; print/json cannot deliver it. Refuse to arm the gate and tell the model to
			// proceed normally rather than retry.
			if (!canPlanInMode(ctx)) {
				notify(
					ctx,
					"Cannot enter plan mode here: this session is not interactive (a TUI or RPC session is required). Proceeding without plan mode.",
					"warning",
				);
				return {
					content: [
						{
							type: "text" as const,
							text: "Plan mode requires a TUI or RPC session and cannot run the approval handshake here. Do not enter plan mode; proceed with the task normally.",
						},
					],
					details: { entered: false, reason: "mode" },
				};
			}
			const trimmed = params.task.trim();
			if (!trimmed) {
				return {
					content: [{ type: "text" as const, text: "enter_plan_mode requires a non-empty task describing what to plan." }],
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

			const plan = createAndArmPlan(pi, ctx, trimmed);
			notify(
				ctx,
				`Pi entered plan mode (${plan.planId}). Read-only until you approve a plan. Task: ${trimmed}`,
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
			"Enter read-only plan mode: /plan <task> — research read-only, write a plan, submit it for approval, then implement. /plan status | /plan exit | /plan cancel.",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "Show plan-mode status" },
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
