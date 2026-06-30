/**
 * pi-loop autopilot DESTRUCTIVE-ACTION gate (pure safety policy).
 *
 * Extracted verbatim from index.ts (behavior-preserving) so the safety policy
 * — which autopilot bash commands / out-of-project writes are gated — lives in
 * one trivially testable, side-effect-free place. The wiring (anyAutopilotActive
 * / handleToolCall, which read shared loop state) stays in index.ts and imports
 * destructiveReason. Depth-one sibling imported via "./gate.js"; the SDK imports
 * are type-only and erased at build time.
 */

import * as path from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * Conservative allowlist of destructive operations that require confirmation when an
 * AUTOPILOT turn (one triggered by a wake, not the user) tries to run them. The intent
 * is to catch clearly irreversible / high-blast-radius actions while NEVER getting in
 * the way of a human's own turn or of ordinary loop work (reads, greps, normal edits).
 *
 * Documented allowlist:
 *  - bash commands matching:
 *      rm RECURSIVE in ANY flag form: -r / -R / -rf / -fr / --recursive (force is
 *        optional — the recursive flag is the data-loss risk). Single-file rm is not gated.
 *      find ... -delete and find ... -exec rm (recursive deletion via find)
 *      truncate / shred (in-place destruction of existing files)
 *      shell redirections (>, >>, the `>|`/`>>|` clobber form, and the `&>`/`&>>`
 *        combined-redirect operator) and tee writing OUTSIDE the project cwd, including
 *        targets that escape via a leading ~ (home), an unexpanded $VAR/${VAR}, a command
 *        substitution ($(...) / `...`), or a relative target reached after a `cd`/`pushd`
 *        into a dir outside the project
 *      git push --force / -f / push ... --force-with-lease / push ... +refspec (force
 *        via a leading `+` on the refspec)
 *      git reset --hard
 *      git clean -fd / -xfd
 *      git filter-branch (history rewrite) and git stash clear / stash drop (stash loss)
 *      DROP TABLE/DATABASE/SCHEMA (SQL drops)
 *      TRUNCATE TABLE
 *      kubectl apply|delete / terraform apply|destroy / helm upgrade|install|uninstall
 *      dd  (raw disk writes)
 *      mkfs (filesystem creation)
 *
 * NOTE on "deploy": there is intentionally NO bare /\bdeploy\b/ pattern. "deploy" is a
 * plain English word, not a binary, so it false-positives on ordinary loop work like
 * `cat deploy.md`, `ls deploy/`, `grep deploy src/`, `npm run deploy:dry-run` — which is
 * the opposite of conservative (a loop whose whole job is to *watch a deploy* would
 * auto-block every iteration). Real deploy tooling is already covered by the structured
 * kubectl/terraform/helm patterns below.
 *
 *  - write/edit targeting a path OUTSIDE the trusted project cwd (an absolute path that
 *    does not start with ctx.cwd, or any path escaping via "..").
 *
 * Conservative bias: when unsure, DO NOT block — only autopilot turns are gated, and
 * only when the pattern clearly matches one of the above.
 *
 * ACCEPTED LIMITATIONS (by design — this is defense-in-depth, NOT a security boundary;
 * the load-bearing controls are project trust + the autopilot confirm/block). A regex
 * allowlist cannot catch destruction expressed through a general-purpose interpreter or
 * runtime indirection, and gating those would false-positive on ordinary work. So these
 * intentionally PASS: interpreter-driven deletion (`perl -e unlink`, `python -c
 * shutil.rmtree`), deletion via `xargs rm` (non-recursive), flags assembled from a shell
 * variable (`R=-rf; rm $R d`), encoded execution (`… | base64 -d | sh`), and destructive
 * verbs behind generic one-letter aliases (`k delete …`) or tools not on the structured
 * list (most `docker`/cloud-CLI subcommands).
 */
