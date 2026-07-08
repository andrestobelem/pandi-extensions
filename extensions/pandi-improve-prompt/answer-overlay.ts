/**
 * Overlay desplazable de `/improve-prompt` en la TUI.
 *
 * Está duplicado desde `pandi-btw` a propósito: cada extensión debe poder publicarse sola,
 * manteniendo el mismo modelo de desplazamiento, el mismo render de Markdown y el mismo
 * cerrar con q/Esc.
 * Se monta vía `ctx.ui.custom()`; mostrarlo no persiste ni envía nada por sí solo.
 * Enviar el resultado es un paso aparte del llamador; al cerrar con q/Esc solo vuelve el
 * control al editor.
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
const VIEWER_FIXED_LINES = 5; // borde superior, título, espacio, pie, borde inferior

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

type OverlayInputAction =
	| { readonly type: "close" }
	| { readonly type: "line"; readonly delta: 1 | -1 }
	| { readonly type: "page"; readonly delta: 1 | -1 }
	| { readonly type: "home" }
	| { readonly type: "end" }
	| { readonly type: "noop" };

function resolveOverlayInputAction(data: string): OverlayInputAction {
	if (matchesKey(data, "q") || matchesKey(data, "escape")) return { type: "close" };
	if (matchesKey(data, "down") || data === "j") return { type: "line", delta: 1 };
	if (matchesKey(data, "up") || data === "k") return { type: "line", delta: -1 };
	if (matchesKey(data, "pageDown") || matchesKey(data, "space")) return { type: "page", delta: 1 };
	if (matchesKey(data, "pageUp")) return { type: "page", delta: -1 };
	if (matchesKey(data, "home") || data === "g") return { type: "home" };
	if (matchesKey(data, "end") || data === "G") return { type: "end" };
	return { type: "noop" };
}

class AnswerViewComponent implements Component {
	private readonly markdown: Markdown;
	private scroll = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly label: string,
		body: string,
		private readonly done: () => void,
	) {
		this.markdown = new Markdown(body, 1, 0, createMarkdownTheme(theme), undefined, {
			preserveOrderedListMarkers: true,
		});
	}

	handleInput(data: string): void {
		const action = resolveOverlayInputAction(data);
		switch (action.type) {
			case "close":
				this.done();
				return;
			case "line":
				this.scroll += action.delta;
				break;
			case "page":
				this.scroll += action.delta * this.pageSize();
				break;
			case "home":
				this.scroll = 0;
				break;
			case "end":
				this.scroll = Number.MAX_SAFE_INTEGER;
				break;
			case "noop":
				return;
		}

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

		const title = this.theme.fg("accent", this.theme.bold("improve-prompt"));
		const label = this.theme.fg("dim", this.label);
		const footer = this.theme.fg(
			"dim",
			`↑/↓ j/k desplazar • PgUp/PgDn página • q/Esc cerrar • ${start + 1}-${end}/${bodyLines.length}`,
		);

		const border = this.theme.fg("border", "─".repeat(safeWidth));
		return [
			border,
			boundedLine(`${title} ${label}`, safeWidth),
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

/** Abre el overlay de resultados y resuelve al cerrarlo con q/Esc. */
export function openAnswerOverlay(ctx: ExtensionContext, label: string, body: string): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new AnswerViewComponent(tui, theme, label, body, () => done(undefined));
	});
}
