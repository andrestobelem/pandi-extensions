/**
 * pi-worktree: manage git worktrees from inside a Pi session.
 *
 * Two surfaces (the project convention, see pi-mdview / pi-local-memory):
 *   - `/worktree`        human slash command (interactive, confirmations, completions)
 *   - `git_worktree`     model-callable tool (explicit actions, no surprise deletes)
 *
 * Both share the pure helpers in ./worktree.ts. `git` is always spawned with an
 * ARGV array (never a shell string) so paths/branch names can't inject commands.
 *
 * Note on cwd: Pi's working directory is fixed at startup and cannot change
 * mid-session, so this extension never tries to "switch" the session into another
 * worktree — it surfaces each worktree's absolute PATH so you can open a new Pi
 * there (`cd <path> && pi`).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ParsedCommand, parseCommand } from "./command.js";
import { type CopyPrefKey, resetSessionCopyDefaults, resolveCopyPrefs, setSessionCopyDefault } from "./copy-prefs.js";
import {
	combinedOutput,
	ensureGitRepo,
	gitError,
	listWorktrees,
	needsForce,
	notify,
	repoError,
} from "./git-context.js";
import {
	buildAddArgs,
	buildListArgs,
	buildListIgnoredArgs,
	buildListUntrackedArgs,
	buildPruneArgs,
	buildRemoveArgs,
	describeWorktree,
	ensureWorktreesBaseDir,
	filterCopyableEntries,
	DEFAULT_GIT_TIMEOUT_MS as GIT_TIMEOUT_MS,
	isValidBranchName,
	parseLsFilesEntries,
	parseWorktreeList,
	resolveWorktreeTarget,
	runGit,
} from "./worktree.js";

// --------------------------------------------------------------------------
// Command argument parsing
// --------------------------------------------------------------------------
// ParsedCommand + tokenize + parseCommand live in ./command.ts; tokenize/parseCommand
// are re-exported so the built bundle keeps the names the integration suite imports.
export { parseCommand, tokenize } from "./command.js";
// Re-exported so the integration suite can unit-test the copy-default resolution
// + parsing directly against the same bundle.
export {
	parseCopyToggleValue,
	resetSessionCopyDefaults,
	resolveCopyPrefs,
	setSessionCopyDefault,
} from "./copy-prefs.js";
// Re-exported for the integration suite to unit-test the pure helpers directly
// against the same bundle. Internal use still goes through the import above
// (an `export … from` re-export creates no local binding, so there is no clash).
export {
	buildAddArgs,
	buildListIgnoredArgs,
	buildListUntrackedArgs,
	describeWorktree,
	filterCopyableEntries,
	isValidBranchName,
	parseLsFilesEntries,
	parseWorktreeList,
} from "./worktree.js";

const HELP_TEXT = [
	"Uso:",
	"  /worktree [list]                       listar worktrees",
	"  /worktree add [-b <branch>] [--detach] [--force] [--copy-ignored] [--copy-untracked] <path> [<commit-ish>]   crear un worktree",
	"  /worktree open [-b <branch>] [--detach] [--force] <path> [<commit-ish>]  si falta, crearlo y luego abrir Pi ahí",
	"  /worktree remove [--force] <path>      eliminar un worktree",
	"  /worktree prune [--dry-run]            limpiar metadatos obsoletos de worktrees",
	"  /worktree set [copy-ignored|copy-untracked] [on|off|status]   definir la copia por defecto de la sesión",
	"",
	"Pasá --copy-ignored/--copy-untracked (o --no-copy-ignored/--no-copy-untracked) para sobrescribirlo en esta llamada.",
	"O definí un valor por defecto de la sesión con `set` (también vía las env vars PI_WORKTREE_COPY_IGNORED / PI_WORKTREE_COPY_UNTRACKED).",
	"",
	`Un <name> simple (sin slash) se crea en ${CONFIG_DIR_NAME}/worktrees/<name> (gitignored).`,
	"Usá ./x, ../x, /abs o ~/x para una ubicación explícita.",
].join("\n");

// --------------------------------------------------------------------------
// Command handlers
// --------------------------------------------------------------------------

async function handleList(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	const listed = await listWorktrees(ctx, signal);
	if (!listed.ok) {
		notify(ctx, `No se pudieron listar los worktrees: ${listed.error}`, "error");
		return;
	}
	if (listed.entries.length === 0) {
		notify(ctx, "No se encontraron worktrees.", "info");
		return;
	}
	const lines = listed.entries.map((entry) => `  • ${describeWorktree(entry)}`);
	notify(ctx, `Lista de worktrees (${listed.entries.length}):\n${lines.join("\n")}`, "info");
}

interface CopyFilesOptions {
	copyIgnored?: boolean;
	copyUntracked?: boolean;
}

interface CopyFilesResult {
	ignored: number;
	untracked: number;
	failed: number;
}

/**
 * After a NEW worktree is created, optionally copy gitignored and/or untracked
 * files from the main worktree (ctx.cwd) into it. Best-effort and abortable:
 * enumeration goes through runGit (argv, never shell); copying uses fs.cp with
 * verbatimSymlinks so symlinks (e.g. node_modules/.bin) survive. The worktrees
 * base dir and .git are always excluded (filterCopyableEntries) to prevent a
 * recursive copy of other worktrees. Never throws into the caller.
 */
