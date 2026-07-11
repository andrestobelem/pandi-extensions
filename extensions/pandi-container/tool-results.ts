/**
 * Adaptadores de resultado para `container_sandbox`.
 */

import type { HandlerResult } from "./container.js";

export function toolResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export function toolError(text: string, details: Record<string, unknown> = {}) {
	return toolResult(text, { isError: true, ...details });
}

export function toToolResult(result: HandlerResult) {
	return toolResult(result.text, result.details);
}
