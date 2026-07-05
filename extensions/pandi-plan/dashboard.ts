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
 * For the active plan it also renders a Claude-style CHECKLIST parsed from the
 * latest submitted plan text by `extractPlanChecklist` (also pure): GFM task-list
 * state is preserved, otherwise steps are derived from the plan's lists/headings.
 *
 * Decoupled from index.ts's PlanState by a minimal STRUCTURAL `PlanSnapshot`
 * (mirrors session-state.ts's PersistedEntry approach); any real PlanState
 * satisfies it. Depth-one sibling imported via "./dashboard.js".
 *
 * `renderPlanDashboardOverlay` hosts the TUI scroll overlay (a minimal
 * self-contained component — no pi-tui runtime import) so index.ts only keeps the
 * command wiring + plan collection; any overlay failure degrades to a notification.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "./notify.js";

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

/** One Claude-style checklist step parsed out of a plan's Markdown. */
export interface ChecklistItem {
	text: string;
	checked: boolean;
}

const CHECKLIST_TEXT_MAX = 120;

/**
 * Parse a submitted plan's Markdown into a Claude-style checklist of steps. PURE
 * and deterministic (no I/O, no Date.now), so it is trivially unit-testable.
 *
 * Strategy, in priority order (the FIRST kind that yields any item wins, so a plan
 * that already uses GFM task lists keeps its checked/unchecked state):
 *   1. GFM task-list items: `- [ ]` / `- [x]` (also `*`/`+` bullets and `1.`/`1)`
 *      ordered prefixes). `[x]`/`[X]` => checked.
 *   2. Ordered-list items (`1. step`) => unchecked steps.
 *   3. Bullet-list items (`- step`) => unchecked steps.
 *   4. `##`..`######` headings => unchecked steps (when the plan has no lists).
 * Returns [] when nothing structured is found.
 */
export function extractPlanChecklist(markdown: string): ChecklistItem[] {
	const taskItems: ChecklistItem[] = [];
	const ordered: ChecklistItem[] = [];
	const bullets: ChecklistItem[] = [];
	const headings: ChecklistItem[] = [];
	for (const raw of String(markdown).split("\n")) {
		const line = raw.trim();
		const task = line.match(/^(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*\S)/);
		if (task) {
			taskItems.push({ text: clip(task[2], CHECKLIST_TEXT_MAX), checked: task[1].toLowerCase() === "x" });
			continue;
		}
		const ord = line.match(/^\d+[.)]\s+(.*\S)/);
		if (ord) {
			ordered.push({ text: clip(ord[1], CHECKLIST_TEXT_MAX), checked: false });
			continue;
		}
		const bul = line.match(/^[-*+]\s+(.*\S)/);
		if (bul) {
			bullets.push({ text: clip(bul[1], CHECKLIST_TEXT_MAX), checked: false });
			continue;
		}
		const head = line.match(/^#{2,6}\s+(.*\S)/);
		if (head) headings.push({ text: clip(head[1], CHECKLIST_TEXT_MAX), checked: false });
	}
	if (taskItems.length) return taskItems;
	if (ordered.length) return ordered;
	if (bullets.length) return bullets;
	return headings;
}

/**
 * Render the plan-mode dashboard as Markdown: a header with session totals, an
 * "Active" detail section for any armed plan (posture, counts, last submitted
 * plan), and a "History" table of every plan in the session (oldest first).
 */
export function buildPlanDashboardMarkdown(plans: PlanSnapshot[]): string {
	const lines: string[] = ["# Tablero de Modo Plan", ""];
	if (plans.length === 0) {
		lines.push(
			"Todavía no hay planes registrados en esta sesión. Empezá uno con `/plan <task>` o la tool `enter_plan_mode`.",
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
		lines.push("## Activo");
		for (const p of active) {
			lines.push(
				"",
				`### ${p.planId} — ${p.status} (gate de solo lectura ARMADO)`,
				`- **Postura:** ${planPosture(p)}`,
				`- **Envíos:** ${p.submissions} · **Rechazos:** ${p.rejections}`,
				`- **Actualizado:** ${p.updatedAt}`,
				`- **Tarea:** ${clip(p.task, 200)}`,
			);
			if (p.lastPlan) {
				// Claude-style checklist derived from the latest submitted plan.
				const steps = extractPlanChecklist(p.lastPlan);
				if (steps.length) {
					const done = steps.filter((s) => s.checked).length;
					lines.push("", `#### Checklist (${done}/${steps.length} listos)`);
					for (const s of steps) lines.push(`- [${s.checked ? "x" : " "}] ${s.text}`);
				} else {
					lines.push("", "_No se pudo extraer ningún paso del checklist del último plan._");
				}
				lines.push("", "<details><summary>Último plan enviado</summary>", "", p.lastPlan, "", "</details>");
			}
		}
		lines.push("");
	}

	lines.push(
		"## Historial",
		"",
		"| Plan | Estado | Postura | Envíos | Rech | Tarea |",
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

/**
 * Render the dashboard Markdown as a scrollable TUI overlay. The overlay is a
 * minimal self-contained component (no pi-tui runtime import) so it never
 * destabilizes the bundled test harness; any overlay failure degrades to a
 * notification. Caller has already confirmed an interactive TUI with a live UI.
 */
export async function renderPlanDashboardOverlay(ctx: ExtensionContext, markdown: string): Promise<void> {
	try {
		await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
			const allLines = markdown.split("\n");
			let scroll = 0;
			const FIXED = 5; // top border, title, spacer, footer, bottom border
			const bodyHeight = () => Math.max(3, (tui.terminal.rows || 24) - FIXED);
			const pad = (text: string, width: number) =>
				(text.length > width ? text.slice(0, width) : text) + " ".repeat(Math.max(0, width - text.length));
			return {
				invalidate(): void {
					/* no cached render state */
				},
				handleInput(data: string): void {
					if (data === "q" || data === "\u001b") {
						done(undefined);
						return;
					}
					const page = Math.max(1, bodyHeight() - 1);
					if (data === "\u001b[B" || data === "j") scroll += 1;
					else if (data === "\u001b[A" || data === "k") scroll -= 1;
					else if (data === " " || data === "\u001b[6~") scroll += page;
					else if (data === "\u001b[5~") scroll -= page;
					else if (data === "g") scroll = 0;
					else if (data === "G") scroll = Number.MAX_SAFE_INTEGER;
					else return;
					tui.requestRender();
				},
				render(width: number): string[] {
					const safeWidth = Math.max(20, width);
					const height = bodyHeight();
					const maxScroll = Math.max(0, allLines.length - height);
					scroll = Math.min(Math.max(0, scroll), maxScroll);
					const start = scroll;
					const end = Math.min(allLines.length, start + height);
					const visible = allLines.slice(start, end);
					while (visible.length < height) visible.push("");
					const border = "─".repeat(safeWidth);
					const footer = `↑/↓ j/k desplazar · PgUp/PgDn página · q/Esc cerrar · ${start + 1}-${end}/${allLines.length}`;
					return [
						border,
						pad("Tablero de Modo Plan", safeWidth),
						"",
						...visible.map((line) => pad(line, safeWidth)),
						pad(footer, safeWidth),
						border,
					];
				},
			};
		});
	} catch (error) {
		notify(
			ctx,
			`No se pudo abrir el tablero de plan: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}
