/**
 * Claude-style `/goal` for Pi (P0): a GOAL-DIRECTED agent.
 *
 * `/goal <objective>` is an agent of *directed persistence*: it iterates toward a
 * declared OBJECTIVE and, on each iteration, (a) does work, (b) SELF-EVALUATES progress
 * against SUCCESS CRITERIA (definition-of-done), (c) decides `continue` | `done` |
 * `blocked`. It terminates when the criteria are met AND VERIFIED (not by the model's
 * mere self-declaration of "done"), when it blocks (needs a human), or by a cap
 * (iterations / context budget).
 *
 * Difference vs `/loop` (mechanically identical, semantically opposite):
 * - `/loop` repeats a TASK at a cadence; the model picks WHEN to wake (delaySeconds);
 *   the loop has no notion of "finished".
 * - `/goal` pursues an OBJECTIVE with CRITERIA; the model picks WHAT STATE to report
 *   (goal_progress({status})). Its hallmark is the COMPLETENESS CHECK: before declaring
 *   `done`, the engine forces an explicit VERIFICATION of the objective against the
 *   criteria. Re-injection is immediate (delay 0) unless the model declares it is
 *   waiting on an external signal (optional waitSeconds, clamped).
 *
 * Mechanism (Pi has no native scheduling, same inversion as /loop): the model reports
 * its decision by calling the `goal_progress` tool we register; THIS extension
 * materializes the next iteration with setTimeout, re-injecting the prompt via
 * pi.sendUserMessage. The goal lives in the extension's Node process.
 *
 * P0 scope:
 * - command: /goal <objective> [-- <criteria>], /goal stop [id], /goal status [id]
 * - tool: goal_progress({status, assessment, nextStep?, blocker?, waitSeconds?})
 * - engine: fireGoal / scheduleGoal / advanceGoal / startGoal / stopGoal
 * - state machine: pursuing -> verifying -> done | blocked | stopped | stale
 * - completeness check: a first `done` does NOT stop; it transitions to `verifying`
 *   and re-injects a verification prompt. Only a `done` confirmed FROM `verifying` stops.
 * - state: activeGoals Map + persistence via pi.appendEntry("goal-state", ...) + atomic sidecar
 *
 * P1 scope (ADDITIVE — independent adversarial verification of "done"):
 * - The P0 completeness check is a SELF-CHECK: the SAME agent re-evaluates in `verifying`.
 *   P1 escalates the model's CONFIRMED done into an INDEPENDENT verdict: when the model
 *   would close the goal (a `done` confirmed FROM `verifying`), the EXTENSION does not stop.
 *   It transitions to a new `verifying-independent` state and spawns a SEPARATE, skeptical
 *   subagent (`pi -p --no-session --no-extensions`, READ-ONLY tools) that judges the
 *   OBJECTIVE against the CRITERIA using only the recorded evidence/progress log, and emits
 *   a PARSEABLE verdict (`VERDICT: PASS` | `VERDICT: FAIL`). Only an independent PASS closes
 *   the goal as `done`.
 * - Subagent mechanism mirrors extensions/dynamic-workflows/index.ts runSubagent: piCommand =
 *   process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND || "pi"; args ["-p","--no-session",
 *   "--no-extensions", "--tools",<read-only>, model?, prompt]; pi.exec(cmd,args,{cwd,timeout,
 *   signal}). It runs OUTSIDE the model turn (own process): it does NOT call pi.sendUserMessage
 *   during the verdict, so it never fires the wake or the agent_end gate while it runs.
 * - FAIL → re-inject ONE normal `continue` iteration carrying the verifier's feedback as the
 *   nextStep, and bump verifyAttempts. A CAP (maxIndependentVerifications, default 2) of
 *   FAILED independent verifications → stopGoal("blocked") with the feedback (needs a human).
 *   Never an infinite loop.
 * - Config (defaults): verifierTools (read-only ["read","grep","find","ls"]),
 *   verifierTimeoutMs (120000), maxIndependentVerifications (2).
 * - state machine grows: pursuing -> verifying -> verifying-independent -> done | (continue→
 *   pursuing) | blocked. All P0 gates/caps/persistence/rehydrate stay intact.
 * - rehydrate on session_start (no double-fire; single catch-up tick)
 * - cleanup on session_shutdown (clearTimeout + abort + persist "stale")
 * - safety net on agent_end
 * - status line
 *
 * Hard rules (mirrored from the /loop family):
 * - print/json gate: only tui/rpc can sustain a goal; never re-inject elsewhere.
 * - clamp waitSeconds to [MIN, MAX] INSIDE execute() (do not trust the model).
 * - the heuristic / decision policy lives in goal_progress promptGuidelines, not in code.
 * - no new deps (typebox is already present).
 * - defaults: maxIterations = 30; best-effort context-budget cut via ctx.getContextUsage().
 * - on "fork" do NOT migrate the goal.
 *
 * AUTONOMOUS: this file does not import from extensions/loop/index.ts; patterns are copied.
 */

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatEta } from "./time.js";
import { notify } from "../shared/notify.js";
import { collectLatestByKey } from "../shared/session-state.js";

const GOAL_STATE_TYPE = "goal-state";
const GOAL_STATUS_KEY = "goal";
const GOAL_DIR = "goals";
const STATE_FILE = "state.json";
const DEFAULT_MAX_ITERATIONS = 30;
// Optional external-wait bounds (seconds): the model only sets waitSeconds when it is
// waiting on a real external signal; by default re-injection is immediate (delay 0).
const MIN_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 3600;
// Safety-net cadence when a turn closed without the model calling goal_progress.
const SAFETY_NET_DELAY_SECONDS = 1500;
// Best-effort context-usage percent cap (stop if getContextUsage().percent exceeds).
const DEFAULT_CONTEXT_PERCENT_CAP = 90;
// How many recent assessments to keep in the progress log (bounded continuity).
const PROGRESS_LOG_KEEP = 12;
// How many failed verifications (done → verifying → continue) we tolerate before we
// stop the goal as blocked. Defends against a "self-declares done, fails the check,
// keeps going" ping-pong silently burning the whole iteration budget without progress.
const MAX_VERIFY_ATTEMPTS = 3;