async function copyFilesToWorktree(
	ctx: ExtensionContext,
	destPath: string,
	opts: CopyFilesOptions,
	signal?: AbortSignal,
): Promise<CopyFilesResult> {
	const result: CopyFilesResult = { ignored: 0, untracked: 0, failed: 0 };
	const gitOpts = { cwd: ctx.cwd, signal, timeoutMs: GIT_TIMEOUT_MS };
	const copyEntries = async (entries: string[]): Promise<number> => {
		let copied = 0;
		for (const entry of entries) {
			if (signal?.aborted) break;
			const src = path.join(ctx.cwd, entry);
			const dst = path.join(destPath, entry);
			try {
				await fsp.mkdir(path.dirname(dst), { recursive: true });
				await fsp.cp(src, dst, { recursive: true, force: true, errorOnExist: false, verbatimSymlinks: true });
				copied++;
			} catch {
				result.failed++;
			}
		}
		return copied;
	};
	if (opts.copyIgnored) {
		const r = await runGit(buildListIgnoredArgs(), gitOpts);
		if (r.ok) result.ignored = await copyEntries(filterCopyableEntries(parseLsFilesEntries(r.stdout)));
	}
	if (opts.copyUntracked) {
		const r = await runGit(buildListUntrackedArgs(), gitOpts);
		if (r.ok) result.untracked = await copyEntries(filterCopyableEntries(parseLsFilesEntries(r.stdout)));
	}
	return result;
}

/** A short " (copied N ignored + M untracked file(s))" suffix; "" when nothing was requested. */
function copyNote(opts: CopyFilesOptions, r: CopyFilesResult): string {
	if (!opts.copyIgnored && !opts.copyUntracked) return "";
	const parts: string[] = [];
	if (opts.copyIgnored) parts.push(`${r.ignored} ignorados`);
	if (opts.copyUntracked) parts.push(`${r.untracked} sin seguimiento`);
	const failed = r.failed ? `, ${r.failed} fallidos` : "";
	return ` (se copiaron ${parts.join(" + ")} archivo(s)${failed})`;
}

/** One-line summary of the resolved copy defaults (session/env, no per-call params). */
function describeCopyDefaults(): string {
	const r = resolveCopyPrefs({});
	return `copy-ignored ${r.copyIgnored ? "on" : "off"}, copy-untracked ${r.copyUntracked ? "on" : "off"}`;
}

/** `/worktree set [copy-ignored|copy-untracked] [on|off|status]` — manage the session copy default. */
function handleSet(ctx: ExtensionContext, parsed: ParsedCommand): void {
	if (parsed.error) {
		notify(ctx, parsed.error, "warning");
		return;
	}
	// No target, or an explicit `status`: just report the current resolution.
	if (!parsed.setTarget || parsed.setValue === "status") {
		notify(ctx, `Copias por defecto de worktrees: ${describeCopyDefaults()}.`, "info");
		return;
	}
	if (parsed.setValue === "invalid") {
		notify(ctx, `Uso: /worktree set ${parsed.setTarget} [on|off|status]`, "warning");
		return;
	}
	const key: CopyPrefKey = parsed.setTarget === "copy-ignored" ? "copyIgnored" : "copyUntracked";
	setSessionCopyDefault(key, parsed.setValue === "on");
	notify(
		ctx,
		`Se definió ${parsed.setTarget} ${parsed.setValue} para esta sesión: ${describeCopyDefaults()}.`,
		"info",
	);
}

