/**
 * pi-dynamic-workflows JSON extraction (pure).
 *
 * Pull a single JSON value out of (possibly noisy) LLM text: try a direct
 * JSON.parse, then any \`\`\`json fenced blocks, then the first brace/bracket-
 * balanced substring. Fully self-contained — no ctx, no node/SDK imports, no
 * shared state, and independent of schema VALIDATION (which couples to safeJson
 * and TypeBox Value and lives in the structured-output.ts sibling).
 *
 * Extracted verbatim from index.ts (behavior-preserving). Depth-one sibling
 * imported via "./json-extract.js"; parseJsonText/balancedJsonCandidate stay
 * module-private, only extractJsonCandidate (the sole external caller) is exported.
 */

function parseJsonText(textValue: string): { ok: true; data: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, data: JSON.parse(textValue) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function balancedJsonCandidate(textValue: string): string | undefined {
	const starts = [textValue.indexOf("{"), textValue.indexOf("[")].filter((index) => index >= 0).sort((a, b) => a - b);
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
				if (stack.length === 0) return textValue.slice(start, i + 1);
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