// --- P1: independent adversarial verification (defaults) ---------------------
// The verifier subagent (separate `pi -p` process) gets READ-ONLY tools only: it
// judges, it never mutates the workspace.
const DEFAULT_VERIFIER_TOOLS = ["read", "grep", "find", "ls"] as const;
// Wall-clock budget for one independent verification (ms). Generous: the subagent may
// read files and run a few greps before emitting its verdict.
const DEFAULT_VERIFIER_TIMEOUT_MS = 120_000;
// How many FAILED independent verifications we tolerate before stopping as blocked.
// Small on purpose: a model that keeps claiming done while an independent judge keeps
// failing it needs a human, not more turns.
const DEFAULT_MAX_INDEPENDENT_VERIFICATIONS = 2;
// pi command used to spawn the verifier subagent (mirrors dynamic-workflows.ts).
const PI_COMMAND = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND || "pi";

type GoalStatus =
	| "pursuing"
	| "verifying"
	| "verifying-independent"
	| "done"
	| "blocked"
	| "stopped"
	| "stale";
type GoalDecision = "continue" | "done" | "blocked";

interface GoalAssessment {
	iteration: number;
	status: GoalDecision;
	assessment: string;
	nextStep?: string;
	at: string;
}

interface GoalState {
	goalId: string;
	objective: string;
	/** Success criteria supplied by the user via `-- <criteria>`, if any. */
	successCriteria?: string;
	/** Criteria DERIVED by the model in iteration 1 when the user gave none (S2). */
	derivedCriteria?: string;
	iteration: number;
	maxIterations: number;
	/** Best-effort context-usage percent cap. */
	contextPercentCap: number;
	/** Bounded history of self-assessments (sliced to PROGRESS_LOG_KEEP at persist). */
	assessments: GoalAssessment[];
	/** Count of completeness checks that FAILED (verifying → continue). Caps verify ping-pong. */
	verifyAttempts: number;
	/** P1: count of INDEPENDENT verifications that returned FAIL. Caps the independent ping-pong. */
	independentVerifyAttempts: number;
	/** P1: max FAILED independent verifications tolerated before blocking (config, default 2). */
	maxIndependentVerifications: number;
	/** P1: wall-clock budget (ms) for one independent verification subagent (config). */
	verifierTimeoutMs: number;
	/** P1: read-only tools handed to the verifier subagent (config). */
	verifierTools: string[];
	gstatus: GoalStatus;
	startedAt: number;
	nextFireAt: number | null;
	lastReason?: string;
	/** ISO timestamp of the last write; used to resolve JSONL-vs-sidecar conflicts. */
	updatedAt: string;
}

interface ActiveGoal extends GoalState {
	timer: ReturnType<typeof setTimeout> | null;
	controller: AbortController;
	/** True once a wake was (re)armed in the current turn; reset on each fire. */
	rearmedThisTurn: boolean;
	/** P1: true while an independent verifier subagent is in flight (debounces re-launch). */
	verifierInFlight: boolean;
}

// Source of truth of "which timers live NOW". Map supports several, but P0 tools
// resolve the single active goal (S4).
const activeGoals = new Map<string, ActiveGoal>();

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** The effective criteria text: user-supplied wins, else model-derived, else none yet. */
function effectiveCriteria(goal: GoalState): string | undefined {
	if (goal.successCriteria && goal.successCriteria.trim()) return goal.successCriteria.trim();
	if (goal.derivedCriteria && goal.derivedCriteria.trim()) return goal.derivedCriteria.trim();
	return undefined;
}

/** Compact progress log of the last N assessments, for continuity without re-reading the session. */
function formatProgressLog(goal: GoalState): string[] {
	const lines: string[] = [];
	const recent = goal.assessments.slice(-PROGRESS_LOG_KEEP);
	if (recent.length === 0) return lines;
	lines.push("PROGRESS LOG (most recent last):");
	for (const a of recent) {
		const step = a.nextStep ? ` next: ${a.nextStep}` : "";
		lines.push(`- it ${a.iteration} [${a.status}] ${a.assessment}${step}`);
	}
	return lines;
}

/** Stable iteration-prompt mold re-injected each `pursuing` iteration. */
function makeGoalIterationPrompt(goal: GoalState): string {
	const lines: string[] = [];
	lines.push(`You are pursuing a /goal (goal ${goal.goalId}).`);
	lines.push("");
	lines.push("OBJECTIVE (verbatim):");
	lines.push(goal.objective);
	lines.push("");

	const criteria = effectiveCriteria(goal);
	if (criteria) {
		lines.push("SUCCESS CRITERIA (definition-of-done):");
		lines.push(criteria);
	} else {
		lines.push("SUCCESS CRITERIA: none were provided.");
		lines.push(
			"FIRST, derive 2-5 concrete, VERIFIABLE success criteria from the objective (each checkable by a command, a test, or an inspectable artifact). State them explicitly in your reply; they will be recorded as the definition-of-done for the rest of this goal.",
		);
	}
	lines.push("");

	const log = formatProgressLog(goal);
	if (log.length) {
		lines.push(...log);
		lines.push("");
	}

	lines.push(`This is iteration ${goal.iteration}/${goal.maxIterations}.`);
	if (goal.lastReason) lines.push(`Previous decision: ${goal.lastReason}`);
	lines.push("");
	lines.push("Do work toward the objective now. THEN self-evaluate against the success criteria and call goal_progress:");
	lines.push("- status \"continue\" (with a concrete nextStep) if criteria are not yet all met.");
	lines.push(
		"- status \"done\" only when you believe EVERY criterion is met; you will then get one verification turn before the goal closes.",
	);
	lines.push("- status \"blocked\" if you cannot progress without a human decision/credential/access (explain the blocker).");
	lines.push(
		`If you call neither, the goal will defensively re-arm and will hard-stop at iteration ${goal.maxIterations}.`,
	);
	return lines.join("\n");
}

