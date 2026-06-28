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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	buildAddArgs,
	buildListArgs,
	buildPruneArgs,
	buildRemoveArgs,
	describeWorktree,
	isValidBranchName,
	parseWorktreeList,
	resolveWorktreeTarget,
	ensureWorktreesBaseDir,
	runGit,
	type GitResult,
	type WorktreeEntry,
} from "./worktree.js";

// Re-exported for the integration suite to unit-test the pure helpers directly
// against the same bundle. Internal use still goes through the import above
// (an `export … from` re-export creates no local binding, so there is no clash).
export { buildAddArgs, parseWorktreeList, isValidBranchName, describeWorktree } from "./worktree.js";

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
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

const GIT_TIMEOUT_MS = 30_000;

/** A short, single-line reason from a failed git invocation. */
function gitError(result: GitResult): string {
	if (result.spawnError) return `git could not be started: ${result.spawnError}`;
	if (result.timedOut) return "git timed out";
	const reason = (result.stderr || result.stdout).trim().split("\n")[0];
	return reason || `git exited with code ${result.exitCode}`;
}

/** Combined stdout+stderr (git worktree prune reports to stderr). */
function combinedOutput(result: GitResult): string {
	return `${result.stdout}\n${result.stderr}`.trim();
}

/**
 * Locale-independent check for git's "needs --force" refusal (dirty or locked
 * worktree). git always emits the literal `--force` flag regardless of language.
 */
function needsForce(result: GitResult): boolean {
	return `${result.stderr}\n${result.stdout}`.includes("--force");
}

/**
 * Detect a usable git context (work tree OR bare repo) and return the raw
 * GitResult so callers can tell "not a repo" apart from git-missing/timeout.
 * `rev-parse --git-dir` exits 0 inside a work tree AND inside a bare repo, where
 * worktree add/list/remove/prune still work.
 */