export const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
	// rm that is RECURSIVE, in ANY flag form (-r, -R, -rf, -fr, --recursive). The
	// recursive flag is the data-loss risk; force only suppresses prompts, so a bare
	// `rm -r dir` in a non-interactive autopilot shell still deletes a whole tree.
	// Single-file `rm foo.txt` is intentionally NOT gated.
	/\brm\b(?=[^\n]*(\s-[a-z]*[rR]|\s--recursive\b))/i,
	// find-driven deletion: `find … -delete` and `find … -exec rm …`.
	/\bfind\b[^\n]*\s-delete\b/i,
	/\bfind\b[^\n]*-exec\s+rm\b/i,
	// In-place data destruction of existing files (coreutils truncate, shred).
	/\btruncate\b/i,
	/\bshred\b/i,
	/\bgit\b[^\n]*\bpush\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i,
	// Force-push via a `+` refspec (e.g. `git push origin +master`): a leading `+` on the
	// refspec force-updates the remote ref WITHOUT any --force/-f flag, so the flag-based
	// pattern above misses it. The `\s\+\S` anchors on a whitespace-led `+<ref>` token.
	/\bgit\b[^\n]*\bpush\b[^\n]*\s\+[^\s]/i,
	/\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i,
	/\bgit\b[^\n]*\bclean\b[^\n]*\s-[a-z]*f/i,
	// git history rewrite (filter-branch) and stash destruction (stash clear/drop) are
	// irreversible — same destructive-git family as reset --hard / clean -fd above.
	/\bgit\b[^\n]*\bfilter-branch\b/i,
	/\bgit\b[^\n]*\bstash\b[^\n]*\b(clear|drop)\b/i,
	/\bdrop\s+(table|database|schema)\b/i,
	/\btruncate\s+table\b/i,
	/\b(kubectl)\b[^\n]*\b(delete|apply)\b/i,
	/\bterraform\b[^\n]*\b(apply|destroy)\b/i,
	/\bhelm\b[^\n]*\b(upgrade|install|uninstall)\b/i,
	/\bdd\b[^\n]*\bif=|\bdd\b[^\n]*\bof=/i,
	/\bmkfs(\.\w+)?\b/i,
];

/** Is this bash command in the destructive allowlist? */
export function isDestructiveBash(command: string): boolean {
	return DESTRUCTIVE_BASH_PATTERNS.some((re) => re.test(command));
}

