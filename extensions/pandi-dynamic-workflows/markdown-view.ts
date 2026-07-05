/**
 * Shared Markdown viewer para el dynamic-workflows dashboard.
 *
 * Un viewer scrollable self-contained construido sobre pi-tui's `Markdown` component
 * así run views, agent views, y `.md` artifacts se renderizan como RICH Markdown
 * (headings, code blocks, lists) en lugar de plain text editor dump. Deliberadamente
 * NO importamos pandi-mdview at runtime (la self-contained-extension rule prohíbe
 * cross-extension runtime imports), ni el getMarkdownTheme() del SDK como valor
 * (eso tira todo el coding-agent runtime — cross-spawn/child_process — al bundle
 * y rompe standalone load). En lugar de eso el Markdown theme se construye desde el
 * runtime `theme` object usando SOLO type-only SDK imports. La small chrome duplication
 * con el own viewer de pandi-mdview es intencional y sanctioned.
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

/** Rutea un file path al viewer que le cabe: Markdown para .md/.markdown, else text. */
export function pickViewerForPath(filePath: string): "markdown" | "text" {
	const lower = filePath.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown") ? "markdown" : "text";
}

// Shared viewer chrome (una source of truth para el run view Y el live agent view):
// la navigation/close/position hint string y el scroll-key mapping, así ambos viewers
// advertisen y honren las MISMAS keys.
export function formatViewerHints(opts: { canOpenFiles: boolean; start: number; end: number; total: number }): string {
	const filesHint = opts.canOpenFiles ? "f files • " : "";
	return `↑/↓ j/k scroll • PgUp/PgDn page • ${filesHint}q/Esc close • ${opts.start}-${opts.end}/${opts.total}`;
}

// Mapea un input key a una scroll action compartida por ambos viewers: un line delta (±1),
// un page delta (±page), "top"/"bottom" jumps, o null cuando la key no es scroll key.
export function scrollDelta(data: string, page: number): number | "top" | "bottom" | null {
	if (matchesKey(data, "down") || data === "j") return 1;
	if (matchesKey(data, "up") || data === "k") return -1;
	if (matchesKey(data, "pageDown") || matchesKey(data, "space")) return page;
	if (matchesKey(data, "pageUp")) return -page;
	if (matchesKey(data, "home") || data === "g") return "top";
	if (matchesKey(data, "end") || data === "G") return "bottom";
	return null;
}

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function boundedLine(text: string, width: number): string {
	return padToWidth(truncateToWidth(text, Math.max(1, width)), width);
}

// Construye el Markdown theme desde el runtime `theme` (un valor pasado al ctx.ui.custom
// callback). Type-only SDK imports mantiene esto self-contained (ver file header). Exportado
// para reuse WITHIN esta extensión (p. ej. el live agent view) — nunca importado entre extensions.
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

/** Intent devuelto cuando el viewer cierra: plain close (undefined) o "open an artifact". */
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
		const delta = scrollDelta(data, this.pageSize());
		if (delta === null) return;
		if (delta === "top") this.scroll = 0;
		else if (delta === "bottom") this.scroll = Number.MAX_SAFE_INTEGER;
		else this.scroll += delta;
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
		const footer = this.theme.fg(
			"dim",
			formatViewerHints({ canOpenFiles: this.canOpenFiles, start: start + 1, end, total: bodyLines.length }),
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
