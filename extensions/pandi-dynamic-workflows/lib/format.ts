/**
 * Núcleo de formato de salida de tools para dynamic-workflows: el wrapper estándar de resultado
 * text(), truncate() acotado por longitud, un serializador JSON seguro ante ciclos (safeJson),
 * y stringify() que los combina. Puro y sin dependencias (solo el presupuesto MAX_TOOL_TEXT,
 * que vive acá para que truncate/stringify mantengan su default), así que es un módulo hoja
 * compartido por el runner, los handlers de tools y la TUI del monitor sin ningún ciclo ESM.
 *
 * Movido textualmente desde index.ts (preserva comportamiento).
 */

export const MAX_TOOL_TEXT = 24_000;

export function text(content: string) {
	return { type: "text" as const, text: content };
}

export function truncate(value: string, max = MAX_TOOL_TEXT): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 120))}\n\n...[truncated ${value.length - max} chars]`;
}

export function safeJson(value: unknown, indent = 2): string {
	// Rastreá "seen" por RUTA de recorrido (agregar al entrar, borrar al salir del scope), reflejando
	// stableStringify de journal.ts. Un replacer plano de JSON.stringify no puede hacer esto: nunca
	// sabe cuándo se salió por completo de un subárbol, así que un WeakSet global sin cleanup marca
	// erróneamente CUALQUIER referencia repetida como "[Circular]" — incluso un hijo compartido pero
	// no circular de un DAG entre dos ramas independientes — en vez de solo ciclos reales.
	const seen = new WeakSet<object>();
	const replace = (current: unknown, key = ""): unknown => {
		// Reflejamos el orden SerializeJSONProperty propio de JSON.stringify: toJSON() (p. ej. Date) corre
		// ANTES del chequeo de ciclos, igual que el algoritmo nativo, para que los valores con toJSON
		// sigan serializando exactamente como lo hacían con la implementación anterior basada en replacer.
		if (
			typeof current === "object" &&
			current !== null &&
			typeof (current as { toJSON?: unknown }).toJSON === "function"
		) {
			current = (current as { toJSON: (key: string) => unknown }).toJSON(key);
		}
		if (typeof current === "bigint") return current.toString();
		if (typeof current !== "object" || current === null) return current;
		if (seen.has(current)) return "[Circular]";
		seen.add(current);
		const out: unknown = Array.isArray(current)
			? current.map((item, i) => replace(item, String(i)))
			: Object.fromEntries(Object.entries(current).map(([k, v]) => [k, replace(v, k)]));
		seen.delete(current);
		return out;
	};
	return JSON.stringify(replace(value), null, indent);
}

export function stringify(value: unknown, max = MAX_TOOL_TEXT): string {
	if (typeof value === "string") return truncate(value, max);
	try {
		return truncate(safeJson(value), max);
	} catch (err) {
		return truncate(String(err), max);
	}
}
