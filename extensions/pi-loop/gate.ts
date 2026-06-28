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

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

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
 *      shell redirections (>, >>) and tee writing OUTSIDE the project cwd
 *      git push --force / -f / push ... --force-with-lease
 *      git reset --hard
 *      git clean -fd / -xfd
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
	/\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i,
	/\bgit\b[^\n]*\bclean\b[^\n]*\s-[a-z]*f/i,
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

// Shell redirections that WRITE a file (>, >>, optionally fd-prefixed like 2>log),
// capturing the target path. Excludes fd-dups (>&, 2>&1) and the operators ->, =>,
// >= which are not redirections.
export const REDIRECT_TARGET_RE = /(?:^|[^&>=\d-])\d*>>?\s*(?![&>=])("[^"]*"|'[^']*'|[^\s|&;<>]+)/g;
// `tee [flags] <file>` also writes a file.
export const TEE_TARGET_RE = /\btee\b\s+(?:-\S+\s+)*("[^"]*"|'[^']*'|[^\s|&;<>]+)/gi;

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
	for (const m of command.matchAll(REDIRECT_TARGET_RE)) if (m[1]) targets.push(unquote(m[1]));
	for (const m of command.matchAll(TEE_TARGET_RE)) if (m[1]) targets.push(unquote(m[1]));
	for (const target of targets) {
		if (target.startsWith("/dev/")) continue; // /dev/null and friends are not real writes
		if (isUnsafeWritePath(ctx, target)) return target;
	}
	return undefined;
}

/** Is this write/edit path unsafe (outside the trusted project cwd, or escaping via "..")? */
export function isUnsafeWritePath(ctx: ExtensionContext, filePath: unknown): boolean {
	if (typeof filePath !== "string" || filePath.length === 0) return false;
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
		const filePath =
			(event.input as { file_path?: unknown; path?: unknown }).file_path ??
			(event.input as { path?: unknown }).path;
		if (isUnsafeWritePath(ctx, filePath)) {
			return `autopilot blocked a ${event.toolName} outside the project: ${String(filePath).slice(0, 200)}`;
		}
		return undefined;
	}
	return undefined;
}
