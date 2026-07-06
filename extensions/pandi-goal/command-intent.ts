/**
 * Parser puro de intención para `/goal`.
 *
 * Mantiene la gramática observable que antes vivía inline en index.ts: flags
 * `--ultracode`/`--uc` se quitan antes de partir criterios con ` -- `, y
 * `stop`/`status` son subcomandos solo cuando el texto no contiene ese separador.
 */

export type GoalCommandKind = "start" | "stop" | "status";

export interface GoalCommandIntent {
	kind: GoalCommandKind;
	/** Args de start o id opcional de subcomandos, ya trimmeado. */
	rest: string;
}

export interface GoalStartArgs {
	objective: string;
	successCriteria?: string;
	ultracode: boolean;
}

/** Quita `--ultracode` / `--uc` de cualquier posición, preservando el resto tokenizado. */
export function extractUltracodeFlag(args: string): { rest: string; ultracode: boolean } {
	let ultracode = false;
	const kept: string[] = [];
	for (const token of args.split(/\s+/)) {
		const lower = token.toLowerCase();
		if (lower === "--ultracode" || lower === "--uc") ultracode = true;
		else if (token.length) kept.push(token);
	}
	return { rest: kept.join(" "), ultracode };
}

/** Parsea los argumentos de inicio de `/goal` luego de quitar flags de postura. */
export function parseGoalArgs(args: string): GoalStartArgs {
	const { rest, ultracode } = extractUltracodeFlag(args);
	const separator = " -- ";
	const index = rest.indexOf(separator);
	if (index === -1) return { objective: rest.trim(), ultracode };
	const objective = rest.slice(0, index).trim();
	const successCriteria = rest.slice(index + separator.length).trim();
	return { objective, successCriteria: successCriteria || undefined, ultracode };
}

/** Resuelve el primer token de `/goal` a una intención de comando sin efectos secundarios. */
export function parseGoalCommandIntent(args: string): GoalCommandIntent {
	const trimmed = args.trim();
	const firstSpace = trimmed.indexOf(" ");
	const firstToken = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

	// "stop"/"status" son subcomandos solo cuando no hay separador de criterios ` -- `
	// que los capture como parte de un objetivo.
	const hasCriteriaSeparator = trimmed.includes(" -- ");
	if (!hasCriteriaSeparator && (firstToken === "stop" || firstToken === "status")) return { kind: firstToken, rest };
	return { kind: "start", rest: trimmed };
}
