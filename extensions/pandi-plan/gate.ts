/**
 * El GATE de solo lectura para modo plan — la política PURA de exactamente qué una llamada a tool
 * puede hacer mientras se redacta un plan.
 *
 * Extraído verbatim de index.ts (preservando comportamiento). Puro y sin side-effects,
 * así que es trivialmente testable y reviewable en aislamiento (la garantía de seguridad
 * vive acá; el cableado/handleToolCall se queda en index.ts).
 *
 * Módulo sibling de profundidad uno (coincide con el glob `files` de `package.json`); importado
 * por index.ts vía "./gate.js", así que se type-checkea transitivamente. La
 * importación `ToolCallEvent` es type-only y se borra en tiempo de build.
 */

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * Allowlist de comandos bash MUTANTES (best-effort, documentados). El gate bloquea una llamada bash
 * SI Y SOLO SI su comando coincide con uno de estos; todo lo demás (reads) está permitido. Este es
 * el uso inverso del maquinario DESTRUCTIVE_BASH_PATTERNS de loop.ts (look-aheads independientes de orden de bandera),
 * ampliado per el brief. Es BEST-EFFORT: un comando de shell suficientemente creativo puede evadirlo (p. ej. tooling oscuro, mutador aliaseado).
 * Las garantías duras están en las tools estructuradas (write/edit/notebook-edit SIEMPRE bloqueadas); bash es un
 * heurístico de respaldo. Cuando no estamos seguros erramos hacia BLOQUEAR (este es modo plan — sin mutación).
 *
 * Conjunto de bloqueo:
 *   - Creación/borrado/movimiento/cambios de metadata de archivo: touch, mkdir, rm, rmdir, mv, truncate, shred, unlink, chmod, chown, chgrp
 *   - Tooling in-place / de escritura: sed -i, tee, dd, mkfs
 *   - Redireccionamientos de shell que ESCRIBEN archivo: >, >>, >|, incluyendo writes de fd numerado
 *     como 2>err.log (pero NO quoted > text o fd duplications como 2>&1)
 *   - Mutaciones de Git: commit, add, push, pull, clone, fetch, reset, clean, checkout, switch, restore, merge,
 *     rebase, stash, apply, rm, mv, tag, creación/borrado de branch, cherry-pick, revert
 *   - Mutaciones de package manager: npm/pnpm/yarn/bun install|add|ci|uninstall|remove|update|upgrade|prune, npx -y, pip/pipx install, poetry add,
 *     cargo add, go get, gem install, brew install, bun add/install
 *   - Infra/build que escribe: make, kubectl apply/delete, terraform apply/destroy,
 *     helm upgrade/install/uninstall
 */
export const MUTATING_BASH_PATTERNS: RegExp[] = [
	// Creación/borrado/movimiento/cambios de metadata de archivo (cualquier bandera). \brm\b también cubre rm -rf.
	/\btouch\b/i,
	/\bmkdir\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bln\b/i,
	/\binstall\b/i, // GNU coreutils `install` crea archivos; también re-cubre npm/pip install
	/\btruncate\b/i,
	/\bshred\b/i,
	/\bunlink\b/i,
	// Herramientas in-place / de escritura de archivos.
	/\bsed\b[^\n]*\s-i\b/i, // sed -i (edición in-place)
	/\btee\b/i,
	/\bdd\b[^\n]*\b(if|of)=/i,
	/\bmkfs(\.\w+)?\b/i,
	// Los redireccionamientos de shell se checkean por hasWritingRedirection abajo, porque la versión regex
	// no pudía distinguir `> file` de un patrón grep de solo lectura quoted.
	// Mutaciones de Git.
	/\bgit\b[^\n]*\b(commit|add|push|pull|clone|fetch|reset|clean|checkout|switch|restore|merge|rebase|stash|apply|rm|mv|tag|cherry-pick|revert)\b/i,
	/\bgit\b[^\n]*\bbranch\b[^\n]*\s-(?:[dDmMcC]|-delete|-move|-copy|-set-upstream-to|-unset-upstream|-create-reflog|-track)\b/i,
	/\bgit\b[^\n]*\bbranch\b\s+(?!-)(?:"[^"]+"|'[^']+'|[^\s;|&]+)/i,
	// Instalaciones de package.
	/\b(npm|pnpm|yarn|bun)\b[^\n]*\b(install|add|ci|uninstall|remove|update|upgrade|prune)\b/i,
	/\bnpx\b[^\n]*\s-y\b/i,
	/\b(pip|pip3|pipx)\b[^\n]*\binstall\b/i,
	/\bpoetry\b[^\n]*\badd\b/i,
	/\bcargo\b[^\n]*\badd\b/i,
	/\bgo\b[^\n]*\bget\b/i,
	/\bgem\b[^\n]*\binstall\b/i,
	/\bbrew\b[^\n]*\binstall\b/i,
	// Infra / build que escribe.
	/\bmake\b/i,
	/\bkubectl\b[^\n]*\b(apply|delete)\b/i,
	/\bterraform\b[^\n]*\b(apply|destroy)\b/i,
	/\bhelm\b[^\n]*\b(upgrade|install|uninstall)\b/i,
];

