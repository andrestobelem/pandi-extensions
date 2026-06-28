import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type MarkdownTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const VIEWER_MIN_BODY_LINES = 3;
const VIEWER_FIXED_LINES = 5; // top border, title, spacer, footer, bottom border
const MAX_MDVIEW_BYTES = 2_000_000; // guard: reading/parsing a huge file blocks the TUI event loop

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
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
		const relativePath = path.relative(this.cwd, this.filePath) || this.filePath;
		const location = this.theme.fg("dim", relativePath);
		const footer = this.theme.fg(
			"dim",
			`↑/↓ j/k scroll • PgUp/PgDn page • q/Esc close • ${start + 1}-${end}/${bodyLines.length}`,
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

type MarkdownLoad =
	| { ok: true; filePath: string; content: string; bytes: number }
	| { ok: false; message: string; level: "warning" | "error" };

/**
 * Resolve + size-guard + read a Markdown file. Shared by the `/mdview` command and the
 * model-callable `view_markdown` tool so both apply the SAME validation and limits.
 * Pure of UI: callers decide how to surface success (viewer / content) and errors.
 */
async function loadMarkdownDocument(pathArg: string, cwd: string): Promise<MarkdownLoad> {
	const filePath = resolveMarkdownPath(pathArg, cwd);
	if (!filePath) return { ok: false, message: "Usage: /mdview <path-to-markdown-file>", level: "warning" };
	try {
		const stat = await fs.stat(filePath);
		if (stat.size > MAX_MDVIEW_BYTES) {
			return {
				ok: false,
				message: `Markdown file is too large to view (${stat.size} bytes; limit ${MAX_MDVIEW_BYTES}).`,
				level: "warning",
			};
		}
		const content = await fs.readFile(filePath, "utf8");
		return { ok: true, filePath, content, bytes: stat.size };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `Could not read Markdown file: ${message}`, level: "error" };
	}
}

/** Open the interactive scroll viewer; resolves when the user closes it (q/Esc). */
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
		// Non-TUI fallback: dump the document for terminal viewing. Under --print pi
		// has taken over stdout and routes this to stderr, so it is NOT redirectable
		// to a file (`pi /mdview f.md > out.md` captures nothing); use `cat` for raw text.
		console.log(load.content);
		return;
	}

	await openMarkdownViewer(ctx, load.filePath, load.content);
}

export default function markdownViewExtension(pi: ExtensionAPI): void {
	pi.registerCommand("mdview", {
		description: "View a Markdown file in Pi's TUI",
		handler: async (args, ctx) => {
			await showMarkdown(args, ctx);
		},
	});

	// Model-callable counterpart of `/mdview`. The command is user-only (the agent cannot
	// type a slash command), so this TOOL lets the agent itself show Markdown: it opens the
	// same scroll viewer in a TUI, and returns the raw content in non-interactive modes
	// (where it renders in the transcript).
	pi.registerTool({
		name: "view_markdown",
		label: "View Markdown",
		description:
			"Open a Markdown file for the user. In a TUI it opens Pi's scrollable Markdown viewer; in non-interactive modes it returns the file's Markdown content. Use when the user asks to show, open, or view a Markdown (.md) file.",
		promptSnippet: "Show or open a Markdown file for the user.",
		parameters: Type.Object({
			path: Type.String({
				minLength: 1,
				description: "Path to the Markdown file: relative to the cwd, ~-expanded, or absolute.",
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
			const relativePath = path.relative(ctx.cwd, load.filePath) || load.filePath;
			if (ctx.mode === "tui" && ctx.hasUI) {
				await openMarkdownViewer(ctx, load.filePath, load.content);
				return {
					content: [
						{
							type: "text" as const,
							text: `Opened ${relativePath} in the Markdown viewer (${load.bytes} bytes).`,
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
