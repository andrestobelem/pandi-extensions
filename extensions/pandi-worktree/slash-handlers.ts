/**
 * Manejadores del slash command `/worktree`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ParsedCommand, parseCommand } from "./command.js";
import { HELP_TEXT, WORKTREE_ARGUMENT_COMPLETIONS, WORKTREE_SELECT_ITEMS } from "./constants.js";
import { type CopyPrefKey, resolveCopyPrefs, setSessionCopyDefault } from "./copy-prefs.js";
import {
	combinedOutput,
	ensureGitRepo,
	gitError,
	listWorktrees,
	needsForce,
	notify,
	repoError,
} from "./git-context.js";
import { openWorktree } from "./open-worktree.js";
import { registerGitWorktreeTool } from "./tool-handlers.js";
import {
	buildPruneArgs,
	buildRemoveArgs,
	describeWorktree,
	DEFAULT_GIT_TIMEOUT_MS as GIT_TIMEOUT_MS,
	isValidBranchName,
	resolveWorktreeTarget,
	runGit,
} from "./worktree.js";
import { addWorktree } from "./worktree-actions.js";
import {
	ensureWorktreeWriterForCommand,
	formatWorktreeWriterBlock,
	isWorktreeWriterGuardEnabled,
	setWorktreeWriterGuardEnabled,
} from "./writer-guard.js";

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

/** Resumen de una línea de los copy-defaults resueltos (sesión/env, sin params por llamada). */
function describeCopyDefaults(): string {
	const r = resolveCopyPrefs({});
	return `copy-ignored ${r.copyIgnored ? "on" : "off"}, copy-untracked ${r.copyUntracked ? "on" : "off"}`;
}

function describeWriterGuardDefault(): string {
	return `writer-guard ${isWorktreeWriterGuardEnabled() ? "on" : "off"}`;
}

/** `/worktree set [copy-ignored|copy-untracked|writer-guard] [on|off|status]` — gestiona preferencias de la sesión. */
async function handleSet(ctx: ExtensionContext, parsed: ParsedCommand): Promise<void> {
	if (parsed.error) {
		notify(ctx, parsed.error, "warning");
		return;
	}
	// Sin target, o con `status` explícito: solo informar la resolución actual.
	if (!parsed.setTarget || parsed.setValue === "status") {
		notify(ctx, `Preferencias de worktrees: ${describeCopyDefaults()}, ${describeWriterGuardDefault()}.`, "info");
		return;
	}
	if (parsed.setValue === "invalid") {
		notify(ctx, `Uso: /worktree set ${parsed.setTarget} [on|off|status]`, "warning");
		return;
	}
	if (parsed.setTarget === "writer-guard") {
		await setWorktreeWriterGuardEnabled(parsed.setValue === "on");
		notify(ctx, `Se definió writer-guard ${parsed.setValue} para esta sesión.`, "info");
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
	// Uso slash-específico cuando falta path; el núcleo addWorktree habla en términos de tool.
	if (!parsed.path?.trim()) {
		notify(ctx, "Uso: /worktree add [-b <branch>] <path> [<commit-ish>]", "warning");
		return;
	}
	const outcome = await addWorktree(
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

	// Confirmar en modo interactivo: la eliminación borra el directorio del worktree.
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

	// git se niega a eliminar un worktree sucio/bloqueado sin --force. Ofrecé una
	// segunda confirmación explícita en vez de forzarlo en silencio.
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
	// Siempre previsualizá primero.
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

/** Resuelve la acción cuando `/worktree` se invoca sin args en una TUI. */
async function resolveInteractiveAction(ctx: ExtensionContext): Promise<ParsedCommand | undefined> {
	const choice = await ctx.ui.select("Acción de worktree", WORKTREE_SELECT_ITEMS);
	if (!choice) return undefined;
	const action = choice.split(/\s+/)[0] as ParsedCommand["action"];
	if (action === "remove") {
		const listed = await listWorktrees(ctx);
		if (!listed.ok || listed.entries.length === 0) {
			notify(ctx, "No hay worktrees disponibles para eliminar.", "warning");
			return undefined;
		}
		// El worktree principal (primera entrada) no puede eliminarse; ofrecé el resto.
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

export async function runWorktreeCommand(ctx: ExtensionContext, args: string): Promise<void> {
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

	// Sin args + UI interactiva → flujo guiado por menú.
	if (args.trim() === "" && ctx.hasUI && typeof ctx.ui.select === "function") {
		const interactive = await resolveInteractiveAction(ctx);
		if (!interactive) return;
		parsed = interactive;
	}

	const writer = await ensureWorktreeWriterForCommand(ctx, {
		action: parsed.action,
		command: `/worktree ${args}`.trim(),
		dryRun: parsed.action === "prune" ? parsed.dryRun : undefined,
	});
	if (!writer.allowed) {
		notify(ctx, formatWorktreeWriterBlock(writer.reason), "warning");
		return;
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
			await handleSet(ctx, parsed);
			return;
		case "remove":
			await handleRemove(ctx, parsed, signal);
			return;
		case "prune":
			await handlePrune(ctx, parsed, signal);
			return;
	}
}

export function registerWorktreeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("worktree", {
		description: "Gestionar worktrees de git: list | add | open | remove | prune",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/);
			if (tokens.length > 1) return null;
			const needle = (tokens[0] ?? "").toLowerCase();
			const items = WORKTREE_ARGUMENT_COMPLETIONS.filter((item) => item.value.startsWith(needle));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			await runWorktreeCommand(ctx, args);
		},
	});
	registerGitWorktreeTool(pi);
}
