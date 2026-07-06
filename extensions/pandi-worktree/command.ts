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
	const force = rest.some((t) => t === "--force" || t === "-f");
	const pathArg = rest.find((t) => t !== "--force" && t !== "-f");
	if (!pathArg) return { action: "remove", error: "Uso: /worktree remove [--force] <path>" };
	return { action: "remove", path: pathArg, force };
}

function parseAddOrOpenCommand(action: "add" | "open", rest: string[]): ParsedCommand {
	const positionals: string[] = [];
	let newBranch: string | undefined;
	let force = false;
	let detach = false;
	// Tres estados: undefined salvo que un flag explícito active/desactive la copia en esta llamada.
	let copyIgnored: boolean | undefined;
	let copyUntracked: boolean | undefined;
	for (let i = 0; i < rest.length; i++) {
		const tok = rest[i];
		if (tok === "-b" || tok === "--branch") {
			newBranch = rest[++i];
		} else if (tok === "--force" || tok === "-f") {
			force = true;
		} else if (tok === "--detach" || tok === "-d") {
			detach = true;
		} else if (tok === "--copy-ignored") {
			copyIgnored = true;
		} else if (tok === "--no-copy-ignored") {
			copyIgnored = false;
		} else if (tok === "--copy-untracked") {
			copyUntracked = true;
		} else if (tok === "--no-copy-untracked") {
			copyUntracked = false;
		} else {
			positionals.push(tok);
		}
	}
	const [pathArg, commitish] = positionals;
	const usage =
		action === "open"
			? "Uso: /worktree open [-b <branch>] <path> [<commit-ish>]"
			: "Uso: /worktree add [-b <branch>] <path> [<commit-ish>]";
	if (!pathArg) return { action, error: usage };
	if (newBranch !== undefined && !isValidBranchName(newBranch)) {
		return {
			action,
			error: `Nombre de rama inválido "${newBranch ?? ""}" — sin espacios, caracteres de control ni puntos o barras iniciales/finales.`,
		};
	}
	return { action, path: pathArg, newBranch, commitish, force, detach, copyIgnored, copyUntracked };
}

/** Parsea la línea de comandos `/worktree` en una intención estructurada. */
export function parseCommand(input: string): ParsedCommand {
	const tokens = tokenize(input.trim());
	if (tokens.length === 0) return { action: "list" };

	const head = tokens[0].toLowerCase();
	if (isHelpCommand(head)) return { action: "help" };
	if (isListCommand(head)) return { action: "list" };

	if (head === "prune") return parsePruneCommand(tokens.slice(1));

	if (head === "set") return parseSetCommand(tokens.slice(1));

	if (head === "add" || head === "open") return parseAddOrOpenCommand(head, tokens.slice(1));

	if (isRemoveCommand(head)) return parseRemoveCommand(tokens.slice(1));

	return { action: "help", error: `Subcomando desconocido: "${tokens[0]}"` };
}
