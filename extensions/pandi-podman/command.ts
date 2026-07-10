/** Parseo deliberadamente pequeño para `/podman`; los comandos internos llegan como argv tras `--`. */

export function parsePodmanCommand(input: string): { action: string; rest: string[]; command: string[] } {
	const trimmed = (input ?? "").trim();
	const separator = trimmed.indexOf(" -- ");
	const head = separator >= 0 ? trimmed.slice(0, separator) : trimmed;
	const command =
		separator >= 0
			? trimmed
					.slice(separator + 4)
					.split(/\s+/)
					.filter(Boolean)
			: [];
	const tokens = head.split(/\s+/).filter(Boolean);
	const action = (tokens.shift() ?? "status").toLowerCase();
	return { action, rest: tokens, command };
}

/** `/podman run` solo acepta una política de red explícita; no es un passthrough de flags. */
export function parseRunOptions(tokens: string[]): { image?: string; network?: "none" | "default"; error?: string } {
	let network: "none" | "default" | undefined;
	const positional: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--network") {
			const value = tokens[index + 1];
			if (value !== "none" && value !== "default") return { error: "--network solo acepta none o default." };
			network = value;
			index += 1;
			continue;
		}
		if (token.startsWith("-")) return { error: `run no admite la flag ${token}.` };
		positional.push(token);
	}
	if (positional.length !== 1) return { error: "run requiere exactamente una image antes de --." };
	return { image: positional[0], network };
}
