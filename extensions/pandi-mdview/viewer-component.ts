/**
 * Visor TUI con scroll para archivos Markdown.
 */

import * as path from "node:path";
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

export const VIEWER_MIN_BODY_LINES = 3;
export const VIEWER_FIXED_LINES = 5;

export function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function boundedLine(text: string, width: number): string {
	return padToWidth(truncateToWidth(text, Math.max(1, width)), width);
}

export function displayMarkdownPath(cwd: string, filePath: string): string {
	return path.relative(cwd, filePath) || filePath;
}

type MarkdownViewport = {
	scroll: number;
	start: number;
	end: number;
	visibleBody: string[];
};

export function calculateMarkdownViewport(bodyLines: string[], scroll: number, bodyHeight: number): MarkdownViewport {
	const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
	const clampedScroll = Math.min(Math.max(0, scroll), maxScroll);
	const start = clampedScroll;
	const end = Math.min(bodyLines.length, start + bodyHeight);
	const visibleBody = bodyLines.slice(start, end);
	while (visibleBody.length < bodyHeight) visibleBody.push("");
	return { scroll: clampedScroll, start, end, visibleBody };
}

// Tema desde `theme` de runtime con imports type-only del SDK — sin getMarkdownTheme() como valor
// (arrastraría child_process al bundle y rompe la extensión autocontenida).
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

export class MarkdownViewComponent implements Component {
	private readonly markdown: Markdown;
	private scroll = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly filePath: string,
		private readonly cwd: string,
		content: string,
		private readonly done: () => void,
	) {
		this.markdown = new Markdown(content, 1, 0, createMarkdownTheme(theme), undefined, {
			preserveOrderedListMarkers: true,
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, "escape")) {
			this.done();
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
		const viewport = calculateMarkdownViewport(bodyLines, this.scroll, bodyHeight);
		this.scroll = viewport.scroll;

		const title = this.theme.fg("accent", this.theme.bold("Markdown"));
		const location = this.theme.fg("dim", displayMarkdownPath(this.cwd, this.filePath));
		const footer = this.theme.fg(
			"dim",
			`↑/↓ j/k desplazar • PgUp/PgDn página • q/Esc cerrar • ${viewport.start + 1}-${viewport.end}/${bodyLines.length}`,
		);

		const border = this.theme.fg("border", "─".repeat(safeWidth));
		return [
			border,
			boundedLine(`${title} ${location}`, safeWidth),
			"",
			...viewport.visibleBody.map((line) => boundedLine(line, safeWidth)),
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

/** Abre el visor interactivo; se resuelve cuando el usuario lo cierra (q/Esc). */
export function openMarkdownViewer(ctx: ExtensionContext, filePath: string, content: string): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new MarkdownViewComponent(tui, theme, filePath, ctx.cwd, content, () => done(undefined));
	});
}
