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
 *      find ... -delete and find ... -exec rm (incl. a path-qualified rm like /bin/rm)
 *      truncate / shred (in-place destruction of existing files)
 *      shell redirections (>, >>, the `>|`/`>>|` clobber form, and BOTH combined-redirect
 *        spellings `&>`/`&>>` and `>&`/`N>&`) and tee (every positional target, not just
 *        the first) writing OUTSIDE the project cwd, including targets that escape via a
 *        leading ~ (home), an unexpanded $VAR/${VAR}, a command substitution ($(...) /
 *        `...`), a backslash-escaped path (`\/etc/...`), or a relative target reached
 *        after a `cd`/`pushd` into a dir outside the project
 *      git push --force / -f / --force-with-lease / +refspec, and the non-force remote
 *        destroyers --delete / --mirror / --prune and the `origin :branch` delete refspec
 *      git reset --hard / git checkout -f|--force (working-tree loss)
 *      git clean -fd / -xfd
 *      git filter-branch (history rewrite) and git stash clear / stash drop (stash loss)
 *      DROP TABLE/DATABASE/SCHEMA/TABLESPACE/OWNED (SQL drops)
 *      TRUNCATE TABLE
 *      kubectl apply|delete / terraform apply|destroy / helm upgrade|install|uninstall|
 *        delete|rollback
 *      dd  (raw disk writes)
 *      mkfs and its aliases (mke2fs / mkdosfs / mkntfs / mkswap / newfs) — device format
 *
 *  Backslash line-continuations are collapsed to a space before matching, so splitting a
 *  command across lines (`rm \\<newline> -rf d`) cannot hide its flags from the patterns.
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
 * variable (`R=-rf; rm $R d`), encoded execution (`… | base64 -d | sh`), destructive
 * verbs behind generic one-letter aliases (`k delete …`) or tools not on the structured
 * list (most `docker`/cloud-CLI subcommands, and `rsync --delete` whose mirror-wipe is
 * indistinguishable from an ordinary sync), and out-of-project writes reached only at
 * runtime through a symlink (no realpath/filesystem awareness here). `git -C <outside>`
 * is not gated on the path itself, but its destructive SUBcommand still is, since the
 * verb patterns above match regardless of the `-C` directory.
 */
