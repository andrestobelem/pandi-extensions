/**
 * pandi-docs — convierte Markdown en un artifact HTML autocontenido con estilo según el
 * manual pandi-artifact-style (layout Claude-design × paleta Panda Syntax).
 *
 * Dos superficies sobre el mismo conversor (./scripts/markdown-to-html.mjs):
 *   - `/docs <in.md> [más.md…] [-o out.html] [--kicker "Text"]` — comando para humanos.
 *   - `markdown_to_html` — herramienta invocable por el modelo (el agente no puede tipear comandos con slash).
 *
 * Los tokens pandi se leen al invocar desde el skill pandi-artifact-style vendoreado
 * que viaja DENTRO de esta extensión (skills/pandi-artifact-style/reference/), resuelto
 * relativo a import.meta.url para que la extensión siga siendo autocontenida al instalarse
 * sola. En el repo la copia vendoreada es un espejo generado de .pi/skills (mantenido
 * idéntico byte a byte por scripts/vendor-extension-skills.mjs).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { notify } from "./notify.js";
import { parseArgs, renderMarkdownToHtml } from "./scripts/markdown-to-html.mjs";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS_PATH = path.join(EXT_DIR, "skills", "pandi-artifact-style", "reference", "pandi-tokens.css");

const USAGE =
	'Uso: /docs <input.md> [más.md…] [-o output.html] [--kicker "Texto"] [--tokens tokens.css] [--css estilo.css]';
const EMPTY_MARKDOWN_PATH_ERROR =
	"markdown_to_html: `path` no puede estar vacío — pasá una ruta a un archivo Markdown.";

function expandHomePath(input: string): string {
	return input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(1)) : input;
}

/** Resuelve una ruta de usuario contra el cwd de la sesión, expandiendo un `~` inicial. */
function resolveUserPath(input: string, cwd: string): string {
	return path.resolve(cwd, expandHomePath(input));
}

/** Ruta de salida por defecto: la entrada con su extensión .md reemplazada por .html. */
function defaultOutPath(inputAbs: string): string {
	return `${inputAbs.replace(/\.md$/i, "")}.html`;
}

export interface ConvertResult {
	input: string;
	output: string;
	bytes: number;
}

/**
 * Convierte un archivo Markdown en un archivo HTML con estilo. Lanza Error con un
 * mensaje presentable al usuario si falla (entrada faltante/ilegible).
 */
export function convertMarkdownFile(
	inputPath: string,
	opts: { cwd: string; out?: string; kicker?: string; tokens?: string; css?: string },
): ConvertResult {
	const inputAbs = resolveUserPath(inputPath, opts.cwd);
	let md: string;
	try {
		md = fs.readFileSync(inputAbs, "utf8");
	} catch {
		throw new Error(`No se pudo leer ${inputPath} — revisá la ruta y volvé a intentar`);
	}
	// `css` reemplaza la hoja de estilos completa; `tokens` solo pisa la paleta pandi.
	let css: string | undefined;
	if (opts.css) {
		try {
			css = fs.readFileSync(resolveUserPath(opts.css, opts.cwd), "utf8");
		} catch {
			throw new Error(`No se pudo leer ${opts.css} — revisá la ruta al CSS`);
		}
	}
	const tokensCssPath = opts.tokens ? resolveUserPath(opts.tokens, opts.cwd) : TOKENS_CSS_PATH;
	let tokensCss: string | undefined;
	try {
		tokensCss = css ? undefined : fs.readFileSync(tokensCssPath, "utf8");
	} catch {
		throw new Error(`No se pudo leer ${opts.tokens} — revisá la ruta a los tokens CSS`);
	}
	const html = renderMarkdownToHtml(md, { title: path.basename(inputAbs), kicker: opts.kicker, tokensCss, css });
	const outAbs = opts.out ? resolveUserPath(opts.out, opts.cwd) : defaultOutPath(inputAbs);
	fs.mkdirSync(path.dirname(outAbs), { recursive: true });
	fs.writeFileSync(outAbs, html);
	return { input: inputAbs, output: outAbs, bytes: Buffer.byteLength(html) };
}

/** Tokeniza una cadena de argumentos del comando, respetando comillas simples/dobles (p. ej. --kicker "Two words"). */
export function tokenizeArgs(args: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const m of args.matchAll(re)) tokens.push(m[1] ?? m[2] ?? (m[3] as string));
	return tokens;
}

function relativeTo(cwd: string, abs: string): string {
	return path.relative(cwd, abs) || abs;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function toolError(text: string) {
	return toolResult(text, { isError: true });
}

export default function docsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("docs", {
		description: "Convertí un archivo Markdown a HTML autocontenido con estilo pandi",
		handler: async (args, ctx) => {
			let parsed: {
				inputs?: string[];
				out?: string | null;
				kicker?: string;
				tokens?: string;
				css?: string;
				help?: boolean;
			};
			try {
				parsed = parseArgs(tokenizeArgs(args ?? ""));
			} catch (error) {
				notify(ctx, `${errorMessage(error)}\n${USAGE}`, "error");
				return;
			}
			if (parsed.help || !parsed.inputs?.length) {
				notify(ctx, USAGE, parsed.help ? "info" : "warning");
				return;
			}
			if (parsed.out && parsed.inputs.length > 1) {
				notify(ctx, `-o solo es válido con un único archivo de entrada\n${USAGE}`, "error");
				return;
			}
			const written: string[] = [];
			for (const input of parsed.inputs) {
				try {
					const result = convertMarkdownFile(input, {
						cwd: ctx.cwd,
						out: parsed.out ?? undefined,
						kicker: parsed.kicker,
						tokens: parsed.tokens,
						css: parsed.css,
					});
					written.push(relativeTo(ctx.cwd, result.output));
				} catch (error) {
					notify(ctx, errorMessage(error), "error");
					return;
				}
			}
			notify(ctx, `Se escribió ${written.join(", ")}`, "info");
		},
	});

	// Contraparte invocable por el modelo de `/docs` (el agente no puede tipear un comando con slash).
	pi.registerTool({
		name: "markdown_to_html",
		label: "Markdown to HTML",
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
