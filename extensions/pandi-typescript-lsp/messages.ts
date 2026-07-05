import type { FormatResult } from "./diagnostics.js";

/** Build the advisory feedback body (non-blocking, surfaced next turn). */
export function advisoryMessage(formatted: FormatResult): string {
	return [
		"Diagnósticos de TypeScript en los archivos que acabás de cambiar:",
		"",
		formatted.text,
		"",
		"Arreglálos cuando continúés; corré typescript_diagnostics para verificar de nuevo.",
	].join("\n");
}

/** Build the autofix follow-up body (triggers a turn so the agent fixes them). */
export function autofixMessage(formatted: FormatResult): string {
	return [
		"Se encontraron diagnósticos de TypeScript en los archivos que acabás de cambiar:",
		"",
		formatted.text,
		"",
		"Arreglá estos errores de tipos ahora, después volvé a correr typescript_diagnostics para confirmar que quedó limpio.",
	].join("\n");
}
