function toolResult(text: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export function toolError(text: string, details?: Record<string, unknown>) {
	return toolResult(text, { isError: true, remembered: false, ...details });
}

export function toolSuccess(text: string, details: Record<string, unknown>) {
	return toolResult(text, details);
}
