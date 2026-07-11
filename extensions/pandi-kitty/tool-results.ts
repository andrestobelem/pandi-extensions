import type { HandlerResult } from "./kitty.js";

function toolResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

export function toolError(text: string, details: Record<string, unknown> = {}) {
	return toolResult(text, { ...details, isError: true });
}

export function toToolResult(result: HandlerResult) {
	return toolResult(result.text, result.details);
}
