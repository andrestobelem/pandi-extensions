/**
 * pi-worktree helpers: pure, UI-free logic for driving `git worktree`.
 *
 * Everything here is deliberately free of pi's ExtensionContext / UI so it can be
 * unit-tested in isolation and reused by both the `/worktree` command and the
 * model-callable `git_worktree` tool. The only side effect lives in `runGit`,
 * which spawns `git` with an ARGV array (never a shell string) so user/model
 * input can never inject shell commands.
 *
 * Depth-one sibling module imported by index.ts via "./worktree.js".
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 1_000_000;
/** Default subdirectory (under the Pi config dir) for worktrees created from a bare name. */
export const WORKTREES_DIR = "worktrees";

export interface GitResult {
	/** true when git exited 0 and was neither aborted nor timed out. */
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	/** set when the process was killed by signal/timeout/abort. */
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	/** set when we never managed to spawn git at all (e.g. git not installed). */
	spawnError?: string;
}

export interface RunGitOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Run `git <args>` in `cwd` and resolve with a typed result. NEVER rejects: a
 * spawn failure, non-zero exit, timeout, or abort all come back as a GitResult so
 * callers can branch without try/catch. Output is byte-bounded to keep a runaway
 * git from blocking the event loop / flooding the transcript.
 */
export function runGit(args: string[], options: RunGitOptions): Promise<GitResult> {
	const { cwd, signal, timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = options;
	return new Promise<GitResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let timedOut = false;

		const child = spawn("git", args, { cwd, windowsHide: true });

		const finish = (result: GitResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const onAbort = (): void => {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			finish({ ok: false, exitCode: null, stdout, stderr, signal: "SIGTERM", timedOut: false });
		};

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}, timeoutMs);
		// Do not keep the process alive just for this timer.
		if (typeof timer.unref === "function") timer.unref();

		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdoutBytes >= MAX_GIT_OUTPUT_BYTES) return;
			stdoutBytes += chunk.length;
			stdout += chunk.toString("utf8");
			if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_GIT_OUTPUT_BYTES);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrBytes >= MAX_GIT_OUTPUT_BYTES) return;
			stderrBytes += chunk.length;
			stderr += chunk.toString("utf8");
			if (stderrBytes > MAX_GIT_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_GIT_OUTPUT_BYTES);
		});

		child.on("error", (err) => {
			finish({ ok: false, exitCode: null, stdout, stderr, signal: null, timedOut, spawnError: err.message });
		});
		child.on("close", (code, sig) => {
			finish({ ok: code === 0 && !timedOut, exitCode: code, stdout, stderr, signal: sig, timedOut });
		});
	});
}

/** A single entry from `git worktree list --porcelain`. */
export interface WorktreeEntry {
	path: string;
	head?: string;
	/** full ref (e.g. refs/heads/main) when attached to a branch. */
	branch?: string;
	/** short branch name derived from `branch`. */
	branchShort?: string;
	bare: boolean;
	detached: boolean;
	locked: boolean;
	lockedReason?: string;
	prunable: boolean;
	prunableReason?: string;
}

/**
 * Parse `git worktree list --porcelain`. Records are separated by blank lines;
 * each line is `key value` or a bare `key`. Unknown keys are ignored so newer
 * git versions never break the parser.
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
		if (!current) continue; // malformed: a key before any `worktree` line
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
 * Validate a git branch name against a practical subset of `git check-ref-format`.
 * Returns true only for names git would accept for a new branch. This is a guard
 * before `git worktree add -b <name>` so we fail fast with a clear message rather
 * than surfacing a cryptic git error.
 */
export function isValidBranchName(name: string): boolean {
	if (!name || name.length > 255) return false;
	if (/\s/.test(name)) return false; // no whitespace
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1f\x7f~^:?*[\\]/.test(name)) return false; // control chars + forbidden set
	if (name.startsWith("/") || name.endsWith("/")) return false;
	if (name.startsWith("-")) return false; // would look like a flag
	if (name.startsWith(".") || name.endsWith(".")) return false;
	if (name.endsWith(".lock")) return false;
	if (name.includes("..")) return false;
	if (name.includes("//")) return false;
	if (name.includes("@{")) return false;
	if (name === "@") return false;
	// no path component may start with a dot or end with .lock
	for (const part of name.split("/")) {
		if (part === "" || part.startsWith(".") || part.endsWith(".lock")) return false;
	}
	return true;
}

