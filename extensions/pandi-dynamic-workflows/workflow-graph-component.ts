/**
 * WorkflowGraphComponent — el componente TUI que renderiza un workflow graph.
 *
 * Presentación pura: dado un WorkflowGraphModel (+ intento opcional de imagen renderizada y
 * theme), dibuja las líneas del documento / imagen en la terminal. Su engine (construcción de modelo
 * + render de líneas/imagen) vive en el sibling workflow-graph.ts. index.ts
 * lo construye solo dentro del cuerpo showWorkflowGraph, así que no hay ciclo runtime:
 * la única referencia de vuelta a index.ts es el `import type WorkflowGraphModel` borrado.
 * Extraído byte-idéntico (solo se agregó un prefijo `export ` a la clase).
 */
import * as path from "node:path";
import { Key, matchesKey, Image as TerminalImage, truncateToWidth } from "@earendil-works/pi-tui";
import type { WorkflowGraphImageAttempt } from "./workflow-graph.js";
import { renderWorkflowGraphDocumentLines, workflowGraphImageOptions } from "./workflow-graph.js";
import type { WorkflowGraphModel } from "./workflow-graph-types.js";

export class WorkflowGraphComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly imageComponent?: TerminalImage;

	constructor(
		private readonly model: WorkflowGraphModel,
		private readonly theme: any,
		private readonly close: () => void,
		private readonly imageAttempt: WorkflowGraphImageAttempt = {},
	) {
		if (imageAttempt.image) {
			const imageOptions = workflowGraphImageOptions(model);
			this.imageComponent = new TerminalImage(
				imageAttempt.image.base64,
				"image/png",
				{ fallbackColor: (textValue: string) => theme.fg("muted", textValue) },
				{
					filename: path.basename(imageAttempt.image.pngPath),
					maxWidthCells: imageOptions.maxWidthCells,
					maxHeightCells: imageOptions.maxHeightCells,
				},
			);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") this.close();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const w = Math.max(1, width);
		const line = (textValue: string) => truncateToWidth(textValue, w, "");
		const help = line(
			this.theme.fg(
				"dim",
				"enter/q/esc close • mmdc PNG when supported • static graph; use /workflow view for runtime timeline",
			),
		);
		const lines = [help];
		if (this.imageAttempt.image && this.imageComponent) {
			const image = this.imageAttempt.image;
			lines.push(
				line(
					`${this.theme.fg("accent", "Mermaid PNG")} ${this.theme.fg("dim", `via ${image.command} • ${image.width}×${image.height} @${image.scale}x • ${image.elapsedMs}ms`)}`,
				),
			);
			lines.push(line(this.theme.fg("dim", `png: ${image.pngPath}`)));
			lines.push(line(this.theme.fg("dim", `mmd: ${image.mmdPath}`)));
			lines.push(...this.imageComponent.render(w));
			lines.push(line(""));
		} else if (this.imageAttempt.warning) {
			lines.push(line(this.theme.fg("warning", "Mermaid PNG unavailable; falling back to text graph.")));
			for (const warningLine of this.imageAttempt.warning.split(/\r?\n/).slice(0, 8))
				lines.push(line(this.theme.fg("muted", warningLine)));
			lines.push(line(""));
		}
		lines.push(...renderWorkflowGraphDocumentLines(this.model, w, this.theme));
		this.cachedLines = lines;
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