/** Verification-prompt mold, injected only in the `verifying` state (the completeness check). */
function makeGoalVerificationPrompt(goal: GoalState): string {
	const lines: string[] = [];
	lines.push(`COMPLETENESS CHECK for /goal ${goal.goalId}.`);
	lines.push("");
	lines.push("OBJECTIVE (verbatim):");
	lines.push(goal.objective);
	lines.push("");
	const criteria = effectiveCriteria(goal);
	if (criteria) {
		lines.push("SUCCESS CRITERIA (definition-of-done):");
		lines.push(criteria);
		lines.push("");
	}
	lines.push("You declared the objective complete. Do NOT do new work now. VERIFY adversarially:");
	lines.push(
		"- For EACH success criterion, present concrete evidence that it is met (a command you ran and its output, a test that passed, a file that exists). Do not assert; show.",
	);
	lines.push("- If every criterion is supported by evidence, call goal_progress({status:\"done\", assessment}) to CONFIRM and close the goal.");
	lines.push(
		"- If any criterion fails or the evidence is missing, call goal_progress({status:\"continue\", nextStep}) describing exactly what still has to be done.",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// P1: independent adversarial verifier (separate subagent process)
// ---------------------------------------------------------------------------

interface VerifierVerdict {
	pass: boolean;
	/** The full reasoning text (last block) the verifier produced; surfaced as feedback. */
	feedback: string;
	/** True when no parseable verdict was found (treated as FAIL to stay conservative). */
	unparsed: boolean;
}

/**
 * Prompt for the INDEPENDENT verifier. Fresh eyes, skeptical, READ-ONLY: it is told it is
 * not the author, must trust nothing on faith, must judge EACH criterion against concrete
 * evidence (the progress log + what it can read/grep in the workspace), and must end with a
 * single PARSEABLE verdict line. We pass the recorded evidence so the subagent (which has no
 * session) has the same context the model accumulated.
 */
function makeIndependentVerifierPrompt(goal: GoalState): string {
	const lines: string[] = [];
	lines.push(
		"You are an INDEPENDENT, SKEPTICAL verifier. You did NOT do this work. Your job is to decide whether an objective is genuinely complete against its success criteria. Trust nothing on faith: an agent has CLAIMED it is done, and agents are routinely wrong.",
	);
	lines.push("");
	lines.push("OBJECTIVE (verbatim):");
	lines.push(goal.objective);
	lines.push("");
	const criteria = effectiveCriteria(goal);
	if (criteria) {
		lines.push("SUCCESS CRITERIA (definition-of-done):");
		lines.push(criteria);
	} else {
		lines.push("SUCCESS CRITERIA: none were stated explicitly; infer the minimal verifiable bar from the objective and judge against it.");
	}
	lines.push("");
	const log = formatProgressLog(goal);
	if (log.length) {
		lines.push("EVIDENCE the working agent recorded (its own claims — verify, do not assume true):");
		lines.push(...log);
		lines.push("");
	}
	lines.push("INSTRUCTIONS:");
	lines.push(
		"- You have READ-ONLY tools. Inspect the workspace (read files, grep, find, ls) to confirm or refute the claims. Do NOT modify anything.",
	);
	lines.push("- Judge EACH success criterion separately. For each, state PASS or FAIL and cite the CONCRETE evidence you found (a file's contents, a match, an absence). A claim without verifiable evidence is a FAIL.");
	lines.push("- Be adversarial: look for the criterion that was quietly skipped, the test that does not actually assert, the file that is empty.");
	lines.push("");
	lines.push(
		"OUTPUT: a short per-criterion judgment, THEN on the FINAL line emit EXACTLY one of:",
	);
	lines.push("VERDICT: PASS   (only if EVERY criterion is met with evidence)");
	lines.push("VERDICT: FAIL   (if ANY criterion is unmet, unverifiable, or evidence is missing)");
	lines.push("The final line MUST start with 'VERDICT:'. Do not add text after it.");
	return lines.join("\n");
}

/** Build the verifier subagent argv, mirroring dynamic-workflows.ts buildAgentArgs (subset). */
function buildVerifierArgs(goal: ActiveGoal, model: string | undefined, prompt: string): string[] {
	const args = ["-p", "--no-session", "--no-extensions"];
	// Ignore project-local config for a clean, reproducible judge run. NOTE: --no-approve does
	// NOT restrict tools — read-only is enforced solely by the --tools allowlist below.
	args.push("--no-approve");
	// READ-ONLY: the allowlist is the guarantee. Without one, pi starts with the DEFAULT toolset
	// (which includes write/edit/bash), so an empty list must DISABLE tools (--no-tools), never
	// fall through to a mutating default.
	if (goal.verifierTools.length) args.push("--tools", goal.verifierTools.join(","));
	else args.push("--no-tools");
	if (model) args.push("--model", model);
	args.push(prompt);
	return args;
}

/** Same model selector dynamic-workflows.ts uses (provider/id), best-effort. */
function modelArg(ctx: ExtensionContext): string | undefined {
	const model = (ctx as { model?: { provider: string; id: string } }).model;
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}

/**
 * Parse the verdict out of the subagent stdout. The prompt REQUIRES the verdict on the final
 * line, so we anchor on the last non-empty line first: a real PASS lives there. Only if that
 * line carries no verdict do we fall back to the last `VERDICT:` match anywhere. This makes a
 * spurious PASS impossible to forge by echoing the prompt's own instruction lines (which list
 * both "VERDICT: PASS" and "VERDICT: FAIL") earlier in the message — the last non-empty line is
 * the model's actual closing verdict. Any ambiguity (no verdict found) stays a conservative FAIL.
 */
function parseVerdict(stdout: string): VerifierVerdict {
	const text = (stdout || "").trim();
	const lineRe = /VERDICT:\s*(PASS|FAIL)/i;
	// Anchor on the last non-empty line (the required final verdict line).
	const lines = text.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		const m = line.match(lineRe);
		if (m) {
			return { pass: m[1].toUpperCase() === "PASS", feedback: text, unparsed: false };
		}
		// Last non-empty line exists but has no verdict → fall through to a whole-text scan
		// rather than trusting a non-final line; break so we don't keep walking up blindly.
		break;
	}
	// Fallback: scan the whole text, last match wins (handles a trailing blank/format drift).
	const matches = [...text.matchAll(/VERDICT:\s*(PASS|FAIL)/gi)];
	if (matches.length === 0) {
		// No parseable verdict → conservative FAIL (never silently close on a malformed judge).
		return { pass: false, feedback: text || "verifier produced no parseable verdict", unparsed: true };
	}
	const last = matches[matches.length - 1];
	const pass = last[1].toUpperCase() === "PASS";
	return { pass, feedback: text, unparsed: false };
}

/**
 * Run ONE independent verification in a SEPARATE process. Read-only, skeptical, fresh eyes.
 * Returns a parsed verdict. Runs OUTSIDE the model turn: it does not touch pi.sendUserMessage,
 * so it neither fires the wake nor the agent_end gate while it executes. Any exec failure
 * (non-zero exit, timeout/kill, thrown error) is treated as a conservative FAIL with feedback
 * — we never close a goal on a verifier that did not actually return PASS.
 */
async function runIndependentVerifier(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
): Promise<VerifierVerdict> {
	const prompt = makeIndependentVerifierPrompt(goal);
	const args = buildVerifierArgs(goal, modelArg(ctx), prompt);
	try {
		const result = await pi.exec(PI_COMMAND, args, {
			cwd: ctx.cwd,
			timeout: goal.verifierTimeoutMs,
			signal: goal.controller.signal,
		});
		if (result.killed) {
			return { pass: false, feedback: `verifier timed out after ${goal.verifierTimeoutMs}ms`, unparsed: true };
		}
		const verdict = parseVerdict(result.stdout);
		// A non-zero exit with an explicit PASS is contradictory; do not trust it.
		if (result.code !== 0 && verdict.pass) {
			return {
				pass: false,
				feedback: `verifier exited ${result.code} despite a PASS line; treating as FAIL. ${verdict.feedback}`,
				unparsed: false,
			};
		}
		return verdict;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { pass: false, feedback: `verifier could not run: ${msg}`, unparsed: true };
	}
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function setGoalStatus(ctx: ExtensionContext, goal: GoalState): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const phase =
		goal.gstatus === "verifying" ? " verifying" : goal.gstatus === "verifying-independent" ? " verifying⊥" : "";
	const eta =
		(goal.gstatus === "pursuing" || goal.gstatus === "verifying") && goal.nextFireAt
			? ` next ${formatEta(goal.nextFireAt)}`
			: "";
	const reason = goal.lastReason ? ` · ${goal.lastReason}` : "";
	ctx.ui.setStatus(
		GOAL_STATUS_KEY,
		`${theme.fg("accent", "◎ goal")} ${theme.fg("dim", `it ${goal.iteration}/${goal.maxIterations}${phase}${eta}${reason}`)}`,
	);
}

function clearGoalStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
}

