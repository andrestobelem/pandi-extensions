/**
 * Helpers de pandi-worktree: lógica pura, sin UI, para manejar `git worktree`.
 *
 * Todo acá está deliberadamente libre de ExtensionContext / UI de pi para que
 * pueda probarse unitariamente en aislamiento y reutilizarse tanto por el
 * comando `/worktree` como por la herramienta invocable por el modelo `git_worktree`.
 * El único efecto lateral vive en `runGit`, que hace spawn de `git` con un
 * array ARGV (nunca una cadena de shell) para que la entrada de la persona
 * usuaria/modelo nunca pueda inyectar comandos de shell.
 *
 * Módulo hermano de profundidad uno importado por index.ts vía "./worktree.js".
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 1_000_000;
const GIT_TERMINATION_GRACE_MS = 250;
/** Subdirectorio por defecto (bajo el dir de config de Pi) para worktrees creados desde un nombre simple. */
export const WORKTREES_DIR = "worktrees";

export interface GitResult {
	/** true cuando git salió con 0 y no fue abortado ni agotó el tiempo. */
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	/** se define cuando el proceso fue terminado por signal/timeout/abort. */
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	/** true únicamente cuando la AbortSignal externa pidió terminar el proceso. */
	aborted?: boolean;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
	/** se define cuando nunca logramos hacer spawn de git (p. ej., git no instalado). */
	spawnError?: string;
}

export interface RunGitOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Acumula la salida del proceso hijo como texto UTF-8, acotada por bytes a
 * MAX_GIT_OUTPUT_BYTES para que un git desbocado no inunde la memoria ni la
 * transcripción. Conserva bytes completos hasta el límite e informa explícitamente
 * cuando descartó el resto.
 */
function createBoundedOutput(): {
	append(chunk: Buffer | string): void;
	readonly text: string;
	readonly truncated: boolean;
} {
	const decoder = new StringDecoder("utf8");
	const chunks: string[] = [];
	let bytes = 0;
	let truncated = false;
	let finalized: string | undefined;
	return {
		append(chunk): void {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const remaining = MAX_GIT_OUTPUT_BYTES - bytes;
			if (buffer.length > remaining) truncated = true;
			if (remaining <= 0) return;
			const kept = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
			const decoded = decoder.write(kept);
			if (decoded) chunks.push(decoded);
			bytes += kept.length;
		},
		get text(): string {
			if (finalized === undefined) {
				if (!truncated) {
					const tail = decoder.end();
					if (tail) chunks.push(tail);
				}
				finalized = chunks.join("");
			}
			return finalized;
		},
		get truncated(): boolean {
			return truncated;
		},
	};
}

/**
 * Ejecuta `git <args>` en `cwd` y resuelve con un resultado tipado. NUNCA
 * rechaza: un fallo de spawn, salida no cero, timeout o abort vuelven todos
 * como GitResult para que quien llama pueda bifurcar sin try/catch. La salida
 * se acota por bytes para que un git desbocado no bloquee el event loop ni
 * inunde la transcripción.
 */
