/** Parseo puro de `/kitty <subcomando> [args...]` en acción + tokens. */
export function parseKittyCommand(input: string): { action: string; rest: string[] } {
	const tokens = (input ?? "").trim().split(/\s+/).filter(Boolean);
	const action = (tokens.shift() ?? "tab").toLowerCase();
	return { action, rest: tokens };
}
