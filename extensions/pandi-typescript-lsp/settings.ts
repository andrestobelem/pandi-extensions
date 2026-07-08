/**
 * Configuración de pandi-typescript-lsp: los parsers chicos y puros de
 * configuración (env + subcommand comparten estos; refleja pandi-auto-compact)
 * más los tipos de valor de feedback-mode/scope que producen.
 *
 * Igual que diagnostics.ts, este módulo está deliberadamente libre de
 * ExtensionContext / UI de pi para poder probarse de forma aislada contra el
 * mismo bundle que publica la extensión. Sin efectos laterales.
 *
 * Módulo hermano a un nivel, importado por index.ts vía "./settings.js".
 */

export type FeedbackMode = "advisory" | "autofix";
export type Scope = "touched" | "project";

function normalizeToken(value: string | undefined): string | undefined {
	return value?.trim().toLowerCase();
}

/** Parsea una configuración estilo on/off. Devuelve undefined para input no reconocido. */
export function parseOnOff(value: string | undefined): boolean | undefined {
	const v = normalizeToken(value);
	if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
	if (v === "off" || v === "0" || v === "false" || v === "no") return false;
	return undefined;
}

/** Parsea la configuración de modo de retroalimentación (`advisory` | `autofix`). */
export function parseMode(value: string | undefined): FeedbackMode | undefined {
	const v = normalizeToken(value);
	if (v === "advisory" || v === "autofix") return v;
	return undefined;
}

/** Parsea la configuración max-errors como entero positivo. */
export function parseMax(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value.trim());
	if (!Number.isInteger(n) || n <= 0) return undefined;
	return n;
}

/** Parsea la configuración de scope (`touched` | `project`). */
export function parseScope(value: string | undefined): Scope | undefined {
	const v = normalizeToken(value);
	if (v === "touched" || v === "project") return v;
	return undefined;
}
