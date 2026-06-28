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
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { liveAgentHeaderStatus } from "./index.js";

export class AgentLiveViewComponent {
	private lines: string[] = ["Loading agent execution…"];
	private scroll = 0;
	private agentState: string | undefined;

	constructor(
		private readonly theme: any,
		private readonly getHeight: () => number,
		private readonly close: () => void,
		private readonly requestRender: () => void = () => {},
	) {}

	setContent(content: string, state?: string): void {
		this.lines = content.split(/\r?\n/);
		if (state !== undefined) this.agentState = state;
		this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll()));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.close();
			return;
		}
		if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll = Math.min(this.maxScroll(), this.scroll + 1);
		else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - this.pageSize());
		else if (matchesKey(data, Key.pageDown))
			this.scroll = Math.min(this.maxScroll(), this.scroll + this.pageSize());
		else if (matchesKey(data, Key.home)) this.scroll = 0;
		else if (matchesKey(data, Key.end)) this.scroll = this.maxScroll();
		// Repaint immediately on scroll instead of waiting for the 1s refresh tick.
		this.requestRender();
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const page = this.pageSize();
		this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll()));
		const line = (textValue: string) => truncateToWidth(textValue, w, "…");
		const header =
			this.theme.fg("accent", "Live workflow agent") +
			this.theme.fg(
				"dim",
				` • ${liveAgentHeaderStatus(this.agentState)} • ↑↓/PgUp/PgDn scroll • q/esc close • ${this.scroll + 1}-${Math.min(this.lines.length, this.scroll + page)}/${this.lines.length}`,
			);
		return [
			line(header),
			line(this.theme.fg("dim", "─".repeat(Math.min(w, 120)))),
			...this.lines.slice(this.scroll, this.scroll + page).map(line),
		];
	}

	invalidate(): void {}

	private pageSize(): number {
		return Math.max(5, this.getHeight() - 4);
	}

	private maxScroll(): number {
		return Math.max(0, this.lines.length - this.pageSize());
	}
}
