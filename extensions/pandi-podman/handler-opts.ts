/**
 * Opciones compartidas por comando y tool: cwd, signal y timeout de Podman.
 */

import { DEFAULT_PODMAN_TIMEOUT_MS, parseTimeoutMs } from "./podman.js";

export function buildHandlerOpts(cwd: string, signal: AbortSignal | null | undefined) {
	return {
		cwd,
		signal: signal ?? undefined,
		timeoutMs: parseTimeoutMs(process.env.PI_PODMAN_TIMEOUT_MS, DEFAULT_PODMAN_TIMEOUT_MS),
	};
}
