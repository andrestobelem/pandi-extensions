export const DOCS_USAGE =
	'Uso: /docs <input.md> [más.md…] [-o output.html] [--kicker "Texto"] [--tokens tokens.css] [--css estilo.css]';

export const EMPTY_MARKDOWN_PATH_ERROR =
	"markdown_to_html: `path` no puede estar vacío — pasá una ruta a un archivo Markdown.";

/** Tokeniza una cadena de argumentos del comando, respetando comillas simples/dobles (p. ej. --kicker "Two words"). */
export function tokenizeArgs(args: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const m of args.matchAll(re)) tokens.push(m[1] ?? m[2] ?? (m[3] as string));
	return tokens;
}
