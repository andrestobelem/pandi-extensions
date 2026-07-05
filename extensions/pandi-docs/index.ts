/**
 * pi-docs — convert Markdown into a self-contained HTML artifact styled with the
 * pandi-artifact-style manual (Claude-design layout × Panda Syntax palette).
 *
 * Two surfaces over the same converter (./scripts/markdown-to-html.mjs):
 *   - `/docs <in.md> [más.md…] [-o out.html] [--kicker "Text"]` — human command.
 *   - `markdown_to_html` — model-callable tool (the agent cannot type slash commands).
 *
 * The pandi tokens are read at call time from the vendored pandi-artifact-style skill
 * that ships INSIDE this extension (skills/pandi-artifact-style/reference/), resolved
 * relative to import.meta.url so the extension stays self-contained when installed
 * standalone. In-repo the vendored copy is a generated mirror of .pi/skills (kept
 * byte-identical by scripts/vendor-extension-skills.mjs).
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

const USAGE = 'Uso: /docs <input.md> [más.md…] [-o output.html] [--kicker "Texto"]';

/** Resolve a user path against the session cwd, expanding a leading `~`. */
function resolveUserPath(input: string, cwd: string): string {
	const expanded = input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(1)) : input;
	return path.resolve(cwd, expanded);
}

/** Default output path: the input with its .md extension swapped for .html. */
function defaultOutPath(inputAbs: string): string {
	return `${inputAbs.replace(/\.md$/i, "")}.html`;
}

export interface ConvertResult {
	input: string;
	output: string;
	bytes: number;
}

/**
 * Convert one Markdown file to a styled HTML file. Throws Error with a
 * user-presentable message on failure (missing/unreadable input).
 */
export function convertMarkdownFile(
	inputPath: string,
	opts: { cwd: string; out?: string; kicker?: string },
): ConvertResult {
	const inputAbs = resolveUserPath(inputPath, opts.cwd);
	let md: string;
	try {
		md = fs.readFileSync(inputAbs, "utf8");
	} catch {
		throw new Error(`No se pudo leer ${inputPath} — revisá la ruta y volvé a intentar`);
	}
	const tokensCss = fs.readFileSync(TOKENS_CSS_PATH, "utf8");
	const html = renderMarkdownToHtml(md, { title: path.basename(inputAbs), kicker: opts.kicker, tokensCss });
	const outAbs = opts.out ? resolveUserPath(opts.out, opts.cwd) : defaultOutPath(inputAbs);
	fs.mkdirSync(path.dirname(outAbs), { recursive: true });
	fs.writeFileSync(outAbs, html);
	return { input: inputAbs, output: outAbs, bytes: Buffer.byteLength(html) };
}

/** Tokenize a command argument string, honoring single/double quotes (e.g. --kicker "Two words"). */
export function tokenizeArgs(args: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const m of args.matchAll(re)) tokens.push(m[1] ?? m[2] ?? (m[3] as string));
	return tokens;
}

function relativeTo(cwd: string, abs: string): string {
	return path.relative(cwd, abs) || abs;
}

export default function docsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("docs", {
		description: "Convertí un archivo Markdown a HTML autocontenido con estilo pandi",
		handler: async (args, ctx) => {
			let parsed: { inputs?: string[]; out?: string | null; kicker?: string; help?: boolean };
			try {
				parsed = parseArgs(tokenizeArgs(args ?? ""));
			} catch (error) {
				notify(ctx, `${error instanceof Error ? error.message : String(error)}\n${USAGE}`, "error");
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
					});
					written.push(relativeTo(ctx.cwd, result.output));
				} catch (error) {
					notify(ctx, error instanceof Error ? error.message : String(error), "error");
					return;
				}
			}
			notify(ctx, `Se escribió ${written.join(", ")}`, "info");
		},
	});

	// Model-callable counterpart of `/docs` (the agent cannot type a slash command).
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
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (!params.path?.trim()) {
				return {
					content: [
						{
							type: "text" as const,
							text: "markdown_to_html: `path` no puede estar vacío — pasá una ruta a un archivo Markdown.",
						},
					],
					details: { isError: true },
				};
			}
			try {
				const result = convertMarkdownFile(params.path, { cwd: ctx.cwd, out: params.out, kicker: params.kicker });
				const output = relativeTo(ctx.cwd, result.output);
				return {
					content: [
						{
							type: "text" as const,
							text: `Se escribió ${output} (${result.bytes} bytes) a partir de ${relativeTo(ctx.cwd, result.input)}.`,
						},
					],
					details: { input: relativeTo(ctx.cwd, result.input), output, bytes: result.bytes },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: { isError: true },
				};
			}
		},
	});
}
