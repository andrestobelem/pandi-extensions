/**
 * Plan-mode prompt builders (pure).
 *
 * Extracted verbatim from index.ts to isolate the canonical wording of the
 * planning posture and the post-approval implementation message from the
 * command/state wiring. Pure and side-effect free, so the prompt text has a
 * single home and is easy to review/test.
 *
 * Decoupled from `PlanState`: `makePlanningPrompt` takes only the minimal
 * structural fields it needs (planId/task + the optional posture flags), which
 * any `PlanState` satisfies. Depth-one sibling module imported by index.ts via
 * "./prompts.js".
 */

/**
 * Optional posture flags that tune the planning/implementation wording. All
 * default to false (the interactive, no-ultracode posture preserved verbatim):
 *
 * - nonInteractive: plan-only session (print/json or a workflow subagent). There
 *   is no human approval and no implementation; the deliverable is the PLAN. The
 *   read-only gate stays armed for the whole session, so mutation stays blocked.
 * - ultracode: tell the planner to lean on dynamic workflows to RESEARCH/DESIGN
 *   the plan (inspect the catalog read-only now; propose run/start steps).
 * - ultracodeSteps: tell the planner/implementer to execute the plan's STEPS via
 *   dynamic workflows when warranted (exhaustiveness, confidence, scale).
 */
export interface PlanFlags {
	nonInteractive?: boolean;
	ultracode?: boolean;
	ultracodeSteps?: boolean;
}

/** The planning instruction injected when /plan enters the mode. */
export function makePlanningPrompt(plan: { planId: string; task: string } & PlanFlags): string {
	const lines: string[] = [];
	lines.push(`You are now in PLAN MODE (plan ${plan.planId}). This is a READ-ONLY planning posture.`);
	lines.push("");
	lines.push("TASK (verbatim):");
	lines.push(plan.task);
	lines.push("");
	if (plan.nonInteractive) {
		lines.push("NON-INTERACTIVE (plan-only) SESSION:");
		lines.push("- There is NO human approval and NO implementation here. Your only deliverable is the PLAN itself.");
		lines.push("- The read-only gate stays armed for the WHOLE session; write/edit and mutating shell stay blocked.");
		lines.push(
			"- When the plan is ready, call submit_plan({ plan }) to record it, then RETURN THE FULL PLAN as your final answer. Do NOT attempt to implement.",
		);
		lines.push("");
	}
	lines.push("RULES while in plan mode (ENFORCED by a gate, not just guidance):");
	lines.push(
		"- You may ONLY use read-only actions: read, grep, find, ls, and read-only shell commands (e.g. git ls-files, git status, cat, head, sed -n for viewing). Mutating tools (write, edit) and mutating shell commands (rm, mv, git commit/add/push/reset, redirections >/>>, package installs, etc.) are HARD-BLOCKED and will fail. dynamic_workflow is allowed only for read-only actions (list/template/read/graph/runs/view); write/run/start are blocked while planning.",
	);
	lines.push("- Do NOT begin implementing. Implementation happens only AFTER the user approves your plan.");
	lines.push(
		"- Your plan MAY include running dynamic workflows (dynamic_workflow action=run/start) as implementation steps — those execute only AFTER approval, so propose them for broad, parallel, or high-confidence work (large audits, migrations, exhaustive sweeps, independent verification, deep research). While planning you can inspect the catalog read-only (dynamic_workflow action=list/template/read) to pick or design the right workflow, then describe it in the plan.",
	);
	if (plan.ultracode) {
		lines.push(
			"- ULTRACODE: lean on dynamic workflows to RESEARCH and DESIGN this plan. Inspect the catalog read-only now (dynamic_workflow action=list/template/read/graph) and make the plan name the run/start workflows that will execute the work after approval, with explicit concurrency/maxAgents.",
		);
	}
	if (plan.ultracodeSteps) {
		lines.push(
			"- ULTRACODE STEPS: structure the plan so its STEPS execute via dynamic workflows when warranted (exhaustiveness, confidence, scale). For each step, note whether it runs as a workflow and with what concurrency/maxAgents, vs. inline.",
		);
	}
	if (!plan.nonInteractive) {
		lines.push("- You may call AskUserQuestion to clarify requirements before finalizing the plan, if needed.");
	}
	lines.push("");
	lines.push("WHAT TO DO:");
	lines.push("1. RESEARCH the task with read-only tools until you understand it.");
	lines.push("2. DESIGN an implementation approach.");
	if (plan.nonInteractive) {
		lines.push(
			"3. When the plan is complete and self-contained, call submit_plan({ plan }) to record it, then output the FULL plan in Markdown as your final answer.",
		);
		lines.push(
			"This is a non-interactive session: there is no approval or implementation step. The plan IS the result.",
		);
	} else {
		lines.push(
			"3. When the plan is complete and self-contained, call submit_plan({ plan }) with the FULL implementation plan in Markdown. This presents it to the user for approval.",
		);
		lines.push(
			"On approval you will exit plan mode and be asked to implement. If the plan is rejected you will get feedback and should revise, then call submit_plan again.",
		);
	}
	return lines.join("\n");
}

/** The implementation message re-injected after the user approves the plan. */
export function makeImplementPrompt(planText: string, opts: { ultracodeSteps?: boolean } = {}): string {
	const base = `Plan approved. Implement now:\n\n${planText}`;
	if (!opts.ultracodeSteps) return base;
	return `${base}\n\nExecute the steps marked for ultracode via dynamic_workflow (action=run/start) with explicit concurrency/maxAgents; keep the rest inline.`;
}
