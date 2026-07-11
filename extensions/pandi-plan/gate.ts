/**
 * El GATE de solo lectura para modo plan — la política PURA de exactamente qué una llamada a tool
 * puede hacer mientras se redacta un plan.
 *
 * Extraído verbatim de index.ts (preservando comportamiento). Puro y sin side-effects,
 * así que es trivialmente testable y reviewable en aislamiento (la garantía de seguridad
 * vive acá; el cableado/handleToolCall se queda en tool-call-handler.ts).
 *
 * Módulo sibling de profundidad uno (coincide con el glob `files` de `package.json`); importado
 * por index.ts vía "./gate.js", así que se type-checkea transitivamente. La
 * importación `ToolCallEvent` es type-only y se borra en tiempo de build.
 */

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	commandBasename,
	firstCommandIndex,
	firstXargsCommandIndex,
	hasAny,
	hasDownloadOutputFlag,
	hasSedInPlaceFlag,
	hasWritingRedirection,
	shellWords,
	splitShellSegments,
} from "./gate-shell-parse.js";

export { MUTATING_BASH_PATTERNS } from "./gate-patterns.js";

const FILE_MUTATING_COMMANDS = new Set([
	"touch",
	"mkdir",
	"chmod",
	"chown",
	"chgrp",
	"rm",
	"rmdir",
	"mv",
	"cp",
	"ln",
	"install",
	"truncate",
	"shred",
	"unlink",
	"tee",
	"make",
]);

const GIT_MUTATING_SUBCOMMANDS = new Set([
	"commit",
	"add",
	"push",
	"pull",
	"clone",
	"fetch",
	"reset",
	"clean",
	"checkout",
	"switch",
	"restore",
	"merge",
	"rebase",
	"stash",
	"apply",
	"rm",
	"mv",
	"cherry-pick",
	"revert",
]);

const GIT_BRANCH_MUTATING_FLAGS = new Set([
	"-d",
	"-D",
	"-m",
	"-M",
	"-c",
	"-C",
	"--delete",
	"--move",
	"--copy",
	"--set-upstream-to",
	"--unset-upstream",
	"--create-reflog",
	"--track",
]);

const GIT_TAG_MUTATING_FLAGS = new Set([
	"-a",
	"-d",
	"-f",
	"-m",
	"-s",
	"-u",
	"--annotate",
	"--delete",
	"--force",
	"--message",
	"--sign",
	"--local-user",
]);

function gitSubcommand(words: string[], gitIndex: number): { subcommand: string; args: string[] } | undefined {
	for (let index = gitIndex + 1; index < words.length; index++) {
		const word = words[index];
		if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree") {
			index += 1;
			continue;
		}
		if (word.startsWith("--git-dir=") || word.startsWith("--work-tree=")) continue;
		if (word.startsWith("-")) continue;
		return { subcommand: word, args: words.slice(index + 1) };
	}
	return undefined;
}

function isMutatingGit(words: string[], gitIndex: number): boolean {
	const parsed = gitSubcommand(words, gitIndex);
	if (!parsed) return false;
	const { subcommand, args } = parsed;
	if (GIT_MUTATING_SUBCOMMANDS.has(subcommand)) return true;
	if (subcommand === "branch") {
		if (hasAny(args, GIT_BRANCH_MUTATING_FLAGS)) return true;
		const hasReadListFlag = args.some((arg) => arg === "--list" || arg === "-l" || arg === "--show-current");
		return !hasReadListFlag && args.some((arg) => !arg.startsWith("-"));
	}
	if (subcommand === "tag") {
		if (hasAny(args, GIT_TAG_MUTATING_FLAGS)) return true;
		return args.some((arg) => !arg.startsWith("-"));
	}
	if (subcommand === "remote") return hasAny(args, new Set(["add", "remove", "rm", "rename", "set-url", "prune"]));
	return false;
}

function isMutatingGh(words: string[], ghIndex: number): boolean {
	const scope = words[ghIndex + 1];
	const action = words[ghIndex + 2];
	if (!scope) return false;
	if (scope === "issue")
		return hasAny(
			[action ?? ""],
			new Set([
				"close",
				"comment",
				"create",
				"delete",
				"develop",
				"edit",
				"lock",
				"pin",
				"reopen",
				"transfer",
				"unlock",
				"unpin",
			]),
		);
	if (scope === "pr")
		return hasAny(
			[action ?? ""],
			new Set([
				"checkout",
				"close",
				"comment",
				"create",
				"draft",
				"edit",
				"lock",
				"merge",
				"ready",
				"reopen",
				"review",
				"unlock",
			]),
		);
	if (scope === "project")
		return hasAny(
			[action ?? ""],
			new Set(["close", "create", "delete", "edit", "item-add", "item-archive", "item-delete", "item-edit"]),
		);
	if (scope === "repo")
		return hasAny([action ?? ""], new Set(["clone", "create", "delete", "fork", "rename", "sync"]));
	if (scope === "release")
		return hasAny([action ?? ""], new Set(["create", "delete", "delete-asset", "edit", "upload"]));
	if (scope === "workflow") return action === "run";
	if (scope === "run") return hasAny([action ?? ""], new Set(["cancel", "delete", "rerun"]));
	if (scope === "secret" || scope === "variable") return hasAny([action ?? ""], new Set(["delete", "remove", "set"]));
	if (scope === "auth") return hasAny([action ?? ""], new Set(["login", "logout", "refresh", "switch"]));
	return false;
}

