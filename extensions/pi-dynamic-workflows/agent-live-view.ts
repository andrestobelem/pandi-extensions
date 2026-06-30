/**
 * AgentLiveViewComponent — the TUI component that renders a single agent's live
 * execution output (scrollable log with a status header).
 *
 * Pure presentation over plain string content; index.ts feeds it the streamed agent
 * text and constructs it only inside the showLiveAgentView ctx.ui.custom callback.
 * Deferred cycle: it reads liveAgentHeaderStatus from ./index.js only inside render()
 * (erased-safe at load); index.ts imports the class back as a value used only in that
 * callback body. Extracted byte-identically (only an added `export ` prefix).
 */
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { liveAgentHeaderStatus } from "./agent-view.js";
import { createMarkdownTheme, formatViewerHints, scrollDelta } from "./markdown-view.js";

export class AgentLiveViewComponent {
	// The agent view body is Markdown (formatAgentView output): render it RICH via pi-tui's
	// Markdown component, the same renderer the run view and pi-mdview use, so headings/code
	// blocks/lists look right instead of a flat line dump. Rebuilt on each setContent tick.
	private markdown: Markdown | undefined;
	private scroll = 0;
	private agentState: string | undefined;

	constructor(
		private readonly theme: any,
		private readonly getHeight: () => number,
		private readonly done: (intent?: "openFiles") => void,
		private readonly requestRender: () => void = () => {},
		private readonly canOpenFiles = false,
	) {}

	setContent(content: string, state?: string): void {
		this.markdown = new Markdown(content, 1, 0, createMarkdownTheme(this.theme), undefined, {
			preserveOrderedListMarkers: true,
		});
		if (state !== undefined) this.agentState = state;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (this.canOpenFiles && data === "f") {
			this.done("openFiles");
			return;
		}
		// Scroll is clamped in render() once the body height is known for the active width.
		const delta = scrollDelta(data, this.pageSize());
		if (delta === null) return;
		if (delta === "top") this.scroll = 0;
		else if (delta === "bottom") this.scroll = Number.MAX_SAFE_INTEGER;
		else this.scroll += delta;
		// Repaint immediately on scroll instead of waiting for the 1s refresh tick.
		this.requestRender();
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const page = this.pageSize();
		const bodyLines = this.markdown ? this.markdown.render(w) : ["Loading agent execution…"];
		const maxScroll = Math.max(0, bodyLines.length - page);
		this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
		const line = (textValue: string) => truncateToWidth(textValue, w, "…");
		const end = Math.min(bodyLines.length, this.scroll + page);
		const hints = formatViewerHints({
			canOpenFiles: this.canOpenFiles,
			start: this.scroll + 1,
			end,
			total: bodyLines.length,
		});
		const header =
			this.theme.fg("accent", "Live workflow agent") +
			this.theme.fg("dim", ` • ${liveAgentHeaderStatus(this.agentState)} • ${hints}`);
		return [
			line(header),
			line(this.theme.fg("border", "─".repeat(Math.min(w, 120)))),
			...bodyLines.slice(this.scroll, end).map(line),
		];
	}

	invalidate(): void {
		this.markdown?.invalidate();
	}

	private pageSize(): number {
		return Math.max(5, this.getHeight() - 4);
	}
}