/** Refresh status from whatever goal is currently active (pursuing/verifying), if any. */
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
// Persistence
// ---------------------------------------------------------------------------

function snapshot(goal: ActiveGoal): GoalState {
	return {
		goalId: goal.goalId,
		objective: goal.objective,
		successCriteria: goal.successCriteria,
		derivedCriteria: goal.derivedCriteria,
		iteration: goal.iteration,
		maxIterations: goal.maxIterations,
		contextPercentCap: goal.contextPercentCap,
		// Bound the persisted log so the JSONL entry never grows without limit.
		assessments: goal.assessments.slice(-PROGRESS_LOG_KEEP),
		verifyAttempts: goal.verifyAttempts,
		independentVerifyAttempts: goal.independentVerifyAttempts,
		maxIndependentVerifications: goal.maxIndependentVerifications,
		verifierTimeoutMs: goal.verifierTimeoutMs,
		verifierTools: goal.verifierTools,
		gstatus: goal.gstatus,
		startedAt: goal.startedAt,
		nextFireAt: goal.nextFireAt,
		lastReason: goal.lastReason,
		updatedAt: goal.updatedAt,
	};
}

/**
 * Persist a goal transition. Stamps `updatedAt`, appends to the session JSONL (does NOT
 * go to the LLM), and fire-and-forgets an ATOMIC sidecar write for crash recovery.
 */
function persist(pi: ExtensionAPI, ctx: ExtensionContext, goal: ActiveGoal): void {
	goal.updatedAt = new Date().toISOString();
	const snap = snapshot(goal);
	pi.appendEntry<GoalState>(GOAL_STATE_TYPE, snap);
	void writeSidecar(ctx, snap).catch(() => {});
}

/**
 * Dual-root state dir:
 * - trusted project → <cwd>/.pi/goals/<id>
 * - otherwise       → <agentDir>/goals/<projectHash>/<id>
 */
function goalStateDir(ctx: ExtensionContext, goalId: string): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, GOAL_DIR, goalId);
	const projectHash = crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 12);
	return path.join(getAgentDir(), GOAL_DIR, projectHash, goalId);
}

/** Atomic write: temp file then rename, so a crash mid-write never truncates state.json. */
async function writeSidecar(ctx: ExtensionContext, state: GoalState): Promise<void> {
	const dir = goalStateDir(ctx, state.goalId);
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, STATE_FILE);
	const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	try {
		await fs.rename(temp, file);
	} catch (err) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Wake / scheduling
// ---------------------------------------------------------------------------

/**
 * A goal can only run where the agent loop is interactive enough to re-inject a
 * prompt and resume on its own: TUI and RPC. "print" is one-shot, "json" is
 * non-interactive — neither can sustain a goal.
 */
function canGoalInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

