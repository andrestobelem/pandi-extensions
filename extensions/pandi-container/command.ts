import { describeTiers } from "./container.js";

/**
 * Extrae una flag `--size <tier>` (alias `--tier <tier>`) de una lista de tokens (puro).
 * Devuelve los tokens restantes más el tier; una flag colgando produce un error acotado.
 */
export function parseSizeFlag(tokens: string[]): { tokens: string[]; tier?: string; error?: string } {
	const out: string[] = [];
	let tier: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--size" || token === "--tier") {
			const next = tokens[i + 1];
			if (!next || next.startsWith("--")) {
				return { tokens: out, error: `--size requiere un nombre de nivel. Niveles válidos: ${describeTiers()}.` };
			}
			tier = next;
			i += 1;
		} else {
			out.push(token);
		}
	}
	return tier != null ? { tokens: out, tier } : { tokens: out };
}

/** Divide una línea de comando en subcomando y resto, respetando un separador argv `--`. */
export function parseContainerCommand(input: string): {
	action: string;
	rest: string[];
	command: string[];
} {
	const trimmed = (input ?? "").trim();
	const sepIndex = trimmed.indexOf(" -- ");
	const head = sepIndex >= 0 ? trimmed.slice(0, sepIndex) : trimmed;
	const command =
		sepIndex >= 0
			? trimmed
					.slice(sepIndex + 4)
					.trim()
					.split(/\s+/)
					.filter(Boolean)
			: [];
	const tokens = head.split(/\s+/).filter(Boolean);
	const action = (tokens.shift() ?? "status").toLowerCase();
	return { action, rest: tokens, command };
}
