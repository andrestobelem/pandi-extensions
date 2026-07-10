/**
 * Extracción JSON de pandi-dynamic-workflows (pura).
 *
 * Saca un único valor JSON desde texto de LLM (posiblemente ruidoso): probá primero
 * JSON.parse directo, luego cualquier bloque fenced \`\`\`json, y luego el primer substring
 * balanceado por llaves/corchetes. Completamente autocontenido — sin ctx, sin imports node/SDK,
 * sin estado compartido, e independiente de la VALIDACIÓN de schema (que se acopla a safeJson
 * y TypeBox Value y vive en el sibling structured-output.ts).
 *
 * Extraído textualmente desde index.ts (preserva comportamiento). Sibling de profundidad uno
 * importado vía "./json-extract.js"; parseJsonText/balancedJsonCandidate quedan
 * privados del módulo, solo se exporta extractJsonCandidate (el único caller externo).
 */

function parseJsonText(textValue: string): { ok: true; data: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, data: JSON.parse(textValue) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function balancedJsonCandidate(textValue: string): string | undefined {
	const starts: number[] = [];
	for (let i = 0; i < textValue.length; i++) {
		if (textValue[i] === "{" || textValue[i] === "[") starts.push(i);
	}
	for (const start of starts) {
		const stack: string[] = [];
		let inString = false;
		let escaped = false;
		for (let i = start; i < textValue.length; i++) {
			const ch = textValue[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				inString = true;
				continue;
			}
			if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
			else if (ch === "}" || ch === "]") {
				if (stack.pop() !== ch) break;
				if (stack.length === 0) {
					const candidate = textValue.slice(start, i + 1);
					if (parseJsonText(candidate).ok) return candidate;
					break;
				}
			}
		}
	}
	return undefined;
}

export function extractJsonCandidate(output: string): { ok: true; data: unknown } | { ok: false; error: string } {
	const trimmed = output.trim();
	if (!trimmed) return { ok: false, error: "empty output" };
	const direct = parseJsonText(trimmed);
	if (direct.ok) return direct;
	const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of trimmed.matchAll(fencePattern)) {
		const fenced = parseJsonText(match[1].trim());
		if (fenced.ok) return fenced;
	}
	const balanced = balancedJsonCandidate(trimmed);
	if (balanced) {
		const parsed = parseJsonText(balanced);
		if (parsed.ok) return parsed;
		return { ok: false, error: `balanced JSON candidate did not parse: ${parsed.error}` };
	}
	return { ok: false, error: `could not parse JSON output: ${direct.error}` };
}
