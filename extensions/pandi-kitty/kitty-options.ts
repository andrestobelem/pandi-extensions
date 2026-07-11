import { DEFAULT_KITTY_TIMEOUT_MS, parseTimeoutMs } from "./kitty.js";

export function buildKittyOpts(cwd: string, signal: AbortSignal | null | undefined) {
	return {
		cwd,
		signal: signal ?? undefined,
		timeoutMs: parseTimeoutMs(process.env.PI_KITTY_TIMEOUT_MS, DEFAULT_KITTY_TIMEOUT_MS),
	};
}
