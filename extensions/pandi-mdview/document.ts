import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MAX_MDVIEW_BYTES = 2_000_000; // guarda: leer o parsear un archivo enorme bloquea el loop de eventos de la TUI

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

function missingMarkdownPath(): MarkdownLoad {
	return { ok: false, message: "Uso: /mdview <ruta-al-archivo-markdown>", level: "warning" };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatReadMarkdownFailure(error: unknown): string {
	return `No se pudo leer el archivo Markdown: ${errorMessage(error)}`;
}

function hasMarkdownExtension(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown");
}

type MarkdownFileValidation = { ok: true; bytes: number } | { ok: false; message: string; level: "warning" };

async function validateMarkdownFile(filePath: string): Promise<MarkdownFileValidation> {
	if (!hasMarkdownExtension(filePath)) {
		return {
			ok: false,
			message: "El visor Markdown solo abre archivos .md o .markdown.",
			level: "warning",
		};
	}
	const stat = await fs.stat(filePath);
	if (stat.size > MAX_MDVIEW_BYTES) {
		return {
			ok: false,
			message: `El archivo Markdown es demasiado grande para verlo (${stat.size} bytes; límite ${MAX_MDVIEW_BYTES} bytes) — abrilo en un editor externo.`,
			level: "warning",
		};
	}
	return { ok: true, bytes: stat.size };
}

/**
 * Resuelve, valida el tamaño y lee un archivo Markdown. Lo comparten el comando `/mdview` y la
 * TOOL `view_markdown` invocable por el modelo para que ambos apliquen la MISMA validación y los mismos límites.
 * Sin UI: quien llama decide cómo mostrar éxitos (visor o contenido) y errores.
 */
export async function loadMarkdownDocument(pathArg: string, cwd: string): Promise<MarkdownLoad> {
	const filePath = resolveMarkdownPath(pathArg, cwd);
	if (!filePath) return missingMarkdownPath();
	try {
		const validation = await validateMarkdownFile(filePath);
		if (!validation.ok) return validation;
		const content = await fs.readFile(filePath, "utf8");
		return { ok: true, filePath, content, bytes: validation.bytes };
	} catch (error) {
		return { ok: false, message: formatReadMarkdownFailure(error), level: "error" };
	}
}
