/**
 * Capa pura de parsing y dominio para el comando `/effort`.
 *
 * Se extrajo de index.ts para aislar el parsing de argumentos (sin efectos
 * secundarios) y el vocabulario de niveles de pensamiento del cableado del
 * comando. Mantener esta capa pura la hace barata de probar y razonar
 * (cohesión + testabilidad), mientras index.ts queda como agregador fino de
 * comando y registro.
 *
 * Módulo hermano a un nivel de profundidad (coincide con el glob `files` de
 * `package.json`); index.ts lo importa vía "./parse.js", así que se
 * typecheckea de forma transitiva.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type EffortTarget =
	| { kind: "status" }
	| { kind: "level"; level: ThinkingLevel }
	| { kind: "ultracode" }
	| { kind: "invalid"; value: string };

/**
 * Palabras livianas de prefijo/separación que se descartan antes de resolver el
 * token significativo final (p. ej. `/effort thinking=high`, `/effort level high`).
 */
const PREFIX_WORDS = ["thinking", "think", "level", "effort"];

const LEVEL_ALIASES: Record<string, ThinkingLevel> = {
	"0": "off",
	false: "off",
	no: "off",
	none: "off",
	off: "off",
	disable: "off",
	disabled: "off",
	min: "minimal",
	minimal: "minimal",
	low: "low",
	lo: "low",
	medium: "medium",
	med: "medium",
	normal: "medium",
	default: "medium",
	high: "high",
	hi: "high",
	max: "max",
	xhigh: "xhigh",
	"x-high": "xhigh",
	extra: "xhigh",
};

const STATUS_ALIASES = new Set(["", "status", "show", "current"]);
const ULTRACODE_ALIASES = new Set(["ultracode", "ultra-code"]);

function resolveMeaningfulToken(value: string): string {
	// Acepta `/effort thinking=high`, `/effort level high`, etc. usando el
	// token significativo final después de separadores y palabras prefijo livianas.
	const tokens = value
		.replace(/[=:,]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.filter((token) => !PREFIX_WORDS.includes(token));
	return tokens[tokens.length - 1] ?? value;
}

export function parseEffortTarget(raw: string): EffortTarget {
	const value = raw.trim().toLowerCase();
	if (STATUS_ALIASES.has(value)) return { kind: "status" };
	if (ULTRACODE_ALIASES.has(value)) return { kind: "ultracode" };

	const level = LEVEL_ALIASES[resolveMeaningfulToken(value)];
	if (level) return { kind: "level", level };
	return { kind: "invalid", value: raw.trim() };
}
