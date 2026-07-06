// Parseo de la línea de comandos de pandi-worktree `/worktree ...`: tokeniza la cadena de argumentos y
// la parsea en una intención ParsedCommand estructurada. Puro (sin ctx/git); se reexporta desde
// index.ts para que el bundle construido conserve los nombres que importa la suite de integración.

import { parseCopyToggleValue } from "./copy-prefs.js";
import { isValidBranchName } from "./worktree.js";

export interface ParsedCommand {
	action: "list" | "add" | "open" | "remove" | "prune" | "set" | "help";
	path?: string;
	newBranch?: string;
	commitish?: string;
	force?: boolean;
	detach?: boolean;
	dryRun?: boolean;
	/** Tres estados: true (--copy-ignored), false (--no-copy-ignored), undefined (seguir al siguiente valor). */
	copyIgnored?: boolean;
	copyUntracked?: boolean;
	/** Para `set`: qué valor de sesión leer/escribir (undefined = mostrar todos). */
	setTarget?: "copy-ignored" | "copy-untracked" | "writer-guard";
	/** Para `set`: el valor parseado del toggle on|off|status|invalid. */
	setValue?: "on" | "off" | "status" | "invalid";
	error?: string;
}

/**
 * Tokeniza una cadena de argumentos `/worktree ...`, respetando comillas
 * simples/dobles básicas para que funcionen paths con espacios. No es un parser
 * completo de shell: solo comillas.
 */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: loop idiomático con regex.exec()
	while ((match = re.exec(input)) !== null) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return tokens;
}

function isHelpCommand(token: string): boolean {
	return token === "help" || token === "-h" || token === "--help";
}

function isListCommand(token: string): boolean {
	return token === "list" || token === "ls";
}

function isRemoveCommand(token: string): boolean {
	return token === "remove" || token === "rm";
}

function isAddOrOpenCommand(token: string): token is "add" | "open" {
	return token === "add" || token === "open";
}

function isPruneCommand(token: string): boolean {
	return token === "prune";
}

function isSetCommand(token: string): boolean {
	return token === "set";
}

function isForceFlag(token: string): boolean {
	return token === "--force" || token === "-f";
}

function isDetachFlag(token: string): boolean {
	return token === "--detach" || token === "-d";
}

function isBranchFlag(token: string): boolean {
	return token === "-b" || token === "--branch";
}

function parsePruneCommand(rest: string[]): ParsedCommand {
	const dryRun = rest.some((t) => t === "--dry-run" || t === "-n");
	return { action: "prune", dryRun };
}

function parseSetCommand(rest: string[]): ParsedCommand {
	if (rest.length === 0) return { action: "set" }; // mostrar todo
	const target = rest[0].toLowerCase();
	if (target !== "copy-ignored" && target !== "copy-untracked" && target !== "writer-guard") {
		return {
			action: "set",
			error: "Uso: /worktree set [copy-ignored|copy-untracked|writer-guard] [on|off|status]",
		};
	}
	return { action: "set", setTarget: target, setValue: parseCopyToggleValue(rest[1] ?? "") };
}

function parseRemoveCommand(rest: string[]): ParsedCommand {
	const force = rest.some(isForceFlag);
	const pathArg = rest.find((t) => !isForceFlag(t));
	if (!pathArg) return { action: "remove", error: "Uso: /worktree remove [--force] <path>" };
	return { action: "remove", path: pathArg, force };
}

function parseUnknownCommand(token: string): ParsedCommand {
	return { action: "help", error: `Subcomando desconocido: "${token}"` };
}

function formatAddOrOpenUsage(action: "add" | "open"): string {
	return action === "open"
		? "Uso: /worktree open [-b <branch>] <path> [<commit-ish>]"
		: "Uso: /worktree add [-b <branch>] <path> [<commit-ish>]";
}

function formatInvalidBranchNameError(branch: string | undefined): string {
	return `Nombre de rama inválido "${branch ?? ""}" — sin espacios, caracteres de control ni puntos o barras iniciales/finales.`;
}

interface AddOrOpenParseState {
	positionals: string[];
	newBranch?: string;
	force: boolean;
	detach: boolean;
	// Tres estados: undefined salvo que un flag explícito active/desactive la copia en esta llamada.
	copyIgnored?: boolean;
	copyUntracked?: boolean;
}

function applyAddOrOpenToken(rest: string[], index: number, state: AddOrOpenParseState): number {
	const tok = rest[index];
	if (isBranchFlag(tok)) {
		state.newBranch = rest[index + 1];
		return index + 1;
	}
	if (isForceFlag(tok)) {
		state.force = true;
	} else if (isDetachFlag(tok)) {
		state.detach = true;
	} else if (tok === "--copy-ignored") {
		state.copyIgnored = true;
	} else if (tok === "--no-copy-ignored") {
		state.copyIgnored = false;
	} else if (tok === "--copy-untracked") {
		state.copyUntracked = true;
	} else if (tok === "--no-copy-untracked") {
		state.copyUntracked = false;
	} else {
		state.positionals.push(tok);
	}
	return index;
}

function parseAddOrOpenCommand(action: "add" | "open", rest: string[]): ParsedCommand {
	const state: AddOrOpenParseState = { positionals: [], force: false, detach: false };
	for (let i = 0; i < rest.length; i++) {
		i = applyAddOrOpenToken(rest, i, state);
	}
	const [pathArg, commitish] = state.positionals;
	if (!pathArg) return { action, error: formatAddOrOpenUsage(action) };
	if (state.newBranch !== undefined && !isValidBranchName(state.newBranch)) {
		return {
			action,
			error: formatInvalidBranchNameError(state.newBranch),
		};
	}
	return {
		action,
		path: pathArg,
		newBranch: state.newBranch,
		commitish,
		force: state.force,
		detach: state.detach,
		copyIgnored: state.copyIgnored,
		copyUntracked: state.copyUntracked,
	};
}

/** Parsea la línea de comandos `/worktree` en una intención estructurada. */
export function parseCommand(input: string): ParsedCommand {
	const tokens = tokenize(input.trim());
	if (tokens.length === 0) return { action: "list" };

	const head = tokens[0].toLowerCase();
	if (isHelpCommand(head)) return { action: "help" };
	if (isListCommand(head)) return { action: "list" };

	if (isPruneCommand(head)) return parsePruneCommand(tokens.slice(1));

	if (isSetCommand(head)) return parseSetCommand(tokens.slice(1));

	if (isAddOrOpenCommand(head)) return parseAddOrOpenCommand(head, tokens.slice(1));

	if (isRemoveCommand(head)) return parseRemoveCommand(tokens.slice(1));

	return parseUnknownCommand(tokens[0]);
}
