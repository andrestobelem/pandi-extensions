import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MAX_MDVIEW_BYTES = 2_000_000; // guarda: leer/parsear un archivo enorme bloquea el loop de eventos de la TUI

function stripWrappingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function resolveMarkdownPath(rawPath: string, cwd: string): string | undefined {
	const requested = stripWrappingQuotes(rawPath);
	if (!requested) return undefined;
	if (requested === "~") return os.homedir();
	if (requested.startsWith("~/")) return path.join(os.homedir(), requested.slice(2));
	return path.resolve(cwd, requested);
}

export type MarkdownLoad =
	| { ok: true; filePath: string; content: string; bytes: number }
	| { ok: false; message: string; level: "warning" | "error" };

/**
 * Resuelve + valida tamaño + lee un archivo Markdown. Lo comparten el comando `/mdview` y la
 * TOOL `view_markdown` invocable por el modelo para que ambos apliquen la MISMA validación y límites.
 * Sin UI: quien llama decide cómo mostrar éxitos (visor / contenido) y errores.
 */
export async function loadMarkdownDocument(pathArg: string, cwd: string): Promise<MarkdownLoad> {
	const filePath = resolveMarkdownPath(pathArg, cwd);
	if (!filePath) return { ok: false, message: "Uso: /mdview <ruta-al-archivo-markdown>", level: "warning" };
	try {
		const stat = await fs.stat(filePath);
		if (stat.size > MAX_MDVIEW_BYTES) {
			return {
				ok: false,
				message: `El archivo Markdown es demasiado grande para verlo (${stat.size} bytes; límite ${MAX_MDVIEW_BYTES} bytes) — abrilo en un editor externo.`,
				level: "warning",
			};
		}
		const content = await fs.readFile(filePath, "utf8");
		return { ok: true, filePath, content, bytes: stat.size };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `No se pudo leer el archivo Markdown: ${message}`, level: "error" };
	}
}
