/**
 * Plan-mode tracking dashboard — PURE render kernel.
 *
 * `buildPlanDashboardMarkdown` turns a set of plan snapshots (the session's plan
 * history + the active plan) into a Markdown report for `/plan dashboard`. It is
 * pure and DETERMINISTIC (no Date.now / no I/O): everything it shows is derived
 * from its inputs, so it is trivially unit-testable. The command wiring and the
 * TUI scroll overlay live in index.ts (the overlay needs a live TUI we cannot
 * exercise from the bundled integration harness).
 *
 * Decoupled from index.ts's PlanState by a minimal STRUCTURAL `PlanSnapshot`
 * (mirrors session-state.ts's PersistedEntry approach); any real PlanState
 * satisfies it. Depth-one sibling imported via "./dashboard.js".
 */

/** Structural shape of a plan this dashboard renders. Any PlanState satisfies it. */
export interface PlanSnapshot {
	planId: string;
	task: string;
	active: boolean;
	status: string;
	submissions: number;
	rejections: number;
	nonInteractive?: boolean;
	ultracode?: boolean;
	ultracodeSteps?: boolean;
	startedAt: number;
	updatedAt: string;
	lastPlan?: string;
}

/** Human-readable posture tags (or "interactive" when no flag is set). */
export function planPosture(plan: PlanSnapshot): string {
	const tags: string[] = [];
	if (plan.nonInteractive) tags.push("plan-only");
	if (plan.ultracode) tags.push("ultracode");
	if (plan.ultracodeSteps) tags.push("ultracode-steps");
	return tags.length ? tags.join(", ") : "interactive";
}

/** Collapse whitespace and clip to a single line of at most `max` chars. */
function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Render the plan-mode dashboard as Markdown: a header with session totals, an
 * "Active" detail section for any armed plan (posture, counts, last submitted
 * plan), and a "History" table of every plan in the session (oldest first).
 */
export function buildPlanDashboardMarkdown(plans: PlanSnapshot[]): string {
	const lines: string[] = ["# Plan Mode Dashboard", ""];
	if (plans.length === 0) {
		lines.push(
			"No plans recorded in this session yet. Start one with `/plan <task>` or the `enter_plan_mode` tool.",
		);
		return lines.join("\n");
	}

	const sorted = [...plans].sort((a, b) => a.startedAt - b.startedAt);
	const active = sorted.filter((p) => p.active);
	const totalSubs = sorted.reduce((n, p) => n + p.submissions, 0);
	const totalRej = sorted.reduce((n, p) => n + p.rejections, 0);
	lines.push(
		`**Plans:** ${sorted.length} · **active:** ${active.length} · **submitted:** ${totalSubs} · **rejected:** ${totalRej}`,
		"",
	);

	if (active.length) {
		lines.push("## Active");
		for (const p of active) {
			lines.push(
				"",
				`### ${p.planId} — ${p.status} (read-only gate ARMED)`,
				`- **Posture:** ${planPosture(p)}`,
				`- **Submissions:** ${p.submissions} · **Rejections:** ${p.rejections}`,
				`- **Updated:** ${p.updatedAt}`,
				`- **Task:** ${clip(p.task, 200)}`,
			);
			if (p.lastPlan) {
				lines.push("", "<details><summary>Last submitted plan</summary>", "", p.lastPlan, "", "</details>");
			}
		}
		lines.push("");
	}

	lines.push(
		"## History",
		"",
		"| Plan | Status | Posture | Subs | Rej | Task |",
		"| --- | --- | --- | --- | --- | --- |",
	);
	for (const p of sorted) {
		const status = p.active ? `**${p.status}**` : p.status;
		lines.push(
			`| ${p.planId} | ${status} | ${planPosture(p)} | ${p.submissions} | ${p.rejections} | ${clip(p.task, 60)} |`,
		);
	}
	return lines.join("\n");
}
