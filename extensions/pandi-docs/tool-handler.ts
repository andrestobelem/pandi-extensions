import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EMPTY_MARKDOWN_PATH_ERROR } from "./args.js";
import { convertMarkdownFile } from "./convert.js";
import { relativeTo } from "./paths.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function toolError(text: string) {
	return toolResult(text, { isError: true });
}

export function registerMarkdownToHtmlTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "markdown_to_html",
		label: "Markdown a HTML",
		description:
			"Convertí un archivo Markdown en un artifact HTML autocontenido con el estilo " +
			"pandi-artifact-style (layout Claude-design, paleta Panda Syntax, claro+oscuro). Escribe " +
			"un .html hermano junto a la entrada salvo que se indique `out`. Usalo cuando el usuario " +
			"pida un informe/artifact HTML con estilo a partir de un archivo Markdown.",
		promptSnippet: "Convertí un archivo Markdown en un artifact HTML autocontenido con estilo pandi.",
		parameters: Type.Object({
			path: Type.String({
				minLength: 1,
				description: "Ruta al archivo Markdown: relativa al cwd, con `~` expandido, o absoluta.",
			}),
			out: Type.Optional(
				Type.String({
					description: "Ruta del HTML de salida (por defecto: la entrada con `.md` reemplazado por `.html`).",
				}),
			),
			kicker: Type.Optional(
				Type.String({
					description: 'Texto de kicker sobre el título de la página (por defecto "Pandi artifact").',
				}),
			),
			tokens: Type.Optional(
				Type.String({
					description:
						"Ruta a un archivo CSS con tokens (custom properties) propios para pisar la paleta " +
						"pandi por defecto — así otro proyecto conecta su propia identidad visual.",
				}),
			),
			css: Type.Optional(
				Type.String({
					description:
						"Ruta a una hoja de estilos que reemplaza el CSS COMPLETO (tokens + layout pandi) — " +
						"para repos con look propio. Tiene prioridad sobre `tokens`.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (!params.path?.trim()) {
				return toolError(EMPTY_MARKDOWN_PATH_ERROR);
			}
			try {
				const result = convertMarkdownFile(params.path, {
					cwd: ctx.cwd,
					out: params.out,
					kicker: params.kicker,
					tokens: params.tokens,
					css: params.css,
				});
				const output = relativeTo(ctx.cwd, result.output);
				return toolResult(
					`Se escribió ${output} (${result.bytes} bytes) a partir de ${relativeTo(ctx.cwd, result.input)}.`,
					{
						input: relativeTo(ctx.cwd, result.input),
						output,
						bytes: result.bytes,
					},
				);
			} catch (error) {
				return toolError(errorMessage(error));
			}
		},
	});
}