function wake(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	// Mode gate: never re-inject outside tui/rpc (defends rehydrate paths too).
	if (!canGoalInMode(ctx)) return;
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

/**
 * Best-effort context-budget gate. Returns a stop-reason string if the context-usage
 * percent exceeds the cap, else undefined. `percent` may be null right after compaction
 * (per types.d.ts), in which case we do NOT cut.
 */
function contextBudgetExceeded(ctx: ExtensionContext, goal: ActiveGoal): string | undefined {
	const usage = ctx.getContextUsage?.();
	if (usage && usage.percent !== null && usage.percent >= goal.contextPercentCap) {
		return `context budget exhausted (${Math.round(usage.percent)}% ≥ ${goal.contextPercentCap}%)`;
	}
	return undefined;
}

/**
 * Fire one iteration. Guards status, enforces maxIterations + context budget, then
 * re-injects the prompt appropriate to the current phase (iteration vs verification).
 */
function fireGoal(pi: ExtensionAPI, ctx: ExtensionContext, goal: ActiveGoal): void {
	goal.timer = null;
	if (goal.gstatus !== "pursuing" && goal.gstatus !== "verifying") return;

	if (goal.iteration >= goal.maxIterations) {
		stopGoal(pi, ctx, goal.goalId, `reached maxIterations (${goal.maxIterations})`, "stopped");
		notify(ctx, `Goal ${goal.goalId} stopped: reached maxIterations (${goal.maxIterations}).`, "warning");
		return;
	}

	// Best-effort budget gate before doing any work.
	const budget = contextBudgetExceeded(ctx, goal);
	if (budget) {
		stopGoal(pi, ctx, goal.goalId, budget, "stopped");
		notify(ctx, `Goal ${goal.goalId} stopped: ${budget}. You can /compact and resume.`, "warning");
		return;
	}

	goal.iteration += 1;
	goal.nextFireAt = null;
	goal.rearmedThisTurn = false;
	persist(pi, ctx, goal);
	setGoalStatus(ctx, goal);
	const prompt = goal.gstatus === "verifying" ? makeGoalVerificationPrompt(goal) : makeGoalIterationPrompt(goal);
	wake(pi, ctx, prompt);
}

/**
 * Arm the next wake after delaySec (0 = immediate via setTimeout(…, 0)). Caller is
 * responsible for clamping. Used by advanceGoal and the verification transition.
 */
function scheduleGoal(pi: ExtensionAPI, ctx: ExtensionContext, goal: ActiveGoal, delaySec: number, reason: string): void {
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
 * Record a self-assessment and arm the next `pursuing` iteration. `continue` keeps the
 * goal in `pursuing`; a failed verification (`continue` from `verifying`) drops back to
 * `pursuing` too. Cadence is immediate (delay 0) unless waitSeconds was given (clamped).
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
 * P1: the model has CONFIRMED done from `verifying`. Instead of P0's immediate close, run
 * an INDEPENDENT adversarial verifier (separate process, fresh eyes). Transition to
 * `verifying-independent`, launch the subagent, then resolve:
 *   - PASS                       → stopGoal(done) (finally closed, independently confirmed).
 *   - FAIL (under cap)           → record the verifier feedback as a progress assessment and
 *                                  re-inject ONE normal `continue` iteration with that feedback
 *                                  as nextStep; bump independentVerifyAttempts.
 *   - FAIL (cap reached)         → stopGoal(blocked) with the feedback (needs a human).
 * The subagent runs OUTSIDE the model turn; this function only re-injects (wake) AFTER the
 * verdict, exactly like a `continue`, so the gate semantics are unchanged.
 *
 * Concurrency: guarded by verifierInFlight so a stray re-entry (e.g. a duplicate confirm)
 * cannot launch two verifiers for the same goal.
 */
async function beginIndependentVerification(pi: ExtensionAPI, ctx: ExtensionContext, goal: ActiveGoal): Promise<void> {
	if (goal.verifierInFlight) return;
	// Park the goal in the independent-verification phase. No timer is armed: the goal is
	// neither pursuing nor (self-)verifying, so fireGoal / the agent_end safety net leave it
	// alone while the external judge runs.
	if (goal.timer) {
		clearTimeout(goal.timer);
		goal.timer = null;
	}
	goal.verifierInFlight = true;
	goal.gstatus = "verifying-independent";
	goal.nextFireAt = null;
	goal.lastReason = "independent verification in progress";
	persist(pi, ctx, goal);
	setGoalStatus(ctx, goal);

	const verdict = await runIndependentVerifier(pi, ctx, goal);
	goal.verifierInFlight = false;

	// The goal may have been stopped (user /goal stop, shutdown) while the verifier ran.
	const live = activeGoals.get(goal.goalId);
	if (!live || live !== goal || goal.gstatus !== "verifying-independent") return;

	const at = new Date().toISOString();
	if (verdict.pass) {
		goal.assessments.push({
			iteration: goal.iteration,
			status: "done",
			assessment: `independent verifier PASS: ${verdict.feedback}`.slice(0, 2000),
			at,
		});
		stopGoal(pi, ctx, goal.goalId, "done: independently verified against success criteria", "done");
		notify(ctx, `Goal ${goal.goalId} DONE: independently verified (fresh-eyes subagent confirmed).`, "info");
		return;
	}

	// FAIL. Count it; if we have exhausted the independent-verification budget, block.
	goal.independentVerifyAttempts += 1;
	const feedback = verdict.feedback.trim() || "independent verifier rejected the claim without detail";
	if (goal.independentVerifyAttempts >= goal.maxIndependentVerifications) {
		goal.assessments.push({
			iteration: goal.iteration,
			status: "blocked",
			assessment: `independent verifier FAIL (${goal.independentVerifyAttempts}/${goal.maxIndependentVerifications}): ${feedback}`.slice(
				0,
				2000,
			),
			at,
		});
		const blocker = `independent verification failed ${goal.independentVerifyAttempts} time(s); last verdict: ${feedback}`;
		stopGoal(pi, ctx, goal.goalId, `blocked: ${blocker}`, "blocked");
		notify(
			ctx,
			`Goal ${goal.goalId} is BLOCKED: independent verification kept failing (needs a human). ${feedback}`,
			"warning",
		);
		return;
	}

	// Under the cap → re-inject one normal pursuing iteration carrying the verifier feedback
	// so the model fixes exactly what the independent judge faulted. Immediate (delay 0),
	// identical mechanics to a `continue`.
	const assessment: GoalAssessment = {
		iteration: goal.iteration,
		status: "continue",
		assessment: `independent verifier FAIL (${goal.independentVerifyAttempts}/${goal.maxIndependentVerifications}): ${feedback}`.slice(
			0,
			2000,
		),
		nextStep: `Address the independent verifier's findings before re-declaring done: ${feedback}`.slice(0, 2000),
		at,
	};
	advanceGoal(pi, ctx, goal, assessment, 0, "independent verification failed → continue");
	notify(ctx, `Goal ${goal.goalId}: independent verifier returned FAIL; iterating again.`, "info");
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

/**
 * Parse `/goal` start args. Convention: if the text contains the ` -- ` separator, the
 * left side is the objective and the right side is the success criteria (free text).
 * Without it, the whole text is the objective (the model derives criteria, S2).
 */
function parseGoalArgs(args: string): { objective: string; successCriteria?: string } {
	const SEP = " -- ";
	const idx = args.indexOf(SEP);
	if (idx === -1) return { objective: args.trim() };
	const objective = args.slice(0, idx).trim();
	const successCriteria = args.slice(idx + SEP.length).trim();
	return { objective, successCriteria: successCriteria || undefined };
}

function startGoal(pi: ExtensionAPI, ctx: ExtensionContext, args: string): ActiveGoal | undefined {
	// Mode gate: only TUI/RPC can sustain a persistent goal session.
	if (!canGoalInMode(ctx)) {
		notify(ctx, "/goal requires a TUI or RPC session (this mode cannot run a goal).", "error");
		return undefined;
	}
	// Single active goal at a time: the P0 tool (goal_progress) carries no goalId and resolves
	// the one active goal, so a second concurrent goal would make reports ambiguous and let two
	// goals fight over wake re-injection. Refuse to start a second; the user stops the first.
	const existing = activeGoal();
	if (existing) {
		notify(
			ctx,
			`A goal is already active (${existing.goalId}: ${existing.objective}). Stop it first with /goal stop.`,
			"warning",
		);
		return undefined;
	}
	const { objective, successCriteria } = parseGoalArgs(args);
	if (!objective) {
		notify(ctx, "Usage: /goal <objective> [-- <success criteria>]", "warning");
		return undefined;
	}

	const goalId = crypto.randomBytes(4).toString("hex");
	const goal: ActiveGoal = {
		goalId,
		objective,
		successCriteria,
		derivedCriteria: undefined,
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

	// Send the first iteration prompt immediately. fireGoal handles iteration++/persist/status.
	fireGoal(pi, ctx, goal);
	const crit = successCriteria ? " (with criteria)" : " (model will derive criteria)";
	notify(ctx, `Started goal ${goalId}${crit}: ${objective}`, "info");
	return goal;
}

/**
 * Resolve a goal by id, the unique candidate, or via ui.select. `statuses` filters
 * which goals are eligible. Defaults to active (pursuing/verifying).
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
			"Which goal?",
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
	refreshGoalStatus(ctx);
	return true;
}

/** The single active goal (pursuing, self-verifying, or independently verifying), or undefined. */
function activeGoal(): ActiveGoal | undefined {
	return [...activeGoals.values()].find(
		(g) => g.gstatus === "pursuing" || g.gstatus === "verifying" || g.gstatus === "verifying-independent",
	);
}

// ---------------------------------------------------------------------------
// Rehydration (session_start)
// ---------------------------------------------------------------------------

/**
 * Rebuild goal state from persisted entries (last-wins by goalId) and re-arm active
 * goals. Avoids double-fire: if activeGoals already has the goal (timer alive in this
 * process), skip. Only a SINGLE catch-up tick — no replay of N missed wakes.
 */
function rehydrate(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getEntries();
	const latest = collectLatestByKey<GoalState>(entries, GOAL_STATE_TYPE, (d) => d.goalId);

	for (const state of latest.values()) {
		// Recover goals that were live ("pursuing"/"verifying"/"verifying-independent") or
		// cleanly parked ("stale").
		if (
			state.gstatus !== "pursuing" &&
			state.gstatus !== "verifying" &&
			state.gstatus !== "verifying-independent" &&
			state.gstatus !== "stale"
		) {
			continue;
		}
		// Timer still alive in this process → do not re-arm (no double-fire).
		if (activeGoals.has(state.goalId)) continue;

		const goal: ActiveGoal = {
			...state,
			// A recovered "stale" snapshot resumes pursuing; a "verifying" snapshot resumes
			// verifying (the completeness check survives a reload); a "verifying-independent"
			// snapshot resumes by re-running the independent verifier below (its verdict was
			// lost on crash, so we re-judge rather than guess).
			gstatus: state.gstatus === "stale" ? "pursuing" : state.gstatus,
			assessments: Array.isArray(state.assessments) ? state.assessments : [],
			verifyAttempts: typeof state.verifyAttempts === "number" ? state.verifyAttempts : 0,
			// Backfill P1 fields for snapshots written by a pre-P1 build (defensive defaults).
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
			// Resume the lost independent verification: re-launch the subagent (no timer; the
			// async verdict drives the next transition). Single launch — verifierInFlight guards.
			void beginIndependentVerification(pi, ctx, goal);
			continue;
		}

		const remaining = goal.nextFireAt === null ? 0 : Math.max(0, goal.nextFireAt - Date.now());
		// Single catch-up tick (clamped to >= 0); never a burst.
		goal.timer = setTimeout(() => fireGoal(pi, ctx, goal), remaining);
	}
	refreshGoalStatus(ctx);
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

function formatStatus(goal: GoalState): string {
	const phase =
		goal.gstatus === "verifying"
			? " (verifying)"
			: goal.gstatus === "verifying-independent"
				? " (independent verification)"
				: "";
	const eta = goal.gstatus === "pursuing" || goal.gstatus === "verifying" ? `, next ${formatEta(goal.nextFireAt)}` : "";
	const reason = goal.lastReason ? `, reason: ${goal.lastReason}` : "";
	return `${goal.goalId} [${goal.gstatus}]${phase} it ${goal.iteration}/${goal.maxIterations}${eta}${reason} — ${goal.objective}`;
}

async function handleGoalCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const trimmed = args.trim();
	const firstSpace = trimmed.indexOf(" ");
	const firstToken = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

	// "stop"/"status" are only subcommands when they are the WHOLE first token AND there
	// is no ` -- ` criteria separator capturing them as part of an objective.
	const hasCriteriaSeparator = trimmed.includes(" -- ");
	if (firstToken === "stop" && !hasCriteriaSeparator) {
		const goal = await resolveGoal(ctx, rest || undefined);
		if (!goal) {
			notify(ctx, "No matching goal to stop.", "warning");
			return;
		}
		stopGoal(pi, ctx, goal.goalId, "stopped by user (/goal stop)", "stopped");
		notify(ctx, `Stopped goal ${goal.goalId}.`, "info");
		return;
	}

	if (firstToken === "status" && !hasCriteriaSeparator) {
		if (rest) {
			const goal = activeGoals.get(rest);
			notify(ctx, goal ? formatStatus(goal) : `No goal with id ${rest}.`, goal ? "info" : "warning");
			return;
		}
		const all = [...activeGoals.values()];
		if (all.length === 0) {
			notify(ctx, "No goals.", "info");
			return;
		}
		notify(ctx, all.map(formatStatus).join("\n"), "info");
		return;
	}

	// Otherwise: the whole args is the objective (possibly with ` -- ` criteria).
	startGoal(pi, ctx, trimmed);
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default function goalExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "goal_progress",
		label: "Goal Progress",
		description:
			"Report progress on the active /goal after self-evaluating against its success criteria. The ONLY way to advance, finish, or block a goal.",
		promptSnippet: "Report /goal progress: self-evaluate vs the success criteria and decide continue/done/blocked.",
		promptGuidelines: [
			"Before declaring `done`, confront EACH success criterion with concrete, verifiable evidence (a command you ran, a test that passed, a file that exists). Never declare `done` on intuition.",
			"After a first `done`, you will receive a VERIFICATION turn: review your own work adversarially. Only confirm `done` if the evidence supports every criterion; otherwise return `continue` with the missing nextStep.",
			"Confirming `done` from the verification turn does NOT close the goal: an INDEPENDENT verifier (a separate, skeptical subagent with fresh eyes and read-only access) then judges the objective against the criteria using your recorded evidence. It closes only if that independent verifier returns PASS. So leave durable, inspectable evidence (committed files, passing tests, artifacts) — not just claims in your assessment — because a third party must be able to confirm each criterion without trusting you.",
			"If the independent verifier returns FAIL, you will get a `continue` iteration carrying its findings as the nextStep; fix exactly what it faulted before re-declaring done. Repeated independent FAILs will block the goal for a human.",
			"`continue` requires an actionable `nextStep`. If there is no next step, you are either `done` or `blocked`.",
			"`blocked` is for what no number of your own iterations can resolve (a human decision, credential, or access). Explain the `blocker` in one sentence.",
			"`waitSeconds` only when you are waiting on a real external signal (a deploy, a job). By default do NOT wait — the next iteration fires immediately.",
			"`assessment` is always required: one or two sentences on where you stand versus the criteria. It is recorded in the progress log and re-injected for continuity.",
		],
		parameters: Type.Object({
			status: Type.Union([Type.Literal("continue"), Type.Literal("done"), Type.Literal("blocked")], {
				description: "continue = keep iterating; done = you believe all criteria are met; blocked = need a human.",
			}),
			assessment: Type.String({
				minLength: 3,
				description: "Self-evaluation against the success criteria (where you stand and why).",
			}),
			nextStep: Type.Optional(
				Type.String({ description: "Required when status is 'continue': the next actionable step." }),
			),
			blocker: Type.Optional(
				Type.String({ description: "Required when status is 'blocked': the human decision/access needed." }),
			),
			// No schema bounds on waitSeconds on purpose: the SDK rejects out-of-range args
			// BEFORE execute() runs, so min/max here would throw instead of letting us clamp.
			waitSeconds: Type.Optional(
				Type.Number({
					description: `Optional: seconds to wait before the next iteration when waiting on an external signal; clamped to [${MIN_WAIT_SECONDS}, ${MAX_WAIT_SECONDS}]. Default 0 (immediate).`,
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const goal = activeGoal();
			if (!goal) {
				return {
					content: [{ type: "text" as const, text: "No active goal. There is nothing to report progress on." }],
					details: { isError: true },
				};
			}

			// An INDEPENDENT verifier is judging this goal right now (separate process, launched
			// from a prior confirmed `done`). Its verdict — not this call — decides the outcome.
			// Reject any re-entrant goal_progress so it cannot mutate gstatus out from under the
			// in-flight verdict (which would corrupt the state machine and silently discard it).
			if (goal.gstatus === "verifying-independent") {
				return {
					content: [
						{
							type: "text" as const,
							text: `Goal ${goal.goalId} is under INDEPENDENT verification right now; that verdict (not this report) decides whether it closes. Wait for it — this report was not recorded.`,
						},
					],
					details: { goalId: goal.goalId, status: "verifying-independent", ignored: true },
				};
			}

			// Clamp waitSeconds INSIDE execute() — never trust the model. Absent/0/non-finite
			// → immediate (delay 0). A finite positive value is clamped to [MIN, MAX].
			const raw = params.waitSeconds;
			let delaySec = 0;
			if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
				delaySec = Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, Math.round(raw)));
			}

			const assessmentEntry: GoalAssessment = {
				iteration: goal.iteration,
				status: params.status,
				assessment: params.assessment,
				nextStep: params.nextStep,
				at: new Date().toISOString(),
			};

			// If criteria were derived this turn (no user criteria yet), capture the model's
			// assessment text as the derived definition-of-done so later iterations carry it.
			if (!goal.successCriteria && !goal.derivedCriteria && goal.iteration <= 1) {
				goal.derivedCriteria = params.assessment;
			}

			if (params.status === "blocked") {
				goal.assessments.push(assessmentEntry);
				const blocker = params.blocker?.trim() || params.assessment;
				stopGoal(pi, ctx, goal.goalId, `blocked: ${blocker}`, "blocked");
				notify(ctx, `Goal ${goal.goalId} is BLOCKED and needs you: ${blocker}`, "warning");
				return {
					content: [{ type: "text" as const, text: `Goal ${goal.goalId} marked blocked. A human was notified.` }],
					details: { goalId: goal.goalId, status: "blocked", blocker },
				};
			}

			if (params.status === "done") {
				if (goal.gstatus === "verifying") {
					// P1: the model CONFIRMED done after its self-check. Do NOT close yet — escalate
					// to an INDEPENDENT adversarial verifier (separate skeptical subagent). Only an
					// independent PASS closes the goal. Record the model's confirmation, then launch
					// the verifier OUTSIDE this turn (fire-and-forget: the subagent process resolves
					// the verdict and either closes, re-injects continue, or blocks). We return to the
					// model now so its turn ends cleanly; the goal sits in `verifying-independent`.
					goal.assessments.push(assessmentEntry);
					void beginIndependentVerification(pi, ctx, goal);
					return {
						content: [
							{
								type: "text" as const,
								text: `Recorded your confirmed 'done' for goal ${goal.goalId}. NOT closed yet — an INDEPENDENT verifier (fresh-eyes subagent) is now judging the objective against the criteria with the available evidence. The goal closes only if that independent verifier returns PASS.`,
							},
						],
						details: { goalId: goal.goalId, status: "verifying-independent" },
					};
				}
				// First `done` from `pursuing` → DO NOT stop. Transition to verifying and
				// re-inject the verification prompt (the hallmark completeness check).
				goal.assessments.push(assessmentEntry);
				goal.gstatus = "verifying";
				scheduleGoal(pi, ctx, goal, 0, "self-declared done → verifying");
				return {
					content: [
						{
							type: "text" as const,
							text: `Recorded a first 'done' for goal ${goal.goalId}. NOT finished yet — a verification turn will confront each criterion with evidence before the goal can close.`,
						},
					],
					details: { goalId: goal.goalId, status: "verifying" },
				};
			}

			// status === "continue".
			// A `continue` arriving FROM `verifying` means the completeness check FAILED:
			// count it. If verification keeps failing, the model is ping-ponging
			// done↔verify without real progress; stop as blocked instead of silently
			// burning the whole iteration budget.
			if (goal.gstatus === "verifying") {
				goal.verifyAttempts += 1;
				if (goal.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
					goal.assessments.push(assessmentEntry);
					const blocker = `verification kept failing after ${goal.verifyAttempts} attempt(s); last gap: ${
						params.nextStep || params.assessment
					}`;
					stopGoal(pi, ctx, goal.goalId, `blocked: ${blocker}`, "blocked");
					notify(ctx, `Goal ${goal.goalId} is BLOCKED: ${blocker}`, "warning");
					return {
						content: [
							{
								type: "text" as const,
								text: `Goal ${goal.goalId} blocked: the completeness check failed ${goal.verifyAttempts} time(s). A human was notified.`,
							},
						],
						details: { goalId: goal.goalId, status: "blocked", verifyAttempts: goal.verifyAttempts },
					};
				}
			}

			// Record + arm the next pursuing iteration.
			const reason = params.nextStep ? `continue: ${params.nextStep}` : "continue";
			advanceGoal(pi, ctx, goal, assessmentEntry, delaySec, reason);
			const when = delaySec > 0 ? `in ${delaySec}s` : "immediately";
			return {
				content: [
					{ type: "text" as const, text: `Recorded progress on goal ${goal.goalId}; next iteration ${when}.` },
				],
				details: { goalId: goal.goalId, status: "continue", delaySeconds: delaySec, clampedFrom: raw !== delaySec ? raw : undefined },
			};
		},
	});

	pi.registerCommand("goal", {
		description:
			"Pursue an objective until verified done: /goal <objective> [-- <criteria>] | /goal stop [id] | /goal status [id]",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items = [
				{ value: "stop", label: "stop", description: "Stop an active goal" },
				{ value: "status", label: "status", description: "Show goal status" },
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
		// Do NOT migrate a goal into a forked session: a fork inherits the parent's
		// "goal-state" entries, but the goal must keep running only in the parent.
		if (event.reason === "fork") return;
		rehydrate(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const goal of activeGoals.values()) {
			if (goal.timer) {
				clearTimeout(goal.timer);
				goal.timer = null;
			}
			goal.controller.abort("session shutdown");
			if (goal.gstatus === "verifying" || goal.gstatus === "verifying-independent") {
				// A verifying goal must resume verifying after reload (the completeness check
				// survives), so persist the phase verbatim — rehydrate keeps it. A
				// verifying-independent goal persists the same way; rehydrate RE-RUNS the
				// independent verifier (the in-flight verdict was lost when we aborted here).
				goal.verifierInFlight = false;
				persist(pi, ctx, goal);
			} else if (goal.gstatus === "pursuing") {
				// Persist as "stale" (recoverable on next session_start), keeping nextFireAt intact;
				// rehydrate resumes it as pursuing.
				goal.gstatus = "stale";
				persist(pi, ctx, goal);
			}
		}
		clearGoalStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Safety net: if a goal is still active and the turn closed without the model
		// calling goal_progress (no re-arm) and with no live timer, re-arm defensively
		// so the goal does not silently die.
		for (const goal of activeGoals.values()) {
			// Only `pursuing`/`verifying` goals participate in the safety net. A
			// `verifying-independent` goal is deliberately EXCLUDED: its verifier runs in a
			// separate process OUTSIDE the model turn and resolves the next transition itself
			// (done / continue / blocked). Re-arming it here would race the in-flight verdict.
			if (goal.gstatus !== "pursuing" && goal.gstatus !== "verifying") continue;

			// Budget gate BEFORE any re-arm (mirrors loop.ts agent_end): if the context
			// budget is already exhausted, stop cleanly instead of paying for another turn
			// (the `continue`/advanceGoal path arms without consulting the budget, so this
			// is the earliest honest place to cut it on the re-arm side).
			const budget = contextBudgetExceeded(ctx, goal);
			if (budget) {
				stopGoal(pi, ctx, goal.goalId, budget, "stopped");
				notify(ctx, `Goal ${goal.goalId} stopped: ${budget}. You can /compact and resume.`, "warning");
				continue;
			}

			if (goal.rearmedThisTurn) continue;
			if (goal.timer) continue;
			// A wake is already pending (e.g. a delay-0 fire armed this turn for the
			// done→verifying transition has not run yet): do NOT stack a second wake on
			// top of it, which would duplicate the verification / iteration prompt.
			if (goal.nextFireAt !== null) continue;
			// Never let the safety net re-arm a `verifying` goal. The done→verifying
			// transition arms a delay-0 wake whose fireGoal resets rearmedThisTurn/timer;
			// if that fireGoal already injected the verification prompt before this
			// agent_end, re-arming here would inject a SECOND verification prompt. The
			// verification turn is already in flight; a `continue`/`done` from the model
			// (or a later pursuing iteration) will re-arm legitimately.
			if (goal.gstatus === "verifying") continue;
			scheduleGoal(pi, ctx, goal, SAFETY_NET_DELAY_SECONDS, "auto: turn closed without goal_progress");
		}
	});
}
