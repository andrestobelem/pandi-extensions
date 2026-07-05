import type { FormatResult } from "./diagnostics.js";

/** Construye el cuerpo del mensaje advisory (no bloqueante, se muestra en el turno siguiente). */
export function advisoryMessage(formatted: FormatResult): string {
	return [
		"Diagnósticos de TypeScript en los archivos que acabás de cambiar:",
		"",
		formatted.text,
		"",
		"Arreglálos cuando continúés; corré typescript_diagnostics para verificar de nuevo.",
	].join("\n");
}

/** Construye el cuerpo del seguimiento de autofix (dispara un turno para que el agente los arregle). */
export function autofixMessage(formatted: FormatResult): string {
	return [
		"Se encontraron diagnósticos de TypeScript en los archivos que acabás de cambiar:",
		"",
		formatted.text,
		"",
		"Arreglá estos errores de tipos ahora, después volvé a correr typescript_diagnostics para confirmar que quedó limpio.",
	].join("\n");
}
