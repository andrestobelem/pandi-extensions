// pandi-worktree `/worktree ...` command-line parsing: tokenize the argument string and
// parse it into a structured ParsedCommand intent. Pure (no ctx/git); re-exported from
// index.ts so the built bundle keeps the names the integration suite imports.

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
	/** Tri-state: true (--copy-ignored), false (--no-copy-ignored), undefined (fall through). */
	copyIgnored?: boolean;
	copyUntracked?: boolean;
	/** For `set`: which copy default to read/write (undefined = show both). */
	setTarget?: "copy-ignored" | "copy-untracked";
	/** For `set`: the parsed on|off|status|invalid toggle value. */
	setValue?: "on" | "off" | "status" | "invalid";
	error?: string;
}

/**
 * Tokenize a `/worktree ...` argument string, honoring simple single/double
 * quotes so paths with spaces work. Not a full shell parser — quotes only.
 */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec() loop
	while ((match = re.exec(input)) !== null) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return tokens;
}

/** Parse the `/worktree` command line into a structured intent. */
export function parseCommand(input: string): ParsedCommand {
	const tokens = tokenize(input.trim());
	if (tokens.length === 0) return { action: "list" };

	const head = tokens[0].toLowerCase();
	if (head === "help" || head === "-h" || head === "--help") return { action: "help" };
	if (head === "list" || head === "ls") return { action: "list" };

	if (head === "prune") {
		const dryRun = tokens.slice(1).some((t) => t === "--dry-run" || t === "-n");
		return { action: "prune", dryRun };
	}

	if (head === "set") {
		const rest = tokens.slice(1);
		if (rest.length === 0) return { action: "set" }; // show both
		const target = rest[0].toLowerCase();
		if (target !== "copy-ignored" && target !== "copy-untracked") {
			return { action: "set", error: "Uso: /worktree set [copy-ignored|copy-untracked] [on|off|status]" };
		}
		return { action: "set", setTarget: target, setValue: parseCopyToggleValue(rest[1] ?? "") };
	}

	if (head === "add" || head === "open") {
		const rest = tokens.slice(1);
		const positionals: string[] = [];
		let newBranch: string | undefined;
		let force = false;
		let detach = false;
		// Tri-state: undefined unless an explicit flag turns copy on/off this call.
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
			head === "open"
				? "Uso: /worktree open [-b <branch>] <path> [<commit-ish>]"
				: "Uso: /worktree add [-b <branch>] <path> [<commit-ish>]";
		if (!pathArg) return { action: head, error: usage };
		if (newBranch !== undefined && !isValidBranchName(newBranch)) {
			return {
				action: head,
				error: `Nombre de rama inválido "${newBranch ?? ""}" — sin espacios, caracteres de control ni puntos o barras iniciales/finales.`,
			};
		}
		return { action: head, path: pathArg, newBranch, commitish, force, detach, copyIgnored, copyUntracked };
	}

	if (head === "remove" || head === "rm") {
		const rest = tokens.slice(1);
		const force = rest.some((t) => t === "--force" || t === "-f");
		const pathArg = rest.find((t) => t !== "--force" && t !== "-f");
		if (!pathArg) return { action: "remove", error: "Uso: /worktree remove [--force] <path>" };
		return { action: "remove", path: pathArg, force };
	}

	return { action: "help", error: `Subcomando desconocido: "${tokens[0]}"` };
}
