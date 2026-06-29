/**
 * WorkflowDashboardDownEditor — the custom Down-key editor that opens the workflow
 * dashboard from the prompt, plus its install hook and small cursor helper.
 *
 * installWorkflowDashboardDownEditor wires the editor into the session; the class
 * implements the host EditorComponent contract. Deferred cycle: it calls
 * openWorkflowDashboard from ./index.js only inside the editor's open closure, and
 * index.ts imports installWorkflowDashboardDownEditor back (invoked only in the
 * session_start handler). The Dashboard* function types stay in index.ts (shared with
 * openWorkflowDashboard) and cross as import type. Extracted byte-identically.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { DashboardCommandSubmitter, DashboardOpener } from "./dashboard-orchestration.js";
import { openWorkflowDashboard } from "./dashboard-orchestration.js";
import { type ColorMode, colorizeKeyword, detectColorMode } from "./rainbow.js";
import { stripAnsiCodes } from "./render-utils.js";

const WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER = "__dynamicWorkflowDashboardDownEditor";
// ~8 fps: smooth enough for a scrolling rainbow without flooding the renderer. The timer
// only triggers a re-render while the prompt holds the keyword AND is focused, so an idle
// or keyword-free prompt costs nothing beyond one boolean check per tick.
const RAINBOW_INTERVAL_MS = 120;
// The typed words that get the animated multicolor effect (case-insensitive).
const RAINBOW_KEYWORDS = ["ultracode", "workflow"];

class WorkflowDashboardDownEditor implements EditorComponent {
	readonly [WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER] = true;
	actionHandlers: Map<string, () => void>;
	private opening = false;

	constructor(
		private readonly base: EditorComponent,
		private openDashboard: DashboardOpener,
		private openAgentsDashboard: DashboardOpener = openDashboard,
		private getBorderLabel: () => string | undefined = () => undefined,
		private readonly requestRender: () => void = () => {},
	) {
		const customBase = base as { actionHandlers?: unknown };
		this.actionHandlers =
			customBase.actionHandlers instanceof Map
				? (customBase.actionHandlers as Map<string, () => void>)
				: new Map<string, () => void>();
		if (this.rainbowColorMode !== "none") {
			this.rainbowTimer = setInterval(() => this.tickRainbow(), RAINBOW_INTERVAL_MS);
			// Never let the animation keep the Node process alive on its own.
			this.rainbowTimer.unref?.();
		}
	}

	private rainbowPhase = 0;
	private rainbowTimer?: ReturnType<typeof setInterval>;
	private readonly rainbowColorMode: ColorMode = detectColorMode();

	// Advance the rainbow band and repaint, but only while the prompt actually contains the
	// keyword and is focused — so the effect animates as you type "ultracode" and pauses (no
	// wasted renders) when the word is gone, a dashboard/modal is up, or color is unsupported.
	private tickRainbow(): void {
		if (this.rainbowColorMode === "none" || !this.focused || !this.textHasKeyword()) return;
		this.advanceRainbow();
		this.requestRender();
	}

	private textHasKeyword(): boolean {
		const text = this.base.getText().toLowerCase();
		return RAINBOW_KEYWORDS.some((keyword) => text.includes(keyword));
	}

	/** Bump the rainbow phase one step (exposed for deterministic tests). */
	advanceRainbow(): void {
		this.rainbowPhase = (this.rainbowPhase + 1) % 1_000_000;
	}

	/** Stop the animation timer. Best-effort hygiene; the timer is also unref'd. */
	dispose(): void {
		if (this.rainbowTimer) {
			clearInterval(this.rainbowTimer);
			this.rainbowTimer = undefined;
		}
	}

	setWorkflowDashboardOpen(
		openDashboard: DashboardOpener,
		openAgentsDashboard: DashboardOpener = openDashboard,
	): void {
		this.openDashboard = openDashboard;
		this.openAgentsDashboard = openAgentsDashboard;
	}

	setBorderLabelProvider(getBorderLabel: () => string | undefined): void {
		this.getBorderLabel = getBorderLabel;
	}

	get focused(): boolean {
		return Boolean((this.base as { focused?: boolean }).focused);
	}

	set focused(value: boolean) {
		(this.base as { focused?: boolean }).focused = value;
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.base.wantsKeyRelease;
	}

	set wantsKeyRelease(value: boolean | undefined) {
		this.base.wantsKeyRelease = value;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.base.onSubmit;
	}

	set onSubmit(handler: ((text: string) => void) | undefined) {
		this.base.onSubmit = handler;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.base.onChange;
	}

	set onChange(handler: ((text: string) => void) | undefined) {
		this.base.onChange = handler;
	}

	get borderColor(): ((str: string) => string) | undefined {
		return this.base.borderColor;
	}

	set borderColor(color: ((str: string) => string) | undefined) {
		this.base.borderColor = color;
	}

	get onEscape(): (() => void) | undefined {
		return (this.base as { onEscape?: () => void }).onEscape;
	}

	set onEscape(handler: (() => void) | undefined) {
		(this.base as { onEscape?: () => void }).onEscape = handler;
	}

	get onCtrlD(): (() => void) | undefined {
		return (this.base as { onCtrlD?: () => void }).onCtrlD;
	}

	set onCtrlD(handler: (() => void) | undefined) {
		(this.base as { onCtrlD?: () => void }).onCtrlD = handler;
	}

	get onPasteImage(): (() => void) | undefined {
		return (this.base as { onPasteImage?: () => void }).onPasteImage;
	}

	set onPasteImage(handler: (() => void) | undefined) {
		(this.base as { onPasteImage?: () => void }).onPasteImage = handler;
	}

	get onExtensionShortcut(): ((data: string) => boolean | undefined) | undefined {
		return (this.base as { onExtensionShortcut?: (data: string) => boolean | undefined }).onExtensionShortcut;
	}

	set onExtensionShortcut(handler: ((data: string) => boolean | undefined) | undefined) {
		(this.base as { onExtensionShortcut?: (data: string) => boolean | undefined }).onExtensionShortcut = handler;
	}

	render(width: number): string[] {
		const lines = this.decorateTopBorder(this.base.render(width), width);
		if (this.rainbowColorMode === "none") return lines;
		// Paint each typed keyword with the animated rainbow on the content lines. Line 0 is the
		// top border (its own color + the optional "ultracode auto" label), left untouched so the
		// effect belongs to what you write, not the always-on mode indicator.
		return lines.map((line, index) =>
			index === 0
				? line
				: RAINBOW_KEYWORDS.reduce(
						(acc, keyword) => colorizeKeyword(acc, keyword, this.rainbowPhase, { mode: this.rainbowColorMode }),
						line,
					),
		);
	}

	// Embed a short status label into the editor's top border (the violet prompt
	// line) without disturbing the base layout. Only a plain, full-width border is
	// decorated, so scroll hints like "↑ N more" are left untouched.
	private decorateTopBorder(lines: string[], width: number): string[] {
		if (lines.length === 0 || width <= 0) return lines;
		const label = this.getBorderLabel();
		if (!label) return lines;
		if (!/^─+$/.test(stripAnsiCodes(lines[0]))) return lines;
		const colored = this.base.borderColor ?? ((s: string) => s);
		const text = ` ${label} `;
		const rightDashes = 2;
		const leftDashes = width - visibleWidth(text) - rightDashes;
		if (leftDashes < 2) return lines;
		const decorated = [...lines];
		decorated[0] = colored("─".repeat(leftDashes)) + colored(text) + colored("─".repeat(rightDashes));
		return decorated;
	}

	invalidate(): void {
		this.base.invalidate();
	}

	getText(): string {
		return this.base.getText();
	}

	setText(text: string): void {
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	handleInput(data: string): void {
		const opensMonitor = matchesKey(data, Key.down);
		const opensAgents = matchesKey(data, Key.left);
		// Only treat ↓/← as dashboard-open gestures from a genuinely empty editor.
		// With a composed prompt they must stay normal cursor movements (← at col 0 of
		// a written prompt used to surprise-open the Agents dashboard).
		if ((!opensMonitor && !opensAgents) || this.base.getText().trim() !== "") {
			this.base.handleInput(data);
			return;
		}

		const cursorBefore = this.getCursor();
		const textBefore = this.base.getText();
		const autocompleteBefore = this.isShowingAutocomplete();
		this.base.handleInput(data);
		const autocompleteAfter = this.isShowingAutocomplete();
		const cursorAfter = this.getCursor();
		const textAfter = this.base.getText();

		if (autocompleteBefore || autocompleteAfter) return;
		if (!cursorBefore || !cursorAfter) return;
		if (textBefore !== textAfter || !sameEditorCursor(cursorBefore, cursorAfter)) return;
		if (this.opening) return;

		this.opening = true;
		const open = opensAgents ? this.openAgentsDashboard : this.openDashboard;
		void open((command) => this.submitCommand(command)).finally(() => {
			this.opening = false;
		});
	}

	private submitCommand(command: string): void {
		const submit = this.base.onSubmit;
		if (typeof submit === "function") {
			try {
				void Promise.resolve(submit(command)).catch(() => undefined);
			} catch {
				// Fall back to leaving the command ready for manual Enter if direct submission fails.
				this.base.setText(command);
			}
			return;
		}
		this.base.setText(command);
	}

	private getCursor(): { line: number; col: number } | undefined {
		const editor = this.base as { getCursor?: () => { line: number; col: number } };
		if (typeof editor.getCursor !== "function") return undefined;
		try {
			return editor.getCursor.call(this.base);
		} catch {
			return undefined;
		}
	}

	private isShowingAutocomplete(): boolean {
		const editor = this.base as { isShowingAutocomplete?: () => boolean };
		if (typeof editor.isShowingAutocomplete !== "function") return false;
		try {
			return editor.isShowingAutocomplete.call(this.base);
		} catch {
			return false;
		}
	}
}

