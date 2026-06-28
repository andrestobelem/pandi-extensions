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
 * Flow:
 *   /plan <task>
 *     → guard mode (print/json → notify + refuse)
 *     → activate plan-mode (in-memory + persisted)
 *     → arm read-only GATE (tool_call handler blocks mutations)
 *     → inject the planning instruction (research read-only, then submit_plan)
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
import { notify } from "../shared/notify.js";

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
// Prompts
// ---------------------------------------------------------------------------

/** The planning instruction injected when /plan enters the mode. */
function makePlanningPrompt(plan: PlanState): string {
	const lines: string[] = [];
	lines.push(`You are now in PLAN MODE (plan ${plan.planId}). This is a READ-ONLY planning posture.`);
	lines.push("");
	lines.push("TASK (verbatim):");
	lines.push(plan.task);
	lines.push("");
	lines.push("RULES while in plan mode (ENFORCED by a gate, not just guidance):");
	lines.push(
		"- You may ONLY use read-only actions: read, grep, find, ls, and read-only shell commands (e.g. git ls-files, git status, cat, head, sed -n for viewing). Mutating tools (write, edit) and mutating shell commands (rm, mv, git commit/add/push/reset, redirections >/>>, package installs, etc.) are HARD-BLOCKED and will fail. dynamic_workflow is allowed only for read-only actions (list/template/read/graph/runs/view); write/run/start are blocked while planning.",
	);
	lines.push("- Do NOT begin implementing. Implementation happens only AFTER the user approves your plan.");
	lines.push("- You may call AskUserQuestion to clarify requirements before finalizing the plan, if needed.");
	lines.push("");
	lines.push("WHAT TO DO:");
	lines.push("1. RESEARCH the task with read-only tools until you understand it.");
	lines.push("2. DESIGN an implementation approach.");
	lines.push(
		"3. When the plan is complete and self-contained, call submit_plan({ plan }) with the FULL implementation plan in Markdown. This presents it to the user for approval.",
	);
	lines.push(
		"On approval you will exit plan mode and be asked to implement. If the plan is rejected you will get feedback and should revise, then call submit_plan again.",
	);
	return lines.join("\n");
}

/** The implementation message re-injected after the user approves the plan. */
function makeImplementPrompt(planText: string): string {
	return `Plan approved. Implement now:\n\n${planText}`;
}

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
// The read-only GATE — exactly what it blocks
// ---------------------------------------------------------------------------

/**
 * Allowlist of MUTATING bash commands (best-effort, documented). The gate blocks a bash
 * call IFF its command matches one of these; everything else (reads) is allowed. This is
 * the inverse use of loop.ts's DESTRUCTIVE_BASH_PATTERNS machinery (flag-order-independent
 * look-aheads), broadened per the brief. It is BEST-EFFORT: a sufficiently creative shell
 * command can evade it (e.g. obscure tooling, an aliased mutator). The hard guarantees are
 * on the structured tools (write/edit/notebook-edit are ALWAYS blocked); bash is a
 * heuristic backstop. When unsure we err toward BLOCKING (this is plan mode — no mutation).
 *
 * Blocking set:
 *   - File creation / deletion / move / metadata changes: touch, mkdir, rm, rmdir, mv, truncate, shred, unlink, chmod, chown, chgrp
 *   - In-place / writing tooling: sed -i, tee, dd, mkfs
 *   - Shell redirections that WRITE a file: >, >>, >|, including numbered-fd
 *     writes like 2>err.log (but NOT fd duplications like 2>&1)
 *   - Git mutations: commit, add, push, reset, clean, checkout, switch, restore, merge,
 *     rebase, stash, apply, rm, mv, tag, branch -D/-d, cherry-pick, revert
 *   - Package installs: npm/pnpm/yarn install|add|ci, npx -y, pip/pipx install, poetry add,
 *     cargo add, go get, gem install, brew install, bun add/install
 *   - Infra/build that writes: make, kubectl apply/delete, terraform apply/destroy,
 *     helm upgrade/install/uninstall
 */
const MUTATING_BASH_PATTERNS: RegExp[] = [
	// File creation / deletion / move / metadata changes (any flags). \brm\b also covers rm -rf.
	/\btouch\b/i,
	/\bmkdir\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bln\b/i,
	/\binstall\b/i, // GNU coreutils `install` creates files; also re-covers npm/pip install
	/\btruncate\b/i,
	/\bshred\b/i,
	/\bunlink\b/i,
	// In-place / file-writing tooling.
	/\bsed\b[^\n]*\s-i\b/i, // sed -i (in-place edit)
	/\btee\b/i,
	/\bdd\b[^\n]*\b(if|of)=/i,
	/\bmkfs(\.\w+)?\b/i,
	// Shell redirections that write a file: >, >>, >|, including numbered-fd
	// writes like 2>err.log (avoid matching 2>&1 / >&N fd-dups, and the operators
	// ->, =>, >= which are not redirections).
	/(^|[^&>=-])>>?\s*(?![&>=])/,
	/>\|/,
	// Git mutations.
	/\bgit\b[^\n]*\b(commit|add|push|reset|clean|checkout|switch|restore|merge|rebase|stash|apply|rm|mv|tag|cherry-pick|revert)\b/i,
	/\bgit\b[^\n]*\bbranch\b[^\n]*\s-[dD]\b/i,
	// Package installs.
	/\b(npm|pnpm|yarn|bun)\b[^\n]*\b(install|add|ci)\b/i,
	/\bnpx\b[^\n]*\s-y\b/i,
	/\b(pip|pip3|pipx)\b[^\n]*\binstall\b/i,
	/\bpoetry\b[^\n]*\badd\b/i,
	/\bcargo\b[^\n]*\badd\b/i,
	/\bgo\b[^\n]*\bget\b/i,
	/\bgem\b[^\n]*\binstall\b/i,
	/\bbrew\b[^\n]*\binstall\b/i,
	// Infra / build that writes.
	/\bmake\b/i,
	/\bkubectl\b[^\n]*\b(apply|delete)\b/i,
	/\bterraform\b[^\n]*\b(apply|destroy)\b/i,
	/\bhelm\b[^\n]*\b(upgrade|install|uninstall)\b/i,
];