function isMutatingCommand(words: string[], start = 0): boolean {
	const commandIndex = firstCommandIndex(words, start);
	const command = commandBasename(words[commandIndex]);
	const args = words.slice(commandIndex + 1);
	if (!command) return false;
	if (command === "sudo" || command === "command" || command === "builtin" || command === "time")
		return isMutatingCommand(words, commandIndex + 1);
	if (command === "env") return isMutatingCommand(words, commandIndex + 1);
	if (command === "eval") return isMutatingBash(args.join(" "));
	if (command === "xargs") {
		const xargsCommandIndex = firstXargsCommandIndex(words, commandIndex);
		return xargsCommandIndex === undefined ? false : isMutatingCommand(words, xargsCommandIndex);
	}
	if (command === "curl" || command === "wget") return hasDownloadOutputFlag(args);
	if (FILE_MUTATING_COMMANDS.has(command)) return true;
	if (command === "sed") return hasSedInPlaceFlag(args);
	if (command === "dd") return args.some((arg) => /^(if|of)=/.test(arg));
	if (command.startsWith("mkfs")) return true;
	if (command === "git") return isMutatingGit(words, commandIndex);
	if (command === "gh") return isMutatingGh(words, commandIndex);
	if (["npm", "pnpm", "yarn", "bun"].includes(command))
		return hasAny(args, new Set(["install", "add", "ci", "uninstall", "remove", "update", "upgrade", "prune"]));
	if (command === "npx") return args.includes("-y");
	if (["pip", "pip3", "pipx"].includes(command)) return args.includes("install");
	if (command === "poetry") return args.includes("add");
	if (command === "cargo") return args.includes("add");
	if (command === "go") return args.includes("get");
	if (command === "gem") return args.includes("install");
	if (command === "brew") return args.includes("install");
	if (command === "kubectl") return hasAny(args, new Set(["apply", "delete"]));
	if (command === "terraform") return hasAny(args, new Set(["apply", "destroy"]));
	if (command === "helm") return hasAny(args, new Set(["upgrade", "install", "uninstall"]));
	if (["bash", "sh", "zsh"].includes(command)) {
		const scriptIndex = args.indexOf("-c");
		if (scriptIndex >= 0 && args[scriptIndex + 1]) return isMutatingBash(args[scriptIndex + 1]);
	}
	return false;
}

function hasMutatingExec(words: string[]): boolean {
	for (let index = 0; index < words.length; index++) {
		if (words[index] !== "-exec") continue;
		if (isMutatingCommand(words, index + 1)) return true;
	}
	return false;
}

function isMutatingSegment(segment: string): boolean {
	const words = shellWords(segment);
	if (words.length === 0) return false;
	return isMutatingCommand(words) || hasMutatingExec(words);
}

/**
 * ¿Este comando bash debe tratarse como mutante para el gate de `/plan`?
 * Es una clasificación heurística best-effort, no un parser shell completo; el contrato exacto está caracterizado
 * en `tests/integration/plan-gate-helpers.test.mjs`.
 */
export function isMutatingBash(command: string): boolean {
	return hasWritingRedirection(command) || splitShellSegments(command).some(isMutatingSegment);
}

/**
 * Decide si una llamada a tool debe ser HARD-BLOQUEADA mientras el modo plan está activo. Devuelve una
 * razón legible cuando debe bloquearse, sino undefined (permitir). Puro (sin side
 * effects) así que es trivialmente testable.
 */
export const DYNAMIC_WORKFLOW_READONLY_ACTIONS = new Set([
	"list",
	"scaffold",
	"read",
	"check",
	"graph",
	"runs",
	"view",
]);

const ALWAYS_BLOCKED_BUILTIN_TOOLS = new Set(["write", "edit", "notebook-edit"]);
const READONLY_TOOLS = new Set([
	"read",
	"grep",
	"rg",
	"glob",
	"find",
	"ls",
	"web_search",
	"ask_choice",
	"ask_confirm",
	"submit_plan",
	"enter_plan_mode",
]);

export function blockedReason(event: ToolCallEvent): string | undefined {
	const name = event.toolName;
	if (ALWAYS_BLOCKED_BUILTIN_TOOLS.has(name)) {
		return `el modo plan es de SOLO LECTURA: la tool "${name}" está bloqueada mientras planificás. Presentá tu plan vía submit_plan; podés editar después de que el usuario apruebe.`;
	}
	if (READONLY_TOOLS.has(name)) return undefined;
	if (name === "bash") {
		const command = (event.input as { command?: unknown }).command;
		if (typeof command === "string" && isMutatingBash(command)) {
			return `el modo plan es de SOLO LECTURA: este comando de shell parece una mutación y está bloqueado mientras planificás: ${command.slice(0, 200)}`;
		}
		return undefined;
	}
	if (name === "dynamic_workflow") {
		const action = (event.input as { action?: unknown }).action;
		if (typeof action === "string" && DYNAMIC_WORKFLOW_READONLY_ACTIONS.has(action)) return undefined;
		return `el modo plan es de SOLO LECTURA: dynamic_workflow "${String(action)}" puede escribir archivos o lanzar subagentes mutantes y está bloqueado mientras planificás. Usá solo acciones de solo lectura (list/scaffold/read/check/graph/runs/view), o submit_plan cuando tu plan esté listo.`;
	}
	return `el modo plan es de SOLO LECTURA: la tool desconocida "${name}" no está en la allowlist explícita de solo lectura y queda bloqueada mientras planificás. Usá una tool de investigación permitida, o submit_plan cuando tu plan esté listo.`;
}