// Shell redirections that WRITE a file (>, >>, the `>|` clobber-override form, optionally
// fd-prefixed like 2>log), capturing the target path. Excludes fd-dups (>&, 2>&1) and the
// operators ->, =>, >= which are not redirections. The `\|?` after `>>?` catches `>|`/`>>|`,
// which set noclobber-override and otherwise slip past (the `|` is not a valid target char).
export const REDIRECT_TARGET_RE = /(?:^|[^&>=\d-])\d*>>?\|?\s*(?![&>=])("[^"]*"|'[^']*'|[^\s|&;<>]+)/g;
// `&>` / `&>>` redirect BOTH stdout+stderr to a file (bash). REDIRECT_TARGET_RE deliberately
// rejects a `&` immediately before `>` (to skip fd-dups like 2>&1 / >&2), so the combined-
// redirect operator needs its own pattern: `&` at a command-ish position, then `>`/`>>`.
export const AMP_REDIRECT_TARGET_RE = /(?:^|[\s;|&(])&>>?\s*(?![&>=])("[^"]*"|'[^']*'|[^\s|&;<>]+)/g;
// `tee [flags] <file>` also writes a file.
export const TEE_TARGET_RE = /\btee\b\s+(?:-\S+\s+)*("[^"]*"|'[^']*'|[^\s|&;<>]+)/gi;
// `cd`/`pushd` at COMMAND position (start, or after a ;/&&/||/|/newline/`(` separator),
// capturing the optional directory operand. A bare `cd` (no operand) goes to $HOME.
export const CD_TARGET_RE = /(?:^|[;&|\n(])[ \t]*(?:cd|pushd)\b[ \t]*("[^"]*"|'[^']*'|[^\s|&;<>]+)?/gi;

// Does the command `cd`/`pushd` into a directory we cannot prove stays inside the
// project? If so, any RELATIVE redirect/tee target is no longer provably in-project.
// A bare `cd`, `cd -`, `cd ~`, `cd ..`, `cd /abs-outside`, or `cd $VAR` all qualify.
export function commandChangesToUnsafeDir(ctx: ExtensionContext, command: string): boolean {
	for (const m of command.matchAll(CD_TARGET_RE)) {
		const raw = m[1];
		if (raw === undefined) return true; // bare `cd` -> $HOME (outside the project)
		const dir = unquote(raw);
		if (dir === "" || dir === "-") return true; // `cd -` returns to an unknown previous dir
		if (isUnsafeWritePath(ctx, dir)) return true; // absolute-outside, .., leading ~, or $VAR
	}
	return false;
}

export function unquote(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

// Return the first shell redirect/tee target that writes OUTSIDE the project, so a
// bash command cannot evade the same out-of-project guard applied to write/edit.
export function unsafeBashWriteTarget(ctx: ExtensionContext, command: string): string | undefined {
	const targets: string[] = [];
	for (const re of [REDIRECT_TARGET_RE, AMP_REDIRECT_TARGET_RE, TEE_TARGET_RE]) {
		for (const m of command.matchAll(re)) if (m[1]) targets.push(unquote(m[1]));
	}
	const leftProject = commandChangesToUnsafeDir(ctx, command);
	for (const target of targets) {
		if (target.startsWith("/dev/")) continue; // /dev/null and friends are not real writes
		if (isUnsafeWritePath(ctx, target)) return target;
		// After a `cd` outside the project, a relative target resolves outside too.
		if (leftProject && !path.isAbsolute(target)) return target;
	}
	return undefined;
}

/** Is this write/edit path unsafe (outside the trusted project cwd, or escaping via "..")? */
export function isUnsafeWritePath(ctx: ExtensionContext, filePath: unknown): boolean {
	if (typeof filePath !== "string" || filePath.length === 0) return false;
	// A leading ~ (home), an unexpanded shell variable ($VAR / ${VAR}), a command
	// substitution ($(...) or `...`) cannot be proven to resolve inside the project: the
	// shell expands them at runtime, path.normalize does not. Treat them as out-of-project
	// rather than as innocuous relative names.
	if (filePath.startsWith("~")) return true;
	if (/\$[\w{(]/.test(filePath)) return true;
	if (filePath.includes("`")) return true;
	// Reject any path that climbs out of cwd via "..".
	const normalized = path.normalize(filePath);
	if (normalized.split(path.sep).includes("..")) return true;
	if (path.isAbsolute(normalized)) {
		const root = path.resolve(ctx.cwd);
		const target = path.resolve(normalized);
		// Outside cwd → unsafe. (Inside cwd → ordinary loop work, allowed.)
		return target !== root && !target.startsWith(root + path.sep);
	}
	// A relative path with no ".." resolves inside cwd → safe.
	return false;
}

/**
 * Decide whether an autopilot tool call is a gated destructive action. Returns a
 * human-readable reason when it should be gated, else undefined. Pure (no side effects)
 * so it is trivially testable.
 */
export function destructiveReason(ctx: ExtensionContext, event: ToolCallEvent): string | undefined {
	if (event.toolName === "bash") {
		const command = (event.input as { command?: unknown }).command;
		if (typeof command === "string") {
			if (isDestructiveBash(command)) {
				return `autopilot blocked a destructive shell command: ${command.slice(0, 200)}`;
			}
			const unsafeTarget = unsafeBashWriteTarget(ctx, command);
			if (unsafeTarget) {
				return `autopilot blocked a shell write outside the project: ${unsafeTarget.slice(0, 200)}`;
			}
		}
		return undefined;
	}
	if (event.toolName === "write" || event.toolName === "edit") {
		const input = event.input as { file_path?: unknown; path?: unknown };
		const filePath = input.file_path ?? input.path;
		if (isUnsafeWritePath(ctx, filePath)) {
			return `autopilot blocked a ${event.toolName} outside the project: ${String(filePath).slice(0, 200)}`;
		}
		return undefined;
	}
	return undefined;
}
