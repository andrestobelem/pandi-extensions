/**
 * AgentLiveViewComponent — the TUI component that renders a single agent's live
 * execution output (scrollable log with a status header), optionally with SUB-TABS
 * (Card / Prompt / Output / Definition / Run) so the Monitor's Enter detail screen
 * lets the user move between views without bouncing back to the dashboard.
 *
 * Pure presentation over plain string content; agent-view.ts feeds it the per-tab
 * Markdown and constructs it only inside the showLiveAgentView ctx.ui.custom callback.
 * Tabs mode: `tabs` labels the sub-views, `setTabContent(key, content)` fills them,
 * ←/→ Tab/Shift+Tab/digits switch (scroll is remembered PER TAB), and `onTabChange`
 * lets the opener load the newly-focused tab immediately instead of waiting for the
 * 1s poll. Without `tabs` it behaves exactly as the legacy single-document viewer.
 * Deferred cycle: it reads liveAgentHeaderStatus from ./agent-view.js only inside
 * render() (erased-safe at load). Extracted byte-identically before tabs were added.
 */
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { liveAgentHeaderStatus } from "./agent-view.js";
import { createMarkdownTheme, formatViewerHints, scrollDelta } from "./markdown-view.js";

export interface AgentViewTab {
	key: string;
	label: string;
}

export class AgentLiveViewComponent {
	// The body is Markdown (formatAgentView & friends): render it RICH via pi-tui's
	// Markdown component, the same renderer the run view and pi-mdview use. One
	// Markdown + one scroll offset per tab so switching keeps each tab's position.
	private markdownByTab = new Map<string, Markdown>();
	private scrollByTab = new Map<string, number>();
	private tabIndex = 0;
	private agentState: string | undefined;

	constructor(
		private readonly theme: any,
		private readonly getHeight: () => number,
		private readonly done: (intent?: "openFiles") => void,
		private readonly requestRender: () => void = () => {},
		private readonly canOpenFiles = false,
		private readonly tabs: AgentViewTab[] = [],
		private readonly onTabChange?: (key: string) => void,
	) {}

	/** Key of the currently focused tab ("" in legacy single-document mode). */
	getActiveTab(): string {
		return this.tabs[this.tabIndex]?.key ?? "";
	}

	setTabContent(key: string, content: string): void {
		this.markdownByTab.set(
			key,
			new Markdown(content, 1, 0, createMarkdownTheme(this.theme), undefined, {
				preserveOrderedListMarkers: true,
			}),
		);
	}

	// Legacy entry point: sets the active tab's content (the ONLY document when no
	// tabs were passed) and records the agent state for the header status label.
	setContent(content: string, state?: string): void {
		if (state !== undefined) this.agentState = state;
		// In tabs mode the opener drives content via setTabContent; a bare setContent
		// only updates state so the header can flip to "final (...)".
		if (this.tabs.length === 0) this.setTabContent(this.getActiveTab(), content);
	}

	setState(state: string | undefined): void {
		if (state !== undefined) this.agentState = state;
	}

	private switchTab(index: number): void {
		const n = this.tabs.length;
		if (n === 0) return;
		const next = ((index % n) + n) % n;
		if (next === this.tabIndex) return;
		this.tabIndex = next;
		this.onTabChange?.(this.getActiveTab());
		this.requestRender();
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
		if (this.tabs.length > 0) {
			if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
				this.switchTab(this.tabIndex + 1);
				return;
			}
			if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab")) {
				this.switchTab(this.tabIndex - 1);
				return;
			}
			const digit = /^[1-9]$/.test(data) ? Number(data) : 0;
			if (digit >= 1 && digit <= this.tabs.length) {
				this.switchTab(digit - 1);
				return;
			}
		}
		// Scroll is clamped in render() once the body height is known for the active width.
		const delta = scrollDelta(data, this.pageSize());
		if (delta === null) return;
		const key = this.getActiveTab();
		const current = this.scrollByTab.get(key) ?? 0;
		if (delta === "top") this.scrollByTab.set(key, 0);
		else if (delta === "bottom") this.scrollByTab.set(key, Number.MAX_SAFE_INTEGER);
		else this.scrollByTab.set(key, current + delta);
		// Repaint immediately on scroll instead of waiting for the 1s refresh tick.
		this.requestRender();
	}

	private renderTabBar(): string {
		return this.tabs
			.map((tab, index) =>
				index === this.tabIndex
					? this.theme.fg("accent", `[${tab.label}]`)
					: this.theme.fg("muted", ` ${tab.label} `),
			)
			.join(" ");
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const page = this.pageSize();
		const key = this.getActiveTab();
		const markdown = this.markdownByTab.get(key);
		const bodyLines = markdown ? markdown.render(w) : ["Loading agent execution…"];
		const maxScroll = Math.max(0, bodyLines.length - page);
		const scroll = Math.max(0, Math.min(this.scrollByTab.get(key) ?? 0, maxScroll));
		this.scrollByTab.set(key, scroll);
		const line = (textValue: string) => truncateToWidth(textValue, w, "…");
		const end = Math.min(bodyLines.length, scroll + page);
		const tabsHint = this.tabs.length > 0 ? "←→ tabs • " : "";
		const hints =
			tabsHint +
			formatViewerHints({
				canOpenFiles: this.canOpenFiles,
				start: scroll + 1,
				end,
				total: bodyLines.length,
			});
		const header =
			this.theme.fg("accent", "Live workflow agent") +
			this.theme.fg("dim", ` • ${liveAgentHeaderStatus(this.agentState)} • ${hints}`);
		const chrome = [line(header)];
		if (this.tabs.length > 0) chrome.push(line(this.renderTabBar()));
		chrome.push(line(this.theme.fg("border", "─".repeat(Math.min(w, 120)))));
		return [...chrome, ...bodyLines.slice(scroll, end).map(line)];
	}

	invalidate(): void {
		for (const markdown of this.markdownByTab.values()) markdown.invalidate();
	}

	private pageSize(): number {
		// One extra chrome line (the tab bar) in tabs mode.
		return Math.max(5, this.getHeight() - (this.tabs.length > 0 ? 5 : 4));
	}
}
