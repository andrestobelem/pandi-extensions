import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadMarkdownDocument } from "./document.js";

export { resolveMarkdownPath } from "./document.js";

const VIEWER_MIN_BODY_LINES = 3;
const VIEWER_FIXED_LINES = 5; // borde superior, título, separador, pie, borde inferior

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		// En modo --print/--json pi toma process.stdout (reservando stdout real
		// para la respuesta del modelo) y enruta toda la salida de consola a stderr. Así, ambas
		// ramas de abajo aparecen en la terminal vía stderr; la separación solo conserva
		// la semántica log/error para quien inspeccione los dos streams.
		if (type === "info") console.log(message);
		else console.error(message);
		return;
	}
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function boundedLine(text: string, width: number): string {
	return padToWidth(truncateToWidth(text, Math.max(1, width)), width);
}

function displayMarkdownPath(cwd: string, filePath: string): string {
	return path.relative(cwd, filePath) || filePath;
}

// Construye el tema de Markdown a partir del objeto `theme` de runtime (el valor que entra al
// callback ctx.ui.custom) usando SOLO imports type-only del SDK. A propósito NO importamos
// getMarkdownTheme() del SDK como valor: eso arrastra todo el runtime de coding-agent
// (cross-spawn/child_process) al bundle y rompe la carga autocontenida de la extensión.
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

class MarkdownViewComponent implements Component {
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
		const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
		this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);

		const start = this.scroll;
		const end = Math.min(bodyLines.length, start + bodyHeight);
		const visibleBody = bodyLines.slice(start, end);
		while (visibleBody.length < bodyHeight) visibleBody.push("");

		const title = this.theme.fg("accent", this.theme.bold("Markdown"));
		const location = this.theme.fg("dim", displayMarkdownPath(this.cwd, this.filePath));
		const footer = this.theme.fg(
			"dim",
			`↑/↓ j/k desplazar • PgUp/PgDn página • q/Esc cerrar • ${start + 1}-${end}/${bodyLines.length}`,
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

/** Abre el visor interactivo con scroll; se resuelve cuando el usuario lo cierra (q/Esc). */
function openMarkdownViewer(ctx: ExtensionContext, filePath: string, content: string): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new MarkdownViewComponent(tui, theme, filePath, ctx.cwd, content, () => done(undefined));
	});
}

async function showMarkdown(pathArg: string, ctx: ExtensionContext): Promise<void> {
	const load = await loadMarkdownDocument(pathArg, ctx.cwd);
	if (!load.ok) {
		notify(ctx, load.message, load.level);
		return;
	}

	if (ctx.mode !== "tui") {
		// Fallback no TUI: vuelca el documento para verlo en la terminal. Bajo --print, pi
		// tomó control de stdout y lo enruta a stderr, así que NO puede redirigirse
		// a un archivo (`pi /mdview f.md > out.md` no captura nada); usá `cat` para texto crudo.
		console.log(load.content);
		return;
	}

	await openMarkdownViewer(ctx, load.filePath, load.content);
}

export default function markdownViewExtension(pi: ExtensionAPI): void {
	pi.registerCommand("mdview", {
		description: "Ver un archivo Markdown en la TUI de Pi",
		handler: async (args, ctx) => {
			await showMarkdown(args, ctx);
		},
	});

	// Contraparte invocable por el modelo de `/mdview`. El comando es solo para el usuario (el agente no puede
	// tipear un slash command), así que esta TOOL le permite al agente mostrar Markdown: abre el
	// mismo visor con scroll en una TUI y devuelve el contenido crudo en modos no interactivos
	// (donde se renderiza en la transcripción).
	pi.registerTool({
		name: "view_markdown",
		label: "Ver Markdown",
		description:
			"Abre un archivo Markdown para el usuario. En una TUI abre el visor Markdown con scroll de Pi; en modos no interactivos devuelve el contenido Markdown del archivo. Usalo cuando el usuario pida mostrar, abrir o ver un archivo Markdown (.md).",
		promptSnippet: "Mostrar o abrir un archivo Markdown para el usuario.",
		parameters: Type.Object({
			path: Type.String({
				minLength: 1,
				description: "Ruta al archivo Markdown: relativa al cwd, expandida con ~, o absoluta.",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const load = await loadMarkdownDocument(params.path, ctx.cwd);
			if (!load.ok) {
				return {
					content: [{ type: "text" as const, text: load.message }],
					details: { isError: true },
				};
			}
			const relativePath = displayMarkdownPath(ctx.cwd, load.filePath);
			if (ctx.mode === "tui" && ctx.hasUI) {
				await openMarkdownViewer(ctx, load.filePath, load.content);
				return {
					content: [
						{
							type: "text" as const,
							text: `Se abrió ${relativePath} en el visor Markdown (${load.bytes} bytes).`,
						},
					],
					details: { path: relativePath, bytes: load.bytes, opened: true },
				};
			}
			return {
				content: [{ type: "text" as const, text: load.content }],
				details: { path: relativePath, bytes: load.bytes, opened: false },
			};
		},
	});
}