async function ensureGitRepo(ctx: ExtensionContext, signal?: AbortSignal): Promise<GitResult> {
	return runGit(["rev-parse", "--git-dir"], { cwd: ctx.cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
}

/** Diagnostic for a failed repo check: distinguish git-missing/timeout from "no repo". */
function repoError(result: GitResult, surface: string): string {
	if (result.spawnError || result.timedOut) return gitError(result);
	return `Not inside a git repository — ${surface} needs a git repo.`;
}

async function listWorktrees(
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<{ ok: true; entries: WorktreeEntry[] } | { ok: false; error: string }> {
	const result = await runGit(buildListArgs(), { cwd: ctx.cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
	if (!result.ok) return { ok: false, error: gitError(result) };
	return { ok: true, entries: parseWorktreeList(result.stdout) };
}

// --------------------------------------------------------------------------
// Command argument parsing
// --------------------------------------------------------------------------

interface ParsedCommand {
	action: "list" | "add" | "remove" | "prune" | "help";
	path?: string;
	newBranch?: string;
	commitish?: string;
	force?: boolean;
	detach?: boolean;
	dryRun?: boolean;
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

	if (head === "add") {
		const rest = tokens.slice(1);
		const positionals: string[] = [];
		let newBranch: string | undefined;
		let force = false;
		let detach = false;
		for (let i = 0; i < rest.length; i++) {
			const tok = rest[i];
			if (tok === "-b" || tok === "--branch") {
				newBranch = rest[++i];
			} else if (tok === "--force" || tok === "-f") {
				force = true;
			} else if (tok === "--detach" || tok === "-d") {
				detach = true;
			} else {
				positionals.push(tok);
			}
		}
		const [pathArg, commitish] = positionals;
		if (!pathArg) return { action: "add", error: "Usage: /worktree add [-b <branch>] <path> [<commit-ish>]" };
		if (newBranch !== undefined && !isValidBranchName(newBranch)) {
			return { action: "add", error: `Invalid branch name: "${newBranch ?? ""}"` };
		}
		return { action: "add", path: pathArg, newBranch, commitish, force, detach };
	}

	if (head === "remove" || head === "rm") {
		const rest = tokens.slice(1);
		const force = rest.some((t) => t === "--force" || t === "-f");
		const pathArg = rest.find((t) => t !== "--force" && t !== "-f");
		if (!pathArg) return { action: "remove", error: "Usage: /worktree remove [--force] <path>" };
		return { action: "remove", path: pathArg, force };
	}

	return { action: "help", error: `Unknown subcommand: "${tokens[0]}"` };
}

const HELP_TEXT = [
	"Usage:",
	"  /worktree [list]                       list worktrees",
	"  /worktree add [-b <branch>] [--detach] [--force] <path> [<commit-ish>]   add a worktree",
	"  /worktree remove [--force] <path>      remove a worktree",
	"  /worktree prune [--dry-run]            prune stale worktree metadata",
	"",
	"A bare <name> (no slash) is created under .pi/worktrees/<name> (gitignored).",
	"Use ./x, ../x, /abs, or ~/x for an explicit location.",
].join("\n");

// --------------------------------------------------------------------------
// Command handlers
// --------------------------------------------------------------------------

async function handleList(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	const listed = await listWorktrees(ctx, signal);
	if (!listed.ok) {
		notify(ctx, `Could not list worktrees: ${listed.error}`, "error");
		return;
	}
	if (listed.entries.length === 0) {
		notify(ctx, "No worktrees found.", "info");
		return;
	}
	const lines = listed.entries.map((entry) => `  • ${describeWorktree(entry)}`);
	notify(ctx, `Worktrees (${listed.entries.length}):\n${lines.join("\n")}`, "info");
}

async function handleAdd(ctx: ExtensionContext, parsed: ParsedCommand, signal?: AbortSignal): Promise<void> {
	if (parsed.error) {
		notify(ctx, parsed.error, "warning");
		return;
	}
	const target = resolveWorktreeTarget(parsed.path ?? "", ctx.cwd);
	if (!target) {
		notify(ctx, "Usage: /worktree add [-b <branch>] <path> [<commit-ish>]", "warning");
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
		notify(ctx, `Could not add worktree: ${gitError(result)}`, "error");
		return;
	}
	const branchNote = parsed.newBranch ? ` (new branch ${parsed.newBranch})` : "";
	const locationNote = target.usedDefaultBase ? " (default .pi/worktrees/)" : "";
	notify(ctx, `Added worktree at ${target.path}${branchNote}${locationNote}.`, "info");
}

async function handleRemove(ctx: ExtensionContext, parsed: ParsedCommand, signal?: AbortSignal): Promise<void> {
	if (parsed.error) {
		notify(ctx, parsed.error, "warning");
		return;
	}
	const target = resolveWorktreeTarget(parsed.path ?? "", ctx.cwd);
	if (!target) {
		notify(ctx, "Usage: /worktree remove [--force] <path>", "warning");
		return;
	}
	const resolved = target.path;

	// Confirm in interactive mode — removal deletes the worktree directory.
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm("Remove worktree?", `This will remove the worktree at:\n${resolved}`);
		if (!ok) {
			notify(ctx, "Removal cancelled.", "info");
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
			"Force remove?",
			`The worktree is dirty or locked:\n${gitError(result)}\n\nForce removal (discards changes)?`,
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
		notify(ctx, `Could not remove worktree: ${gitError(result)}`, "error");
		return;
	}
	notify(ctx, `Removed worktree at ${resolved}${force ? " (forced)" : ""}.`, "info");
}

async function handlePrune(ctx: ExtensionContext, parsed: ParsedCommand, signal?: AbortSignal): Promise<void> {
	// Always preview first.
	const preview = await runGit(buildPruneArgs(true), {
		cwd: ctx.cwd,
		signal,
		timeoutMs: GIT_TIMEOUT_MS,
	});
	if (!preview.ok) {
		notify(ctx, `Could not prune worktrees: ${gitError(preview)}`, "error");
		return;
	}
	const previewText = combinedOutput(preview);
	if (parsed.dryRun) {
		notify(ctx, previewText ? `Would prune:\n${previewText}` : "Nothing to prune.", "info");
		return;
	}
	if (!previewText) {
		notify(ctx, "Nothing to prune.", "info");
		return;
	}
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm("Prune worktrees?", `This will prune stale worktree metadata:\n${previewText}`);
		if (!ok) {
			notify(ctx, "Prune cancelled.", "info");
			return;
		}
	}
	const result = await runGit(buildPruneArgs(false), {
		cwd: ctx.cwd,
		signal,
		timeoutMs: GIT_TIMEOUT_MS,
	});
	if (!result.ok) {
		notify(ctx, `Could not prune worktrees: ${gitError(result)}`, "error");
		return;
	}
	notify(ctx, "Pruned stale worktree metadata.", "info");
}

/** Resolve the action when `/worktree` is invoked without args in a TUI. */
async function resolveInteractiveAction(ctx: ExtensionContext): Promise<ParsedCommand | undefined> {
	const choice = await ctx.ui.select("Worktree action", [
		"list — show worktrees",
		"add — create a worktree",
		"remove — delete a worktree",
		"prune — clean stale metadata",
	]);
	if (!choice) return undefined;
	const action = choice.split(/\s+/)[0] as ParsedCommand["action"];
	if (action === "remove") {
		const listed = await listWorktrees(ctx);
		if (!listed.ok || listed.entries.length === 0) {
			notify(ctx, "No worktrees available to remove.", "warning");
			return undefined;
		}
		// The main worktree (first entry) cannot be removed; offer the rest.
		const removable = listed.entries.slice(1);
		if (removable.length === 0) {
			notify(ctx, "Only the main worktree exists; nothing to remove.", "warning");
			return undefined;
		}
		const pick = await ctx.ui.select(
			"Remove which worktree?",
			removable.map((e) => e.path),
		);
		if (!pick) return undefined;
		return { action: "remove", path: pick };
	}
	if (action === "add") {
		const pathArg = await ctx.ui.input?.("New worktree path", "");
		if (!pathArg) {
			notify(ctx, "Add cancelled (no path).", "info");
			return undefined;
		}
		const branch = await ctx.ui.input?.("New branch name (optional)", "");
		const newBranch = branch?.trim() || undefined;
		if (newBranch && !isValidBranchName(newBranch)) {
			notify(ctx, `Invalid branch name: "${newBranch}"`, "warning");
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

export type GitWorktreeAction = "list" | "add" | "remove" | "prune";

const SUBCOMMANDS = ["list", "add", "remove", "prune", "help"] as const;

export default function worktreeExtension(pi: ExtensionAPI): void {
	pi.registerCommand("worktree", {
		description: "Manage git worktrees: list | add | remove | prune",
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
			"Manage git worktrees in the current repository. Actions: 'list' (enumerate worktrees), 'add' (create a worktree at a path, optionally on a new branch), 'remove' (delete a worktree; refuses a dirty worktree unless force=true), 'prune' (clean stale worktree metadata). git is invoked with an argv array, never a shell.",
		promptSnippet: "List, add, remove, or prune git worktrees.",
		promptGuidelines: [
			"Use git_worktree to inspect or manage git worktrees (list/add/remove/prune) instead of hand-writing `git worktree` bash commands.",
			"git_worktree remove never force-deletes by default: only pass force=true when the user explicitly accepts discarding a dirty worktree's changes.",
			"Pi's cwd is fixed for the session, so git_worktree cannot switch into another worktree — report the worktree path so the user can open a new Pi there.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "add", "remove", "prune"] as const),
			path: Type.Optional(
				Type.String({
					description:
						"Worktree location (required for add/remove). A BARE name with no '/' (e.g. \"feature\") is created under <configDir>/worktrees/<name> (gitignored). Use ./x, ../x, /abs, or ~/x to place it literally (relative to cwd / home / absolute).",
				}),
			),
			branch: Type.Optional(
				Type.String({
					description: "For add: create and check out this new branch (git worktree add -b).",
				}),
			),
			commitish: Type.Optional(
				Type.String({
					description: "For add: commit/branch/tag to base the worktree on (start point).",
				}),
			),
			detach: Type.Optional(Type.Boolean({ description: "For add: check out in detached HEAD mode." })),
			force: Type.Optional(
				Type.Boolean({
					description:
						"For add: allow a branch already checked out elsewhere. For remove: discard a dirty/locked worktree.",
				}),
			),
			dryRun: Type.Optional(
				Type.Boolean({
					description: "For prune: only report what would be pruned without deleting.",
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
						content: [{ type: "text" as const, text: `Could not list worktrees: ${gitError(result)}` }],
						details: { isError: true, action: "list" },
					};
				}
				const entries = parseWorktreeList(result.stdout);
				const text = entries.length
					? entries.map((e) => describeWorktree(e)).join("\n")
					: "No worktrees found.";
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
						content: [{ type: "text" as const, text: `Could not prune worktrees: ${gitError(result)}` }],
						details: { isError: true, action: "prune" },
					};
				}
				const out = combinedOutput(result);
				const text = dryRun
					? out
						? `Would prune:\n${out}`
						: "Nothing to prune."
					: "Pruned stale worktree metadata.";
				return {
					content: [{ type: "text" as const, text }],
					details: { action: "prune", dryRun, output: out },
				};
			}

			if (params.action === "add") {
				const target = resolveWorktreeTarget(params.path ?? "", ctx.cwd);
				if (!target) {
					return {
						content: [{ type: "text" as const, text: "git_worktree add requires a 'path'." }],
						details: { isError: true, action: "add" },
					};
				}
				if (params.branch !== undefined && !isValidBranchName(params.branch)) {
					return {
						content: [{ type: "text" as const, text: `Invalid branch name: "${params.branch}"` }],
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
						content: [{ type: "text" as const, text: `Could not add worktree: ${gitError(result)}` }],
						details: { isError: true, action: "add", path: target.path },
					};
				}
				const branchNote = params.branch ? ` (new branch ${params.branch})` : "";
				const locationNote = target.usedDefaultBase ? " (default .pi/worktrees/)" : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `Added worktree at ${target.path}${branchNote}${locationNote}. Open it with: cd ${target.path} && pi`,
						},
					],
					details: {
						action: "add",
						path: target.path,
						branch: params.branch ?? null,
						defaultBase: target.usedDefaultBase,
					},
				};
			}

			// remove
			const target = resolveWorktreeTarget(params.path ?? "", ctx.cwd);
			if (!target) {
				return {
					content: [{ type: "text" as const, text: "git_worktree remove requires a 'path'." }],
					details: { isError: true, action: "remove" },
				};
			}
			const resolved = target.path;
			const force = params.force ?? false;
			const result = await runGit(buildRemoveArgs(resolved, force), opts);
			if (!result.ok) {
				const hint =
					!force && needsForce(result)
						? " The worktree is dirty or locked; re-run with force=true only if the user accepts discarding changes."
						: "";
				return {
					content: [
						{
							type: "text" as const,
							text: `Could not remove worktree: ${gitError(result)}.${hint}`,
						},
					],
					details: { isError: true, action: "remove", path: resolved },
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Removed worktree at ${resolved}${force ? " (forced)" : ""}.`,
					},
				],
				details: { action: "remove", path: resolved, forced: force },
			};
		},
	});
}
