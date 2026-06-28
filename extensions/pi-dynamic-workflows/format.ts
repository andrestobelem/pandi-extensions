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
	const seen = new WeakSet<object>();
	return JSON.stringify(
		value,
		(_key, current) => {
			if (typeof current === "bigint") return current.toString();
			if (typeof current === "object" && current !== null) {
				if (seen.has(current)) return "[Circular]";
				seen.add(current);
			}
			return current;
		},
		indent,
	);
}

export function stringify(value: unknown, max = MAX_TOOL_TEXT): string {
	if (typeof value === "string") return truncate(value, max);
	try {
		return truncate(safeJson(value), max);
	} catch (err) {
		return truncate(String(err), max);
	}
}