async function handleAdd(ctx: ExtensionContext, parsed: ParsedCommand, signal?: AbortSignal): Promise<void> {
	if (parsed.error) {
		notify(ctx, parsed.error, "warning");
		return;
	}
	const target = resolveWorktreeTarget(parsed.path ?? "", ctx.cwd);
	if (!target) {
		notify(ctx, "Uso: /worktree add [-b <branch>] <path> [<commit-ish>]", "warning");
		return;
	}
	if (target.usedDefaultBase) ensureWorktreesBaseDir(ctx.cwd);
	const args = buildAddArgs({
		path: target.path,
		newBranch: parsed.newBranch,
		commitish: parsed.commitish,
		detach: parsed.detach,
		force: parsed.force,
	});
	const result = await runGit(args, { cwd: ctx.cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
	if (!result.ok) {
		notify(ctx, `No se pudo crear el worktree: ${gitError(result)}`, "error");
		return;
	}
	const copyOpts = resolveCopyPrefs({ copyIgnored: parsed.copyIgnored, copyUntracked: parsed.copyUntracked });
	const copyRes = await copyFilesToWorktree(ctx, target.path, copyOpts, signal);
	const branchNote = parsed.newBranch ? ` (rama nueva ${parsed.newBranch})` : "";
	const locationNote = target.usedDefaultBase ? ` (por defecto ${CONFIG_DIR_NAME}/worktrees/)` : "";
	notify(
		ctx,
		`Se creó el worktree en ${target.path}${branchNote}${locationNote}${copyNote(copyOpts, copyRes)}.`,
		"info",
	);
}

// --------------------------------------------------------------------------
// Open: create-if-missing a worktree and start a new Pi session in it
// --------------------------------------------------------------------------

// Supacode's CLI acks `tab new` over the controlling TTY (OSC). A child spawned
// without a TTY never gets that ack and the command times out — EVEN THOUGH the
// tab is created. So we generate the tab id ourselves (`tab new -n`) and confirm
// creation via `tab list` (a read that works over the socket), instead of
// trusting `tab new`'s exit code or stdout.
const SUPACODE_LIST_TIMEOUT_MS = 5_000;
const SUPACODE_VERIFY_TIMEOUT_MS = 5_000;
const SUPACODE_VERIFY_DELAY_MS = 350;

/** True when running inside a Supacode terminal (which can open a new tab). */
function isSupacode(): boolean {
	return process.env.TERM_PROGRAM === "supacode" || Boolean(process.env.SUPACODE_SOCKET_PATH);
}

/** POSIX single-quote a string so it is safe inside a shell command. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Run a `supacode` subcommand with an argv array (never a shell string). Never
 * rejects: spawn failure, non-zero exit, timeout, and abort all resolve to a
 * typed result. `spawnFailed` flags a missing/broken binary (child 'error') so
 * callers can tell it apart from the expected ack timeout of `tab new`.
 */
function runSupacode(
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; spawnFailed: boolean; error?: string }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn("supacode", args, { windowsHide: true });
		const finish = (result: { ok: boolean; stdout: string; spawnFailed: boolean; error?: string }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			resolve(result);
		};
		const onAbort = (): void => finish({ ok: false, stdout, spawnFailed: false, error: "abortado" });
		const timer = setTimeout(
			() => finish({ ok: false, stdout, spawnFailed: false, error: "supacode agotó el tiempo de espera" }),
			timeoutMs,
		);
		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort);
		}
		child.stdout?.on("data", (d) => {
			stdout += String(d);
		});
		child.stderr?.on("data", (d) => {
			stderr += String(d);
		});
		child.on("error", (err) => finish({ ok: false, stdout, spawnFailed: true, error: err.message }));
		child.on("close", (code) =>
			finish({
				ok: code === 0,
				stdout,
				spawnFailed: false,
				error: code === 0 ? undefined : stderr.trim() || `supacode salió con el código ${code}`,
			}),
		);
	});
}

/**
 * Open a new Pi session in a Supacode tab whose shell starts in `cwd`. The tab id
 * is generated here and passed via `tab new -n`, then confirmed with `tab list`,
 * so the result is correct even though `tab new` times out waiting for a TTY ack
 * it can never receive (the tab is still created). The only shell-evaluated text
 * is the `-i` input, where the path is single-quoted.
 */
