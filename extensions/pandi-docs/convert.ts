import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultOutPath, resolveUserPath } from "./paths.js";
import { renderMarkdownToHtml } from "./scripts/markdown-to-html.mjs";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TOKENS_CSS_PATH = path.join(EXT_DIR, "skills", "pandi-artifact-style", "reference", "pandi-tokens.css");

function readUtf8OrThrow(inputAbs: string, errorMessage: string): string {
	try {
		return fs.readFileSync(inputAbs, "utf8");
	} catch {
		throw new Error(errorMessage);
	}
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
	const md = readUtf8OrThrow(inputAbs, `No se pudo leer ${inputPath} — revisá la ruta y volvé a intentar`);
	// `css` reemplaza la hoja de estilos completa; `tokens` solo pisa la paleta pandi.
	let css: string | undefined;
	if (opts.css) {
		const cssAbs = resolveUserPath(opts.css, opts.cwd);
		css = readUtf8OrThrow(cssAbs, `No se pudo leer ${opts.css} — revisá la ruta al CSS`);
	}
	const tokensCssPath = opts.tokens ? resolveUserPath(opts.tokens, opts.cwd) : TOKENS_CSS_PATH;
	const tokensCss = css
		? undefined
		: readUtf8OrThrow(tokensCssPath, `No se pudo leer ${opts.tokens} — revisá la ruta a los tokens CSS`);
	const html = renderMarkdownToHtml(md, { title: path.basename(inputAbs), kicker: opts.kicker, tokensCss, css });
	const outAbs = opts.out ? resolveUserPath(opts.out, opts.cwd) : defaultOutPath(inputAbs);
	fs.mkdirSync(path.dirname(outAbs), { recursive: true });
	fs.writeFileSync(outAbs, html);
	return { input: inputAbs, output: outAbs, bytes: Buffer.byteLength(html) };
}
