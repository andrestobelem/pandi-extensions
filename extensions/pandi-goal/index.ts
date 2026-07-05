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

import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_CONTEXT_PERCENT_CAP,
	DEFAULT_MAX_INDEPENDENT_VERIFICATIONS,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_VERIFIER_TIMEOUT_MS,
	DEFAULT_VERIFIER_TOOLS,
	GOAL_STATE_TYPE,
	MAX_VERIFY_ATTEMPTS,
	MAX_WAIT_SECONDS,
	MIN_WAIT_SECONDS,
	SAFETY_NET_DELAY_SECONDS,
} from "./constants.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { makeGoalIterationPrompt, makeGoalVerificationPrompt } from "./prompts.js";
import { collectLatestByKey } from "./session-state.js";
import { clearGoalStatus, setGoalStatus } from "./status.js";
import { formatEta } from "./time.js";
import type { ActiveGoal, GoalAssessment, GoalState, GoalStatus } from "./types.js";
import { runIndependentVerifier } from "./verifier.js";

// Source of truth of "which timers live NOW". Map supports several, but P0 tools
// resolve the single active goal (S4).
const activeGoals = new Map<string, ActiveGoal>();

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

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
		return `presupuesto de contexto agotado (${Math.round(usage.percent)}% ≥ ${goal.contextPercentCap}%)`;
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
		stopGoal(pi, ctx, goal.goalId, `alcanzó el límite de maxIterations (${goal.maxIterations})`, "stopped");
		notify(
			ctx,
			`Goal ${goal.goalId} detenido: alcanzó el límite de maxIterations (${goal.maxIterations}).`,
			"warning",
		);
		return;
	}

	// Best-effort budget gate before doing any work.
	const budget = contextBudgetExceeded(ctx, goal);
	if (budget) {
		stopGoal(pi, ctx, goal.goalId, budget, "stopped");
		notify(ctx, `Goal ${goal.goalId} detenido: ${budget}. Podés hacer /compact y retomar.`, "warning");
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
function scheduleGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
	delaySec: number,
	reason: string,
): void {
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
	goal.lastReason = "verificación independiente en curso";
	persist(pi, ctx, goal);
	setGoalStatus(ctx, goal);

	const verdict = await runIndependentVerifier(pi, ctx, goal);
	goal.verifierInFlight = false;

	// The goal may have been stopped (user /goal stop, shutdown) while the verifier ran. A user stop
	// removes it from activeGoals; a session_shutdown keeps it (persisted verbatim so rehydrate
	// re-runs the verifier) but ABORTS its controller — so also bail when the controller is aborted,
	// otherwise a late verdict would finalize the goal (done/blocked), clobber the persisted
	// verifying-independent snapshot, and message a dead session.
	const live = activeGoals.get(goal.goalId);
	if (!live || live !== goal || goal.gstatus !== "verifying-independent" || goal.controller.signal.aborted) return;

	const at = new Date().toISOString();
	if (verdict.pass) {
		goal.assessments.push({
			iteration: goal.iteration,
			status: "done",
			assessment: `independent verifier PASS: ${verdict.feedback}`.slice(0, 2000),
			at,
		});
		stopGoal(pi, ctx, goal.goalId, "done: verificado de forma independiente contra los criterios de éxito", "done");
		notify(
			ctx,
			`Goal ${goal.goalId} DONE: verificado de forma independiente (subagente con ojos frescos confirmó). 🐼`,
			"info",
		);
		return;
	}

	// FAIL. Count it; if we have exhausted the independent-verification budget, block.
	goal.independentVerifyAttempts += 1;
	const feedback = verdict.feedback.trim() || "el verificador independiente rechazó la afirmación sin detalle";
	if (goal.independentVerifyAttempts >= goal.maxIndependentVerifications) {
		goal.assessments.push({
			iteration: goal.iteration,
			status: "blocked",
			assessment:
				`independent verifier FAIL (${goal.independentVerifyAttempts}/${goal.maxIndependentVerifications}): ${feedback}`.slice(
					0,
					2000,
				),
			at,
		});
		const blocker = `la verificación independiente falló ${goal.independentVerifyAttempts} vez(veces); último veredicto: ${feedback}`;
		stopGoal(pi, ctx, goal.goalId, `blocked: ${blocker}`, "blocked");
		notify(
			ctx,
			`Goal ${goal.goalId} está BLOCKED: la verificación independiente siguió fallando (necesita a un humano). ${feedback}`,
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
		assessment:
			`independent verifier FAIL (${goal.independentVerifyAttempts}/${goal.maxIndependentVerifications}): ${feedback}`.slice(
				0,
				2000,
			),
		nextStep: `Atendé los hallazgos del verificador independiente antes de volver a declarar done: ${feedback}`.slice(
			0,
			2000,
		),
		at,
	};
	advanceGoal(pi, ctx, goal, assessment, 0, "la verificación independiente falló → continue");
	notify(ctx, `Goal ${goal.goalId}: el verificador independiente devolvió FAIL; iterando de nuevo.`, "info");
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

/**
 * Strip a `--ultracode` / `--uc` posture flag off the args (anywhere in the string).
 * Returns the cleaned text plus whether the flag was present. Parsed BEFORE the ` -- `
 * criteria split so a flag placed after the criteria is still honored.
 */
function extractUltracodeFlag(args: string): { rest: string; ultracode: boolean } {
	let ultracode = false;
	const kept: string[] = [];
	for (const token of args.split(/\s+/)) {
		const lower = token.toLowerCase();
		if (lower === "--ultracode" || lower === "--uc") ultracode = true;
		else if (token.length) kept.push(token);
	}
	return { rest: kept.join(" "), ultracode };
}

/**
 * Parse `/goal` start args. Convention: if the text contains the ` -- ` separator, the
 * left side is the objective and the right side is the success criteria (free text).
 * Without it, the whole text is the objective (the model derives criteria, S2). A
 * `--ultracode`/`--uc` flag (anywhere) sets the ultracode posture and is removed first.
 */
function parseGoalArgs(args: string): { objective: string; successCriteria?: string; ultracode: boolean } {
	const { rest, ultracode } = extractUltracodeFlag(args);
	const SEP = " -- ";
	const idx = rest.indexOf(SEP);
	if (idx === -1) return { objective: rest.trim(), ultracode };
	const objective = rest.slice(0, idx).trim();
	const successCriteria = rest.slice(idx + SEP.length).trim();
	return { objective, successCriteria: successCriteria || undefined, ultracode };
}

function startGoal(pi: ExtensionAPI, ctx: ExtensionContext, args: string): ActiveGoal | undefined {
	// Mode gate: only TUI/RPC can sustain a persistent goal session.
	if (!canGoalInMode(ctx)) {
		notify(ctx, "/goal requiere una sesión TUI o RPC (este modo no puede sostener un goal).", "error");
		return undefined;
	}
	// Single active goal at a time: the P0 tool (goal_progress) carries no goalId and resolves
	// the one active goal, so a second concurrent goal would make reports ambiguous and let two
	// goals fight over wake re-injection. Refuse to start a second; the user stops the first.
	const existing = activeGoal();
	if (existing) {
		notify(
			ctx,
			`Ya hay un goal activo (${existing.goalId}: ${existing.objective}). Detenélo primero con /goal stop.`,
			"warning",
		);
		return undefined;
	}
	const { objective, successCriteria, ultracode } = parseGoalArgs(args);
	if (!objective) {
		notify(ctx, "Uso: /goal [--ultracode] <objective> [-- <success criteria>]", "warning");
		return undefined;
	}

	const goalId = crypto.randomBytes(4).toString("hex");
	const goal: ActiveGoal = {
		goalId,
		objective,
		successCriteria,
		derivedCriteria: undefined,
		ultracode,
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
	const crit = successCriteria ? " (con criterios)" : " (el modelo va a derivar los criterios)";
	const uc = ultracode ? " [ultracode]" : "";
	notify(ctx, `Goal ${goalId} iniciado${crit}${uc}: ${objective}`, "info");
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
			"¿Qué goal?",
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
	// Terminal goals are no longer active: keep the persisted final snapshot for
	// audit/rehydrate, but drop the in-memory entry immediately (mirrors pi-loop's
	// stopLoop -> activeLoops.delete) so agent_end/activeGoal()/scan and `/goal status`
	// only ever traverse live goals instead of accumulating dead ones for the session.
	activeGoals.delete(goalId);
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
	// Mode gate (mirrors startGoal): a /goal can only be sustained in tui/rpc. In a
	// non-interactive session (print one-shot, json) the goal can never advance, so the
	// reload path must be a NO-OP: do not re-arm a catch-up timer (fireGoal would bump the
	// iteration and persist while wake() no-ops) and — crucially — do not spawn the
	// independent verifier subprocess for a verifying-independent snapshot. wake() already
	// suppresses the prompt RE-INJECTION, but only refusing rehydrate here stops those side
	// effects. Leaving the persisted state untouched lets a later tui/rpc session recover it.
	if (!canGoalInMode(ctx)) return;
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
			? " (verificando)"
			: goal.gstatus === "verifying-independent"
				? " (verificación independiente)"
				: "";
	const eta =
		goal.gstatus === "pursuing" || goal.gstatus === "verifying" ? `, próximo ${formatEta(goal.nextFireAt)}` : "";
	const reason = goal.lastReason ? `, razón: ${goal.lastReason}` : "";
	return `${goal.goalId} [${goal.gstatus}]${phase} iter ${goal.iteration}/${goal.maxIterations}${eta}${reason} — ${goal.objective}`;
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
			notify(ctx, "No hay ningún goal que coincida para detener — revisá el id con /goal status.", "warning");
			return;
		}
		stopGoal(pi, ctx, goal.goalId, "detenido por el usuario (/goal stop)", "stopped");
		notify(ctx, `Goal ${goal.goalId} detenido.`, "info");
		return;
	}

	if (firstToken === "status" && !hasCriteriaSeparator) {
		if (rest) {
			const goal = activeGoals.get(rest);
			notify(
				ctx,
				goal
					? formatStatus(goal)
					: `No hay ningún goal con id ${rest} — corré /goal status para listar los goals activos.`,
				goal ? "info" : "warning",
			);
			return;
		}
		const all = [...activeGoals.values()];
		if (all.length === 0) {
			notify(ctx, "No hay goals.", "info");
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
			"Reporta el progreso del /goal activo después de autoevaluar contra sus criterios de éxito. Es la ÚNICA forma de avanzar, terminar o bloquear un goal.",
		promptSnippet:
			"Reportá el progreso del /goal: autoevaluá contra los criterios de éxito y decidí continue/done/blocked.",
		promptGuidelines: [
			"Antes de declarar `done`, confrontá CADA criterio de éxito con evidencia concreta y verificable (un comando que corriste, un test que pasó, un archivo que existe). Nunca declares `done` por intuición.",
			"Después de un primer `done`, vas a recibir un turno de VERIFICACIÓN: revisá tu propio trabajo de forma adversarial. Confirmá `done` solo si la evidencia respalda cada criterio; si no, devolvé `continue` con el nextStep que falta.",
			"Confirmar `done` desde el turno de verificación NO cierra el goal: después, un verificador INDEPENDIENTE (un subagente aparte, escéptico, con ojos frescos y acceso de solo lectura) juzga el objetivo contra los criterios usando tu evidencia registrada. Cierra solo si ese verificador independiente devuelve PASS. Por eso dejá evidencia durable e inspeccionable (archivos commiteados, tests que pasan, artifacts) — no solo afirmaciones en tu assessment — porque un tercero tiene que poder confirmar cada criterio sin confiar en vos.",
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
			// No schema bounds on waitSeconds on purpose: the SDK rejects out-of-range args
			// BEFORE execute() runs, so min/max here would throw instead of letting us clamp.
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

			// An INDEPENDENT verifier is judging this goal right now (separate process, launched
			// from a prior confirmed `done`). Its verdict — not this call — decides the outcome.
			// Reject any re-entrant goal_progress so it cannot mutate gstatus out from under the
			// in-flight verdict (which would corrupt the state machine and silently discard it).
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

			// If criteria were derived (no user criteria yet), capture them from the DEDICATED
			// `successCriteria` field as the definition-of-done so later iterations carry it.
			// Never reuse `assessment`: that is a self-evaluation, not a list of criteria.
			if (!goal.successCriteria && !goal.derivedCriteria && params.successCriteria?.trim()) {
				goal.derivedCriteria = params.successCriteria.trim();
			}

			if (params.status === "blocked") {
				goal.assessments.push(assessmentEntry);
				const blocker = params.blocker?.trim() || params.assessment;
				stopGoal(pi, ctx, goal.goalId, `blocked: ${blocker}`, "blocked");
				notify(ctx, `Goal ${goal.goalId} está BLOCKED y te necesita: ${blocker}`, "warning");
				return {
					content: [
						{
							type: "text" as const,
							text: `Goal ${goal.goalId} marcado como blocked. Se notificó a un humano.`,
						},
					],
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
								text: `Registramos tu 'done' confirmado para el goal ${goal.goalId}. TODAVÍA NO se cerró — un verificador INDEPENDIENTE (subagente con ojos frescos) está juzgando el objetivo contra los criterios con la evidencia disponible. El goal se cierra solo si ese verificador independiente devuelve PASS.`,
							},
						],
						details: { goalId: goal.goalId, status: "verifying-independent" },
					};
				}
				// First `done` from `pursuing` → DO NOT stop. Transition to verifying and
				// re-inject the verification prompt (the hallmark completeness check).
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
			// A `continue` arriving FROM `verifying` means the completeness check FAILED:
			// count it. If verification keeps failing, the model is ping-ponging
			// done↔verify without real progress; stop as blocked instead of silently
			// burning the whole iteration budget.
			if (goal.gstatus === "verifying") {
				goal.verifyAttempts += 1;
				if (goal.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
					goal.assessments.push(assessmentEntry);
					const blocker = `la verificación siguió fallando después de ${goal.verifyAttempts} intento(s); última brecha: ${
						params.nextStep || params.assessment
					}`;
					stopGoal(pi, ctx, goal.goalId, `blocked: ${blocker}`, "blocked");
					notify(ctx, `Goal ${goal.goalId} está BLOCKED: ${blocker}`, "warning");
					return {
						content: [
							{
								type: "text" as const,
								text: `Goal ${goal.goalId} blocked: el chequeo de completitud falló ${goal.verifyAttempts} vez(veces). Se notificó a un humano.`,
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

			// Record + arm the next pursuing iteration.
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
			const items = [
				{ value: "stop", label: "stop", description: "Detener un goal activo" },
				{ value: "status", label: "status", description: "Mostrar el estado del goal" },
				{ value: "--ultracode", label: "--ultracode", description: "Perseguir el goal vía dynamic workflows" },
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
			goal.controller.abort("cierre de sesión");
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
				notify(ctx, `Goal ${goal.goalId} detenido: ${budget}. Podés hacer /compact y retomar.`, "warning");
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
			scheduleGoal(pi, ctx, goal, SAFETY_NET_DELAY_SECONDS, "auto: el turno cerró sin goal_progress");
		}
	});
}