export interface WorktreeTarget {
	/** absolute path where the worktree will live. */
	path: string;
	/** true when a bare <name> was placed under <cwd>/<configDir>/worktrees/. */
	usedDefaultBase: boolean;
}

/**
 * Resolve a user/model supplied worktree location.
 *
 * A BARE NAME (no path separator, not ~/absolute) lands in the default base
 * `<cwd>/<configDir>/worktrees/<name>` (kept local + gitignored — see
 * ensureWorktreesBaseDir). Anything that looks like a path — `./x`, `../x`,
 * `/abs/x`, `~/x`, or `a/b` — is honored literally (escape hatch), resolved
 * against `cwd` when relative.
 */
export function resolveWorktreeTarget(rawPath: string, cwd: string, configDirName: string = CONFIG_DIR_NAME): WorktreeTarget | undefined {
	const requested = stripWrappingQuotes(rawPath);
	if (!requested) return undefined;
	if (requested === "~") return { path: os.homedir(), usedDefaultBase: false };
	if (requested.startsWith("~/")) return { path: path.join(os.homedir(), requested.slice(2)), usedDefaultBase: false };
	if (path.isAbsolute(requested)) return { path: requested, usedDefaultBase: false };
	if (requested.includes("/") || requested.includes("\\")) return { path: path.resolve(cwd, requested), usedDefaultBase: false };
	return { path: path.join(cwd, configDirName, WORKTREES_DIR, requested), usedDefaultBase: true };
}

/**
 * Make sure `<cwd>/<configDir>/worktrees/` exists and is self-ignoring, so the
 * worktrees created there never show up in the main repo's `git status`. Writes
 * a `.gitignore` containing `*` (ignores everything, including itself) on first
 * use. Best-effort: filesystem errors are swallowed because the subsequent
 * `git worktree add` will surface any real problem with a clear message.
 */
export function ensureWorktreesBaseDir(cwd: string, configDirName: string = CONFIG_DIR_NAME): string {
	const base = path.join(cwd, configDirName, WORKTREES_DIR);
	try {
		mkdirSync(base, { recursive: true });
		const gitignore = path.join(base, ".gitignore");
		if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n", "utf8");
	} catch {
		/* best-effort: git add will report any real failure */
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
	/** create a new branch with this name (git worktree add -b <branch>). */
	newBranch?: string;
	/** start point / commit-ish to base the worktree on. */
	commitish?: string;
	/** checkout in detached HEAD mode. */
	detach?: boolean;
	/** force creation even when the branch is already checked out elsewhere. */
	force?: boolean;
}

/** Build argv for `git worktree add ...`. Pure; does not touch the filesystem. */
export function buildAddArgs(options: AddArgsOptions): string[] {
	const args = ["worktree", "add"];
	if (options.force) args.push("--force");
	if (options.detach) args.push("--detach");
	if (options.newBranch) args.push("-b", options.newBranch);
	// `--` ends option parsing so a dash-leading commitish (the only model/user
	// value reaching git unvalidated) can't be interpreted as a flag.
	args.push("--", options.path);
	if (options.commitish) args.push(options.commitish);
	return args;
}

/** Build argv for `git worktree remove ...`. */
export function buildRemoveArgs(targetPath: string, force = false): string[] {
	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(targetPath);
	return args;
}

/** Build argv for `git worktree prune ...`. */
export function buildPruneArgs(dryRun = false): string[] {
	const args = ["worktree", "prune"];
	if (dryRun) args.push("--dry-run");
	return args;
}

/** Build argv for `git worktree list --porcelain`. */
export function buildListArgs(): string[] {
	return ["worktree", "list", "--porcelain"];
}

/** One-line human summary of a worktree entry for lists/notifications. */
export function describeWorktree(entry: WorktreeEntry): string {
	const label = entry.bare
		? "(bare)"
		: entry.detached
			? `(detached ${entry.head ? entry.head.slice(0, 8) : "?"})`
			: entry.branchShort
				? entry.branchShort
				: entry.head
					? entry.head.slice(0, 8)
					: "(unknown)";
	const flags: string[] = [];
	if (entry.locked) flags.push("locked");
	if (entry.prunable) flags.push("prunable");
	const suffix = flags.length ? `  [${flags.join(", ")}]` : "";
	return `${entry.path}  →  ${label}${suffix}`;
}
