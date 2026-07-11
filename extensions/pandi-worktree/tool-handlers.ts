/**
 * Herramienta git_worktree (invocable por el modelo).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_ACTIONS } from "./constants.js";
import {
	combinedOutput,
	describeOutputTruncation,
	ensureGitRepo,
	gitError,
	needsForce,
	outputTruncationDetails,
	repoError,
} from "./git-context.js";
import { openWorktree } from "./open-worktree.js";
import {
	buildListArgs,
	buildPruneArgs,
	buildRemoveArgs,
	describeWorktree,
	DEFAULT_GIT_TIMEOUT_MS as GIT_TIMEOUT_MS,
	parseWorktreeList,
	resolveWorktreeTarget,
	runGit,
} from "./worktree.js";
import { addWorktree } from "./worktree-actions.js";

function toolResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function toolError(text: string, details: Record<string, unknown> = {}) {
	return toolResult(text, { isError: true, ...details });
}

export function registerGitWorktreeTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "git_worktree",
		label: "Worktree de Git",
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
			action: StringEnum(TOOL_ACTIONS),
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
			return executeGitWorktree(ctx, params, signal ?? undefined);
		},
	});
}

type GitWorktreeParams = {
	action: (typeof TOOL_ACTIONS)[number];
	path?: string;
	branch?: string;
	commitish?: string;
	detach?: boolean;
	force?: boolean;
	dryRun?: boolean;
	copyIgnored?: boolean;
	copyUntracked?: boolean;
};

export async function executeGitWorktree(ctx: ExtensionContext, params: GitWorktreeParams, signal?: AbortSignal) {
	const repo = await ensureGitRepo(ctx, signal);
	if (!repo.ok) {
		return toolError(repoError(repo, "git_worktree"), { action: params.action });
	}

	const opts = { cwd: ctx.cwd, signal, timeoutMs: GIT_TIMEOUT_MS };

	if (params.action === "list") {
		const result = await runGit(buildListArgs(), opts);
		if (!result.ok) {
			return toolError(`No se pudieron listar los worktrees: ${gitError(result)}`, {
				action: "list",
				...outputTruncationDetails(result),
			});
		}
		const truncation = describeOutputTruncation(result);
		if (truncation) {
			return toolError(`No se pudieron listar los worktrees: ${truncation}`, {
				action: "list",
				...outputTruncationDetails(result),
			});
		}
		const entries = parseWorktreeList(result.stdout);
		const text = entries.length ? entries.map((e) => describeWorktree(e)).join("\n") : "No se encontraron worktrees.";
		return toolResult(text, { action: "list", count: entries.length, worktrees: entries });
	}

	if (params.action === "prune") {
		const dryRun = params.dryRun ?? false;
		const result = await runGit(buildPruneArgs(dryRun), opts);
		if (!result.ok) {
			return toolError(`No se pudieron limpiar los worktrees: ${gitError(result)}`, { action: "prune" });
		}
		const out = combinedOutput(result);
		const text = dryRun
			? out
				? `Se limpiaría:\n${out}`
				: "No hay nada para limpiar."
			: "Se limpiaron los metadatos obsoletos de worktrees.";
		return toolResult(text, { action: "prune", dryRun, output: out });
	}

	if (params.action === "add") {
		const outcome = await addWorktree(
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
			signal,
		);
		if (!outcome.ok) {
			return toolError(outcome.message, {
				action: "add",
				...(outcome.path ? { path: outcome.path } : {}),
			});
		}
		return toolResult(`${outcome.message} Abrilo con: cd ${outcome.path} && pi`, {
			action: "add",
			path: outcome.path,
			branch: outcome.branch ?? null,
			defaultBase: outcome.usedDefaultBase,
			copied: outcome.copied,
		});
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
			signal,
		);
		return toolResult(
			outcome.message,
			outcome.isError
				? { isError: true, action: "open", path: outcome.path || null }
				: {
						action: "open",
						path: outcome.path,
						created: outcome.created,
						opened: outcome.opened,
						tabId: outcome.tabId ?? null,
					},
		);
	}

	// remove
	const target = resolveWorktreeTarget(params.path ?? "", ctx.cwd);
	if (!target) {
		return toolError("La acción 'remove' requiere 'path'.", { action: "remove" });
	}
	const resolved = target.path;
	const force = params.force ?? false;
	const result = await runGit(buildRemoveArgs(resolved, force), opts);
	if (!result.ok) {
		const hint =
			!force && needsForce(result)
				? " El worktree tiene cambios o está bloqueado; reintentá con force=true solo si la persona usuaria acepta descartar cambios."
				: "";
		return toolError(`No se pudo eliminar el worktree: ${gitError(result)}.${hint}`, {
			action: "remove",
			path: resolved,
		});
	}
	return toolResult(`Se eliminó el worktree en ${resolved}${force ? " (forzado)" : ""}.`, {
		action: "remove",
		path: resolved,
		forced: force,
	});
}