function sameEditorCursor(a: { line: number; col: number }, b: { line: number; col: number }): boolean {
	return a.line === b.line && a.col === b.col;
}

export function installWorkflowDashboardDownEditor(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	getBorderLabel: () => string | undefined = () => undefined,
): void {
	if (ctx.mode !== "tui") return;
	const previous = ctx.ui.getEditorComponent?.();
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const openMonitor = async (submitCommand?: DashboardCommandSubmitter) =>
			await openWorkflowDashboard(pi, ctx, "monitor", { submitCommand });
		const openAgents = async (submitCommand?: DashboardCommandSubmitter) =>
			await openWorkflowDashboard(pi, ctx, "agents", { submitCommand });
		const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		const existing = base as EditorComponent & {
			[WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER]?: boolean;
			setWorkflowDashboardOpen?: (openDashboard: DashboardOpener, openAgentsDashboard?: DashboardOpener) => void;
			setBorderLabelProvider?: (getBorderLabel: () => string | undefined) => void;
		};
		if (existing[WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER] && typeof existing.setWorkflowDashboardOpen === "function") {
			existing.setWorkflowDashboardOpen(openMonitor, openAgents);
			existing.setBorderLabelProvider?.(getBorderLabel);
			return existing;
		}
		return new WorkflowDashboardDownEditor(base, openMonitor, openAgents, getBorderLabel, () => tui.requestRender());
	});
}