export function runGit(args: string[], options: RunGitOptions): Promise<GitResult> {
	const { cwd, signal, timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = options;
	return new Promise<GitResult>((resolve) => {
		const stdout = createBoundedOutput();
		const stderr = createBoundedOutput();
		let settled = false;
		let termination: "timeout" | "abort" | undefined;
		let spawnError: string | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		const useProcessGroup = process.platform !== "win32";

		const child = spawn("git", args, { cwd, detached: useProcessGroup, windowsHide: true });

		const sendSignal = (processSignal: NodeJS.Signals): void => {
			if (useProcessGroup && child.pid && child.pid !== process.pid) {
				try {
					process.kill(-child.pid, processSignal);
					return;
				} catch {
					// El fallback conserva el comportamiento en hosts sin group kill.
				}
			}
			try {
				child.kill(processSignal);
			} catch {
				// El proceso ya cerró.
			}
		};

		const finish = (code: number | null, childSignal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve({
				ok: !spawnError && !termination && code === 0,
				exitCode: spawnError ? null : code,
				stdout: stdout.text,
				stderr: stderr.text,
				signal: childSignal,
				timedOut: termination === "timeout",
				aborted: termination === "abort",
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				spawnError,
			});
		};

		const terminate = (reason: "timeout" | "abort"): void => {
			if (settled || termination) return;
			termination = reason;
			sendSignal("SIGTERM");
			killTimer = setTimeout(() => {
				if (!settled) sendSignal("SIGKILL");
			}, GIT_TERMINATION_GRACE_MS);
			killTimer.unref?.();
		};

		const onAbort = (): void => terminate("abort");

		child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
		child.once("error", (err) => {
			spawnError = err.message;
		});
		child.once("close", finish);

		timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
		timeoutTimer.unref?.();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

/** Una entrada de `git worktree list --porcelain`. */
export interface WorktreeEntry {
	path: string;
	head?: string;
	/** ref completa (p. ej. refs/heads/main) cuando está asociado a una rama. */
	branch?: string;
	/** nombre corto de la rama derivado de `branch`. */
	branchShort?: string;
	bare: boolean;
	detached: boolean;
	locked: boolean;
	lockedReason?: string;
	prunable: boolean;
	prunableReason?: string;
}

/**
 * Parsea `git worktree list --porcelain`. Los registros se separan por líneas
 * en blanco; cada línea es `key value` o una `key` sola. Las keys desconocidas
 * se ignoran para que versiones más nuevas de git nunca rompan el parser.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;

	const pushCurrent = (): void => {
		if (current) entries.push(current);
		current = null;
	};

	for (const rawLine of porcelain.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line === "") {
			pushCurrent();
			continue;
		}
		const spaceIdx = line.indexOf(" ");
		const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
		const value = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);

		if (key === "worktree") {
			pushCurrent();
			current = { path: value, bare: false, detached: false, locked: false, prunable: false };
			continue;
		}
		if (!current) continue; // malformado: una key antes de cualquier línea `worktree`
		switch (key) {
			case "HEAD":
				current.head = value;
				break;
			case "branch":
				current.branch = value;
				current.branchShort = value.replace(/^refs\/heads\//, "");
				break;
			case "bare":
				current.bare = true;
				break;
			case "detached":
				current.detached = true;
				break;
			case "locked":
				current.locked = true;
				if (value) current.lockedReason = value;
				break;
			case "prunable":
				current.prunable = true;
				if (value) current.prunableReason = value;
				break;
			default:
				break;
		}
	}
	pushCurrent();
	return entries;
}

/**
 * Valida un nombre de rama de git contra un subconjunto práctico de
 * `git check-ref-format`. Devuelve true solo para nombres que git aceptaría
 * para una rama nueva. Esto es un guard antes de `git worktree add -b <name>`
 * para fallar rápido con un mensaje claro en vez de mostrar un error críptico
 * de git.
 */
export function isValidBranchName(name: string): boolean {
	if (!name || name.length > 255) return false;
	if (/\s/.test(name)) return false; // sin espacios en blanco
	if (/[\x00-\x1f\x7f~^:?*[\\]/.test(name)) return false; // caracteres de control + conjunto prohibido
	if (name.startsWith("/") || name.endsWith("/")) return false;
	if (name.startsWith("-")) return false; // se vería como un flag
	if (name.startsWith(".") || name.endsWith(".")) return false;
	if (name.endsWith(".lock")) return false;
	if (name.includes("..")) return false;
	if (name.includes("//")) return false;
	if (name.includes("@{")) return false;
	if (name === "@") return false;
	// ningún componente del path puede empezar con punto ni terminar en .lock
	for (const part of name.split("/")) {
		if (part === "" || part.startsWith(".") || part.endsWith(".lock")) return false;
	}
	return true;
}

export interface WorktreeTarget {
	/** path absoluto donde vivirá el worktree. */
	path: string;
	/** true cuando un <name> simple se ubicó bajo <cwd>/<configDir>/worktrees/. */
	usedDefaultBase: boolean;
}

/**
 * Resuelve una ubicación de worktree provista por la persona usuaria/modelo.
 *
 * Un NOMBRE SIMPLE (sin separador de path, no ~/absolute) cae en la base por
 * defecto `<cwd>/<configDir>/worktrees/<name>` (se mantiene local + gitignored:
 * ver ensureWorktreesBaseDir). Cualquier cosa que parezca un path — `./x`,
 * `../x`, `/abs/x`, `~/x` o `a/b` — se respeta de forma literal (vía de escape)
 * y se resuelve contra `cwd` cuando es relativo.
 */
export function resolveWorktreeTarget(
	rawPath: string,
	cwd: string,
	configDirName: string = CONFIG_DIR_NAME,
): WorktreeTarget | undefined {
	const requested = stripWrappingQuotes(rawPath);
	if (!requested) return undefined;
	if (requested === "~") return { path: os.homedir(), usedDefaultBase: false };
	if (requested.startsWith("~/")) return { path: path.join(os.homedir(), requested.slice(2)), usedDefaultBase: false };
	if (path.isAbsolute(requested)) return { path: requested, usedDefaultBase: false };
	if (requested.includes("/") || requested.includes("\\"))
		return { path: path.resolve(cwd, requested), usedDefaultBase: false };
	return { path: path.join(cwd, configDirName, WORKTREES_DIR, requested), usedDefaultBase: true };
}

/**
 * Asegura que `<cwd>/<configDir>/worktrees/` exista y se auto-ignore, para que
 * los worktrees creados ahí nunca aparezcan en el `git status` del repo
 * principal. En el primer uso escribe un `.gitignore` con `*` (ignora todo,
 * incluido a sí mismo). Si falla, los errores de filesystem se absorben
 * porque el `git worktree add` posterior mostrará cualquier problema real con
 * un mensaje claro.
 */
export function ensureWorktreesBaseDir(cwd: string, configDirName: string = CONFIG_DIR_NAME): string {
	const base = path.join(cwd, configDirName, WORKTREES_DIR);
	try {
		mkdirSync(base, { recursive: true });
		const gitignore = path.join(base, ".gitignore");
		if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n", "utf8");
	} catch {
		/* si falla, git add informará cualquier fallo real */
	}
	return base;
}

export function stripWrappingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export interface AddArgsOptions {
	path: string;
	/** crea una rama nueva con este nombre (git worktree add -b <branch>). */
	newBranch?: string;
	/** punto de inicio / commit-ish sobre el que basar el worktree. */
	commitish?: string;
	/** hace checkout en modo detached HEAD. */
	detach?: boolean;
	/** fuerza la creación incluso cuando la rama ya está checkouteada en otro lugar. */
	force?: boolean;
}

/** Construye argv para `git worktree add ...`. Puro; no toca el filesystem. */
export function buildAddArgs(options: AddArgsOptions): string[] {
	const args = ["worktree", "add"];
	if (options.force) args.push("--force");
	if (options.detach) args.push("--detach");
	if (options.newBranch) args.push("-b", options.newBranch);
	// `--` termina el parsing de opciones para que un commitish que empieza con
	// guion (el único valor de modelo/usuario que llega a git sin validar) no se
	// interprete como un flag.
	args.push("--", options.path);
	if (options.commitish) args.push(options.commitish);
	return args;
}

/** Construye argv para `git worktree remove ...`. */
export function buildRemoveArgs(targetPath: string, force = false): string[] {
	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(targetPath);
	return args;
}

/** Construye argv para `git worktree prune ...`. */
export function buildPruneArgs(dryRun = false): string[] {
	const args = ["worktree", "prune"];
	if (dryRun) args.push("--dry-run");
	return args;
}

/** Construye argv para `git worktree list --porcelain`. */
export function buildListArgs(): string[] {
	return ["worktree", "list", "--porcelain"];
}

/**
 * Construye argv para enumerar paths GITIGNORED en el worktree principal, con
 * directorios totalmente ignorados colapsados a una sola entrada (p. ej.
 * `node_modules/`) para copiar un directorio en vez de miles de archivos.
 */
export function buildListIgnoredArgs(): string[] {
	return ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"];
}

/** Construye argv para enumerar paths UNTRACKED (no ignorados), con dirs sin seguimiento colapsados. */
export function buildListUntrackedArgs(): string[] {
	return ["ls-files", "--others", "--exclude-standard", "--directory"];
}

/** Divide `git ls-files` stdout en entradas relativas recortadas (separadas por NUL o salto de línea). */
export function parseLsFilesEntries(stdout: string): string[] {
	return String(stdout)
		.split(/\0|\n/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Descarta entradas que NUNCA deben copiarse a un worktree nuevo y devuelve
 * paths con separadores normalizados, sin duplicados y sin slash final:
 * - el dir base de worktrees `<configDir>/worktrees/` Y cualquier ancestro suyo
 *   (p. ej. una `.pi/` colapsada); de lo contrario copy-ignored copiaría de
 *   forma recursiva cada OTRO worktree dentro del nuevo;
 * - cualquier dir/archivo `.git` (top-level o puntero de worktree anidado);
 * - `.`/`..`/vacío.
 */
export function filterCopyableEntries(entries: string[], options: { configDirName?: string } = {}): string[] {
	const configDirName = options.configDirName ?? CONFIG_DIR_NAME;
	const worktreesBase = `${configDirName}/${WORKTREES_DIR}`.replace(/\\/g, "/").replace(/\/+$/g, "");
	const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/g, "");
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of entries) {
		const e = norm(raw);
		if (!e || e === "." || e === "..") continue;
		if (e === ".git" || e.startsWith(".git/") || e.endsWith("/.git") || e.includes("/.git/")) continue;
		// él mismo, descendiente O ancestro de la base de worktrees (`.pi/` colapsado).
		if (e === worktreesBase || e.startsWith(`${worktreesBase}/`) || worktreesBase.startsWith(`${e}/`)) continue;
		if (seen.has(e)) continue;
		seen.add(e);
		out.push(e);
	}
	return out;
}

/** Etiqueta corta que describe el estado de checkout de una entrada de worktree. */
function worktreeLabel(entry: WorktreeEntry): string {
	if (entry.bare) return "(bare)";
	if (entry.detached) {
		if (!entry.head) return "(detached ?)";
		return `(detached ${entry.head.slice(0, 8)})`;
	}
	if (entry.branchShort) return entry.branchShort;
	if (entry.head) return entry.head.slice(0, 8);
	return "(unknown)";
}

/** Resumen humano de una línea de una entrada de worktree para listas/notificaciones. */
export function describeWorktree(entry: WorktreeEntry): string {
	const label = worktreeLabel(entry);
	const flags: string[] = [];
	if (entry.locked) flags.push("bloqueado");
	if (entry.prunable) flags.push("limpiable");
	const suffix = flags.length ? `  [${flags.join(", ")}]` : "";
	return `${entry.path}  →  ${label}${suffix}`;
}