export const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
	// rm that is RECURSIVE, in ANY flag form (-r, -R, -rf, -fr, --recursive). The
	// recursive flag is the data-loss risk; force only suppresses prompts, so a bare
	// `rm -r dir` in a non-interactive autopilot shell still deletes a whole tree.
	// Single-file `rm foo.txt` is intentionally NOT gated.
	/\brm\b(?=[^\n]*(\s-[a-z]*[rR]|\s--recursive\b))/i,
	// find-driven deletion: `find … -delete` and `find … -exec rm …` (allowing a path-
	// qualified rm like `-exec /bin/rm` or `-exec /usr/bin/rm`, which bare `rm\b` would miss).
	/\bfind\b[^\n]*\s-delete\b/i,
	/\bfind\b[^\n]*-exec\s+(?:\S*\/)?rm\b/i,
	// In-place data destruction of existing files (coreutils truncate, shred).
	/\btruncate\b/i,
	/\bshred\b/i,
	/\bgit\b[^\n]*\bpush\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i,
	// Force-push via a `+` refspec (e.g. `git push origin +master`): a leading `+` on the
	// refspec force-updates the remote ref WITHOUT any --force/-f flag, so the flag-based
	// pattern above misses it. The `\s\+\S` anchors on a whitespace-led `+<ref>` token.
	/\bgit\b[^\n]*\bpush\b[^\n]*\s\+[^\s]/i,
	// Destructive remote pushes that carry NO force flag: `--delete`/`--mirror`/`--prune`
	// (delete or rewrite remote refs) and the empty-source colon refspec `origin :branch`
	// (deletes the remote branch). A leading-whitespace colon `\s:\S` avoids matching the
	// `host:repo`/`main:refs/...` colons in ordinary push URLs and ref mappings.
	/\bgit\b[^\n]*\bpush\b[^\n]*(--delete\b|--mirror\b|--prune\b)/i,
	/\bgit\b[^\n]*\bpush\b[^\n]*\s:\S/i,
	/\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i,
	/\bgit\b[^\n]*\bclean\b[^\n]*\s-[a-z]*f/i,
	// git checkout -f / --force discards uncommitted working-tree changes (no reflog for
	// them) — same irreversible-working-tree-loss class as reset --hard.
	/\bgit\b[^\n]*\bcheckout\b[^\n]*\s(?:-f\b|--force\b)/i,
	// git history rewrite (filter-branch) and stash destruction (stash clear/drop) are
	// irreversible — same destructive-git family as reset --hard / clean -fd above.
	/\bgit\b[^\n]*\bfilter-branch\b/i,
	/\bgit\b[^\n]*\bstash\b[^\n]*\b(clear|drop)\b/i,
	/\bdrop\s+(table|database|schema|tablespace|owned)\b/i,
	/\btruncate\s+table\b/i,
	/\b(kubectl)\b[^\n]*\b(delete|apply)\b/i,
	/\bterraform\b[^\n]*\b(apply|destroy)\b/i,
	/\bhelm\b[^\n]*\b(upgrade|install|uninstall|delete|rollback)\b/i,
	/\bdd\b[^\n]*\bif=|\bdd\b[^\n]*\bof=/i,
	/\bmkfs(\.\w+)?\b/i,
	// mkfs aliases / other filesystem-format tools that reformat a device.
	/\b(mke2fs|mkdosfs|mkntfs|mkswap|newfs)\b/i,
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
// `>&file` / `N>&file` is the `>`-first spelling of the combined redirect: bash sends BOTH
// streams to <file> when the word after `>&` is not a number/`-` (a number/`-` is an fd-dup
// or close: 2>&1, >&2, >&-). AMP_REDIRECT_TARGET_RE only matches the `&`-first `&>` form, so
// this mirror needs its own pattern; the `(?![-\d&])` guard preserves the fd-dup exclusions.
export const GT_AMP_REDIRECT_TARGET_RE = /(?:^|[^&>=\d-])\d*>&\s*(?![-\d&])("[^"]*"|'[^']*'|[^\s|&;<>]+)/g;
// `tee [flags] <file...>` writes EVERY positional file. Capture the whole post-`tee`
// argument run so unsafeBashWriteTarget can check each target, not just the first (a
// single-capture regex let `tee build/ok.log /etc/evil` slip its second target past).
export const TEE_ARGS_RE = /\btee\b((?:\s+(?:-\S+|"[^"]*"|'[^']*'|[^\s|&;<>]+))+)/gi;
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
	for (const re of [REDIRECT_TARGET_RE, AMP_REDIRECT_TARGET_RE, GT_AMP_REDIRECT_TARGET_RE]) {
		for (const m of command.matchAll(re)) if (m[1]) targets.push(unquote(m[1]));
	}
	// `tee` may list several files; check every non-flag token in its argument run.
	for (const m of command.matchAll(TEE_ARGS_RE)) {
		if (!m[1]) continue;
		for (const tok of m[1].trim().split(/\s+/)) {
			if (tok.startsWith("-")) continue;
			targets.push(unquote(tok));
		}
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
	// Drop shell backslash-escapes first: `> \/etc/x` reaches here as `\/etc/x`, which
	// path.normalize treats as a NON-absolute name (it does not start with `/`) and would
	// wave through. Unescaping restores the real `/etc/x` so the absolute-outside check fires.
	const p = filePath.replace(/\\(.)/g, "$1");
	// A leading ~ (home), an unexpanded shell variable ($VAR / ${VAR}), a command
	// substitution ($(...) or `...`) cannot be proven to resolve inside the project: the
	// shell expands them at runtime, path.normalize does not. Treat them as out-of-project
	// rather than as innocuous relative names.
	if (p.startsWith("~")) return true;
	if (/\$[\w{(]/.test(p)) return true;
	if (p.includes("`")) return true;
	// Reject any path that climbs out of cwd via "..".
	const normalized = path.normalize(p);
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
		const rawCommand = (event.input as { command?: unknown }).command;
		if (typeof rawCommand === "string") {
			// Collapse backslash line-continuations to a space BEFORE matching: otherwise a
			// command split across lines (`rm \\<newline> -rf d`) hides its flags from the
			// [^\n]*-anchored patterns. This strengthens every pattern at once.
			const command = rawCommand.replace(/\\\r?\n/g, " ");
			if (isDestructiveBash(command)) {
				return `autopilot bloqueó un comando de shell destructivo: ${command.slice(0, 200)}`;
			}
			const unsafeTarget = unsafeBashWriteTarget(ctx, command);
			if (unsafeTarget) {
				return `autopilot bloqueó una escritura de shell fuera del proyecto: ${unsafeTarget.slice(0, 200)}`;
			}
		}
		return undefined;
	}
	if (event.toolName === "write" || event.toolName === "edit") {
		const input = event.input as { file_path?: unknown; path?: unknown };
		const filePath = input.file_path ?? input.path;
		if (isUnsafeWritePath(ctx, filePath)) {
			return `autopilot bloqueó un ${event.toolName} fuera del proyecto: ${String(filePath).slice(0, 200)}`;
		}
		return undefined;
	}
	return undefined;
}
