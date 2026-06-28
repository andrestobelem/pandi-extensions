/**
 * Plan-mode prompt builders (pure).
 *
 * Extracted verbatim from index.ts to isolate the canonical wording of the
 * planning posture and the post-approval implementation message from the
 * command/state wiring. Pure and side-effect free, so the prompt text has a
 * single home and is easy to review/test.
 *
 * Decoupled from `PlanState`: `makePlanningPrompt` takes only the minimal
 * structural fields it needs, which any `PlanState` satisfies. Depth-one sibling
 * module imported by index.ts via "./prompts.js".
 */

/** The planning instruction injected when /plan enters the mode. */
export function makePlanningPrompt(plan: { planId: string; task: string }): string {
	const lines: string[] = [];
	lines.push(
		`You are now in PLAN MODE (plan ${plan.planId}). This is a READ-ONLY planning posture.`,
	);
	lines.push("");
	lines.push("TASK (verbatim):");
	lines.push(plan.task);
	lines.push("");
	lines.push("RULES while in plan mode (ENFORCED by a gate, not just guidance):");
	lines.push(
		"- You may ONLY use read-only actions: read, grep, find, ls, and read-only shell commands (e.g. git ls-files, git status, cat, head, sed -n for viewing). Mutating tools (write, edit) and mutating shell commands (rm, mv, git commit/add/push/reset, redirections >/>>, package installs, etc.) are HARD-BLOCKED and will fail. dynamic_workflow is allowed only for read-only actions (list/template/read/graph/runs/view); write/run/start are blocked while planning.",
	);
	lines.push(
		"- Do NOT begin implementing. Implementation happens only AFTER the user approves your plan.",
	);
	lines.push(
		"- Your plan MAY include running dynamic workflows (dynamic_workflow action=run/start) as implementation steps — those execute only AFTER approval, so propose them for broad, parallel, or high-confidence work (large audits, migrations, exhaustive sweeps, independent verification, deep research). While planning you can inspect the catalog read-only (dynamic_workflow action=list/template/read) to pick or design the right workflow, then describe it in the plan.",
	);
	lines.push(
		"- You may call AskUserQuestion to clarify requirements before finalizing the plan, if needed.",
	);
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
export function makeImplementPrompt(planText: string): string {
	return `Plan approved. Implement now:\n\n${planText}`;
}
