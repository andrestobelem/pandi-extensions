/** Overlay TUI scrollable del dashboard de modo plan. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "./notify.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Renderiza el Markdown del dashboard como un overlay de TUI scrollable. El overlay es un
 * componente mínimo autocontenido (sin importación de runtime pi-tui) así que nunca
 * desestabiliza el harness de test empaquetado; cualquier fallo del overlay se degrada a una
 * notificación. El llamador ya ha confirmado un TUI interactivo con una UI viva.
 */
export async function renderPlanDashboardOverlay(ctx: ExtensionContext, markdown: string): Promise<void> {
	try {
		await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
			const allLines = markdown.split("\n");
			let scroll = 0;
			const FIXED = 5; // top border, title, spacer, footer, bottom border
			const bodyHeight = () => Math.max(3, (tui.terminal.rows || 24) - FIXED);
			const pad = (text: string, width: number) =>
				(text.length > width ? text.slice(0, width) : text) + " ".repeat(Math.max(0, width - text.length));
			return {
				invalidate(): void {
					/* no cached render state */
				},
				handleInput(data: string): void {
					if (data === "q" || data === "\u001b") {
						done(undefined);
						return;
					}
					const page = Math.max(1, bodyHeight() - 1);
					if (data === "\u001b[B" || data === "j") scroll += 1;
					else if (data === "\u001b[A" || data === "k") scroll -= 1;
					else if (data === " " || data === "\u001b[6~") scroll += page;
					else if (data === "\u001b[5~") scroll -= page;
					else if (data === "g") scroll = 0;
					else if (data === "G") scroll = Number.MAX_SAFE_INTEGER;
					else return;
					tui.requestRender();
				},
				render(width: number): string[] {
					const safeWidth = Math.max(20, width);
					const height = bodyHeight();
					const maxScroll = Math.max(0, allLines.length - height);
					scroll = Math.min(Math.max(0, scroll), maxScroll);
					const start = scroll;
					const end = Math.min(allLines.length, start + height);
					const visible = allLines.slice(start, end);
					while (visible.length < height) visible.push("");
					const border = "─".repeat(safeWidth);
					const footer = `↑/↓ j/k desplazar · PgUp/PgDn página · q/Esc cerrar · ${start + 1}-${end}/${allLines.length}`;
					return [
						border,
						pad("Dashboard de Modo Plan", safeWidth),
						"",
						...visible.map((line) => pad(line, safeWidth)),
						pad(footer, safeWidth),
						border,
					];
				},
			};
		});
	} catch (error) {
		notify(ctx, `No se pudo abrir el dashboard de plan: ${errorMessage(error)}`, "warning");
	}
}