/** Is this bash command a mutation per the best-effort allowlist? */
function isMutatingBash(command: string): boolean {
	return MUTATING_BASH_PATTERNS.some((re) => re.test(command));
}

/**
 * Decide whether a tool call should be HARD-BLOCKED while plan mode is active. Returns a
 * human-readable reason when it should be blocked, else undefined (allow). Pure (no side
 * effects) so it is trivially testable.
 *
 * Always blocked (the built-in mutating tools): write, edit. (notebook-edit is also blocked
 *                                                defensively by name, though it is not a
 *                                                built-in in this SDK — see note below.)
 * Always allowed (read-only built-ins):          read, grep, find, ls, submit_plan.
 * bash:                                           blocked iff the command matches the
 *                                                mutating allowlist (above); else allowed.
 * Known mutating custom tools:                    dynamic_workflow is blocked unless its
 *                                                action is read-only (list/template/read/
 *                                                graph/runs/view). It can write files to the
 *                                                workspace and spawn subagents that run
 *                                                write/edit/bash, and those subagent tool
 *                                                calls do NOT pass through this main-session
 *                                                gate — so blocking it here is the only place
 *                                                we can stop it.
 * Any other tool name:                            allowed. The HARD guarantees are the built-in
 *                                                structured mutators (write/edit) + the bash
 *                                                heuristic + the known custom-tool block above;
 *                                                an unknown custom mutating tool registered by
 *                                                another extension/MCP would fall through here
 *                                                (best-effort — we rely on the prompt for those).
 */
const DYNAMIC_WORKFLOW_READONLY_ACTIONS = new Set(["list", "template", "read", "graph", "runs", "view"]);

function blockedReason(event: ToolCallEvent): string | undefined {
	const name = event.toolName;
	// submit_plan is the one permitted "output" (writing the plan).
	if (name === "submit_plan") return undefined;
	// Structured built-in mutators are ALWAYS blocked. notebook-edit is matched by string
	// compare (defensive — it is not a built-in tool name in this SDK, but blocking a
	// non-existent name is inert and future-proofs against a notebook editor being added).
	if (name === "write" || name === "edit" || name === "notebook-edit") {
		return `plan mode is READ-ONLY: the "${name}" tool is blocked while planning. Present your plan via submit_plan; you can edit after the user approves.`;
	}
	// Read-only built-ins are always allowed.
	if (name === "read" || name === "grep" || name === "find" || name === "ls") return undefined;
	// bash: block only mutating commands; allow read-only ones (cat, git ls-files, grep...).
	if (name === "bash") {
		const command = (event.input as { command?: unknown }).command;
		if (typeof command === "string" && isMutatingBash(command)) {
			return `plan mode is READ-ONLY: this shell command looks like a mutation and is blocked while planning: ${command.slice(0, 200)}`;
		}
		return undefined;
	}
	// Known mutating custom tool: dynamic_workflow can write files (action=write) and spawn
	// subagents with write/edit/bash (action=run/start/resume), whose tool calls bypass this
	// main-session gate entirely. Allow only its read-only actions; block the rest. If the
	// action is missing/unknown we err toward BLOCKING (this is plan mode — no mutation).
	if (name === "dynamic_workflow") {
		const action = (event.input as { action?: unknown }).action;
		if (typeof action === "string" && DYNAMIC_WORKFLOW_READONLY_ACTIONS.has(action)) return undefined;
		return `plan mode is READ-ONLY: dynamic_workflow "${String(action)}" can write files or spawn mutating subagents and is blocked while planning. Use only read-only actions (list/template/read/graph/runs/view), or submit_plan when your plan is ready.`;
	}
	// Unknown / other tools: allow. The hard guarantees above (built-in mutators + bash
	// heuristic + the known custom-tool block) are best-effort; an unknown custom mutating
	// tool would fall through here, in which case we rely on the planning prompt.
	return undefined;
}

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

	const planId = crypto.randomBytes(4).toString("hex");
	const plan: PlanState = {
		planId,
		task: trimmed,
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

	// Inject the planning instruction (research read-only, then submit_plan when ready).
	wake(pi, ctx, makePlanningPrompt(plan));
	notify(ctx, `Entered plan mode (${planId}). Read-only until you approve a plan. Task: ${trimmed}`, "info");
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
	const latest = new Map<string, PlanState>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PLAN_STATE_TYPE) continue;
		const data = entry.data as PlanState | undefined;
		if (!data || typeof data.planId !== "string") continue;
		latest.set(data.planId, data); // last-wins
	}

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
