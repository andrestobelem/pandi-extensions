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
import { stripAnsiCodes } from "./render-utils.js";

const WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER = "__dynamicWorkflowDashboardDownEditor";

class WorkflowDashboardDownEditor implements EditorComponent {
	readonly [WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER] = true;
	actionHandlers: Map<string, () => void>;
	private opening = false;

	constructor(
		private readonly base: EditorComponent,
		private openDashboard: DashboardOpener,
		private openAgentsDashboard: DashboardOpener = openDashboard,
		private getBorderLabel: () => string | undefined = () => undefined,
	) {
		const customBase = base as { actionHandlers?: unknown };
		this.actionHandlers =
			customBase.actionHandlers instanceof Map
				? (customBase.actionHandlers as Map<string, () => void>)
				: new Map<string, () => void>();
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
		return this.decorateTopBorder(this.base.render(width), width);
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
		return new WorkflowDashboardDownEditor(base, openMonitor, openAgents, getBorderLabel);
	});
}