async function openSupacodeTab(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; tabId?: string; error?: string }> {
	const tabId = randomUUID().toUpperCase();
	const input = `cd ${shellQuote(cwd)} && exec pi`;
	// Fire-and-forget: this call hangs ~10s on the missing ack, so we do not await
	// it. We keep the handle to detect a spawn failure and to kill the straggler
	// once the tab is confirmed.
	const create = spawn("supacode", ["tab", "new", "-n", tabId, "-i", input], { windowsHide: true });
	let spawnError: string | undefined;
	create.on("error", (err) => {
		spawnError = err.message;
	});
	create.stdout?.resume();
	create.stderr?.resume();
	try {
		const deadline = Date.now() + SUPACODE_VERIFY_TIMEOUT_MS;
		do {
			if (signal?.aborted) return { ok: false, error: "abortado" };
			if (spawnError) return { ok: false, error: spawnError };
			const list = await runSupacode(["tab", "list"], SUPACODE_LIST_TIMEOUT_MS, signal);
			if (list.spawnFailed) return { ok: false, error: list.error ?? "no se pudo ejecutar supacode" };
			if (list.ok && list.stdout.toUpperCase().includes(tabId)) return { ok: true, tabId };
			await delay(SUPACODE_VERIFY_DELAY_MS, signal);
		} while (Date.now() < deadline);
		return { ok: false, error: spawnError ?? "supacode no informó la nueva pestaña a tiempo" };
	} finally {
		try {
			create.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

interface OpenOptions {
	path?: string;
	newBranch?: string;
	commitish?: string;
	detach?: boolean;
	force?: boolean;
	copyIgnored?: boolean;
	copyUntracked?: boolean;
}

interface OpenOutcome {
	ok: boolean;
	path: string;
	created: boolean;
	opened: boolean;
	tabId?: string;
	message: string;
	isError?: boolean;
}

/**
 * Resolve a worktree target, create it when its directory does not exist yet,
 * then start a NEW Pi session in it (a new Supacode tab when available; otherwise
 * report the `cd <path> && pi` command). The current session's cwd never changes.
 * Shared by the /worktree open command and the git_worktree tool.
 */
async function openWorktree(ctx: ExtensionContext, opts: OpenOptions, signal?: AbortSignal): Promise<OpenOutcome> {
	const target = resolveWorktreeTarget(opts.path ?? "", ctx.cwd);
	if (!target) {
		return {
			ok: false,
			path: "",
			created: false,
			opened: false,
			isError: true,
			message: "La acción 'open' requiere 'path'.",
		};
	}
	if (opts.newBranch !== undefined && !isValidBranchName(opts.newBranch)) {
		return {
			ok: false,
			path: target.path,
			created: false,
			opened: false,
			isError: true,
			message: `Nombre de rama inválido "${opts.newBranch}" — sin espacios, caracteres de control ni puntos o barras iniciales/finales.`,
		};
	}
	let created = false;
	let copySuffix = "";
	if (!existsSync(target.path)) {
		if (target.usedDefaultBase) ensureWorktreesBaseDir(ctx.cwd);
		const args = buildAddArgs({
			path: target.path,
			newBranch: opts.newBranch,
			commitish: opts.commitish,
			detach: opts.detach,
			force: opts.force,
		});
		const result = await runGit(args, { cwd: ctx.cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
		if (!result.ok) {
			return {
				ok: false,
				path: target.path,
				created: false,
				opened: false,
				isError: true,
				message: `No se pudo crear el worktree: ${gitError(result)}`,
			};
		}
		created = true;
		const copyOpts = resolveCopyPrefs({ copyIgnored: opts.copyIgnored, copyUntracked: opts.copyUntracked });
		copySuffix = copyNote(copyOpts, await copyFilesToWorktree(ctx, target.path, copyOpts, signal));
	}
	const state = created ? "creado" : "listo";
	const openHint = `cd ${target.path} && pi`;
	if (!isSupacode()) {
		return {
			ok: true,
			path: target.path,
			created,
			opened: false,
			message: `Worktree ${state} en ${target.path}${copySuffix}. Abrilo con: ${openHint}`,
		};
	}
	const tab = await openSupacodeTab(target.path, signal);
	if (!tab.ok) {
		return {
			ok: true,
			path: target.path,
			created,
			opened: false,
			message: `Worktree ${state} en ${target.path}${copySuffix}, pero no se pudo abrir una pestaña de Supacode: ${tab.error}. Abrilo con: ${openHint}`,
		};
	}
	return {
		ok: true,
		path: target.path,
		created,
		opened: true,
		tabId: tab.tabId,
		message: `Se abrió Pi en una pestaña nueva de Supacode${tab.tabId ? ` (${tab.tabId})` : ""} en ${target.path}${created ? " (worktree nuevo)" : ""}${copySuffix}.`,
	};
}

async function handleOpen(ctx: ExtensionContext, parsed: ParsedCommand, signal?: AbortSignal): Promise<void> {
	if (parsed.error) {
		notify(ctx, parsed.error, "warning");
		return;
	}
	const outcome = await openWorktree(
		ctx,
		{
			path: parsed.path,
			newBranch: parsed.newBranch,
			commitish: parsed.commitish,
			detach: parsed.detach,
			force: parsed.force,
			copyIgnored: parsed.copyIgnored,
			copyUntracked: parsed.copyUntracked,
		},
		signal,
	);
	notify(ctx, outcome.message, outcome.isError ? "error" : "info");
}

async function handleRemove(ctx: ExtensionContext, parsed: ParsedCommand, signal?: AbortSignal): Promise<void> {
	if (parsed.error) {
		notify(ctx, parsed.error, "warning");
		return;
	}
	const target = resolveWorktreeTarget(parsed.path ?? "", ctx.cwd);
	if (!target) {
		notify(ctx, "Uso: /worktree remove [--force] <path>", "warning");
		return;
	}
	const resolved = target.path;

	// Confirm in interactive mode — removal deletes the worktree directory.
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm("¿Eliminar worktree?", `Esto eliminará el worktree en:\n${resolved}`);
		if (!ok) {
			notify(ctx, "Eliminación cancelada.", "info");
			return;
		}
	}

	let force = parsed.force ?? false;
	let result = await runGit(buildRemoveArgs(resolved, force), {
		cwd: ctx.cwd,
		signal,
		timeoutMs: GIT_TIMEOUT_MS,
	});

	// git refuses to remove a dirty/locked worktree without --force. Offer a
	// second, explicit confirmation rather than silently forcing.
	if (!result.ok && !force && ctx.hasUI && needsForce(result)) {
		const forceOk = await ctx.ui.confirm(
			"¿Forzar eliminación?",
			`El worktree tiene cambios sin confirmar o está bloqueado:\n${gitError(result)}\n\n¿Forzar la eliminación (descarta cambios)?`,
		);
		if (forceOk) {
			force = true;
			result = await runGit(buildRemoveArgs(resolved, true), {
				cwd: ctx.cwd,
				signal,
				timeoutMs: GIT_TIMEOUT_MS,
			});
		}
	}

	if (!result.ok) {
		notify(ctx, `No se pudo eliminar el worktree: ${gitError(result)}`, "error");
		return;
	}
	notify(ctx, `Se eliminó el worktree en ${resolved}${force ? " (forzado)" : ""}.`, "info");
}

async function handlePrune(ctx: ExtensionContext, parsed: ParsedCommand, signal?: AbortSignal): Promise<void> {
	// Always preview first.
	const preview = await runGit(buildPruneArgs(true), {
		cwd: ctx.cwd,
		signal,
		timeoutMs: GIT_TIMEOUT_MS,
	});
	if (!preview.ok) {
		notify(ctx, `No se pudieron limpiar los worktrees: ${gitError(preview)}`, "error");
		return;
	}
	const previewText = combinedOutput(preview);
	if (parsed.dryRun) {
		notify(ctx, previewText ? `Se limpiaría:\n${previewText}` : "No hay nada para limpiar.", "info");
		return;
	}
	if (!previewText) {
		notify(ctx, "No hay nada para limpiar.", "info");
		return;
	}
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			"¿Limpiar worktrees?",
			`Esto limpiará metadatos obsoletos de worktrees:\n${previewText}`,
		);
		if (!ok) {
			notify(ctx, "Limpieza cancelada.", "info");
			return;
		}
	}
	const result = await runGit(buildPruneArgs(false), {
		cwd: ctx.cwd,
		signal,
		timeoutMs: GIT_TIMEOUT_MS,
	});
	if (!result.ok) {
		notify(ctx, `No se pudieron limpiar los worktrees: ${gitError(result)}`, "error");
		return;
	}
	notify(ctx, "Se limpiaron los metadatos obsoletos de worktrees.", "info");
}

/** Resolve the action when `/worktree` is invoked without args in a TUI. */
async function resolveInteractiveAction(ctx: ExtensionContext): Promise<ParsedCommand | undefined> {
	const choice = await ctx.ui.select("Acción de worktree", [
		"list — listar worktrees",
		"add — crear un worktree",
		"remove — eliminar un worktree",
		"prune — limpiar metadatos obsoletos",
	]);
	if (!choice) return undefined;
	const action = choice.split(/\s+/)[0] as ParsedCommand["action"];
	if (action === "remove") {
		const listed = await listWorktrees(ctx);
		if (!listed.ok || listed.entries.length === 0) {
			notify(ctx, "No hay worktrees disponibles para eliminar.", "warning");
			return undefined;
		}
		// The main worktree (first entry) cannot be removed; offer the rest.
		const removable = listed.entries.slice(1);
		if (removable.length === 0) {
			notify(ctx, "Solo existe el worktree principal; no hay nada para eliminar.", "warning");
			return undefined;
		}
		const pick = await ctx.ui.select(
			"¿Qué worktree querés eliminar?",
			removable.map((e) => e.path),
		);
		if (!pick) return undefined;
		return { action: "remove", path: pick };
	}
	if (action === "add") {
		const pathArg = await ctx.ui.input?.("Ruta del worktree nuevo", "");
		if (!pathArg) {
			notify(ctx, "Se canceló la creación porque falta la ruta.", "info");
			return undefined;
		}
		const branch = await ctx.ui.input?.("Nombre de la rama nueva (opcional)", "");
		const newBranch = branch?.trim() || undefined;
		if (newBranch && !isValidBranchName(newBranch)) {
			notify(
				ctx,
				`Nombre de rama inválido "${newBranch}" — sin espacios, caracteres de control ni puntos o barras iniciales/finales.`,
				"warning",
			);
			return undefined;
		}
		return { action: "add", path: pathArg, newBranch };
	}
	return { action };
}

async function runCommand(ctx: ExtensionContext, args: string): Promise<void> {
	const signal = ctx.signal;
	const repo = await ensureGitRepo(ctx, signal);
	if (!repo.ok) {
		notify(ctx, repoError(repo, "/worktree"), "error");
		return;
	}

	let parsed = parseCommand(args);
	if (parsed.action === "help") {
		notify(ctx, parsed.error ? `${parsed.error}\n\n${HELP_TEXT}` : HELP_TEXT, parsed.error ? "warning" : "info");
		return;
	}

	// No args + interactive UI → menu-driven flow.
	if (args.trim() === "" && ctx.hasUI && typeof ctx.ui.select === "function") {
		const interactive = await resolveInteractiveAction(ctx);
		if (!interactive) return;
		parsed = interactive;
	}

	switch (parsed.action) {
		case "list":
			await handleList(ctx, signal);
			return;
		case "add":
			await handleAdd(ctx, parsed, signal);
			return;
		case "open":
			await handleOpen(ctx, parsed, signal);
			return;
		case "set":
			handleSet(ctx, parsed);
			return;
		case "remove":
			await handleRemove(ctx, parsed, signal);
			return;
		case "prune":
			await handlePrune(ctx, parsed, signal);
			return;
	}
}

// --------------------------------------------------------------------------
// Tool: git_worktree (model-callable)
// --------------------------------------------------------------------------

const SUBCOMMANDS = ["list", "add", "open", "remove", "prune", "set", "help"] as const;

export default function worktreeExtension(pi: ExtensionAPI): void {
	// Session-default copy toggles live in-memory; clear them at every session boundary
	// (mirrors pi-plan resetting its ultracode posture toggles on session_start).
	pi.on("session_start", () => {
		resetSessionCopyDefaults();
	});

	pi.registerCommand("worktree", {
		description: "Gestionar worktrees de git: list | add | open | remove | prune",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/);
			// Only complete the first token (the subcommand).
			if (tokens.length > 1) return null;
			const needle = (tokens[0] ?? "").toLowerCase();
			const items = SUBCOMMANDS.filter((sub) => sub.startsWith(needle));
			return items.length > 0 ? items.map((sub) => ({ value: sub, label: sub })) : null;
		},
		handler: async (args, ctx) => {
			await runCommand(ctx, args);
		},
	});

	pi.registerTool({
		name: "git_worktree",
		label: "Git Worktree",
		description:
			"Gestiona los worktrees de git en el repositorio actual. Acciones: 'list' (enumerar worktrees), 'add' (crear un worktree en un path, opcionalmente en una rama nueva), 'open' (crear el worktree si falta y luego iniciar una sesión NUEVA de Pi en él: una pestaña nueva de Supacode cuando se ejecuta bajo Supacode; si no, informa el comando cd+pi; el cwd de la sesión actual nunca cambia), 'remove' (eliminar un worktree; se niega a eliminar uno con cambios o bloqueado salvo que force=true), 'prune' (limpiar metadatos obsoletos de worktrees). git se invoca con un array argv, nunca con un shell.",
		promptSnippet: "Gestioná worktrees de git con las acciones list/add/open/remove/prune.",
		promptGuidelines: [
			"Usá git_worktree para inspeccionar o gestionar worktrees de git (list/add/open/remove/prune) en lugar de escribir a mano comandos bash con `git worktree`.",
			"Para add/open, pasá copyIgnored:true para copiar archivos gitignored (por ejemplo, node_modules) y/o copyUntracked:true para copiar archivos sin seguimiento desde el worktree principal al nuevo (solo cuando el worktree se crea en esa llamada). Cada uno es tri-state: true fuerza copiar, false fuerza omitir y, si se omite, cae al valor por defecto de la sesión (definido con el comando /worktree set) y luego a las env vars PI_WORKTREE_COPY_IGNORED / PI_WORKTREE_COPY_UNTRACKED; si no, queda off.",
			"git_worktree remove nunca elimina con force por defecto: pasá force=true solo cuando la persona usuaria acepta explícitamente descartar los cambios de un worktree con cambios.",
			"El cwd de Pi es fijo durante la sesión, así que git_worktree no puede cambiar la sesión actual a otro worktree: informá el path del worktree para que la persona usuaria pueda abrir una sesión nueva de Pi ahí.",
			"Usá la acción 'open' cuando la persona usuaria quiera empezar a trabajar en un worktree: crea el worktree si falta y abre una sesión NUEVA de Pi en él (una pestaña nueva de Supacode bajo Supacode; si no, devuelve el comando `cd <path> && pi`). No mueve la sesión actual.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "add", "open", "remove", "prune"] as const),
			path: Type.Optional(
				Type.String({
					description:
						"Ubicación del worktree (obligatoria para add/open/remove). Un nombre SIMPLE sin '/' (por ejemplo, \"feature\") se crea en <configDir>/worktrees/<name> (gitignored). Usá ./x, ../x, /abs o ~/x para ubicarlo de forma literal (relativo al cwd / home / absoluto).",
				}),
			),
			branch: Type.Optional(
				Type.String({
					description: "Para add: crear y hacer checkout de esta rama nueva (git worktree add -b).",
				}),
			),
			commitish: Type.Optional(
				Type.String({
					description: "Para add: commit/branch/tag sobre el que basar el worktree (punto de inicio).",
				}),
			),
			detach: Type.Optional(Type.Boolean({ description: "Para add: hacer checkout en modo detached HEAD." })),
			force: Type.Optional(
				Type.Boolean({
					description:
						"Para add: permitir una rama ya checkouteada en otro lugar. Para remove: descartar un worktree con cambios o bloqueado.",
				}),
			),
			dryRun: Type.Optional(
				Type.Boolean({
					description: "Para prune: solo informar qué se limpiaría sin borrar nada.",
				}),
			),
			copyIgnored: Type.Optional(
				Type.Boolean({
					description:
						"Para add/open: copiar archivos gitignored (por ejemplo, node_modules) desde el worktree principal al recién creado. Si se omite, cae al valor por defecto de la sesión / env var PI_WORKTREE_COPY_IGNORED (si no, off).",
				}),
			),
			copyUntracked: Type.Optional(
				Type.Boolean({
					description:
						"Para add/open: copiar archivos sin seguimiento desde el worktree principal al recién creado. Si se omite, cae al valor por defecto de la sesión / env var PI_WORKTREE_COPY_UNTRACKED (si no, off).",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const repo = await ensureGitRepo(ctx, signal ?? undefined);
			if (!repo.ok) {
				return {
					content: [{ type: "text" as const, text: repoError(repo, "git_worktree") }],
					details: { isError: true, action: params.action },
				};
			}

			const opts = { cwd: ctx.cwd, signal: signal ?? undefined, timeoutMs: GIT_TIMEOUT_MS };

			if (params.action === "list") {
				const result = await runGit(buildListArgs(), opts);
				if (!result.ok) {
					return {
						content: [
							{ type: "text" as const, text: `No se pudieron listar los worktrees: ${gitError(result)}` },
						],
						details: { isError: true, action: "list" },
					};
				}
				const entries = parseWorktreeList(result.stdout);
				const text = entries.length
					? entries.map((e) => describeWorktree(e)).join("\n")
					: "No se encontraron worktrees.";
				return {
					content: [{ type: "text" as const, text }],
					details: { action: "list", count: entries.length, worktrees: entries },
				};
			}

			if (params.action === "prune") {
				const dryRun = params.dryRun ?? false;
				const result = await runGit(buildPruneArgs(dryRun), opts);
				if (!result.ok) {
					return {
						content: [
							{ type: "text" as const, text: `No se pudieron limpiar los worktrees: ${gitError(result)}` },
						],
						details: { isError: true, action: "prune" },
					};
				}
				const out = combinedOutput(result);
				const text = dryRun
					? out
						? `Se limpiaría:\n${out}`
						: "No hay nada para limpiar."
					: "Se limpiaron los metadatos obsoletos de worktrees.";
				return {
					content: [{ type: "text" as const, text }],
					details: { action: "prune", dryRun, output: out },
				};
			}

			if (params.action === "add") {
				const target = resolveWorktreeTarget(params.path ?? "", ctx.cwd);
				if (!target) {
					return {
						content: [{ type: "text" as const, text: "La acción 'add' requiere 'path'." }],
						details: { isError: true, action: "add" },
					};
				}
				if (params.branch !== undefined && !isValidBranchName(params.branch)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Nombre de rama inválido "${params.branch}" — sin espacios, caracteres de control ni puntos o barras iniciales/finales.`,
							},
						],
						details: { isError: true, action: "add" },
					};
				}
				if (target.usedDefaultBase) ensureWorktreesBaseDir(ctx.cwd);
				const args = buildAddArgs({
					path: target.path,
					newBranch: params.branch,
					commitish: params.commitish,
					detach: params.detach,
					force: params.force,
				});
				const result = await runGit(args, opts);
				if (!result.ok) {
					return {
						content: [{ type: "text" as const, text: `No se pudo crear el worktree: ${gitError(result)}` }],
						details: { isError: true, action: "add", path: target.path },
					};
				}
				const copyOpts = resolveCopyPrefs({ copyIgnored: params.copyIgnored, copyUntracked: params.copyUntracked });
				const copyRes = await copyFilesToWorktree(ctx, target.path, copyOpts, signal ?? undefined);
				const branchNote = params.branch ? ` (rama nueva ${params.branch})` : "";
				const locationNote = target.usedDefaultBase ? ` (por defecto ${CONFIG_DIR_NAME}/worktrees/)` : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `Se creó el worktree en ${target.path}${branchNote}${locationNote}${copyNote(copyOpts, copyRes)}. Abrilo con: cd ${target.path} && pi`,
						},
					],
					details: {
						action: "add",
						path: target.path,
						branch: params.branch ?? null,
						defaultBase: target.usedDefaultBase,
						copied: copyRes,
					},
				};
			}

			if (params.action === "open") {
				const outcome = await openWorktree(
					ctx,
					{
						path: params.path,
						newBranch: params.branch,
						commitish: params.commitish,
						detach: params.detach,
						force: params.force,
						copyIgnored: params.copyIgnored,
						copyUntracked: params.copyUntracked,
					},
					signal ?? undefined,
				);
				return {
					content: [{ type: "text" as const, text: outcome.message }],
					details: outcome.isError
						? { isError: true, action: "open", path: outcome.path || null }
						: {
								action: "open",
								path: outcome.path,
								created: outcome.created,
								opened: outcome.opened,
								tabId: outcome.tabId ?? null,
							},
				};
			}

			// remove
			const target = resolveWorktreeTarget(params.path ?? "", ctx.cwd);
			if (!target) {
				return {
					content: [{ type: "text" as const, text: "La acción 'remove' requiere 'path'." }],
					details: { isError: true, action: "remove" },
				};
			}
			const resolved = target.path;
			const force = params.force ?? false;
			const result = await runGit(buildRemoveArgs(resolved, force), opts);
			if (!result.ok) {
				const hint =
					!force && needsForce(result)
						? " El worktree tiene cambios o está bloqueado; reintentá con force=true solo si la persona usuaria acepta descartar cambios."
						: "";
				return {
					content: [
						{
							type: "text" as const,
							text: `No se pudo eliminar el worktree: ${gitError(result)}.${hint}`,
						},
					],
					details: { isError: true, action: "remove", path: resolved },
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Se eliminó el worktree en ${resolved}${force ? " (forzado)" : ""}.`,
					},
				],
				details: { action: "remove", path: resolved, forced: force },
			};
		},
	});
}