function firstNonWhitespaceAfter(command: string, start: number): string | undefined {
	for (let i = start; i < command.length; i++) {
		if (!/\s/.test(command[i])) return command[i];
	}
	return undefined;
}

function readShellToken(command: string, start: number): string | undefined {
	let inSingle = false;
	let inDouble = false;
	let token = "";

	for (let i = start; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !inSingle) {
			if (i + 1 < command.length) token += command[i + 1];
			i += 1;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "&")) break;
		token += ch;
	}

	return token || undefined;
}

function hasWritingRedirection(command: string): boolean {
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !inSingle) {
			i += 1;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble || ch !== ">") continue;

		const prev = command[i - 1];
		const next = command[i + 1];
		if (prev === "-" || prev === "=" || next === "=") continue; // ->, =>, >=
		if (next === "&") {
			const targetStart = firstNonWhitespaceAfter(command, i + 2);
			if (targetStart === undefined || /[-\d&]/.test(targetStart)) continue; // fd dup/close: 2>&1, >&2, >&-
		}

		let targetOffset = 1;
		if (next === ">" || next === "|") targetOffset = 2; // >>file, >|file
		const target = readShellToken(command, i + targetOffset);
		if (target === "/dev/null") continue;
		return true;
	}

	return false;
}

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let inSingle = false;
	let inDouble = false;
	let start = 0;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !inSingle) {
			i += 1;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble) continue;

		const next = command[i + 1];
		const isSeparator = ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && next === "&");
		if (!isSeparator || (ch === "|" && command[i - 1] === ">")) continue;

		const segment = command.slice(start, i).trim();
		if (segment) segments.push(segment);
		start = i + (ch === "&" && next === "&" ? 2 : 1);
		if (ch === "&" && next === "&") i += 1;
	}

	const last = command.slice(start).trim();
	if (last) segments.push(last);
	return segments;
}

function shellWords(segment: string): string[] {
	const words: string[] = [];
	let inSingle = false;
	let inDouble = false;
	let current = "";

	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\\" && !inSingle) {
			if (i + 1 < segment.length) current += segment[i + 1];
			i += 1;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && /\s/.test(ch)) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += ch;
	}

	if (current) words.push(current);
	return words;
}

