/**
 * Sanitizado de texto inline para observe — copia local de tui/render-utils.renderSafeInline.
 * Evita importar el deep module tui (regla OBS ↛ TUI).
 */
function stripAnsiCodes(value: string): string {
	return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "");
}

export function renderSafeInline(value: string): string {
	return stripAnsiCodes(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
