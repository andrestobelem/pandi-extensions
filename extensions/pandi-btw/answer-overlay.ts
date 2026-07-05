/**
 * The dismissible, scrollable overlay that shows a `/btw` answer in the TUI.
 *
 * This is the Pi analogue of Claude Code's `/btw` overlay: the answer appears on top of
 * the session WITHOUT being written into the conversation. It is rendered via
 * ctx.ui.custom() (which temporarily takes over the editor and resolves when the user
 * dismisses it), so nothing is persisted — closing it just returns control to the editor.
 *
 * The component is vendored from pi-mdview's MarkdownViewComponent (cross-extension
 * duplication is allowed so each extension can be published standalone): same scroll
 * model, same Markdown rendering, same q/Esc-to-close. The only differences are the
 * header (the question instead of a file path) and that it is fed model output rather
 * than a file.
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

class AnswerViewComponent implements Component {
	private readonly markdown: Markdown;
	private scroll = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly question: string,
		answer: string,
		private readonly done: () => void,
	) {
		this.markdown = new Markdown(answer, 1, 0, createMarkdownTheme(theme), undefined, {
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
		const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
		this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);

		const start = this.scroll;
		const end = Math.min(bodyLines.length, start + bodyHeight);
		const visibleBody = bodyLines.slice(start, end);
		while (visibleBody.length < bodyHeight) visibleBody.push("");

		const title = this.theme.fg("accent", this.theme.bold("btw"));
		const question = this.theme.fg("dim", this.question);
		const footer = this.theme.fg(
			"dim",
			`↑/↓ j/k desplazar • PgUp/PgDn página • q/Esc cerrar • ${start + 1}-${end}/${bodyLines.length}`,
		);

		const border = this.theme.fg("border", "─".repeat(safeWidth));
		return [
			border,
			boundedLine(`${title} ${question}`, safeWidth),
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

/** Open the interactive answer overlay; resolves when the user closes it (q/Esc). */
export function openAnswerOverlay(ctx: ExtensionContext, question: string, answer: string): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new AnswerViewComponent(tui, theme, question, answer, () => done(undefined));
	});
}
