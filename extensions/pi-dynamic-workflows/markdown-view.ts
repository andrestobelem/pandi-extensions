/**
 * Shared Markdown viewer for the dynamic-workflows dashboard.
 *
 * A self-contained scrollable viewer built on pi-tui's `Markdown` component so run views,
 * agent views, and `.md` artifacts render as RICH Markdown (headings, code blocks, lists)
 * instead of a plain text editor dump. We deliberately do NOT import pi-mdview at runtime
 * (the self-contained-extension rule forbids cross-extension runtime imports), nor the SDK's
 * getMarkdownTheme() as a value (that pulls the whole coding-agent runtime —
 * cross-spawn/child_process — into the bundle and breaks standalone load). Instead the
 * Markdown theme is built from the runtime `theme` object using ONLY type-only SDK imports.
 * The small chrome duplication with pi-mdview's own viewer is intentional and sanctioned.
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
import { notify } from "./notify.js";

const VIEWER_MIN_BODY_LINES = 3;
const VIEWER_FIXED_LINES = 5; // top border, title, spacer, footer, bottom border

/** Route a file path to the viewer that fits it: Markdown for .md/.markdown, else text. */
export function pickViewerForPath(filePath: string): "markdown" | "text" {
	const lower = filePath.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown") ? "markdown" : "text";
}

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function boundedLine(text: string, width: number): string {
	return padToWidth(truncateToWidth(text, Math.max(1, width)), width);
}

// Build the Markdown theme from the runtime `theme` (a value handed to the ctx.ui.custom
// callback). Type-only SDK imports keep this self-contained (see file header). Exported for
// reuse WITHIN this extension (e.g. the live agent view) — never imported across extensions.
export function createMarkdownTheme(theme: Theme): MarkdownTheme {
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

/** Intent returned when the viewer closes: plain close (undefined) or "open an artifact". */
export type MarkdownViewIntent = "openFiles" | undefined;

export class WorkflowMarkdownViewComponent implements Component {
	private readonly markdown: Markdown;
	private scroll = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly title: string,
		content: string,
		private readonly done: (intent: MarkdownViewIntent) => void,
		private readonly canOpenFiles = false,
	) {
		this.markdown = new Markdown(content, 1, 0, createMarkdownTheme(theme), undefined, {
			preserveOrderedListMarkers: true,
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		}
		if (this.canOpenFiles && data === "f") {
			this.done("openFiles");
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

		const title = this.theme.fg("accent", this.theme.bold(this.title));
		const filesHint = this.canOpenFiles ? "f files • " : "";
		const footer = this.theme.fg(
			"dim",
			`↑/↓ j/k scroll • PgUp/PgDn page • ${filesHint}q/Esc close • ${start + 1}-${end}/${bodyLines.length}`,
		);
		const border = this.theme.fg("border", "─".repeat(safeWidth));
		return [
			border,
			boundedLine(title, safeWidth),
			"",
			...visibleBody.map((bodyLine) => boundedLine(bodyLine, safeWidth)),
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
 * Open the Markdown viewer for already-derived content (run views, agent views, artifacts),
 * mirroring showText's mode switch: print → console.log; TUI → scrollable viewer; otherwise
 * the plain editor / a notify fallback. Returns the close intent so callers can implement an
 * artifact-open loop (see showRunView). `canOpenFiles` advertises the `f` files affordance.
 */
export async function showMarkdown(
	ctx: ExtensionContext,
	title: string,
	content: string,
	options: { canOpenFiles?: boolean } = {},
): Promise<MarkdownViewIntent> {
	if (ctx.mode === "print") {
		console.log(content);
		return undefined;
	}
	if (ctx.mode === "tui" && ctx.hasUI) {
		return await ctx.ui.custom<MarkdownViewIntent>(
			(tui, theme, _keybindings, done) =>
				new WorkflowMarkdownViewComponent(tui, theme, title, content, done, !!options.canOpenFiles),
		);
	}
	if (ctx.hasUI) {
		await ctx.ui.editor(title, content);
		return undefined;
	}
	notify(ctx, content, "info");
	return undefined;
}
