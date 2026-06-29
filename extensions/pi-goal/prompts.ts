/**
 * Prompt molds for the `/goal` extension.
 *
 * Pure prompt-construction helpers: they turn a GoalState into the text re-injected each
 * `pursuing` iteration or `verifying` completeness check. No side effects, no scheduling,
 * no I/O — just string building — so they are trivially testable and depend only on the
 * type/constant leaves. The independent-verifier prompt stays with the verifier code in
 * index.ts and reuses effectiveCriteria/formatProgressLog imported from here.
 */

import { PROGRESS_LOG_KEEP } from "./constants.js";
import type { GoalState } from "./types.js";

/** The effective criteria text: user-supplied wins, else model-derived, else none yet. */
export function effectiveCriteria(goal: GoalState): string | undefined {
	if (goal.successCriteria?.trim()) return goal.successCriteria.trim();
	if (goal.derivedCriteria?.trim()) return goal.derivedCriteria.trim();
	return undefined;
}

/** Compact progress log of the last N assessments, for continuity without re-reading the session. */
export function formatProgressLog(goal: GoalState): string[] {
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
export function makeGoalIterationPrompt(goal: GoalState): string {
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
			"FIRST, derive 2-5 concrete, VERIFIABLE success criteria from the objective (each checkable by a command, a test, or an inspectable artifact). Pass them in the `successCriteria` argument of your FIRST goal_progress call (NOT only in `assessment`); they are recorded ONCE as the definition-of-done for the rest of this goal.",
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
	lines.push(
		"Do work toward the objective now. THEN self-evaluate against the success criteria and call goal_progress:",
	);
	lines.push('- status "continue" (with a concrete nextStep) if criteria are not yet all met.');
	lines.push(
		'- status "done" only when you believe EVERY criterion is met; you will then get one verification turn before the goal closes.',
	);
	lines.push(
		'- status "blocked" if you cannot progress without a human decision/credential/access (explain the blocker).',
	);
	lines.push(
		`If you call neither, the goal will defensively re-arm and will hard-stop at iteration ${goal.maxIterations}.`,
	);
	return lines.join("\n");
}

/** Verification-prompt mold, injected only in the `verifying` state (the completeness check). */
export function makeGoalVerificationPrompt(goal: GoalState): string {
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
	lines.push(
		'- If every criterion is supported by evidence, call goal_progress({status:"done", assessment}) to CONFIRM and close the goal.',
	);
	lines.push(
		'- If any criterion fails or the evidence is missing, call goal_progress({status:"continue", nextStep}) describing exactly what still has to be done.',
	);
	return lines.join("\n");
}
