/**
 * Overlay cerrable y desplazable que muestra una respuesta de `/btw` en la TUI.
 *
 * Este es el análogo en Pi del overlay `/btw` de Claude Code: la respuesta aparece sobre
 * la sesión SIN escribirse en la conversación. Se renderiza con ctx.ui.custom() (que
 * toma el control del editor temporalmente y resuelve cuando el usuario lo cierra), así
 * que no se persiste nada: al cerrarlo solo vuelve el control al editor.
 *
 * El componente está vendoreado desde MarkdownViewComponent de pandi-mdview (se permite la
 * duplicación entre extensiones para que cada una pueda publicarse standalone): mismo
 * modelo de scroll, mismo renderizado de Markdown, mismo cierre con q/Esc. Las únicas
 * diferencias son el encabezado (la pregunta en lugar de una ruta de archivo) y que
 * recibe la salida del modelo en vez de un archivo.
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
const VIEWER_FIXED_LINES = 5; // borde superior, título, espaciador, pie, borde inferior

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

/** Abre el overlay interactivo de respuesta; se resuelve cuando el usuario lo cierra (q/Esc). */
export function openAnswerOverlay(ctx: ExtensionContext, question: string, answer: string): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new AnswerViewComponent(tui, theme, question, answer, () => done(undefined));
	});
}
