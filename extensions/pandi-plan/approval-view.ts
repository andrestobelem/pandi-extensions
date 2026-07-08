/**
 * Overlay Markdown de aprobación de plan — la superficie de estilo mdview que submit_plan usa para presentar un plan para aprobación cuando la sesión puede mostrar un componente personalizado.
 *
 * Por qué replica el visor de pandi-mdview (a propósito)
 * ---------------------------------------------------
 * Pi carga cada extensión autocontenida, así que pandi-plan NO PUEDE importar el visor de pandi-mdview en
 * runtime (una importación entre extensiones rompe una instalación standalone — ver la regla
 * self-contained-extension del repo). La pequeña lógica de tema Markdown + scroll-viewer se
 * REPLICA aquí, luego SE EXTIENDE con una decisión: a diferencia del visor mdview de solo lectura (que solo
 * cierra con q/Esc), este overlay se resuelve a un booleano — APPROVE o REJECT — así que tanto renderiza
 * el plan (headings/lists/code, scrollable) como recoge la aprobación en una pantalla.
 *
 * Las teclas de decisión mapean SEGURAMENTE: y / Y / Enter => APPROVE; n / N / Esc / q => REJECT. Un cierre
 * (Esc/q) es un REJECT, nunca una aprobación implícita. El único caso no manual es el auto-submit opt-in:
 * si el usuario lo activó, 60s sin elección equivalen a APPROVE y el overlay muestra la cuenta regresiva.
 *
 * Como el visor de pandi-mdview y el overlay de dashboard de pandi-plan, el cableado TUI vivo se ejercita por
 * una suite que maneja el componente a través de un ctx.ui.custom mocked (ver
 * tests/integration/plan-approval-view.test.mjs). Cualquier fallo del overlay es responsabilidad del LLAMADOR:
 * submit_plan vuelve a ctx.ui.confirm así que la aprobación nunca se pierde.
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
const VIEWER_FIXED_LINES = 5; // top border, title, spacer, footer, bottom border
const DEFAULT_AUTO_SUBMIT_TIMEOUT_MS = 60_000;

interface RenderPlanApprovalOptions {
	autoSubmit?: boolean;
	timeoutMs?: number;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
		? Math.floor(timeoutMs)
		: DEFAULT_AUTO_SUBMIT_TIMEOUT_MS;
}

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
function boundedLine(text: string, width: number): string {
	return padToWidth(truncateToWidth(text, Math.max(1, width)), width);
}

function approvalDecisionForKey(data: string): boolean | undefined {
	if (data === "y" || data === "Y" || matchesKey(data, "enter")) return true;
	if (data === "n" || data === "N" || data === "q" || matchesKey(data, "escape")) return false;
	return undefined;
}

// Arma el tema Markdown del objeto `theme` runtime usando SOLO importaciones type-only del SDK —
// la misma razón que pandi-mdview: importar getMarkdownTheme() del SDK como VALUE tiraría todo el
// runtime del coding-agent al bundle y rompia la carga de extensión autocontenida.
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

class PlanApprovalComponent implements Component {
	private readonly markdown: Markdown;
	private scroll = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly planId: string,
		content: string,
		private readonly decide: (approved: boolean) => void,
		private readonly autoSubmitDeadline?: number,
	) {
		this.markdown = new Markdown(content, 1, 0, createMarkdownTheme(theme), undefined, {
			preserveOrderedListMarkers: true,
		});
	}

	handleInput(data: string): void {
		// Las teclas de decisión se evalúan antes que el scroll: cerrar el overlay siempre rechaza.
		const approvalDecision = approvalDecisionForKey(data);
		if (approvalDecision !== undefined) {
			this.decide(approvalDecision);
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

		const title = this.theme.fg("accent", this.theme.bold("Plan"));
		const location = this.theme.fg("dim", this.planId);
		const { titleSuffix, footerPrefix } = this.buildAutoSubmitCopy();
		const footer = this.theme.fg(
			"dim",
			`${footerPrefix}↑/↓ j/k desplazar • PgUp/PgDn página • y/Enter aprobar • n/Esc rechazar • ${start + 1}-${end}/${bodyLines.length}`,
		);

		const border = this.theme.fg("border", "─".repeat(safeWidth));
		return [
			border,
			boundedLine(`${title} ${location}${titleSuffix}`, safeWidth),
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
	private remainingAutoSubmitSeconds(): number {
		if (this.autoSubmitDeadline === undefined) return 0;
		return Math.max(0, Math.ceil((this.autoSubmitDeadline - Date.now()) / 1000));
	}
	private buildAutoSubmitCopy(): { titleSuffix: string; footerPrefix: string } {
		if (this.autoSubmitDeadline === undefined) {
			return { titleSuffix: "", footerPrefix: "" };
		}

		const autoSubmitSeconds = this.remainingAutoSubmitSeconds();
		return {
			titleSuffix: ` ${this.theme.fg("warning", `(auto-submit en ${autoSubmitSeconds}s)`)}`,
			footerPrefix: `auto-submit en ${autoSubmitSeconds}s • `,
		};
	}
	private pageSize(): number {
		return Math.max(1, this.bodyHeight() - 1);
	}
}

/**
 * Abre el overlay interactivo de aprobación Markdown; se resuelve a true (APPROVE) o false (REJECT).
 * El llamador debe haber ya confirmado una UI interactiva con ctx.ui.custom disponible.
 */
export function renderPlanApprovalOverlay(
	ctx: ExtensionContext,
	planText: string,
	planId: string,
	options: RenderPlanApprovalOptions = {},
): Promise<boolean> {
	return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		const autoSubmit = options.autoSubmit === true;
		const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
		const deadline = autoSubmit ? Date.now() + timeoutMs : undefined;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let interval: ReturnType<typeof setInterval> | undefined;
		const finish = (approved: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (interval) clearInterval(interval);
			done(approved);
		};
		if (autoSubmit) {
			timeout = setTimeout(() => {
				tui.requestRender();
				finish(true);
			}, timeoutMs);
			interval = setInterval(() => tui.requestRender(), 1000);
		}
		return new PlanApprovalComponent(tui, theme, planId, planText, finish, deadline);
	});
}
