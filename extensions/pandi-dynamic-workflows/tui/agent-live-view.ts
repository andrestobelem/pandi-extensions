/**
 * AgentLiveViewComponent — el componente TUI que renderiza la salida en vivo de
 * un solo agente (log con scroll y encabezado de estado), opcionalmente con SUB-TABS
 * (Card / Prompt / Graph / Output / Definition / Run) para que la pantalla de detalle
 * del Monitor permita moverse entre vistas sin volver al dashboard.
 *
 * Presentación pura sobre contenido string plano; agent-view.ts entrega el Markdown
 * por tab y lo construye solo dentro del callback showLiveAgentView ctx.ui.custom.
 * Modo tabs: `tabs` etiqueta las subvistas, `setTabContent(key, content)` las llena,
 * ←/→ Tab/Shift+Tab/dígitos cambian (el scroll se recuerda POR TAB) y `onTabChange`
 * permite que el abridor cargue de inmediato el tab recién enfocado en vez de esperar el
 * poll de 1s. Sin `tabs` se comporta exactamente como el visor legacy de documento único.
 * Ciclo diferido: lee liveAgentHeaderStatus desde ./agent-view.js solo dentro de
 * render() (seguro al cargar por borrado). Extraído byte-idéntico antes de agregar tabs.
 */
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { createMarkdownTheme, formatViewerHints, scrollDelta } from "../markdown-view.js";
import { liveAgentHeaderStatus } from "./agent-view.js";

export interface AgentViewTab {
	key: string;
	label: string;
}

export class AgentLiveViewComponent {
	// El cuerpo es Markdown (formatAgentView y afines): renderizalo RICH vía el componente
	// Markdown de pi-tui, el mismo renderer que usan la vista de run y pandi-mdview. Un
	// Markdown + un offset de scroll por tab para que cambiar conserve la posición de cada tab.
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

	/** Clave del tab enfocado actualmente ("" en modo legacy de documento único). */
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

	// Punto de entrada legacy: define el contenido del tab activo (el ÚNICO documento cuando no
	// se pasaron tabs) y registra el estado del agente para la etiqueta de status del encabezado.
	setContent(content: string, state?: string): void {
		if (state !== undefined) this.agentState = state;
		// En modo tabs, el abridor controla el contenido vía setTabContent; un setContent suelto
		// solo actualiza el estado para que el encabezado pueda pasar a "final (...)".
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
		// El scroll se limita en render() cuando ya se conoce la altura del cuerpo para el ancho activo.
		const delta = scrollDelta(data, this.pageSize());
		if (delta === null) return;
		const key = this.getActiveTab();
		const current = this.scrollByTab.get(key) ?? 0;
		if (delta === "top") this.scrollByTab.set(key, 0);
		else if (delta === "bottom") this.scrollByTab.set(key, Number.MAX_SAFE_INTEGER);
		else this.scrollByTab.set(key, current + delta);
		// Repintá inmediatamente al scrollear en vez de esperar el tick de refresco de 1s.
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
		const bodyLines = markdown ? markdown.render(w) : ["Cargando ejecución del agente…"];
		const maxScroll = Math.max(0, bodyLines.length - page);
		const scroll = Math.max(0, Math.min(this.scrollByTab.get(key) ?? 0, maxScroll));
		this.scrollByTab.set(key, scroll);
		const line = (textValue: string) => truncateToWidth(textValue, w, "…");
		const end = Math.min(bodyLines.length, scroll + page);
		const tabsHint = this.tabs.length > 0 ? "←→ pestañas • " : "";
		const hints =
			tabsHint +
			formatViewerHints({
				canOpenFiles: this.canOpenFiles,
				start: scroll + 1,
				end,
				total: bodyLines.length,
			});
		const header =
			this.theme.fg("accent", "Agente en vivo del workflow") +
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
		// Una línea extra de chrome (la barra de tabs) en modo tabs.
		return Math.max(5, this.getHeight() - (this.tabs.length > 0 ? 5 : 4));
	}
}
