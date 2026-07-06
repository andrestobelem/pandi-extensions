/**
 * Parser puro de intención para `/loop`.
 *
 * Mantiene la gramática observable que antes vivía inline en index.ts: primer token
 * para subcomandos, `auto` con resto crudo normalizado, flags `--ultracode`/`--uc`
 * removidos antes de detectar un intervalo final, y tareas normalizadas por tokens
 * whitespace-separated. No toca ctx, timers ni persistencia.
 */

import { parseInterval } from "./interval.js";

export type LoopCommandKind = "start" | "auto" | "stop" | "pause" | "resume" | "status";

export interface LoopCommandIntent {
	kind: LoopCommandKind;
	/** Resto ya trimmeado: args de start/auto o id opcional de subcomandos. */
	rest: string;
}

export interface LoopStartArgs {
	/** Task/objective luego de quitar flags y, si aplica, el intervalo final. */
	text: string;
	/** Período de fixed-mode en ms; undefined significa dynamic. */
	intervalMs?: number;
	/** Postura Ultracode pedida por --ultracode / --uc. */
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

/** Parsea los argumentos de start/autonomous luego de resolver el subcomando. */
export function parseLoopStartArgs(args: string): LoopStartArgs {
	const { rest: withoutFlag, ultracode } = extractUltracodeFlag(args);
	const trimmed = withoutFlag.trim();
	let text = trimmed;
	let intervalMs: number | undefined;
	const lastSpace = trimmed.lastIndexOf(" ");
	if (lastSpace !== -1) {
		const candidate = trimmed.slice(lastSpace + 1);
		const parsed = parseInterval(candidate);
		if (parsed !== null) {
			intervalMs = parsed;
			text = trimmed.slice(0, lastSpace).trim();
		}
	}
	return { text, intervalMs, ultracode };
}

/** Resuelve el primer token de `/loop` a una intención de comando sin efectos secundarios. */
export function parseLoopCommandIntent(args: string): LoopCommandIntent {
	const trimmed = args.trim();
	const firstSpace = trimmed.indexOf(" ");
	const firstToken = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

	if (
		firstToken === "stop" ||
		firstToken === "pause" ||
		firstToken === "resume" ||
		firstToken === "status" ||
		firstToken === "auto"
	) {
		return { kind: firstToken, rest };
	}
	return { kind: "start", rest: trimmed };
}
