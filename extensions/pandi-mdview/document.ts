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

function oversizedMarkdownFile(bytes: number): MarkdownLoad {
	return {
		ok: false,
		message: `El archivo Markdown es demasiado grande para verlo (${bytes} bytes; límite ${MAX_MDVIEW_BYTES} bytes) — abrilo en un editor externo.`,
		level: "warning",
	};
}

async function readMarkdownFile(filePath: string): Promise<MarkdownLoad> {
	const file = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(MAX_MDVIEW_BYTES + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, null);
			if (bytesRead === 0) break;
			bytes += bytesRead;
		}
		if (bytes > MAX_MDVIEW_BYTES) return oversizedMarkdownFile(bytes);
		return { ok: true, filePath, content: buffer.subarray(0, bytes).toString("utf8"), bytes };
	} finally {
		await file.close();
	}
}

/**
 * Resuelve, valida el tamaño y lee un archivo Markdown. Lo comparten el comando `/mdview` y la
 * TOOL `view_markdown` invocable por el modelo para que ambos apliquen la MISMA validación y los mismos límites.
 * Sin UI: quien llama decide cómo mostrar éxitos (visor o contenido) y errores.
 */
export async function loadMarkdownDocument(pathArg: string, cwd: string): Promise<MarkdownLoad> {
	const filePath = resolveMarkdownPath(pathArg, cwd);
	if (!filePath) return missingMarkdownPath();
	if (!hasMarkdownExtension(filePath)) {
		return {
			ok: false,
			message: "El visor Markdown solo abre archivos .md o .markdown.",
			level: "warning",
		};
	}
	try {
		return await readMarkdownFile(filePath);
	} catch (error) {
		return { ok: false, message: formatReadMarkdownFailure(error), level: "error" };
	}
}
