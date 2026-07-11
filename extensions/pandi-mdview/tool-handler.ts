/**
 * Herramienta `view_markdown` invocable por el modelo.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadMarkdownDocument } from "./document.js";
import { displayMarkdownPath, openMarkdownViewer } from "./viewer-component.js";

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function toolError(text: string) {
	return toolResult(text, { isError: true });
}

export function registerViewMarkdownTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "view_markdown",
		label: "Abrir Markdown",
		description:
			"Abre un archivo Markdown para el usuario. En una TUI abre el visor Markdown con scroll de Pi; en modos no interactivos devuelve el contenido Markdown del archivo. Usala cuando el usuario pida mostrar, abrir o ver un archivo Markdown (.md).",
		promptSnippet: "Mostrar o abrir un archivo Markdown para el usuario.",
		parameters: Type.Object({
			path: Type.String({
				minLength: 1,
				description: "Ruta al archivo Markdown: relativa al cwd, expandida con ~, o absoluta.",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const load = await loadMarkdownDocument(params.path, ctx.cwd);
			if (!load.ok) {
				return toolError(load.message);
			}
			const relativePath = displayMarkdownPath(ctx.cwd, load.filePath);
			if (ctx.mode === "tui" && ctx.hasUI) {
				await openMarkdownViewer(ctx, load.filePath, load.content);
				return toolResult(`Se abrió ${relativePath} en el visor Markdown (${load.bytes} bytes).`, {
					path: relativePath,
					bytes: load.bytes,
					opened: true,
				});
			}
			return toolResult(load.content, { path: relativePath, bytes: load.bytes, opened: false });
		},
	});
}
