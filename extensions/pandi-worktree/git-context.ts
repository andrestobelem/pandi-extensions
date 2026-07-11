/**
 * Puente entre UI + git-context de pandi-worktree: notificación a la persona usuaria
 * y helpers chicos que detectan un repo git utilizable, clasifican fallos de git y
 * listan worktrees. Se mantiene junto a los helpers puros de ./worktree.ts (que
 * construyen argv + parsean salida); este módulo agrega la superficie consciente de
 * ExtensionContext que index.ts conecta al comando/herramienta.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildListArgs,
	DEFAULT_GIT_TIMEOUT_MS as GIT_TIMEOUT_MS,
	type GitResult,
	parseWorktreeList,
	runGit,
	type WorktreeEntry,
} from "./worktree.js";

export function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		// stdout lleva salida legible por máquina en modo print; mantené warnings/errors en stderr.
		(type === "info" ? console.log : console.error)(message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	// Sin UI: mostrà los problemas en stderr en vez de descartarlos en silencio.
	if (type !== "info") console.error(message);
}

export function outputTruncationDetails(result: GitResult): Record<string, true> {
	return {
		...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
		...(result.stderrTruncated ? { stderrTruncated: true } : {}),
	};
}

export function describeOutputTruncation(result: GitResult): string | undefined {
	const streams = [
		result.stdoutTruncated ? "stdout" : undefined,
		result.stderrTruncated ? "stderr" : undefined,
	].filter((stream): stream is string => Boolean(stream));
	return streams.length ? `La salida de ${streams.join(" y ")} fue truncada al límite de captura.` : undefined;
}

/** Un motivo corto, de una sola línea, para una invocación fallida de git. */
export function gitError(result: GitResult): string {
	const truncation = describeOutputTruncation(result);
	const withTruncation = (message: string): string => (truncation ? `${message}. ${truncation}` : message);
	if (result.spawnError) return withTruncation(`No se pudo iniciar git: ${result.spawnError}`);
	if (result.timedOut) return withTruncation("git agotó el tiempo de espera");
	if (result.aborted) return withTruncation("git fue abortado");
	if (result.signal) return withTruncation(`git terminó por señal ${result.signal}`);
	const reason = (result.stderr || result.stdout).trim().split("\n")[0];
	return withTruncation(reason || `git salió con el código ${result.exitCode}`);
}

type GitOutputStream = "stdout" | "stderr";

function combineGitOutput(
	result: GitResult,
	first: GitOutputStream,
	second: GitOutputStream,
	options: { trim?: boolean } = {},
): string {
	const text = `${result[first]}\n${result[second]}`;
	return options.trim === false ? text : text.trim();
}

/** stdout+stderr combinados (git worktree prune informa por stderr). */
export function combinedOutput(result: GitResult): string {
	const output = combineGitOutput(result, "stdout", "stderr");
	const truncation = describeOutputTruncation(result);
	return truncation ? `${output}${output ? "\n\n" : ""}Advertencia: ${truncation}` : output;
}

/**
 * Chequeo independiente del locale para el rechazo de git que "necesita --force"
 * (worktree sucio o bloqueado). git siempre emite el flag literal `--force` sin
 * importar el idioma.
 */
export function needsForce(result: GitResult): boolean {
	return combineGitOutput(result, "stderr", "stdout", { trim: false }).includes("--force");
}

/**
 * Detecta un contexto git utilizable (work tree O bare repo) y devuelve el
 * GitResult crudo para que quien llama distinga "no es un repo" de
 * git-ausente/timeout. `rev-parse --git-dir` sale con 0 dentro de un work tree
 * Y dentro de un bare repo, donde worktree add/list/remove/prune sigue
 * funcionando.
 */
export async function ensureGitRepo(ctx: ExtensionContext, signal?: AbortSignal): Promise<GitResult> {
	const result = await runGit(["rev-parse", "--git-dir"], { cwd: ctx.cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
	return describeOutputTruncation(result) ? { ...result, ok: false } : result;
}

/** Diagnóstico para un chequeo fallido del repo: distingue git-ausente/timeout de "no repo". */
export function repoError(result: GitResult, surface: string): string {
	if (result.spawnError || result.timedOut || result.aborted || result.signal || describeOutputTruncation(result))
		return gitError(result);
	return `No estás dentro de un repositorio git — ${surface} necesita un repositorio git.`;
}

export async function listWorktrees(
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<{ ok: true; entries: WorktreeEntry[] } | { ok: false; error: string }> {
	const result = await runGit(buildListArgs(), { cwd: ctx.cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
	if (!result.ok) return { ok: false, error: gitError(result) };
	const truncation = describeOutputTruncation(result);
	if (truncation) return { ok: false, error: truncation };
	return { ok: true, entries: parseWorktreeList(result.stdout) };
}
