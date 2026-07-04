/**
 * Plan-approval Markdown OVERLAY — the mdview-style surface submit_plan uses to present a
 * plan for approval when the session can show a custom component.
 *
 * Why this duplicates pi-mdview's viewer (on purpose)
 * ---------------------------------------------------
 * Pi loads each extension self-contained, so pi-plan may NOT import pi-mdview's viewer at
 * runtime (a cross-extension import breaks a standalone install — see the repo's
 * self-contained-extension rule). The small Markdown theme + scroll-viewer logic is therefore
 * DUPLICATED here, then EXTENDED with a decision: unlike the read-only mdview viewer (which only
 * closes on q/Esc), this overlay resolves to a boolean — APPROVE or REJECT — so it both renders
 * the plan (headings/lists/code, scrollable) AND collects the approval in one screen.
 *
 * Decision keys map SAFELY: y / Y / Enter => APPROVE; n / N / Esc / q => REJECT. A dismiss
 * (Esc/q) is a REJECT, never an implicit approval — the whole point of plan mode is that the
 * human must EXPLICITLY approve before any mutation, so the dangerous direction (dismiss silently
 * approving) is impossible here.
 *
 * Like pi-mdview's viewer and pi-plan's dashboard overlay, the live TUI wiring is exercised by
 * a suite that drives the component through a mocked ctx.ui.custom (see
 * tests/integration/plan-approval-view.test.mjs). Any overlay failure is the CALLER's concern:
 * submit_plan falls back to ctx.ui.confirm so approval is never lost.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const VIEWER_MIN_BODY_LINES = 3;
const VIEWER_FIXED_LINES = 5; // top border, title, spacer, footer, bottom border

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
function boundedLine(text: string, width: number): string {
	return padToWidth(truncateToWidth(text, Math.max(1, width)), width);
}

// Build the Markdown theme from the runtime `theme` object using ONLY type-only SDK imports —
// same reasoning as pi-mdview: importing the SDK's getMarkdownTheme() as a VALUE would pull the
// whole coding-agent runtime into the bundle and break the self-contained extension load.
function createMarkdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", theme.bold(text)),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
		codeBlockIndent: "  ",
	};
}

class PlanApprovalComponent implements Component {
	private readonly markdown: Markdown;
	private scroll = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly planId: string,
		content: string,
		private readonly decide: (approved: boolean) => void,
	) {
		this.markdown = new Markdown(content, 1, 0, createMarkdownTheme(theme), undefined, {
			preserveOrderedListMarkers: true,
		});
	}

	handleInput(data: string): void {
		// Decision keys first: y/Y/Enter approve; n/N/Esc/q reject (a dismiss is a reject).
		if (data === "y" || data === "Y" || matchesKey(data, "enter")) {
			this.decide(true);
			return;
		}
		if (data === "n" || data === "N" || data === "q" || matchesKey(data, "escape")) {
			this.decide(false);
			return;
		}

		if (matchesKey(data, "down") || data === "j") this.scroll += 1;
		else if (matchesKey(data, "up") || data === "k") this.scroll -= 1;
		else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.scroll += this.pageSize();
		else if (matchesKey(data, "pageUp")) this.scroll -= this.pageSize();
		else if (matchesKey(data, "home") || data === "g") this.scroll = 0;
		else if (matchesKey(data, "end") || data === "G") this.scroll = Number.MAX_SAFE_INTEGER;
		else return;

		this.tui.requestRender();
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const bodyLines = this.markdown.render(safeWidth);
		const bodyHeight = this.bodyHeight();
		const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
		this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);

		const start = this.scroll;
		const end = Math.min(bodyLines.length, start + bodyHeight);
		const visibleBody = bodyLines.slice(start, end);
		while (visibleBody.length < bodyHeight) visibleBody.push("");

		const title = this.theme.fg("accent", this.theme.bold("Plan"));
		const location = this.theme.fg("dim", this.planId);
		const footer = this.theme.fg(
			"dim",
			`↑/↓ j/k scroll • PgUp/PgDn page • y/Enter approve • n/Esc reject • ${start + 1}-${end}/${bodyLines.length}`,
		);

		const border = this.theme.fg("border", "─".repeat(safeWidth));
		return [
			border,
			boundedLine(`${title} ${location}`, safeWidth),
			"",
			...visibleBody.map((line) => boundedLine(line, safeWidth)),
			boundedLine(footer, safeWidth),
			border,
		];
	}

	private bodyHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(VIEWER_MIN_BODY_LINES, rows - VIEWER_FIXED_LINES);
	}
	private pageSize(): number {
		return Math.max(1, this.bodyHeight() - 1);
	}
}

/**
 * Open the interactive Markdown approval overlay; resolves to true (APPROVE) or false (REJECT).
 * Caller must have already confirmed an interactive UI with ctx.ui.custom available.
 */
export function renderPlanApprovalOverlay(ctx: ExtensionContext, planText: string, planId: string): Promise<boolean> {
	return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		return new PlanApprovalComponent(tui, theme, planId, planText, (approved) => done(approved));
	});
}
