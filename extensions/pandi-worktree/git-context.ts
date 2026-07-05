/**
 * pi-worktree UI + git-context glue: user notification and the small helpers that
 * detect a usable git repo, classify git failures, and list worktrees. Kept next to
 * the pure ./worktree.ts helpers (which build argv + parse output); this module adds
 * the ExtensionContext-aware surface that index.ts wires into the command/tool.
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
		// stdout carries machine-readable output in print mode; keep warnings/errors on stderr.
		(type === "info" ? console.log : console.error)(message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	// Headless without UI: surface problems on stderr instead of silently dropping them.
	if (type !== "info") console.error(message);
}

/** A short, single-line reason from a failed git invocation. */
export function gitError(result: GitResult): string {
	if (result.spawnError) return `No se pudo iniciar git: ${result.spawnError}`;
	if (result.timedOut) return "git agotó el tiempo de espera";
	const reason = (result.stderr || result.stdout).trim().split("\n")[0];
	return reason || `git salió con el código ${result.exitCode}`;
}

/** Combined stdout+stderr (git worktree prune reports to stderr). */
export function combinedOutput(result: GitResult): string {
	return `${result.stdout}\n${result.stderr}`.trim();
}

/**
 * Locale-independent check for git's "needs --force" refusal (dirty or locked
 * worktree). git always emits the literal `--force` flag regardless of language.
 */
export function needsForce(result: GitResult): boolean {
	return `${result.stderr}\n${result.stdout}`.includes("--force");
}

/**
 * Detect a usable git context (work tree OR bare repo) and return the raw
 * GitResult so callers can tell "not a repo" apart from git-missing/timeout.
 * `rev-parse --git-dir` exits 0 inside a work tree AND inside a bare repo, where
 * worktree add/list/remove/prune still work.
 */
export async function ensureGitRepo(ctx: ExtensionContext, signal?: AbortSignal): Promise<GitResult> {
	return runGit(["rev-parse", "--git-dir"], { cwd: ctx.cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
}

/** Diagnostic for a failed repo check: distinguish git-missing/timeout from "no repo". */
export function repoError(result: GitResult, surface: string): string {
	if (result.spawnError || result.timedOut) return gitError(result);
	return `No estás dentro de un repositorio git — ${surface} necesita un repositorio git.`;
}

export async function listWorktrees(
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<{ ok: true; entries: WorktreeEntry[] } | { ok: false; error: string }> {
	const result = await runGit(buildListArgs(), { cwd: ctx.cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
	if (!result.ok) return { ok: false, error: gitError(result) };
	return { ok: true, entries: parseWorktreeList(result.stdout) };
}
