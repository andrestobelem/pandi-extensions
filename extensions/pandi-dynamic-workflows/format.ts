/**
 * Tool-output formatting kernel for dynamic-workflows: the standard text()
 * result wrapper, length-bounded truncate(), a cycle-safe JSON serializer
 * (safeJson), and stringify() that combines them. Pure and dependency-free
 * (only the MAX_TOOL_TEXT budget, which lives here so truncate/stringify keep
 * their default), so it is a leaf module shared by the runner, tool handlers,
 * and the monitor TUI without any ESM cycle.
 *
 * Moved verbatim from index.ts (behavior-preserving).
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
	// Track "seen" per traversal PATH (add on enter, delete on exit of scope), mirroring
	// journal.ts stableStringify. A flat JSON.stringify replacer cannot do this: it never
	// learns when a subtree is fully left, so a global WeakSet without cleanup wrongly
	// stamps ANY repeated reference as "[Circular]" — even a DAG's shared-but-not-circular
	// child across two independent branches — instead of only true cycles.
	const seen = new WeakSet<object>();
	const replace = (current: unknown, key = ""): unknown => {
		// Mirror JSON.stringify's own SerializeJSONProperty order: toJSON() (e.g. Date) runs
		// BEFORE the cycle check, same as the native algorithm, so toJSON-bearing values keep
		// serializing exactly as they did with the old replacer-based implementation.
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