function commandBasename(token: string | undefined): string {
	return (token ?? "").split("/").pop() ?? "";
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function firstCommandIndex(words: string[], start = 0): number {
	let index = start;
	while (index < words.length && isEnvAssignment(words[index])) index += 1;
	return index;
}

function hasSedInPlaceFlag(words: string[]): boolean {
	return words.some((word) => /^-[A-Za-z]*i[A-Za-z]*$/.test(word));
}

function hasAny(words: string[], values: Set<string>): boolean {
	return words.some((word) => values.has(word));
}

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

/** ¿Es este comando bash una mutación per el allowlist best-effort? */
export function isMutatingBash(command: string): boolean {
	return hasWritingRedirection(command) || splitShellSegments(command).some(isMutatingSegment);
}

/**
 * Decide si una llamada a tool debe ser HARD-BLOQUEADA mientras el modo plan está activo. Devuelve una
 * razón legible cuando debe bloquearse, sino undefined (permitir). Puro (sin side
 * effects) así que es trivialmente testable.
 *
 * Siempre bloqueadas (las tools mutantes built-in): write, edit. (notebook-edit también se bloquea
 *                                                defensivamente por nombre, aunque no es
 *                                                una built-in en este SDK — ver nota abajo.)
 * Siempre permitidas (built-ins de solo lectura):  read, grep, find, ls, submit_plan, enter_plan_mode.
 * bash:                                            bloqueado iff el comando coincide con el
 *                                                allowlist mutante (arriba); sino permitido.
 * Tools personalizadas mutantes conocidas:         dynamic_workflow se bloquea a menos que su
 *                                                acción sea de solo lectura (list/scaffold/read/
 *                                                graph/runs/view). Puede escribir archivos en el
 *                                                workspace y generar subagentes que corran
 *                                                write/edit/bash, y esas llamadas a tool de subagente
 *                                                NO pasan por este main-session
 *                                                gate — así que bloquearlo acá es el único lugar
 *                                                donde podemos detenerlo.
 * Cualquier otro nombre de tool:                   permitido. Las garantías DURAS son los mutadores
 *                                                estructurados built-in (write/edit) + la
 *                                                heurística bash + el bloqueo custom-tool conocido arriba;
 *                                                una tool personalizada mutante desconocida registrada
 *                                                por otra extensión/MCP caería acá
 *                                                (best-effort — nos basamos en el prompt para esas).
 */
export const DYNAMIC_WORKFLOW_READONLY_ACTIONS = new Set(["list", "scaffold", "read", "graph", "runs", "view"]);

/**
 * Mutadores built-in estructurados que SIEMPRE se bloquean mientras se planifica. notebook-edit se
 * incluye defensivamente (no es un nombre de tool built-in en este SDK, pero bloquear un
 * nombre no existente es inerte y futuro-prueba contra un editor de notebook que se agregue).
 */
const ALWAYS_BLOCKED_BUILTIN_TOOLS = new Set(["write", "edit", "notebook-edit"]);

/** Built-ins de solo lectura que siempre se permiten mientras se planifica. */
const READONLY_BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function blockedReason(event: ToolCallEvent): string | undefined {
	const name = event.toolName;
	// submit_plan is the one permitted "output" (writing the plan). enter_plan_mode is the
	// model's autonomous ENTRY into plan mode; it never mutates the workspace (it only arms the
	// gate), so it is always allowed — calling it while a plan is already active is a harmless
	// idempotent no-op handled by the tool itself.
	if (name === "submit_plan" || name === "enter_plan_mode") return undefined;
	// Mutadores built-in estructurados que SIEMPRE se bloquean. notebook-edit se matchea por string
	// compare (defensivo — no es un nombre de tool built-in en este SDK, pero bloquear un
	// nombre no existente es inerte y futuro-prueba contra un editor de notebook que se agregue).
	if (ALWAYS_BLOCKED_BUILTIN_TOOLS.has(name)) {
		return `el modo plan es de SOLO LECTURA: la tool "${name}" está bloqueada mientras planificás. Presentá tu plan vía submit_plan; podés editar después de que el usuario apruebe.`;
	}
	// Built-ins de solo lectura siempre se permiten.
	if (READONLY_BUILTIN_TOOLS.has(name)) return undefined;
	// bash: bloquea solo comandos mutantes; permite de solo lectura (cat, git ls-files, grep...).
	if (name === "bash") {
		const command = (event.input as { command?: unknown }).command;
		if (typeof command === "string" && isMutatingBash(command)) {
			return `el modo plan es de SOLO LECTURA: este comando de shell parece una mutación y está bloqueado mientras planificás: ${command.slice(0, 200)}`;
		}
		return undefined;
	}
	// Tool personalizada mutante conocida: dynamic_workflow puede escribir archivos (action=write) y generar
	// subagentes con write/edit/bash (action=run/start/resume), cuyos tool calls pasan por alto este
	// main-session gate enteramente. Permite solo sus acciones de solo lectura; bloquea el resto. Si la
	// acción falta/es desconocida erramos hacia BLOQUEAR (este es modo plan — sin mutación).
	if (name === "dynamic_workflow") {
		const action = (event.input as { action?: unknown }).action;
		if (typeof action === "string" && DYNAMIC_WORKFLOW_READONLY_ACTIONS.has(action)) return undefined;
		return `el modo plan es de SOLO LECTURA: dynamic_workflow "${String(action)}" puede escribir archivos o lanzar subagentes mutantes y está bloqueado mientras planificás. Usá solo acciones de solo lectura (list/scaffold/read/graph/runs/view), o submit_plan cuando tu plan esté listo.`;
	}
	// Herramientas desconocidas / otras: permite. Las garantías duras arriba (mutadores built-in + bash
	// heurística + bloqueo custom-tool conocido) son best-effort; una tool personalizada mutante desconocida
	// caería acá, en cuyo caso nos basamos en el prompt de planificación.
	return undefined;
}
