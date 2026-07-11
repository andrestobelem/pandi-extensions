/**
 * Opciones compartidas por comando y tool: cwd, signal y timeout de `container`.
 */

import { DEFAULT_CONTAINER_TIMEOUT_MS, parseTimeoutMs } from "./container.js";

export function buildHandlerOpts(cwd: string, signal: AbortSignal | null | undefined) {
	return {
		cwd,
		signal: signal ?? undefined,
		timeoutMs: parseTimeoutMs(process.env.PI_CONTAINER_TIMEOUT_MS, DEFAULT_CONTAINER_TIMEOUT_MS),
	};
}
