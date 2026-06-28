import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth, visibleWidth, type Component, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const VIEWER_MIN_BODY_LINES = 3;
const VIEWER_FIXED_LINES = 5; // top border, title, spacer, footer, bottom border
const MAX_MDVIEW_BYTES = 2_000_000; // guard: reading/parsing a huge file blocks the TUI event loop

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		// In --print/--json mode pi takes over process.stdout (reserving real stdout
		// for the model response) and routes all console output to stderr. So both
		// branches below surface on the terminal via stderr; the split only keeps
		// log/error semantics for any caller that inspects the two streams.
		if (type === "info") console.log(message);
		else console.error(message);
		return;
	}
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function stripWrappingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function resolveMarkdownPath(rawPath: string, cwd: string): string | undefined {
	const requested = stripWrappingQuotes(rawPath);
	if (!requested) return undefined;
	if (requested === "~") return os.homedir();
	if (requested.startsWith("~/")) return path.join(os.homedir(), requested.slice(2));
	return path.resolve(cwd, requested);
}

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
		this.markdown = new Markdown(content, 1, 0, createMarkdownTheme(theme), undefined, { preserveOrderedListMarkers: true });
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
		const relativePath = path.relative(this.cwd, this.filePath) || this.filePath;
		const location = this.theme.fg("dim", relativePath);
		const footer = this.theme.fg("dim", `↑/↓ j/k scroll • PgUp/PgDn page • q/Esc close • ${start + 1}-${end}/${bodyLines.length}`);

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

async function showMarkdown(pathArg: string, ctx: ExtensionCommandContext): Promise<void> {
	const filePath = resolveMarkdownPath(pathArg, ctx.cwd);
	if (!filePath) {
		notify(ctx, "Usage: /mdview <path-to-markdown-file>", "warning");
		return;
	}

	let content: string;
	try {
		const stat = await fs.stat(filePath);
		if (stat.size > MAX_MDVIEW_BYTES) {
			notify(ctx, `Markdown file is too large to view (${stat.size} bytes; limit ${MAX_MDVIEW_BYTES}).`, "warning");
			return;
		}
		content = await fs.readFile(filePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `Could not read Markdown file: ${message}`, "error");
		return;
	}

	if (ctx.mode !== "tui") {
		// Non-TUI fallback: dump the document for terminal viewing. Under --print pi
		// has taken over stdout and routes this to stderr, so it is NOT redirectable
		// to a file (`pi /mdview f.md > out.md` captures nothing); use `cat` for raw text.
		console.log(content);
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new MarkdownViewComponent(tui, theme, filePath, ctx.cwd, content, () => done(undefined));
	});
}

export default function markdownViewExtension(pi: ExtensionAPI): void {
	pi.registerCommand("mdview", {
		description: "View a Markdown file in Pi's TUI",
		handler: async (args, ctx) => {
			await showMarkdown(args, ctx);
		},
	});
}
