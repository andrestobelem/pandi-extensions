/**
 * WorkflowDashboardDownEditor — el editor personalizado de teclas Down/Left que abre el
 * dashboard de workflow desde el prompt, más su hook de instalación y pequeño ayudante
 * de cursor.
 *
 * installWorkflowDashboardDownEditor conecta el editor a la sesión; la clase implementa el
 * contrato host EditorComponent. Ciclo deferred: llama openWorkflowDashboard desde ./index.js
 * solo dentro de la closure open del editor, e index.ts importa installWorkflowDashboardDownEditor
 * de vuelta (invocado solo en el handler session_start). Los tipos de función Dashboard*
 * permanecen en index.ts (compartidos con openWorkflowDashboard) y cruzan como import type.
 * Extraído byte-idénticamente.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { type ColorMode, colorizeKeyword, containsKeywordToken, detectColorMode } from "../lib/rainbow.js";
import type { DashboardCommandSubmitter, DashboardOpener } from "./orchestration.js";
import { openWorkflowDashboard } from "./orchestration.js";
import { stripAnsiCodes } from "./render-utils.js";

const WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER = "__dynamicWorkflowDashboardDownEditor";
// ~8 fps: liso enough para un rainbow scrolling sin inundar el renderer. El timer solo
// desencadena re-render mientras el prompt contiene la palabra clave Y está enfocado, así
// un prompt idle o keyword-free no cuesta nada más allá de una boolean check por tick.
const RAINBOW_INTERVAL_MS = 120;
// Las palabras tipadas que obtienen el efecto de múltiples colores animados (case-insensitive).
const RAINBOW_KEYWORDS = ["ultracode", "workflow", "workflows"];

class WorkflowDashboardDownEditor implements EditorComponent {
	readonly [WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER] = true;
	actionHandlers: Map<string, () => void>;
	private opening = false;

	constructor(
		private readonly base: EditorComponent,
		private openDashboard: DashboardOpener,
		private openSessionsDashboard: DashboardOpener = openDashboard,
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
			// Nunca dejes que la animación mantenga el proceso Node vivo por sí solo.
			this.rainbowTimer.unref?.();
		}
	}

	private rainbowPhase = 0;
	private rainbowTimer?: ReturnType<typeof setInterval>;
	private readonly rainbowColorMode: ColorMode = detectColorMode();

	// Avanza la banda rainbow y repinta, pero solo mientras el prompt contiene la palabra clave
	// y está enfocado — así el efecto se anima mientras tipeas "ultracode" y pausa (sin
	// renders malgastados) cuando la palabra se fue, un dashboard/modal está arriba, o color
	// no está soportado.
	private tickRainbow(): void {
		if (this.rainbowColorMode === "none" || !this.focused || !this.textHasKeyword()) return;
		this.advanceRainbow();
		this.requestRender();
	}

	private textHasKeyword(): boolean {
		const text = this.base.getText();
		return RAINBOW_KEYWORDS.some((keyword) => containsKeywordToken(text, keyword));
	}

	/** Incrementa la fase rainbow un paso (expuesta para tests determinísticos). */
	advanceRainbow(): void {
		this.rainbowPhase = (this.rainbowPhase + 1) % 1_000_000;
	}

	/** Detiene el timer de animación. Higiene best-effort; el timer también está unref'd. */
	dispose(): void {
		if (this.rainbowTimer) {
			clearInterval(this.rainbowTimer);
			this.rainbowTimer = undefined;
		}
	}

	setWorkflowDashboardOpen(
		openDashboard: DashboardOpener,
		openSessionsDashboard: DashboardOpener = openDashboard,
	): void {
		this.openDashboard = openDashboard;
		this.openSessionsDashboard = openSessionsDashboard;
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
		// El editor base se renderiza como [top border, ...typed input, bottom border, ...autocomplete].
		// Pinta la palabra clave SOLO en las líneas typed-input (estrictamente entre los dos
		// borders), así el efecto cae donde escribes y nunca en la border label o el dropdown
		// de autocomplete slash-command / que sigue al bottom border.
		let bottomBorder = lines.length;
		for (let i = 1; i < lines.length; i++) {
			if (isBorderLine(lines[i])) {
				bottomBorder = i;
				break;
			}
		}
		return lines.map((line, index) =>
			index >= 1 && index < bottomBorder
				? RAINBOW_KEYWORDS.reduce(
						(acc, keyword) => colorizeKeyword(acc, keyword, this.rainbowPhase, { mode: this.rainbowColorMode }),
						line,
					)
				: line,
		);
	}

	// Inserta una etiqueta de estado corta en el top border del editor (la línea prompt
	// violeta) sin perturbar el layout base. Solo un border plain, full-width se decora,
	// así scroll hints como "↑ N more" se dejan intactos.
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
		const opensSessions = matchesKey(data, Key.left);
		// Solo trata ↓/← como gestos dashboard-open desde un editor genuinamente vacío.
		// Con un prompt compuesto deben permanecer como movimientos normales del cursor (← at col 0
		// de un prompt escrito solía surprise-open el dashboard Sessions).
		if ((!opensMonitor && !opensSessions) || this.base.getText().trim() !== "") {
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
		const open = opensSessions ? this.openSessionsDashboard : this.openDashboard;
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
				// Recurre a dejar el comando listo para Enter manual si la sumisión directa falla.
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

// Un horizontal editor border: la regla ─, opcionalmente llevando un scroll hint ("↑/↓ N more").
// Usado para acotar la región typed-input (entre los top y bottom borders) así la palabra
// clave rainbow nunca sangra en el dropdown autocomplete renderizado después del bottom border.
function isBorderLine(line: string): boolean {
	const stripped = stripAnsiCodes(line);
	if (!stripped.includes("─")) return false;
	const remainder = stripped.replace(/[─↑↓\s]/g, "");
	return remainder === "" || /^\d+more$/i.test(remainder);
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
		const openSessions = async (submitCommand?: DashboardCommandSubmitter) =>
			await openWorkflowDashboard(pi, ctx, "sessions", { submitCommand });
		const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		const existing = base as EditorComponent & {
			[WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER]?: boolean;
			setWorkflowDashboardOpen?: (openDashboard: DashboardOpener, openSessionsDashboard?: DashboardOpener) => void;
			setBorderLabelProvider?: (getBorderLabel: () => string | undefined) => void;
		};
		if (existing[WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER] && typeof existing.setWorkflowDashboardOpen === "function") {
			existing.setWorkflowDashboardOpen(openMonitor, openSessions);
			existing.setBorderLabelProvider?.(getBorderLabel);
			return existing;
		}
		return new WorkflowDashboardDownEditor(base, openMonitor, openSessions, getBorderLabel, () =>
			tui.requestRender(),
		);
	});
}
