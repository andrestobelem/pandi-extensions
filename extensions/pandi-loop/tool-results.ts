export function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

export function toolError(text: string) {
	return toolResult(text, { isError: true });
}
