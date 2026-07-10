/**
 * Acciones compartidas de worktree (add + copy post-create).
 *
 * Las usan el slash `/worktree` y la tool `git_worktree` para no driftar el
 * pipeline create → copy. open (create-si-falta) reutiliza `addWorktree` para
 * la mitad de creación. Confirmaciones UI y presentación slash-vs-tool quedan
 * en index.ts.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCopyPrefs } from "./copy-prefs.js";
import { gitError } from "./git-context.js";
import {
	buildAddArgs,
	buildListIgnoredArgs,
	buildListUntrackedArgs,
	ensureWorktreesBaseDir,
	filterCopyableEntries,
	DEFAULT_GIT_TIMEOUT_MS as GIT_TIMEOUT_MS,
	isValidBranchName,
	parseLsFilesEntries,
	resolveWorktreeTarget,
	runGit,
} from "./worktree.js";

export interface CopyFilesOptions {
	copyIgnored?: boolean;
	copyUntracked?: boolean;
}

export interface CopyFilesResult {
	ignored: number;
	untracked: number;
	failed: number;
}

export interface AddOptions {
	path?: string;
	newBranch?: string;
	commitish?: string;
	detach?: boolean;
	force?: boolean;
	copyIgnored?: boolean;
	copyUntracked?: boolean;
}

export interface AddOutcome {
	ok: boolean;
	path: string;
	usedDefaultBase: boolean;
	branch?: string;
	copied: CopyFilesResult;
	/** Sufijo " (se copiaron …)" o "" — útil para open que arma su propio mensaje. */
	copySuffix: string;
	message: string;
	isError?: boolean;
}

/**
 * Después de crear un worktree NUEVO, copia opcionalmente archivos gitignored
 * y/o untracked desde el worktree principal (ctx.cwd) hacia él. Es de mejor
 * esfuerzo y abortable: la enumeración pasa por runGit (argv, nunca shell); la copia usa
 * fs.cp con verbatimSymlinks para que sobrevivan los symlinks (p. ej.
 * node_modules/.bin). El dir base de worktrees y .git siempre se excluyen
 * (filterCopyableEntries) para evitar una copia recursiva de otros worktrees.
 * Nunca lanza hacia quien llama.
 */
export async function copyFilesToWorktree(
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

/** Sufijo corto " (se copiaron N ignorados + M sin seguimiento archivo(s))"; "" cuando no se pidió nada. */
export function copyNote(opts: CopyFilesOptions, r: CopyFilesResult): string {
	if (!opts.copyIgnored && !opts.copyUntracked) return "";
	const parts: string[] = [];
	if (opts.copyIgnored) parts.push(`${r.ignored} ignorados`);
	if (opts.copyUntracked) parts.push(`${r.untracked} sin seguimiento`);
	const failed = r.failed ? `, ${r.failed} fallidos` : "";
	return ` (se copiaron ${parts.join(" + ")} archivo(s)${failed})`;
}

/**
 * Crea un worktree (git worktree add + copy opcional). Compartido por slash,
 * tool y la rama create-si-falta de open.
 */
export async function addWorktree(ctx: ExtensionContext, opts: AddOptions, signal?: AbortSignal): Promise<AddOutcome> {
	const emptyCopied: CopyFilesResult = { ignored: 0, untracked: 0, failed: 0 };
	const target = resolveWorktreeTarget(opts.path ?? "", ctx.cwd);
	if (!target) {
		return {
			ok: false,
			path: "",
			usedDefaultBase: false,
			copied: emptyCopied,
			copySuffix: "",
			isError: true,
			message: "La acción 'add' requiere 'path'.",
		};
	}
	if (opts.newBranch !== undefined && !isValidBranchName(opts.newBranch)) {
		return {
			ok: false,
			path: target.path,
			usedDefaultBase: target.usedDefaultBase,
			copied: emptyCopied,
			copySuffix: "",
			isError: true,
			message: `Nombre de rama inválido "${opts.newBranch}" — sin espacios, caracteres de control ni puntos o barras iniciales/finales.`,
		};
	}
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
			usedDefaultBase: target.usedDefaultBase,
			copied: emptyCopied,
			copySuffix: "",
			isError: true,
			message: `No se pudo crear el worktree: ${gitError(result)}`,
		};
	}
	const copyOpts = resolveCopyPrefs({ copyIgnored: opts.copyIgnored, copyUntracked: opts.copyUntracked });
	const copied = await copyFilesToWorktree(ctx, target.path, copyOpts, signal);
	const suffix = copyNote(copyOpts, copied);
	const branchNote = opts.newBranch ? ` (rama nueva ${opts.newBranch})` : "";
	const locationNote = target.usedDefaultBase ? ` (por defecto ${CONFIG_DIR_NAME}/worktrees/)` : "";
	return {
		ok: true,
		path: target.path,
		usedDefaultBase: target.usedDefaultBase,
		branch: opts.newBranch,
		copied,
		copySuffix: suffix,
		message: `Se creó el worktree en ${target.path}${branchNote}${locationNote}${suffix}.`,
	};
}
